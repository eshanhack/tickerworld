import { ASSET_SYMBOLS, type AssetState, type AssetSymbol, type Candle, type MarketFeed } from '../types';
import { FORCE_SIMULATION, WORLD_SEED } from '../config';
import { BASE_PRICES, createSimulatedCandles, hashString, mulberry32, stepSimulation } from './simulator';

const REST_URL = 'https://data-api.binance.vision/api/v3/klines';
const SOCKET_URL = 'wss://data-stream.binance.vision/stream?streams=';
const PRESENTATION_INTERVAL = 400;

type Listener = (state: AssetState) => void;

interface BinanceEnvelope {
  stream?: string;
  data?: {
    e?: string;
    s?: string;
    p?: string;
    E?: number;
    k?: {
      t: number;
      o: string;
      h: string;
      l: string;
      c: string;
      x: boolean;
    };
  };
}

export function parseKlines(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const candles: Candle[] = [];
  rows.slice(-30).forEach((row, index, source) => {
    if (!Array.isArray(row)) return;
    const [openTime, open, high, low, close] = row;
    const parsed = [openTime, open, high, low, close].map(Number);
    if (parsed.some((value) => !Number.isFinite(value))) return;
    candles.push({
      openTime: parsed[0] ?? 0,
      open: parsed[1] ?? 0,
      high: parsed[2] ?? 0,
      low: parsed[3] ?? 0,
      close: parsed[4] ?? 0,
      closed: index < source.length - 1,
    });
  });
  return candles;
}

export function reconcileCandle(candles: readonly Candle[], incoming: Candle): Candle[] {
  const next = [...candles];
  const existingIndex = next.findIndex((candle) => candle.openTime === incoming.openTime);
  if (existingIndex >= 0) next[existingIndex] = incoming;
  else next.push(incoming);
  next.sort((a, b) => a.openTime - b.openTime);
  return next.slice(-30);
}

export function isSocketActivityStale(
  activityTimes: Iterable<number>,
  now: number,
  timeoutMs = 12_000,
): boolean {
  const latest = Math.max(...activityTimes);
  return !Number.isFinite(latest) || now - latest > timeoutMs;
}

export class BinanceMarketFeed implements MarketFeed {
  private readonly states = new Map<AssetSymbol, AssetState>();
  private readonly listeners = new Set<Listener>();
  private readonly randoms = new Map<AssetSymbol, () => number>();
  private readonly lastPresented = new Map<AssetSymbol, number>();
  private readonly lastMessage = new Map<AssetSymbol, number>();
  private socket: WebSocket | undefined;
  private simulationTimer: number | undefined;
  private watchdogTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private reconnectAttempt = 0;
  private paused = false;
  private disposed = false;

  constructor() {
    const now = Date.now();
    for (const symbol of ASSET_SYMBOLS) {
      const candles = createSimulatedCandles(symbol, now, 30, WORLD_SEED);
      const price = candles[candles.length - 1]?.close ?? BASE_PRICES[symbol];
      this.states.set(symbol, {
        symbol,
        pair: `${symbol}USDT`,
        candles,
        price,
        previousPrice: price,
        direction: 'flat',
        mode: 'simulated',
        updatedAt: now,
        presentationTick: 0,
      });
      this.randoms.set(symbol, mulberry32(hashString(`${WORLD_SEED}:${symbol}:market`)));
      this.lastMessage.set(symbol, now);
    }
  }

  async start(): Promise<void> {
    this.startTimers();
    if (FORCE_SIMULATION) return;
    await Promise.allSettled(ASSET_SYMBOLS.map((symbol) => this.bootstrap(symbol)));
    if (!this.paused && !this.disposed) this.connect();
  }

  getState(symbol: AssetSymbol): AssetState {
    const state = this.states.get(symbol);
    if (!state) throw new Error(`Unknown market symbol: ${symbol}`);
    return state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    for (const symbol of ASSET_SYMBOLS) listener(this.getState(symbol));
    return () => this.listeners.delete(listener);
  }

  pause(): void {
    this.paused = true;
    this.clearReconnect();
    this.socket?.close(1000, 'Tickerworld hidden');
    this.socket = undefined;
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    if (!FORCE_SIMULATION) {
      void Promise.allSettled(ASSET_SYMBOLS.map((symbol) => this.bootstrap(symbol))).then(() => this.connect());
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    if (this.simulationTimer !== undefined) window.clearInterval(this.simulationTimer);
    if (this.watchdogTimer !== undefined) window.clearInterval(this.watchdogTimer);
    this.listeners.clear();
  }

  private startTimers(): void {
    if (this.simulationTimer === undefined) {
      this.simulationTimer = window.setInterval(() => {
        if (this.paused || this.disposed) return;
        for (const symbol of ASSET_SYMBOLS) {
          const state = this.getState(symbol);
          if (state.mode === 'live') continue;
          const random = this.randoms.get(symbol);
          if (!random) continue;
          const next = stepSimulation(state, random);
          this.states.set(symbol, next);
          this.emit(next);
        }
      }, PRESENTATION_INTERVAL);
    }
    if (this.watchdogTimer === undefined) {
      this.watchdogTimer = window.setInterval(() => this.watchdog(), 4_000);
    }
  }

  private async bootstrap(symbol: AssetSymbol): Promise<void> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6_500);
    try {
      const response = await fetch(`${REST_URL}?symbol=${symbol}USDT&interval=1m&limit=30`, {
        signal: controller.signal,
        mode: 'cors',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Market history returned ${response.status}`);
      const candles = parseKlines(await response.json());
      if (candles.length < 2) throw new Error('Market history was incomplete');
      const previous = this.getState(symbol);
      const price = candles[candles.length - 1]?.close ?? previous.price;
      const state: AssetState = {
        ...previous,
        candles,
        previousPrice: price,
        price,
        direction: 'flat',
        updatedAt: Date.now(),
      };
      this.states.set(symbol, state);
      this.emit(state);
    } catch {
      this.setMode(symbol, 'simulated');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private connect(): void {
    if (this.paused || this.disposed || FORCE_SIMULATION || this.socket) return;
    this.clearReconnect();
    const streams = ASSET_SYMBOLS.flatMap((symbol) => {
      const pair = `${symbol.toLowerCase()}usdt`;
      return [`${pair}@aggTrade`, `${pair}@kline_1m`];
    });
    try {
      const socket = new WebSocket(`${SOCKET_URL}${streams.join('/')}`);
      this.socket = socket;
      socket.addEventListener('open', () => {
        this.reconnectAttempt = 0;
        const now = Date.now();
        ASSET_SYMBOLS.forEach((symbol) => this.lastMessage.set(symbol, now));
      });
      socket.addEventListener('message', (event) => this.handleMessage(String(event.data)));
      socket.addEventListener('close', () => this.handleDisconnect());
      socket.addEventListener('error', () => socket.close());
    } catch {
      this.handleDisconnect();
    }
  }

  private handleMessage(raw: string): void {
    let envelope: BinanceEnvelope;
    try {
      envelope = JSON.parse(raw) as BinanceEnvelope;
    } catch {
      return;
    }
    const data = envelope.data;
    const symbol = this.toAssetSymbol(data?.s);
    if (!data || !symbol) return;
    const now = Date.now();
    this.lastMessage.set(symbol, now);

    if (data.e === 'aggTrade' && data.p) {
      const price = Number(data.p);
      if (!Number.isFinite(price)) return;
      const last = this.lastPresented.get(symbol) ?? 0;
      if (now - last < PRESENTATION_INTERVAL) return;
      this.lastPresented.set(symbol, now);
      const previous = this.getState(symbol);
      const firstLive = previous.mode !== 'live';
      const state: AssetState = {
        ...previous,
        previousPrice: firstLive ? price : previous.price,
        price,
        direction: firstLive ? 'flat' : price > previous.price ? 'up' : price < previous.price ? 'down' : 'flat',
        mode: 'live',
        updatedAt: data.E ?? now,
        presentationTick: previous.presentationTick + 1,
      };
      this.states.set(symbol, state);
      this.emit(state);
      return;
    }

    if (data.e === 'kline' && data.k) {
      const incoming: Candle = {
        openTime: data.k.t,
        open: Number(data.k.o),
        high: Number(data.k.h),
        low: Number(data.k.l),
        close: Number(data.k.c),
        closed: data.k.x,
      };
      if (![incoming.open, incoming.high, incoming.low, incoming.close].every(Number.isFinite)) return;
      const previous = this.getState(symbol);
      const state = {
        ...previous,
        candles: reconcileCandle(previous.candles, incoming),
        mode: 'live' as const,
        updatedAt: now,
      };
      this.states.set(symbol, state);
      this.emit(state);
    }
  }

  private watchdog(): void {
    if (this.paused || this.disposed || FORCE_SIMULATION) return;
    const now = Date.now();
    if (!isSocketActivityStale(this.lastMessage.values(), now)) return;
    ASSET_SYMBOLS.forEach((symbol) => this.setMode(symbol, 'simulated'));
    this.socket?.close();
  }

  private handleDisconnect(): void {
    this.socket = undefined;
    if (this.paused || this.disposed || FORCE_SIMULATION) return;
    ASSET_SYMBOLS.forEach((symbol) => this.setMode(symbol, 'simulated'));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.paused || this.disposed) return;
    const base = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    const jitter = 0.8 + Math.random() * 0.4;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void Promise.allSettled(ASSET_SYMBOLS.map((symbol) => this.bootstrap(symbol))).then(() => this.connect());
    }, base * jitter);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private setMode(symbol: AssetSymbol, mode: AssetState['mode']): void {
    const previous = this.getState(symbol);
    if (previous.mode === mode) return;
    const state = { ...previous, mode };
    this.states.set(symbol, state);
    this.emit(state);
  }

  private emit(state: AssetState): void {
    this.listeners.forEach((listener) => listener(state));
  }

  private toAssetSymbol(pair: string | undefined): AssetSymbol | undefined {
    if (!pair?.endsWith('USDT')) return undefined;
    const symbol = pair.slice(0, -4) as AssetSymbol;
    return ASSET_SYMBOLS.includes(symbol) ? symbol : undefined;
  }
}
