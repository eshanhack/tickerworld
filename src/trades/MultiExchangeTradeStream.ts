import type { AssetSymbol } from '../types';
import { MARKET_TRADE_CONFIG, TRADE_AGGREGATION_CONFIG, exchangesForMarket } from './config';
import {
  COINBASE_SOCKET_URL,
  HYPERLIQUID_SOCKET_URL,
  OKX_SOCKET_URL,
  binanceStreamUrl,
  coinbaseSubscriptions,
  hyperliquidSubscriptions,
  okxSubscriptions,
  parseBinanceTrades,
  parseCoinbaseTrades,
  parseHyperliquidTapeTrades,
  parseGeckoTerminalTapeTrades,
  parseOkxTrades,
} from './adapters';
import type {
  LiveTradeExchange,
  NormalizedTrade,
  TradeTapeHealth,
} from './types';

export interface TradeSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: (event: Event) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'close', listener: (event: Event) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
}

export type TradeSocketFactory = (url: string) => TradeSocketLike;

export interface MultiExchangeTradeStreamOptions {
  readonly socketFactory?: TradeSocketFactory;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
}

interface Session {
  readonly exchange: LiveTradeExchange;
  readonly generation: number;
  socket: TradeSocketLike | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectAttempt: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  pollController: AbortController | null;
  initialized: boolean;
  readonly seenIds: Set<string>;
  createdAt: number;
  openedAt: number | null;
  lastMessageAt: number | null;
  health: TradeTapeHealth['mode'];
  reason?: string;
}

export function computeTradeReconnectDelay(attempt: number, random = Math.random): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const maximum = Math.min(
    TRADE_AGGREGATION_CONFIG.reconnectMaximumMs,
    TRADE_AGGREGATION_CONFIG.reconnectMinimumMs * 2 ** Math.min(8, safeAttempt),
  );
  const unit = Math.min(1, Math.max(0, random()));
  return Math.max(TRADE_AGGREGATION_CONFIG.reconnectMinimumMs, Math.round(maximum * (0.7 + unit * 0.3)));
}

function endpoint(exchange: LiveTradeExchange, pair: string): string {
  switch (exchange) {
    case 'binance': return binanceStreamUrl(pair);
    case 'coinbase': return COINBASE_SOCKET_URL;
    case 'okx': return OKX_SOCKET_URL;
    case 'hyperliquid': return HYPERLIQUID_SOCKET_URL;
    case 'geckoterminal': return '';
  }
}

function subscriptions(exchange: LiveTradeExchange, pair: string): readonly unknown[] {
  switch (exchange) {
    case 'binance': return [];
    case 'coinbase': return coinbaseSubscriptions(pair);
    case 'okx': return okxSubscriptions(pair);
    case 'hyperliquid': return hyperliquidSubscriptions(pair);
    case 'geckoterminal': return [];
  }
}

function parseTrades(
  exchange: LiveTradeExchange,
  payload: unknown,
  symbol: AssetSymbol,
  pair: string,
  receivedAt: number,
): NormalizedTrade[] {
  switch (exchange) {
    case 'binance': return parseBinanceTrades(payload, symbol, pair, receivedAt);
    case 'coinbase': return parseCoinbaseTrades(payload, symbol, pair, receivedAt);
    case 'okx': return parseOkxTrades(payload, symbol, pair, receivedAt);
    case 'hyperliquid': return parseHyperliquidTapeTrades(payload, symbol, pair, receivedAt);
    case 'geckoterminal': return parseGeckoTerminalTapeTrades(payload, symbol, receivedAt);
  }
}

function heartbeatPayload(exchange: LiveTradeExchange): string | null {
  if (exchange === 'hyperliquid') return JSON.stringify({ method: 'ping' });
  if (exchange === 'okx') return 'ping';
  return null;
}

export class MultiExchangeTradeStream {
  private readonly socketFactory: TradeSocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly fetcher: typeof fetch;
  private readonly tradeListeners = new Set<(trades: readonly NormalizedTrade[]) => void>();
  private readonly healthListeners = new Set<(health: readonly TradeTapeHealth[]) => void>();
  private readonly sessions = new Map<LiveTradeExchange, Session>();
  private symbol: AssetSymbol = 'BTC';
  private generation = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private paused = false;
  private disposed = false;

  constructor(options: MultiExchangeTradeStreamOptions = {}) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.paused = false;
    this.watchdogTimer = setInterval(() => this.watchdog(), 2_000);
    this.openAll();
  }

  setActiveMarket(symbol: AssetSymbol): void {
    if (this.disposed || symbol === this.symbol) return;
    this.symbol = symbol;
    this.generation += 1;
    this.closeAll(1_000, 'market switch');
    this.sessions.clear();
    this.emitHealth();
    if (this.started && !this.paused) this.openAll();
  }

  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    this.generation += 1;
    this.closeAll(1_000, 'hidden');
    this.sessions.clear();
    this.emitHealth();
  }

  resume(): void {
    if (!this.paused || this.disposed || !this.started) return;
    this.paused = false;
    this.generation += 1;
    this.openAll();
  }

  subscribe(listener: (trades: readonly NormalizedTrade[]) => void): () => void {
    this.tradeListeners.add(listener);
    return () => this.tradeListeners.delete(listener);
  }

  subscribeHealth(listener: (health: readonly TradeTapeHealth[]) => void): () => void {
    this.healthListeners.add(listener);
    listener(this.getHealth());
    return () => this.healthListeners.delete(listener);
  }

  getHealth(): readonly TradeTapeHealth[] {
    return exchangesForMarket(this.symbol).map((exchange) => {
      const session = this.sessions.get(exchange);
      return {
        exchange,
        mode: session?.health ?? (this.started && !this.paused ? 'connecting' : 'unavailable'),
        lastMessageAt: session?.lastMessageAt ?? null,
        reconnectAttempt: session?.reconnectAttempt ?? 0,
        ...(session?.reason ? { reason: session.reason } : {}),
      };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.closeAll(1_000, 'disposed');
    this.sessions.clear();
    this.tradeListeners.clear();
    this.healthListeners.clear();
  }

  private openAll(): void {
    if (this.paused || this.disposed) return;
    const generation = this.generation;
    for (const exchange of exchangesForMarket(this.symbol)) {
      const session: Session = {
        exchange,
        generation,
        socket: null,
        reconnectTimer: null,
        heartbeatTimer: null,
        pollTimer: null,
        pollController: null,
        initialized: false,
        seenIds: new Set<string>(),
        reconnectAttempt: 0,
        createdAt: this.now(),
        openedAt: null,
        lastMessageAt: null,
        health: 'connecting',
      };
      this.sessions.set(exchange, session);
      if (exchange === 'geckoterminal') this.openDexSession(session);
      else this.openSession(session);
    }
    this.emitHealth();
  }

  private openSession(session: Session): void {
    if (session.exchange === 'geckoterminal' || !this.isCurrent(session) || session.socket || session.reconnectTimer) return;
    const pair = MARKET_TRADE_CONFIG[this.symbol].pairs[session.exchange];
    if (!pair) return;
    // Session objects survive reconnects, but these timestamps describe one
    // concrete socket attempt. Reset them before construction so a fresh
    // CONNECTING socket cannot inherit the age of the socket it replaced.
    session.createdAt = this.now();
    session.openedAt = null;
    let socket: TradeSocketLike;
    try {
      socket = this.socketFactory(endpoint(session.exchange, pair));
    } catch {
      session.reason = 'socket construction failed';
      this.scheduleReconnect(session);
      return;
    }
    session.socket = socket;
    session.health = session.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
    session.reason = undefined;
    socket.addEventListener('open', () => {
      if (!this.isCurrent(session) || session.socket !== socket) return;
      // A successful TCP/WebSocket open is not yet proof that the venue's
      // market subscription is healthy. Promote to live only after one valid
      // normalized trade; acknowledgements and heartbeats are health activity.
      session.health = 'connecting';
      session.openedAt = this.now();
      for (const message of subscriptions(session.exchange, pair)) {
        socket.send(JSON.stringify(message));
      }
      const payload = heartbeatPayload(session.exchange);
      if (payload) {
        session.heartbeatTimer = setInterval(() => {
          if (this.isCurrent(session) && session.socket === socket && socket.readyState === 1) {
            try {
              socket.send(payload);
            } catch {
              socket.close();
            }
          }
        }, TRADE_AGGREGATION_CONFIG.heartbeatIntervalMs);
      }
      this.emitHealth();
    });
    socket.addEventListener('message', (event) => {
      if (!this.isCurrent(session) || session.socket !== socket) return;
      const receivedAt = this.now();
      const trades = parseTrades(session.exchange, event.data, this.symbol, pair, receivedAt)
        .slice(0, TRADE_AGGREGATION_CONFIG.maxInputBatch);
      if (trades.length > 0) {
        const becameLive = session.health !== 'live';
        session.health = 'live';
        session.reconnectAttempt = 0;
        session.lastMessageAt = receivedAt;
        if (becameLive) this.emitHealth();
        // Health promotion comes first so a fallback owner can reset its
        // synthetic generation before accepting this first genuine batch.
        for (const listener of this.tradeListeners) listener(trades);
      }
    });
    socket.addEventListener('error', () => {
      if (session.socket === socket) socket.close();
    });
    socket.addEventListener('close', (event) => {
      if (session.socket !== socket) return;
      session.socket = null;
      session.openedAt = null;
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
      session.health = 'reconnecting';
      const reason = (event as Event & { reason?: unknown }).reason;
      session.reason = typeof reason === 'string' && reason ? reason.slice(0, 80) : 'disconnected';
      this.scheduleReconnect(session);
    });
    this.emitHealth();
  }

  private openDexSession(session: Session): void {
    if (session.exchange !== 'geckoterminal' || !this.isCurrent(session) || session.pollTimer) return;
    const pair = MARKET_TRADE_CONFIG[this.symbol].pairs.geckoterminal;
    if (!pair) return;
    const poll = async (): Promise<void> => {
      if (!this.isCurrent(session) || session.pollController) return;
      const controller = new AbortController();
      session.pollController = controller;
      const timeout = setTimeout(() => controller.abort(), TRADE_AGGREGATION_CONFIG.socketOpenTimeoutMs);
      try {
        const response = await this.fetcher(`/api/dex-market?trades=${encodeURIComponent(pair)}`, {
          headers: { Accept: 'application/json' },
          cache: 'default',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`http ${response.status}`);
        const receivedAt = this.now();
        const trades = parseGeckoTerminalTapeTrades(await response.json(), this.symbol, receivedAt);
        if (!this.isCurrent(session)) return;
        const becameLive = session.health !== 'live';
        session.health = 'live';
        session.reason = undefined;
        session.reconnectAttempt = 0;
        session.lastMessageAt = receivedAt;
        const fresh = trades.filter((trade) => !session.seenIds.has(trade.id));
        for (const trade of trades) session.seenIds.add(trade.id);
        while (session.seenIds.size > 900) session.seenIds.delete(session.seenIds.values().next().value!);
        if (!session.initialized) {
          session.initialized = true;
        } else if (fresh.length > 0) {
          for (const listener of this.tradeListeners) {
            listener(fresh.slice(-TRADE_AGGREGATION_CONFIG.maxInputBatch));
          }
        }
        if (becameLive) this.emitHealth();
      } catch (error) {
        if (!this.isCurrent(session)) return;
        session.health = 'reconnecting';
        session.reconnectAttempt += 1;
        session.reason = error instanceof Error ? error.message.slice(0, 80) : 'poll failed';
        this.emitHealth();
      } finally {
        clearTimeout(timeout);
        if (session.pollController === controller) session.pollController = null;
      }
    };
    session.health = 'connecting';
    void poll();
    session.pollTimer = setInterval(() => { void poll(); }, 2_500);
    this.emitHealth();
  }

  private scheduleReconnect(session: Session): void {
    if (!this.isCurrent(session) || session.reconnectTimer) return;
    session.health = 'reconnecting';
    const delay = computeTradeReconnectDelay(session.reconnectAttempt, this.random);
    session.reconnectAttempt += 1;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      this.openSession(session);
    }, delay);
    this.emitHealth();
  }

  private watchdog(): void {
    if (this.paused || this.disposed) return;
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (!session.socket) continue;
      const openTimedOut = session.socket.readyState === 0
        && now - session.createdAt > TRADE_AGGREGATION_CONFIG.socketOpenTimeoutMs;
      const subscriptionTimedOut = session.openedAt !== null
        && session.health !== 'live'
        && now - session.openedAt > TRADE_AGGREGATION_CONFIG.subscriptionTimeoutMs;
      const streamStale = session.health === 'live'
        && session.lastMessageAt !== null
        && now - session.lastMessageAt > TRADE_AGGREGATION_CONFIG.socketStaleMs;
      if (openTimedOut || subscriptionTimedOut || streamStale) {
        session.reason = 'stale';
        session.socket.close(4_000, 'stale');
      }
    }
  }

  private closeAll(code: number, reason: string): void {
    for (const session of this.sessions.values()) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
      session.reconnectTimer = null;
      session.heartbeatTimer = null;
      if (session.pollTimer) clearInterval(session.pollTimer);
      session.pollController?.abort();
      session.pollTimer = null;
      session.pollController = null;
      const socket = session.socket;
      session.socket = null;
      if (socket) {
        try {
          socket.close(code, reason);
        } catch {
          // A partially constructed socket can be abandoned.
        }
      }
    }
  }

  private isCurrent(session: Session): boolean {
    return !this.disposed && !this.paused && session.generation === this.generation
      && this.sessions.get(session.exchange) === session;
  }

  private emitHealth(): void {
    const health = this.getHealth();
    for (const listener of this.healthListeners) listener(health);
  }
}
