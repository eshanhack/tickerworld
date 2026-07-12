import {
  ASSET_SYMBOLS,
  type AssetSymbol,
  type CompactMarketMid,
  type MarketSlug,
  type RelayedMarketCandle,
  type RelayedMarketState,
} from '@tickerworld/shared';

const HTTP_URL = 'https://api.hyperliquid.xyz/info';
const SOCKET_URL = 'wss://api.hyperliquid.xyz/ws';
const PUBLISH_INTERVAL_MS = 400;
const STALE_AFTER_MS = 8_000;
const MAX_CANDLES = 30;
const NON_HYPERLIQUID_SYMBOLS = new Set<AssetSymbol>(['TEST', 'PUMP', 'ANSEM', 'SHFL']);

type StateListener = (state: RelayedMarketState, mids: readonly CompactMarketMid[]) => void;

export interface MarketRelay {
  start(): void;
  subscribe(market: MarketSlug, listener: StateListener): () => void;
  available(): boolean;
  status(): { available: boolean; lastUpdateAt: number | null; ageMs: number | null };
  dispose(): void;
}

interface InternalMarketState {
  candles: RelayedMarketCandle[];
  price: number | null;
  lastReceivedAt: number | null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRelayedCandle(value: unknown): RelayedMarketCandle | null {
  if (!isRecord(value)) return null;
  const openTime = finiteNumber(value.t ?? value.openTime);
  const open = finiteNumber(value.o ?? value.open);
  const high = finiteNumber(value.h ?? value.high);
  const low = finiteNumber(value.l ?? value.low);
  const close = finiteNumber(value.c ?? value.close);
  if (openTime === null || open === null || high === null || low === null || close === null
    || openTime < 0 || high < low) return null;
  return { openTime, open, high, low, close };
}

export function reconcileRelayedCandles(
  current: readonly RelayedMarketCandle[],
  candle: RelayedMarketCandle,
): RelayedMarketCandle[] {
  const next = current.slice();
  const index = next.findIndex((candidate) => candidate.openTime === candle.openTime);
  if (index >= 0) next[index] = candle;
  else if (candle.openTime > (next.at(-1)?.openTime ?? -1)) next.push(candle);
  return next.sort((left, right) => left.openTime - right.openTime).slice(-MAX_CANDLES);
}

export function applyRelayedTrade(
  current: readonly RelayedMarketCandle[],
  price: number,
  tradeTime: number,
): RelayedMarketCandle[] {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tradeTime) || tradeTime < 0) {
    return current.slice();
  }
  const openTime = Math.floor(tradeTime / 60_000) * 60_000;
  const active = current.at(-1);
  if (active && openTime < active.openTime) return current.slice();
  if (!active || openTime > active.openTime) {
    return reconcileRelayedCandles(current, {
      openTime, open: price, high: price, low: price, close: price,
    });
  }
  return reconcileRelayedCandles(current, {
    ...active,
    high: Math.max(active.high, price),
    low: Math.min(active.low, price),
    close: price,
  });
}

function symbolForMarket(market: MarketSlug): AssetSymbol {
  return market.toUpperCase() as AssetSymbol;
}

function marketForSymbol(symbol: string): MarketSlug | null {
  if (symbol.toLowerCase() === 'xyz:cl') return 'wti';
  const upper = symbol.toUpperCase() as AssetSymbol;
  return !NON_HYPERLIQUID_SYMBOLS.has(upper) && (ASSET_SYMBOLS as readonly string[]).includes(upper)
    ? upper.toLowerCase() as MarketSlug
    : null;
}

function coinForSymbol(symbol: AssetSymbol): string | null {
  if (NON_HYPERLIQUID_SYMBOLS.has(symbol)) return null;
  return symbol === 'WTI' ? 'xyz:CL' : symbol;
}

/** One process-wide Hyperliquid connection and bounded 30-candle windows. */
export class HyperliquidMarketRelay implements MarketRelay {
  private readonly states = new Map<MarketSlug, InternalMarketState>();
  private readonly listeners = new Map<MarketSlug, Set<StateListener>>();
  private socket: WebSocket | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connected = false;
  private failures = 0;
  private openCount = 0;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly now: () => number = Date.now,
  ) {
    for (const symbol of ASSET_SYMBOLS) {
      this.states.set(symbol.toLowerCase() as MarketSlug, {
        candles: [],
        price: null,
        lastReceivedAt: null,
      });
    }
  }

  start(): void {
    if (this.publishTimer || this.stopped) return;
    this.publishTimer = setInterval(() => this.publish(), PUBLISH_INTERVAL_MS);
    this.publishTimer.unref?.();
    void this.bootstrap();
    this.connect();
  }

  subscribe(market: MarketSlug, listener: StateListener): () => void {
    let set = this.listeners.get(market);
    if (!set) {
      set = new Set();
      this.listeners.set(market, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  available(): boolean {
    return this.connected && [...this.states.values()].some((state) => state.lastReceivedAt !== null);
  }

  status(): { available: boolean; lastUpdateAt: number | null; ageMs: number | null } {
    const updates = [...this.states.values()]
      .map((state) => state.lastReceivedAt)
      .filter((value): value is number => value !== null);
    const lastUpdateAt = updates.length > 0 ? Math.max(...updates) : null;
    return {
      available: this.available(),
      lastUpdateAt,
      ageMs: lastUpdateAt === null ? null : Math.max(0, this.now() - lastUpdateAt),
    };
  }

  dispose(): void {
    this.stopped = true;
    this.connected = false;
    if (this.publishTimer) clearInterval(this.publishTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.publishTimer = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1_000, 'shutdown');
    this.listeners.clear();
  }

  private async bootstrap(): Promise<void> {
    const endTime = this.now();
    const startTime = endTime - 32 * 60_000;
    await Promise.allSettled(ASSET_SYMBOLS.map(async (symbol) => {
      const coin = coinForSymbol(symbol);
      if (!coin) return;
      const requestedAt = this.now();
      const response = await this.fetcher(HTTP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval: '1m', startTime, endTime },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error('snapshot_unavailable');
      const payload = await response.json() as unknown;
      if (!Array.isArray(payload)) throw new Error('invalid_snapshot');
      const candles = payload.map(parseRelayedCandle).filter((value): value is RelayedMarketCandle => value !== null);
      const market = symbol.toLowerCase() as MarketSlug;
      const state = this.states.get(market);
      if (!state || candles.length === 0) return;
      const liveOpenTime = state.lastReceivedAt !== null && state.lastReceivedAt > requestedAt
        ? state.candles.at(-1)?.openTime
        : undefined;
      state.candles = candles
        .filter((candle) => liveOpenTime === undefined || candle.openTime < liveOpenTime)
        .reduce(reconcileRelayedCandles, state.candles);
      state.price = state.candles.at(-1)?.close ?? null;
      state.lastReceivedAt = this.now();
    }));
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    let socket: WebSocket;
    try {
      socket = this.socketFactory(SOCKET_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.connected = true;
      this.failures = 0;
      this.openCount += 1;
      if (this.openCount > 1) void this.bootstrap();
      socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids', dex: 'xyz' } }));
      for (const symbol of ASSET_SYMBOLS) {
        const coin = coinForSymbol(symbol);
        if (!coin) continue;
        socket.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'candle', coin, interval: '1m' },
        }));
        socket.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'trades', coin },
        }));
      }
      this.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method: 'ping' }));
      }, 25_000);
      this.heartbeatTimer.unref?.();
    });
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    const closed = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.scheduleReconnect();
    };
    socket.addEventListener('close', closed);
    socket.addEventListener('error', () => socket.close());
  }

  private handleMessage(raw: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8'));
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    if (payload.channel === 'allMids' && isRecord(payload.data) && isRecord(payload.data.mids)) {
      const receivedAt = this.now();
      for (const [symbol, value] of Object.entries(payload.data.mids)) {
        const market = marketForSymbol(symbol);
        const price = finiteNumber(value);
        const state = market ? this.states.get(market) : undefined;
        if (!state || price === null || price <= 0) continue;
        state.price = price;
        state.lastReceivedAt = receivedAt;
      }
      return;
    }
    if (payload.channel === 'candle') {
      const values = Array.isArray(payload.data) ? payload.data : [payload.data];
      for (const value of values) {
        if (!isRecord(value)) continue;
        const symbol = typeof value.s === 'string' ? value.s : '';
        const market = marketForSymbol(symbol);
        const candle = parseRelayedCandle(value);
        const state = market ? this.states.get(market) : undefined;
        if (!state || !candle) continue;
        state.candles = reconcileRelayedCandles(state.candles, candle);
        state.price = candle.close;
        state.lastReceivedAt = this.now();
      }
      return;
    }
    if (payload.channel === 'trades' && Array.isArray(payload.data)) {
      const receivedAt = this.now();
      for (const value of payload.data) {
        if (!isRecord(value) || typeof value.coin !== 'string') continue;
        const market = marketForSymbol(value.coin);
        const price = finiteNumber(value.px);
        const tradeTime = finiteNumber(value.time);
        const state = market ? this.states.get(market) : undefined;
        if (!state || price === null || tradeTime === null) continue;
        state.candles = applyRelayedTrade(state.candles, price, tradeTime);
        state.price = price;
        state.lastReceivedAt = receivedAt;
      }
    }
  }

  private publish(): void {
    const publishedAt = this.now();
    const mids: CompactMarketMid[] = [];
    for (const symbol of ASSET_SYMBOLS) {
      const state = this.states.get(symbol.toLowerCase() as MarketSlug);
      if (state?.price !== null && state?.price !== undefined && state.lastReceivedAt !== null) {
        mids.push({ instrument: symbol, price: state.price, upstreamAt: state.lastReceivedAt });
      }
    }
    for (const [market, listeners] of this.listeners) {
      const state = this.states.get(market);
      if (!state) continue;
      const ageMs = state.lastReceivedAt === null ? null : Math.max(0, publishedAt - state.lastReceivedAt);
      const message: RelayedMarketState = {
        instrument: symbolForMarket(market),
        candles: state.candles.map((candle) => ({ ...candle })),
        candle: state.candles.at(-1) ?? null,
        price: state.price,
        upstreamAt: state.lastReceivedAt,
        publishedAt,
        ageMs,
        stale: !this.connected || ageMs === null || ageMs > STALE_AFTER_MS,
      };
      for (const listener of [...listeners]) listener(message, mids);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.failures += 1;
    const maximum = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.failures - 1));
    const delay = Math.floor(maximum * (0.5 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

export class DisabledMarketRelay implements MarketRelay {
  start(): void {}
  subscribe(): () => void { return () => {}; }
  available(): boolean { return false; }
  status(): { available: boolean; lastUpdateAt: null; ageMs: null } {
    return { available: false, lastUpdateAt: null, ageMs: null };
  }
  dispose(): void {}
}
