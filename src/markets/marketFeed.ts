import { ASSET_SYMBOLS, type AssetState, type AssetSymbol, type Candle, type FeedMode, type MarketFeed } from '../types';
import type { CompactMarketMid, RelayedMarketState } from '../../shared/src/index.js';
import { FORCE_SIMULATION, WORLD_SEED } from '../config';
import {
  BASE_PRICES,
  createSimulatedCandles,
  createSimulatedHistory,
  hashString,
  mulberry32,
  stepSimulation,
  stepTestSimulation,
} from './simulator';
import {
  DAY_MS,
  MINUTE_MS,
  computeHorizonChanges,
  createEmptyHorizonChanges,
} from './horizons';

const REST_URL = 'https://api.hyperliquid.xyz/info';
const SOCKET_URL = 'wss://api.hyperliquid.xyz/ws';
const SNAPSHOT_CANDLE_COUNT = 30;
export const MINUTE_HISTORY_COUNT = 66;
export const DAILY_HISTORY_COUNT = 370;
const MINUTE_SNAPSHOT_LOOKBACK_MS = (MINUTE_HISTORY_COUNT + 6) * MINUTE_MS;
const DAILY_SNAPSHOT_LOOKBACK_MS = (DAILY_HISTORY_COUNT + 5) * DAY_MS;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const PRESENTATION_INTERVAL_MS = 400;
const PRESENTATION_POLL_MS = 50;
const SOCKET_STALE_MS = 45_000;

export const HEARTBEAT_INTERVAL_MS = 25_000;

type Listener = (state: AssetState) => void;

interface PendingTrade {
  price: number;
  time: number;
}

export interface TradeCandleUpdate {
  candles: Candle[];
  accepted: boolean;
  rolled: boolean;
}

interface ParsedTrade extends PendingTrade {
  symbol: AssetSymbol;
}

type HyperliquidSubscription =
  | { type: 'allMids'; dex?: 'xyz' }
  | { type: 'trades'; coin: string }
  | { type: 'candle'; coin: string; interval: '1m' };

type HyperliquidCandleInterval = '1m' | '1d';

interface SnapshotBundle {
  readonly chartCandles: Candle[];
  readonly minuteHistory: Candle[];
  readonly dailyHistory: Candle[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toAssetSymbol(value: unknown): AssetSymbol | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.toLowerCase() === 'xyz:cl') return 'WTI';
  const symbol = value.toUpperCase() as AssetSymbol;
  return ASSET_SYMBOLS.includes(symbol) && symbol !== 'TEST' ? symbol : undefined;
}

/** Maps Tickerworld's friendly symbol onto Hyperliquid's canonical coin id. */
export function hyperliquidCoinForSymbol(symbol: AssetSymbol): string | null {
  if (symbol === 'TEST') return null;
  return symbol === 'WTI' ? 'xyz:CL' : symbol;
}

function looksLikeCandleTuple(value: unknown[]): boolean {
  return value.length >= 5 && !Array.isArray(value[0]) && !isRecord(value[0]);
}

function candleItems(payload: unknown): unknown[] {
  if (isRecord(payload) && 'data' in payload && !('t' in payload) && !('openTime' in payload)) {
    return candleItems(payload.data);
  }
  if (!Array.isArray(payload)) return [payload];
  return looksLikeCandleTuple(payload) ? [payload] : payload;
}

function parseCandleItem(value: unknown, now: number): Candle | undefined {
  let openTime: number | undefined;
  let open: number | undefined;
  let high: number | undefined;
  let low: number | undefined;
  let close: number | undefined;
  let explicitClosed: boolean | undefined;

  if (Array.isArray(value)) {
    if (value.length >= 8 && typeof value[2] === 'string' && typeof value[3] === 'string') {
      // Hyperliquid's compact tuple order: t, T, s, i, o, c, h, l, ...
      openTime = finiteNumber(value[0]);
      open = finiteNumber(value[4]);
      close = finiteNumber(value[5]);
      high = finiteNumber(value[6]);
      low = finiteNumber(value[7]);
    } else {
      // Also tolerate the common [openTime, open, high, low, close] shape.
      openTime = finiteNumber(value[0]);
      open = finiteNumber(value[1]);
      high = finiteNumber(value[2]);
      low = finiteNumber(value[3]);
      close = finiteNumber(value[4]);
      explicitClosed = typeof value[5] === 'boolean' ? value[5] : undefined;
    }
  } else if (isRecord(value)) {
    openTime = finiteNumber(value.t ?? value.openTime);
    open = finiteNumber(value.o ?? value.open);
    high = finiteNumber(value.h ?? value.high);
    low = finiteNumber(value.l ?? value.low);
    close = finiteNumber(value.c ?? value.close);
    explicitClosed = typeof value.closed === 'boolean'
      ? value.closed
      : typeof value.x === 'boolean'
        ? value.x
        : undefined;
  }

  if (
    openTime === undefined
    || open === undefined
    || high === undefined
    || low === undefined
    || close === undefined
    || open <= 0
    || high < Math.max(open, close)
    || low > Math.min(open, close)
    || low <= 0
  ) {
    return undefined;
  }

  const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  return {
    openTime,
    open,
    high,
    low,
    close,
    closed: explicitClosed ?? openTime < currentMinute,
  };
}

/** Parses an ordered Hyperliquid history without coupling it to the 30-candle chart. */
export function parseHyperliquidCandleHistory(
  payload: unknown,
  now = Date.now(),
  maxCount = 5_000,
): Candle[] {
  const byOpenTime = new Map<number, Candle>();
  for (const item of candleItems(payload)) {
    const candle = parseCandleItem(item, now);
    if (candle) byOpenTime.set(candle.openTime, candle);
  }
  const sorted = [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
  return sorted.slice(-Math.max(1, Math.floor(maxCount))).map((candle, index, source) => ({
    ...candle,
    closed: index < source.length - 1 || candle.closed,
  }));
}

/** Parses REST snapshots, websocket objects, and compact candle tuples. */
export function parseHyperliquidCandles(payload: unknown, now = Date.now()): Candle[] {
  return parseHyperliquidCandleHistory(payload, now, SNAPSHOT_CANDLE_COUNT);
}

export function reconcileCandle(
  candles: readonly Candle[],
  incoming: Candle,
  maxCount = SNAPSHOT_CANDLE_COUNT,
): Candle[] {
  const byOpenTime = new Map(candles.map((candle) => [candle.openTime, { ...candle }]));
  byOpenTime.set(incoming.openTime, { ...incoming });
  const next = [...byOpenTime.values()]
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-Math.max(1, Math.floor(maxCount)));
  const latestOpenTime = next.at(-1)?.openTime;
  return next.map((candle) => ({
    ...candle,
    closed: latestOpenTime !== undefined && candle.openTime < latestOpenTime ? true : candle.closed,
  }));
}

/** Applies one coalesced trade to the current minute without accepting historical regressions. */
export function applyTradeToCandles(
  candles: readonly Candle[],
  price: number,
  tradeTime: number,
  maxCount = SNAPSHOT_CANDLE_COUNT,
): TradeCandleUpdate {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tradeTime)) {
    return { candles: [...candles], accepted: false, rolled: false };
  }

  const openTime = Math.floor(tradeTime / MINUTE_MS) * MINUTE_MS;
  const next = [...candles].sort((left, right) => left.openTime - right.openTime);
  const latest = next.at(-1);
  if (!latest) {
    return {
      candles: [{ openTime, open: price, high: price, low: price, close: price, closed: false }],
      accepted: true,
      rolled: true,
    };
  }
  if (openTime < latest.openTime) {
    return { candles: next.slice(-Math.max(1, Math.floor(maxCount))), accepted: false, rolled: false };
  }

  if (openTime === latest.openTime) {
    next[next.length - 1] = {
      ...latest,
      high: Math.max(latest.high, price),
      low: Math.min(latest.low, price),
      close: price,
      closed: false,
    };
    return { candles: next.slice(-Math.max(1, Math.floor(maxCount))), accepted: true, rolled: false };
  }

  next[next.length - 1] = { ...latest, closed: true };
  next.push({ openTime, open: price, high: price, low: price, close: price, closed: false });
  return { candles: next.slice(-Math.max(1, Math.floor(maxCount))), accepted: true, rolled: true };
}

export function parseHyperliquidTrades(payload: unknown): ParsedTrade[] {
  const items = Array.isArray(payload) ? payload : [payload];
  const trades: ParsedTrade[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const symbol = toAssetSymbol(item.coin ?? item.s);
    const price = finiteNumber(item.px ?? item.p);
    const time = finiteNumber(item.time ?? item.t);
    if (!symbol || price === undefined || price <= 0 || time === undefined) continue;
    trades.push({ symbol, price, time });
  }
  return trades.sort((left, right) => left.time - right.time);
}

export function buildHyperliquidSubscriptions(activeSymbol?: AssetSymbol): HyperliquidSubscription[] {
  const symbols = (activeSymbol ? [activeSymbol] : ASSET_SYMBOLS)
    .flatMap((symbol) => {
      const coin = hyperliquidCoinForSymbol(symbol);
      return coin ? [coin] : [];
    });
  return [
    { type: 'allMids' },
    { type: 'allMids', dex: 'xyz' },
    ...symbols.flatMap((coin): HyperliquidSubscription[] => [
      { type: 'trades', coin },
      { type: 'candle', coin, interval: '1m' },
    ]),
  ];
}

/** Parses the compact allMids payload used for portal labels. */
export function parseHyperliquidMids(payload: unknown): Partial<Record<AssetSymbol, number>> {
  const source = isRecord(payload) && isRecord(payload.mids) ? payload.mids : payload;
  if (!isRecord(source)) return {};
  const mids: Partial<Record<AssetSymbol, number>> = {};
  for (const [key, value] of Object.entries(source)) {
    const symbol = toAssetSymbol(key);
    const price = finiteNumber(value);
    if (symbol && price !== undefined && price > 0) mids[symbol] = price;
  }
  return mids;
}

export function computeReconnectDelay(attempt: number, random = Math.random): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = Math.min(30_000, 1_000 * 2 ** Math.min(safeAttempt, 10));
  const jittered = exponential * (0.85 + Math.min(1, Math.max(0, random())) * 0.3);
  return Math.min(30_000, Math.max(1_000, Math.round(jittered)));
}

export function isSocketActivityStale(
  activityTimes: Iterable<number>,
  now: number,
  timeoutMs = SOCKET_STALE_MS,
): boolean {
  const latest = Math.max(...activityTimes);
  return !Number.isFinite(latest) || now - latest > timeoutMs;
}

export class HyperliquidMarketFeed implements MarketFeed {
  private readonly states = new Map<AssetSymbol, AssetState>();
  private readonly listeners = new Set<Listener>();
  private readonly randoms = new Map<AssetSymbol, () => number>();
  private readonly pendingTrades = new Map<AssetSymbol, PendingTrade>();
  private readonly lastPresented = new Map<AssetSymbol, number>();
  private readonly lastTradeTime = new Map<AssetSymbol, number>();
  private readonly minuteHistories = new Map<AssetSymbol, Candle[]>();
  private readonly dailyHistories = new Map<AssetSymbol, Candle[]>();
  private readonly prefetchedSnapshots = new Map<AssetSymbol, { snapshot: SnapshotBundle; fetchedAt: number }>();
  private activeSymbol: AssetSymbol = 'BTC';
  private relayActive = false;
  private directFallbackAllowed = true;
  private socket: WebSocket | undefined;
  private simulationTimer: number | undefined;
  private presentationTimer: number | undefined;
  private watchdogTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private reconnectAttempt = 0;
  private syncGeneration = 0;
  private connectPending = false;
  private lastSocketActivity = 0;
  private socketDebug = 'idle';
  private paused = false;
  private disposed = false;
  private started = false;

  constructor() {
    const now = Date.now();
    for (const symbol of ASSET_SYMBOLS) {
      const simulated = FORCE_SIMULATION || symbol === 'TEST';
      const minuteHistory = simulated
        ? createSimulatedCandles(symbol, now, MINUTE_HISTORY_COUNT, WORLD_SEED)
        : [];
      const candles = minuteHistory.slice(-SNAPSHOT_CANDLE_COUNT);
      const price = simulated
        ? candles.at(-1)?.close ?? BASE_PRICES[symbol]
        : null;
      const dailyHistory = simulated
        ? createSimulatedHistory(
          symbol,
          now,
          DAILY_HISTORY_COUNT,
          DAY_MS,
          `${WORLD_SEED}:daily`,
          price ?? undefined,
        )
        : [];
      this.minuteHistories.set(symbol, minuteHistory);
      this.dailyHistories.set(symbol, dailyHistory);
      this.states.set(symbol, {
        symbol,
        instrument: symbol,
        provider: simulated ? 'simulation' : 'hyperliquid',
        candles,
        price,
        previousPrice: price,
        direction: 'flat',
        mode: simulated ? 'simulated' : 'connecting',
        updateKind: simulated ? 'simulation' : 'snapshot',
        updatedAt: now,
        presentationTick: 0,
        horizonChanges: simulated
          ? computeHorizonChanges(price, now, minuteHistory, dailyHistory)
          : createEmptyHorizonChanges(),
      });
      this.randoms.set(symbol, mulberry32(hashString(`${WORLD_SEED}:${symbol}:market`)));
      this.lastTradeTime.set(symbol, 0);
    }
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.startTimers();
    if (FORCE_SIMULATION) return;
    await this.resyncAndConnect(true);
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

  /** Concise connection lifecycle for `?debug=1`; never contains payloads or credentials. */
  getDebugStatus(): string {
    return `${this.socketDebug}${this.connectPending ? '/sync' : ''} · gen ${this.syncGeneration} · retry ${this.reconnectAttempt}`;
  }

  /** Switches the only full browser fallback chart; compact mids remain global. */
  async setActiveMarket(symbol: AssetSymbol): Promise<void> {
    if (this.disposed || symbol === this.activeSymbol) return;
    this.activeSymbol = symbol;
    this.pendingTrades.clear();
    this.lastPresented.delete(symbol);
    this.lastTradeTime.set(symbol, 0);
    if (FORCE_SIMULATION || !this.started || this.paused) return;
    if (symbol === 'TEST') this.relayActive = false;
    if (this.relayActive) {
      this.setAllModes('reconnecting');
      return;
    }
    this.syncGeneration += 1;
    this.clearReconnect();
    this.closeSocket(1_000, 'Tickerworld market switch');
    await this.resyncAndConnect(true);
  }

  /** Warms a destination during portal dwell without changing the visible chart. */
  async prefetchMarket(symbol: AssetSymbol): Promise<void> {
    if (FORCE_SIMULATION || symbol === 'TEST' || this.relayActive || this.disposed || symbol === this.activeSymbol) return;
    const cached = this.prefetchedSnapshots.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < 20_000) return;
    try {
      const snapshot = await this.fetchSnapshot(symbol);
      if (!this.disposed) this.prefetchedSnapshots.set(symbol, { snapshot, fetchedAt: Date.now() });
    } catch {
      // Portal travel still performs a normal snapshot retry after the veil.
    }
  }

  /** Lets the room relay own prices without maintaining a duplicate browser socket. */
  setRelayAvailable(available: boolean, directFallbackAllowed = true): void {
    if (FORCE_SIMULATION || this.disposed) return;
    this.directFallbackAllowed = directFallbackAllowed;
    // TEST is deliberately client-simulated so it remains a dependable event
    // lab even when a multiplayer room relay is available.
    if (this.activeSymbol === 'TEST') {
      this.relayActive = false;
      return;
    }
    if (available) {
      if (this.relayActive) return;
      this.relayActive = true;
      this.syncGeneration += 1;
      this.clearReconnect();
      this.pendingTrades.clear();
      this.closeSocket(1_000, 'Tickerworld room relay active');
      this.setAllModes('reconnecting');
      return;
    }
    const wasRelayed = this.relayActive;
    this.relayActive = false;
    if (!this.started || this.paused) return;
    if (!this.directFallbackAllowed) {
      this.setAllModes('reconnecting');
      return;
    }
    if (wasRelayed || (!this.socket && !this.connectPending)) void this.resyncAndConnect(false);
  }

  /** Applies one server-coalesced active chart and compact portal mids. */
  acceptRelayState(state: RelayedMarketState, mids: readonly CompactMarketMid[] = []): void {
    if (FORCE_SIMULATION || this.disposed || this.activeSymbol === 'TEST' || state.instrument !== this.activeSymbol) return;
    if (!this.relayActive) this.setRelayAvailable(true, this.directFallbackAllowed);
    this.applyCompactMids(mids, state.publishedAt);
    const previous = this.getState(state.instrument);
    const candles: Candle[] = state.candles.slice(-SNAPSHOT_CANDLE_COUNT).map((candle, index, rows) => ({
      ...candle,
      closed: index < rows.length - 1,
    }));
    const previousPrice = previous.price;
    const price = state.price;
    const direction = previousPrice === null || price === null
      ? 'flat'
      : price > previousPrice
        ? 'up'
        : price < previousPrice
          ? 'down'
          : 'flat';
    const tradePresentation = !state.stale && price !== null && previousPrice !== null;
    const next: AssetState = {
      ...previous,
      candles,
      price,
      previousPrice: previousPrice ?? price,
      direction,
      mode: state.stale ? 'reconnecting' : 'live',
      updateKind: tradePresentation ? 'trade' : 'snapshot',
      updatedAt: state.upstreamAt ?? state.publishedAt,
      ageMs: state.ageMs,
      presentationTick: tradePresentation ? previous.presentationTick + 1 : previous.presentationTick,
      horizonChanges: computeHorizonChanges(
        price,
        state.upstreamAt ?? state.publishedAt,
        candles,
        this.dailyHistories.get(state.instrument) ?? [],
      ),
    };
    this.minuteHistories.set(state.instrument, candles);
    this.states.set(state.instrument, next);
    this.emit(next);
  }

  pause(): void {
    this.paused = true;
    this.syncGeneration += 1;
    this.clearReconnect();
    this.pendingTrades.clear();
    this.closeSocket(1000, 'Tickerworld hidden');
  }

  resume(): void {
    if (this.disposed || !this.started || !this.paused) return;
    this.paused = false;
    if (!FORCE_SIMULATION && !this.relayActive && this.directFallbackAllowed) {
      void this.resyncAndConnect(false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    if (this.simulationTimer !== undefined) window.clearInterval(this.simulationTimer);
    if (this.presentationTimer !== undefined) window.clearInterval(this.presentationTimer);
    if (this.watchdogTimer !== undefined) window.clearInterval(this.watchdogTimer);
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer);
    this.simulationTimer = undefined;
    this.presentationTimer = undefined;
    this.watchdogTimer = undefined;
    this.heartbeatTimer = undefined;
    this.listeners.clear();
  }

  private startTimers(): void {
    // TEST runs in every build; the explicit QA flag additionally simulates
    // every market. Keeping one timer avoids multiplying work by route changes.
    this.simulationTimer = window.setInterval(() => this.stepSimulations(), PRESENTATION_INTERVAL_MS);
    if (FORCE_SIMULATION) return;
    this.presentationTimer = window.setInterval(() => this.flushTrades(), PRESENTATION_POLL_MS);
    this.watchdogTimer = window.setInterval(() => this.watchdog(), 4_000);
    this.heartbeatTimer = window.setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private stepSimulations(): void {
    if (this.paused || this.disposed) return;
    const symbols: readonly AssetSymbol[] = FORCE_SIMULATION ? ASSET_SYMBOLS : ['TEST'];
    for (const symbol of symbols) {
      const random = this.randoms.get(symbol);
      if (!random) continue;
      const now = Date.now();
      const previous = this.getState(symbol);
      const minuteHistory = this.minuteHistories.get(symbol) ?? [...previous.candles];
      const historyState = symbol === 'TEST'
        ? stepTestSimulation(
          { ...previous, candles: minuteHistory },
          now,
          MINUTE_HISTORY_COUNT,
        )
        : stepSimulation(
          { ...previous, candles: minuteHistory },
          random,
          now,
          MINUTE_HISTORY_COUNT,
        );
      this.minuteHistories.set(symbol, [...historyState.candles]);
      const next: AssetState = {
        ...historyState,
        candles: historyState.candles.slice(-SNAPSHOT_CANDLE_COUNT),
        horizonChanges: computeHorizonChanges(
          historyState.price,
          now,
          historyState.candles,
          this.dailyHistories.get(symbol) ?? [],
        ),
      };
      this.states.set(symbol, next);
      this.emit(next);
    }
  }

  private async resyncAndConnect(initial: boolean): Promise<void> {
    if (this.paused || this.disposed || FORCE_SIMULATION || this.relayActive || !this.directFallbackAllowed) return;
    const generation = ++this.syncGeneration;
    this.connectPending = true;
    this.clearReconnect();
    this.pendingTrades.clear();
    if (this.activeSymbol === 'TEST') {
      this.connectPending = false;
      this.connect(generation);
      return;
    }
    this.setAllModes(initial ? 'connecting' : 'reconnecting');

    try {
      const symbol = this.activeSymbol;
      const cached = this.prefetchedSnapshots.get(symbol);
      const snapshot = cached && Date.now() - cached.fetchedAt < 20_000
        ? cached.snapshot
        : await this.fetchSnapshot(symbol);
      this.prefetchedSnapshots.delete(symbol);
      if (generation !== this.syncGeneration || this.paused || this.disposed) return;

      const now = Date.now();
      const previous = this.getState(symbol);
      const price = snapshot.chartCandles.at(-1)?.close ?? null;
      this.minuteHistories.set(symbol, snapshot.minuteHistory);
      this.dailyHistories.set(symbol, snapshot.dailyHistory);
      const state: AssetState = {
        ...previous,
        instrument: symbol,
        provider: 'hyperliquid',
        candles: snapshot.chartCandles,
        price,
        previousPrice: price,
        direction: 'flat',
        mode: initial ? 'connecting' : 'reconnecting',
        updateKind: 'snapshot',
        updatedAt: now,
        horizonChanges: computeHorizonChanges(
          price,
          now,
          snapshot.minuteHistory,
          snapshot.dailyHistory,
        ),
      };
      this.states.set(symbol, state);
      this.lastTradeTime.set(symbol, 0);
      this.emit(state);
      this.connect(generation);
    } catch {
      if (generation !== this.syncGeneration || this.paused || this.disposed) return;
      this.setAllModes('reconnecting');
      this.scheduleReconnect();
    } finally {
      if (generation === this.syncGeneration) this.connectPending = false;
    }
  }

  private async fetchSnapshot(symbol: AssetSymbol): Promise<SnapshotBundle> {
    const coin = hyperliquidCoinForSymbol(symbol);
    if (!coin) throw new Error(`${symbol} is a simulated Tickerworld market`);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
    const now = Date.now();
    try {
      const fetchInterval = async (
        interval: HyperliquidCandleInterval,
        startTime: number,
        maxCount: number,
      ): Promise<Candle[]> => {
        const response = await fetch(REST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'candleSnapshot',
            req: {
              coin,
              interval,
              startTime,
              endTime: now,
            },
          }),
          signal: controller.signal,
          mode: 'cors',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Hyperliquid history returned ${response.status}`);
        return parseHyperliquidCandleHistory(await response.json(), now, maxCount);
      };

      const [minuteHistory, dailyHistory] = await Promise.all([
        fetchInterval('1m', now - MINUTE_SNAPSHOT_LOOKBACK_MS, MINUTE_HISTORY_COUNT),
        fetchInterval('1d', now - DAILY_SNAPSHOT_LOOKBACK_MS, DAILY_HISTORY_COUNT)
          .catch(() => this.dailyHistories.get(symbol) ?? []),
      ]);
      if (minuteHistory.length < SNAPSHOT_CANDLE_COUNT) {
        throw new Error(`Hyperliquid history returned ${minuteHistory.length} minute candles`);
      }
      return {
        chartCandles: minuteHistory.slice(-SNAPSHOT_CANDLE_COUNT),
        minuteHistory,
        dailyHistory,
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private connect(generation: number): void {
    if (
      generation !== this.syncGeneration
      || this.paused
      || this.disposed
      || FORCE_SIMULATION
      || this.relayActive
      || !this.directFallbackAllowed
      || this.socket
    ) return;

    try {
      this.socketDebug = 'opening';
      const socket = new WebSocket(SOCKET_URL);
      this.socket = socket;
      this.lastSocketActivity = Date.now();
      socket.addEventListener('open', () => {
        if (this.socket !== socket || generation !== this.syncGeneration) return;
        this.lastSocketActivity = Date.now();
        this.socketDebug = 'open';
        for (const subscription of buildHyperliquidSubscriptions(this.activeSymbol)) {
          socket.send(JSON.stringify({ method: 'subscribe', subscription }));
        }
        this.reconnectAttempt = 0;
        if (this.activeSymbol !== 'TEST') this.setAllModes('live');
      });
      socket.addEventListener('message', (event) => {
        if (this.socket === socket) this.handleMessage(String(event.data));
      });
      socket.addEventListener('close', (event) => {
        this.socketDebug = `closed ${event.code}${event.reason ? ` ${event.reason.slice(0, 32)}` : ''}`;
        this.handleDisconnect(socket);
      });
      socket.addEventListener('error', () => {
        this.socketDebug = 'error';
        socket.close();
      });
    } catch {
      this.socketDebug = 'construct failed';
      this.closeSocket();
      this.handleDisconnect(undefined);
    }
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    this.lastSocketActivity = Date.now();

    const channel = message.channel;
    if (channel === 'allMids') {
      this.handleMids(message.data);
      return;
    }
    if (channel === 'trades') {
      for (const trade of parseHyperliquidTrades(message.data)) this.queueTrade(trade);
      return;
    }
    if (channel === 'candle') this.handleCandlePayload(message.data);
  }

  private queueTrade(trade: ParsedTrade): void {
    if (trade.symbol !== this.activeSymbol) return;
    const lastTradeTime = this.lastTradeTime.get(trade.symbol) ?? 0;
    const pending = this.pendingTrades.get(trade.symbol);
    if (trade.time < lastTradeTime || (pending && trade.time < pending.time)) return;
    this.pendingTrades.set(trade.symbol, { price: trade.price, time: trade.time });
  }

  private flushTrades(): void {
    if (this.paused || this.disposed || !this.socket) return;
    const now = Date.now();
    const symbol = this.activeSymbol;
    const pending = this.pendingTrades.get(symbol);
    if (!pending || now - (this.lastPresented.get(symbol) ?? 0) < PRESENTATION_INTERVAL_MS) return;
    this.pendingTrades.delete(symbol);
    this.presentTrade(symbol, pending, now);
  }

  private handleMids(payload: unknown): void {
    const now = Date.now();
    const mids = Object.entries(parseHyperliquidMids(payload)).flatMap(([key, price]) => (
      price === undefined ? [] : [{ instrument: key as AssetSymbol, price, upstreamAt: now }]
    ));
    this.applyCompactMids(mids, now);
  }

  private applyCompactMids(mids: readonly CompactMarketMid[], publishedAt: number): void {
    for (const mid of mids) {
      const symbol = mid.instrument;
      const price = mid.price;
      if (symbol === this.activeSymbol || price === undefined) continue;
      const previous = this.getState(symbol);
      const direction = previous.price === null
        ? 'flat'
        : price > previous.price
          ? 'up'
          : price < previous.price
            ? 'down'
            : 'flat';
      const state: AssetState = {
        ...previous,
        price,
        previousPrice: previous.price ?? price,
        direction,
        mode: 'live',
        updateKind: 'snapshot',
        updatedAt: mid.upstreamAt || publishedAt,
        ageMs: Math.max(0, publishedAt - mid.upstreamAt),
      };
      this.states.set(symbol, state);
      this.emit(state);
    }
  }

  private presentTrade(symbol: AssetSymbol, trade: PendingTrade, presentedAt: number): void {
    const previous = this.getState(symbol);
    const candleUpdate = applyTradeToCandles(
      this.minuteHistories.get(symbol) ?? previous.candles,
      trade.price,
      trade.time,
      MINUTE_HISTORY_COUNT,
    );
    if (!candleUpdate.accepted) return;
    this.minuteHistories.set(symbol, candleUpdate.candles);
    const oldPrice = previous.price;
    const direction = oldPrice === null
      ? 'flat'
      : trade.price > oldPrice
        ? 'up'
        : trade.price < oldPrice
          ? 'down'
          : 'flat';
    const state: AssetState = {
      ...previous,
      candles: candleUpdate.candles.slice(-SNAPSHOT_CANDLE_COUNT),
      previousPrice: oldPrice ?? trade.price,
      price: trade.price,
      direction,
      mode: 'live',
      updateKind: 'trade',
      updatedAt: trade.time,
      presentationTick: previous.presentationTick + 1,
      horizonChanges: computeHorizonChanges(
        trade.price,
        trade.time,
        candleUpdate.candles,
        this.dailyHistories.get(symbol) ?? [],
      ),
    };
    this.states.set(symbol, state);
    this.lastTradeTime.set(symbol, trade.time);
    this.lastPresented.set(symbol, presentedAt);
    this.emit(state);
  }

  private handleCandlePayload(payload: unknown): void {
    for (const item of candleItems(payload)) {
      const symbol = Array.isArray(item)
        ? toAssetSymbol(item[2])
        : isRecord(item)
          ? toAssetSymbol(item.s ?? item.coin ?? item.symbol)
          : undefined;
      if (!symbol) continue;
      if (symbol !== this.activeSymbol) continue;
      const incoming = parseHyperliquidCandles(item).at(-1);
      if (!incoming) continue;

      const previous = this.getState(symbol);
      const priorHistory = this.minuteHistories.get(symbol) ?? [...previous.candles];
      const previousOpen = priorHistory.at(-1)?.openTime;
      const minuteHistory = reconcileCandle(priorHistory, incoming, MINUTE_HISTORY_COUNT);
      this.minuteHistories.set(symbol, minuteHistory);
      const candles = minuteHistory.slice(-SNAPSHOT_CANDLE_COUNT);
      const latest = minuteHistory.at(-1);
      const rolled = previousOpen !== undefined && latest !== undefined && latest.openTime > previousOpen;
      const updatesLatest = latest?.openTime === incoming.openTime;
      const nextPrice = updatesLatest ? incoming.close : previous.price;
      const oldPrice = previous.price;
      const direction = !rolled || oldPrice === null || nextPrice === null
        ? previous.direction
        : nextPrice > oldPrice
          ? 'up'
          : nextPrice < oldPrice
            ? 'down'
            : 'flat';
      const state: AssetState = {
        ...previous,
        candles,
        previousPrice: rolled ? oldPrice ?? nextPrice : previous.previousPrice,
        price: nextPrice,
        direction,
        mode: 'live',
        updateKind: 'candle',
        updatedAt: Date.now(),
        presentationTick: rolled ? previous.presentationTick + 1 : previous.presentationTick,
        horizonChanges: computeHorizonChanges(
          nextPrice,
          Date.now(),
          minuteHistory,
          this.dailyHistories.get(symbol) ?? [],
        ),
      };
      this.states.set(symbol, state);
      this.emit(state);
    }
  }

  private watchdog(): void {
    if (this.paused || this.disposed || FORCE_SIMULATION || this.relayActive || !this.socket) return;
    if (isSocketActivityStale([this.lastSocketActivity], Date.now())) this.socket.close();
  }

  private sendHeartbeat(): void {
    const socket = this.socket;
    if (this.paused || this.disposed || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ method: 'ping' }));
    } catch {
      socket.close();
    }
  }

  private handleDisconnect(socket: WebSocket | undefined): void {
    if (socket && this.socket !== socket) return;
    this.socket = undefined;
    this.pendingTrades.clear();
    if (this.paused || this.disposed || FORCE_SIMULATION || this.relayActive || !this.directFallbackAllowed) return;
    this.setAllModes('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.paused || this.disposed || this.relayActive || !this.directFallbackAllowed) return;
    const delay = computeReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.resyncAndConnect(false);
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeSocket(code?: number, reason?: string): void {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // A partially constructed socket is safe to abandon.
    }
  }

  private setAllModes(mode: FeedMode): void {
    const symbol = this.activeSymbol;
    const previous = this.getState(symbol);
    if (symbol === 'TEST') return;
    if (previous.mode === mode) return;
    const state: AssetState = { ...previous, mode, updateKind: 'snapshot' };
    this.states.set(symbol, state);
    this.emit(state);
  }

  private emit(state: AssetState): void {
    this.listeners.forEach((listener) => listener(state));
  }
}
