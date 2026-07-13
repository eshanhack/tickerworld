import type { AssetSymbol } from '../types';

export const TRADE_EXCHANGES = ['hyperliquid', 'binance', 'coinbase', 'okx', 'geckoterminal', 'simulation'] as const;
export type TradeExchange = (typeof TRADE_EXCHANGES)[number];
export type LiveTradeExchange = Exclude<TradeExchange, 'simulation'>;
export type TradeSide = 'buy' | 'sell';
export type TradeKind = 'trade' | 'liquidation';
export type TradeTier = 'dust' | 'minor' | 'notable' | 'big' | 'whale';
export type RollingTradeWindow = '1s' | '10s' | '1m';
export type TradeTapeMode = 'connecting' | 'live' | 'reconnecting' | 'simulated' | 'unavailable';

/** A venue-specific print normalized into a stable, dollar-denominated shape. */
export interface NormalizedTrade {
  readonly id: string;
  readonly exchange: TradeExchange;
  readonly symbol: AssetSymbol;
  readonly side: TradeSide;
  readonly kind: TradeKind;
  readonly price: number;
  readonly baseSize: number;
  /** Price multiplied by base size. USD, USDT, and USDC are intentionally treated at parity. */
  readonly notionalUsd: number;
  readonly timestampMs: number;
  readonly receivedAt: number;
  readonly simulated: boolean;
}

export interface AggregatedOrder {
  readonly id: string;
  readonly symbol: AssetSymbol;
  readonly side: TradeSide;
  readonly tier: TradeTier;
  readonly kind: TradeKind;
  readonly notionalUsd: number;
  readonly vwap: number;
  readonly baseSize: number;
  readonly tradeCount: number;
  readonly sources: readonly TradeExchange[];
  readonly sourceCount: number;
  readonly simulated: boolean;
  readonly startedAt: number;
  readonly endedAt: number;
  /** Alias used by visual consumers that only need the event time. */
  readonly timestampMs: number;
}

export interface RollingSideStats {
  readonly notionalUsd: number;
  readonly tradeCount: number;
  readonly liquidationNotionalUsd: number;
  readonly liquidationCount: number;
}

export interface RollingWindowStats {
  readonly buy: RollingSideStats;
  readonly sell: RollingSideStats;
  /** Signed -1..1 ratio where positive values mean buy-side flow dominates. */
  readonly imbalance: number;
}

export interface RollingTradeStats {
  readonly symbol: AssetSymbol;
  readonly asOf: number;
  readonly windows: Readonly<Record<RollingTradeWindow, RollingWindowStats>>;
}

export interface TradeTapeBatch {
  readonly generation: number;
  readonly sequence: number;
  readonly symbol: AssetSymbol;
  readonly orders: readonly AggregatedOrder[];
  readonly stats: RollingTradeStats;
  readonly publishedAt: number;
  readonly droppedTrades: number;
}

export interface TradeTapeHealth {
  readonly exchange: LiveTradeExchange;
  readonly mode: Exclude<TradeTapeMode, 'simulated'>;
  readonly lastMessageAt: number | null;
  readonly reconnectAttempt: number;
  readonly reason?: string;
}

export interface TradeTapeSnapshot {
  readonly symbol: AssetSymbol;
  readonly mode: TradeTapeMode;
  readonly stats: RollingTradeStats;
  readonly health: readonly TradeTapeHealth[];
  readonly updatedAt: number;
}

export interface TradeTapeFeedLifecycle {
  start(): void;
  setActiveMarket(symbol: AssetSymbol): void;
  pause(): void;
  resume(): void;
  subscribe(listener: (batch: TradeTapeBatch) => void): () => void;
  subscribeState(listener: (state: TradeTapeSnapshot) => void): () => void;
  getState(): TradeTapeSnapshot;
  dispose(): void;
}

export interface TradeWorkerConfigureMessage {
  readonly type: 'configure';
  readonly generation: number;
  readonly symbol: AssetSymbol;
}

export interface TradeWorkerTradesMessage {
  readonly type: 'trades';
  readonly generation: number;
  readonly trades: readonly NormalizedTrade[];
}

export interface TradeWorkerFlushMessage {
  readonly type: 'flush';
  readonly generation: number;
  readonly now: number;
  readonly force?: boolean;
}

export interface TradeWorkerDisposeMessage {
  readonly type: 'dispose';
}

export type TradeWorkerCommand =
  | TradeWorkerConfigureMessage
  | TradeWorkerTradesMessage
  | TradeWorkerFlushMessage
  | TradeWorkerDisposeMessage;

export interface TradeWorkerReadyMessage {
  readonly type: 'ready';
}

export interface TradeWorkerBatchMessage {
  readonly type: 'batch';
  readonly batch: TradeTapeBatch;
}

export type TradeWorkerEvent = TradeWorkerReadyMessage | TradeWorkerBatchMessage;
