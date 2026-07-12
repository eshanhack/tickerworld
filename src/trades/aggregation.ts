import type { AssetSymbol } from '../types';
import { MARKET_TRADE_CONFIG, TRADE_AGGREGATION_CONFIG, classifyTradeTier } from './config';
import type {
  AggregatedOrder,
  NormalizedTrade,
  RollingSideStats,
  RollingTradeStats,
  RollingTradeWindow,
  RollingWindowStats,
  TradeExchange,
  TradeKind,
  TradeSide,
  TradeTapeBatch,
} from './types';

interface MutableAggregate {
  idSeed: string;
  symbol: AssetSymbol;
  side: TradeSide;
  kind: TradeKind;
  notionalUsd: number;
  priceSize: number;
  baseSize: number;
  tradeCount: number;
  sources: Set<TradeExchange>;
  simulated: boolean;
  startedAt: number;
  endedAt: number;
  bucketEndsAt: number;
}

interface RollingEvent {
  readonly timestampMs: number;
  readonly side: TradeSide;
  readonly kind: TradeKind;
  readonly notionalUsd: number;
}

function emptySideStats(): RollingSideStats {
  return { notionalUsd: 0, tradeCount: 0, liquidationNotionalUsd: 0, liquidationCount: 0 };
}

function emptyWindowStats(): RollingWindowStats {
  return { buy: emptySideStats(), sell: emptySideStats(), imbalance: 0 };
}

export function emptyRollingTradeStats(symbol: AssetSymbol, asOf = 0): RollingTradeStats {
  return {
    symbol,
    asOf,
    windows: { '1s': emptyWindowStats(), '10s': emptyWindowStats(), '1m': emptyWindowStats() },
  };
}

function safeAggregateTime(trade: NormalizedTrade): number {
  // Venue clocks occasionally skew. Keep cross-venue clustering close to the
  // local receive time without discarding the exchange's finer ordering.
  return Math.min(trade.receivedAt + 1_000, Math.max(trade.receivedAt - 2_000, trade.timestampMs));
}

function aggregateKey(trade: NormalizedTrade, windowMs: number): string {
  const bucket = Math.floor(safeAggregateTime(trade) / windowMs) * windowMs;
  return `${trade.symbol}|${trade.side}|${trade.kind}|${bucket}`;
}

function isValidTrade(trade: NormalizedTrade): boolean {
  return Boolean(trade.id)
    && Number.isFinite(trade.price) && trade.price > 0
    && Number.isFinite(trade.baseSize) && trade.baseSize > 0
    && Number.isFinite(trade.notionalUsd) && trade.notionalUsd > 0 && trade.notionalUsd <= 1e15
    && Number.isFinite(trade.timestampMs) && trade.timestampMs >= 0
    && Number.isFinite(trade.receivedAt) && trade.receivedAt >= 0;
}

function finalizeAggregate(aggregate: MutableAggregate): AggregatedOrder {
  const sources = [...aggregate.sources].sort();
  const endedAt = Math.max(aggregate.startedAt, aggregate.endedAt);
  return {
    id: `${aggregate.symbol}:${aggregate.side}:${aggregate.kind}:${aggregate.bucketEndsAt}:${aggregate.idSeed}`,
    symbol: aggregate.symbol,
    side: aggregate.side,
    tier: classifyTradeTier(aggregate.symbol, aggregate.notionalUsd),
    kind: aggregate.kind,
    notionalUsd: aggregate.notionalUsd,
    vwap: aggregate.baseSize > 0 ? aggregate.priceSize / aggregate.baseSize : 0,
    baseSize: aggregate.baseSize,
    tradeCount: aggregate.tradeCount,
    sources,
    sourceCount: sources.length,
    simulated: aggregate.simulated,
    startedAt: aggregate.startedAt,
    endedAt,
    timestampMs: endedAt,
  };
}

function coalesceOrders(orders: readonly AggregatedOrder[], sequence: number): AggregatedOrder[] {
  if (orders.length === 0) return [];
  const groups = new Map<string, AggregatedOrder[]>();
  for (const order of orders) {
    const key = `${order.symbol}|${order.side}|${order.kind}`;
    const group = groups.get(key) ?? [];
    group.push(order);
    groups.set(key, group);
  }
  const result: AggregatedOrder[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    let notionalUsd = 0;
    let baseSize = 0;
    let priceSize = 0;
    let tradeCount = 0;
    let startedAt = Number.POSITIVE_INFINITY;
    let endedAt = 0;
    let simulated = true;
    const sources = new Set<TradeExchange>();
    for (const order of group) {
      notionalUsd += order.notionalUsd;
      baseSize += order.baseSize;
      priceSize += order.vwap * order.baseSize;
      tradeCount += order.tradeCount;
      startedAt = Math.min(startedAt, order.startedAt);
      endedAt = Math.max(endedAt, order.endedAt);
      simulated = simulated && order.simulated;
      order.sources.forEach((source) => sources.add(source));
    }
    const sourceList = [...sources].sort();
    result.push({
      id: `${first.symbol}:${first.side}:${first.kind}:overflow:${sequence}`,
      symbol: first.symbol,
      side: first.side,
      tier: classifyTradeTier(first.symbol, notionalUsd),
      kind: first.kind,
      notionalUsd,
      vwap: baseSize > 0 ? priceSize / baseSize : 0,
      baseSize,
      tradeCount,
      sources: sourceList,
      sourceCount: sourceList.length,
      simulated,
      startedAt: Number.isFinite(startedAt) ? startedAt : endedAt,
      endedAt,
      timestampMs: endedAt,
    });
  }
  return result;
}

function boundOrders(orders: readonly AggregatedOrder[], maximum: number, sequence: number): AggregatedOrder[] {
  if (orders.length <= maximum) return [...orders].sort((a, b) => a.endedAt - b.endedAt);
  const reserve = Math.min(4, Math.max(1, maximum - 1));
  const byValue = [...orders].sort((a, b) => b.notionalUsd - a.notionalUsd);
  const kept = byValue.slice(0, maximum - reserve);
  const overflow = coalesceOrders(byValue.slice(maximum - reserve), sequence)
    .sort((a, b) => b.notionalUsd - a.notionalUsd)
    .slice(0, reserve);
  return [...kept, ...overflow].sort((a, b) => a.endedAt - b.endedAt);
}

export class TradeAggregator {
  private readonly aggregates = new Map<string, MutableAggregate>();
  private readonly dedupe = new Map<string, number>();
  private rolling: RollingEvent[] = [];
  private rollingHead = 0;
  private symbol: AssetSymbol;
  private generation = 0;
  private sequence = 0;
  private droppedSinceFlush = 0;
  private acceptedSinceFlush = 0;

  constructor(symbol: AssetSymbol = 'BTC') {
    this.symbol = symbol;
  }

  configure(symbol: AssetSymbol, generation: number): void {
    this.symbol = symbol;
    this.generation = Math.max(0, Math.floor(generation));
    this.sequence = 0;
    this.resetBuffers();
  }

  pushTrades(trades: readonly NormalizedTrade[], generation = this.generation): number {
    if (generation !== this.generation) return 0;
    const maximum = TRADE_AGGREGATION_CONFIG.maxInputBatch;
    if (trades.length > maximum) this.droppedSinceFlush += trades.length - maximum;
    let accepted = 0;
    for (const trade of trades.slice(0, maximum)) {
      if (this.acceptedSinceFlush >= TRADE_AGGREGATION_CONFIG.maxQueuedTrades) {
        this.droppedSinceFlush += 1;
        continue;
      }
      if (trade.symbol !== this.symbol || !isValidTrade(trade)) {
        this.droppedSinceFlush += 1;
        continue;
      }
      const dedupeKey = `${trade.exchange}:${trade.id}`;
      if (this.dedupe.has(dedupeKey)) continue;
      this.dedupe.set(dedupeKey, trade.receivedAt);
      this.trimDedupe();
      this.addAggregate(trade);
      this.addRolling(trade);
      this.acceptedSinceFlush += 1;
      accepted += 1;
    }
    return accepted;
  }

  flush(now: number, force = false): TradeTapeBatch {
    const publishedAt = Number.isFinite(now) && now >= 0 ? now : Date.now();
    const orders: AggregatedOrder[] = [];
    for (const [key, aggregate] of this.aggregates) {
      if (!force && aggregate.bucketEndsAt > publishedAt) continue;
      this.aggregates.delete(key);
      orders.push(finalizeAggregate(aggregate));
    }
    this.evictRolling(publishedAt);
    this.sequence += 1;
    const boundedOrders = boundOrders(
      orders,
      TRADE_AGGREGATION_CONFIG.maxOutputOrders,
      this.sequence,
    );
    const batch: TradeTapeBatch = {
      generation: this.generation,
      sequence: this.sequence,
      symbol: this.symbol,
      orders: boundedOrders,
      stats: this.computeStats(publishedAt),
      publishedAt,
      droppedTrades: this.droppedSinceFlush,
    };
    this.droppedSinceFlush = 0;
    this.acceptedSinceFlush = 0;
    return batch;
  }

  dispose(): void {
    this.resetBuffers();
  }

  private addAggregate(trade: NormalizedTrade): void {
    const windowMs = TRADE_AGGREGATION_CONFIG.aggregationWindowMs;
    const time = safeAggregateTime(trade);
    const key = aggregateKey(trade, windowMs);
    const existing = this.aggregates.get(key);
    if (existing) {
      existing.notionalUsd += trade.notionalUsd;
      existing.priceSize += trade.price * trade.baseSize;
      existing.baseSize += trade.baseSize;
      existing.tradeCount += 1;
      existing.sources.add(trade.exchange);
      existing.simulated = existing.simulated && trade.simulated;
      existing.startedAt = Math.min(existing.startedAt, trade.timestampMs);
      existing.endedAt = Math.max(existing.endedAt, trade.timestampMs);
      return;
    }
    const bucketStart = Math.floor(time / windowMs) * windowMs;
    this.aggregates.set(key, {
      idSeed: trade.id.slice(-48),
      symbol: trade.symbol,
      side: trade.side,
      kind: trade.kind,
      notionalUsd: trade.notionalUsd,
      priceSize: trade.price * trade.baseSize,
      baseSize: trade.baseSize,
      tradeCount: 1,
      sources: new Set([trade.exchange]),
      simulated: trade.simulated,
      startedAt: trade.timestampMs,
      endedAt: trade.timestampMs,
      bucketEndsAt: bucketStart + windowMs,
    });
  }

  private addRolling(trade: NormalizedTrade): void {
    this.rolling.push({
      timestampMs: trade.receivedAt,
      side: trade.side,
      kind: trade.kind,
      notionalUsd: trade.notionalUsd,
    });
    const maximum = TRADE_AGGREGATION_CONFIG.maxRollingEvents;
    if (this.rolling.length - this.rollingHead > maximum) {
      this.rollingHead = this.rolling.length - maximum;
      this.droppedSinceFlush += 1;
    }
    this.compactRolling();
  }

  private computeStats(asOf: number): RollingTradeStats {
    const windows: Record<RollingTradeWindow, RollingWindowStats> = {
      '1s': emptyWindowStats(),
      '10s': emptyWindowStats(),
      '1m': emptyWindowStats(),
    };
    const durations: Readonly<Record<RollingTradeWindow, number>> = {
      '1s': 1_000,
      '10s': 10_000,
      '1m': 60_000,
    };
    for (let index = this.rollingHead; index < this.rolling.length; index += 1) {
      const event = this.rolling[index]!;
      const age = Math.max(0, asOf - event.timestampMs);
      for (const window of ['1s', '10s', '1m'] as const) {
        if (age > durations[window]) continue;
        const target = windows[window][event.side] as {
          notionalUsd: number;
          tradeCount: number;
          liquidationNotionalUsd: number;
          liquidationCount: number;
        };
        target.notionalUsd += event.notionalUsd;
        target.tradeCount += 1;
        if (event.kind === 'liquidation') {
          target.liquidationNotionalUsd += event.notionalUsd;
          target.liquidationCount += 1;
        }
      }
    }
    for (const window of ['1s', '10s', '1m'] as const) {
      const current = windows[window];
      const total = current.buy.notionalUsd + current.sell.notionalUsd;
      (current as { imbalance: number }).imbalance = total > 0
        ? (current.buy.notionalUsd - current.sell.notionalUsd) / total
        : 0;
    }
    return { symbol: this.symbol, asOf, windows };
  }

  private evictRolling(now: number): void {
    const cutoff = now - 60_000;
    while (this.rollingHead < this.rolling.length
      && this.rolling[this.rollingHead]!.timestampMs < cutoff) {
      this.rollingHead += 1;
    }
    this.compactRolling();
  }

  private compactRolling(): void {
    if (this.rollingHead < 4_096 || this.rollingHead < this.rolling.length / 2) return;
    this.rolling = this.rolling.slice(this.rollingHead);
    this.rollingHead = 0;
  }

  private trimDedupe(): void {
    while (this.dedupe.size > TRADE_AGGREGATION_CONFIG.maxDedupeEntries) {
      const oldest = this.dedupe.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.dedupe.delete(oldest);
    }
  }

  private resetBuffers(): void {
    this.aggregates.clear();
    this.dedupe.clear();
    this.rolling = [];
    this.rollingHead = 0;
    this.droppedSinceFlush = 0;
    this.acceptedSinceFlush = 0;
  }
}

/** Exposes the configured threshold table without allowing worker mutation. */
export function tradeThresholds(symbol: AssetSymbol): typeof MARKET_TRADE_CONFIG[AssetSymbol]['tiers'] {
  return MARKET_TRADE_CONFIG[symbol].tiers;
}
