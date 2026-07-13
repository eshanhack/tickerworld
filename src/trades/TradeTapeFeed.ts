import type { AssetSymbol } from '../types';
import { isDexAssetSymbol } from '../markets/dexMarket';
import { emptyRollingTradeStats } from './aggregation';
import { MARKET_TRADE_CONFIG, TRADE_AGGREGATION_CONFIG } from './config';
import {
  MultiExchangeTradeStream,
  type MultiExchangeTradeStreamOptions,
} from './MultiExchangeTradeStream';
import { TradeAggregatorWorkerClient, type TradeWorkerFactory } from './TradeAggregatorWorkerClient';
import { TradeTapeSimulator } from './simulator';
import type {
  NormalizedTrade,
  TradeSide,
  TradeTapeBatch,
  TradeTapeFeedLifecycle,
  TradeTapeHealth,
  TradeTapeSnapshot,
  TradeTier,
} from './types';

export interface TradeTapeFeedOptions {
  readonly activeMarket?: AssetSymbol;
  /** Explicit QA mode. Live mode separately enters labelled simulation after a bounded outage. */
  readonly simulation?: boolean;
  readonly seed?: string;
  readonly workerFactory?: TradeWorkerFactory;
  readonly streamOptions?: MultiExchangeTradeStreamOptions;
}

function tierDebugNotional(symbol: AssetSymbol, tier: TradeTier): number {
  const threshold = MARKET_TRADE_CONFIG[symbol].tiers;
  switch (tier) {
    case 'dust': return threshold.minor * 0.5;
    case 'minor': return Math.sqrt(threshold.minor * threshold.notable);
    case 'notable': return Math.sqrt(threshold.notable * threshold.big);
    case 'big': return Math.sqrt(threshold.big * threshold.whale);
    case 'whale': return threshold.whale * 1.25;
  }
}

export class TradeTapeFeed implements TradeTapeFeedLifecycle {
  private readonly worker: TradeAggregatorWorkerClient;
  private readonly stream: MultiExchangeTradeStream;
  private readonly simulator: TradeTapeSimulator;
  private readonly simulationRequested: boolean;
  private readonly batchListeners = new Set<(batch: TradeTapeBatch) => void>();
  private readonly stateListeners = new Set<(state: TradeTapeSnapshot) => void>();
  private readonly stopWorkerSubscription: () => void;
  private readonly stopStreamSubscription: () => void;
  private readonly stopHealthSubscription: () => void;
  private symbol: AssetSymbol;
  private generation = 1;
  private stateValue: TradeTapeSnapshot;
  private simulationTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private automaticFallback = false;
  private debugSequence = 0;
  private streamStarted = false;
  private started = false;
  private paused = false;
  private disposed = false;

  constructor(options: TradeTapeFeedOptions = {}) {
    this.symbol = options.activeMarket ?? 'BTC';
    this.simulationRequested = options.simulation ?? false;
    this.worker = new TradeAggregatorWorkerClient(options.workerFactory);
    this.stream = new MultiExchangeTradeStream(options.streamOptions);
    this.simulator = new TradeTapeSimulator(this.symbol, options.seed);
    this.stateValue = {
      symbol: this.symbol,
      mode: this.usesForcedSimulation() ? 'simulated' : this.worker.available ? 'connecting' : 'unavailable',
      stats: emptyRollingTradeStats(this.symbol),
      health: [],
      updatedAt: Date.now(),
    };
    this.worker.configure(this.symbol, this.generation);
    if (this.symbol !== 'BTC') this.stream.setActiveMarket(this.symbol);
    this.stopWorkerSubscription = this.worker.subscribe((batch) => this.acceptWorkerBatch(batch));
    this.stopStreamSubscription = this.stream.subscribe((trades) => {
      this.worker.pushTrades(trades, this.generation);
    });
    this.stopHealthSubscription = this.stream.subscribeHealth((health) => this.acceptHealth(health));
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.paused = false;
    if (!this.worker.available) {
      this.updateMode('unavailable');
      return;
    }
    if (this.usesForcedSimulation()) this.startSimulation();
    else this.startStream();
  }

  setActiveMarket(symbol: AssetSymbol): void {
    if (this.disposed || symbol === this.symbol) return;
    const wasForcedSimulation = this.usesForcedSimulation();
    this.clearFallbackTimer();
    this.automaticFallback = false;
    this.stopSimulation();
    this.symbol = symbol;
    this.generation += 1;
    this.worker.configure(symbol, this.generation);
    this.simulator.setActiveMarket(symbol);
    const forcedSimulation = this.usesForcedSimulation();
    this.stateValue = {
      symbol,
      mode: forcedSimulation ? 'simulated' : this.worker.available ? 'connecting' : 'unavailable',
      stats: emptyRollingTradeStats(symbol),
      health: forcedSimulation ? [] : this.stream.getHealth(),
      updatedAt: Date.now(),
    };
    this.emitState();
    this.stream.setActiveMarket(symbol);
    if (this.started && !this.paused) {
      if (forcedSimulation) {
        if (!wasForcedSimulation && this.streamStarted) this.stream.pause();
        this.startSimulation();
      } else {
        if (wasForcedSimulation) {
          if (this.streamStarted) this.stream.resume();
          else this.startStream();
        }
        this.acceptHealth(this.stream.getHealth());
      }
    }
  }

  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    this.clearFallbackTimer();
    this.automaticFallback = false;
    this.stopSimulation();
    if (!this.usesForcedSimulation() && this.streamStarted) this.stream.pause();
  }

  resume(): void {
    if (!this.paused || this.disposed || !this.started) return;
    this.paused = false;
    if (this.usesForcedSimulation()) this.startSimulation();
    else {
      if (this.streamStarted) this.stream.resume();
      else this.startStream();
      this.acceptHealth(this.stream.getHealth());
    }
  }

  subscribe(listener: (batch: TradeTapeBatch) => void): () => void {
    this.batchListeners.add(listener);
    return () => this.batchListeners.delete(listener);
  }

  subscribeState(listener: (state: TradeTapeSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.stateValue);
    return () => this.stateListeners.delete(listener);
  }

  getState(): TradeTapeSnapshot {
    return this.stateValue;
  }

  getDebugStatus(): string {
    const live = this.stateValue.health.filter((health) => health.mode === 'live').length;
    return `${this.stateValue.mode} · ${live}/${this.stateValue.health.length} venues · batch ${this.stateValue.stats.asOf}`;
  }

  /** Dev tooling may inject a labelled simulated order without touching candles. */
  injectDebugOrder(side: TradeSide, tier: TradeTier, now = Date.now()): void {
    if (this.disposed || !this.worker.available) return;
    const notionalUsd = tierDebugNotional(this.symbol, tier);
    const price = MARKET_TRADE_CONFIG[this.symbol].referencePrice;
    this.debugSequence += 1;
    const trade: NormalizedTrade = {
      id: `debug:${this.symbol}:${this.debugSequence}`,
      exchange: 'simulation',
      symbol: this.symbol,
      side,
      kind: 'trade',
      price,
      baseSize: notionalUsd / price,
      notionalUsd,
      timestampMs: now,
      receivedAt: now,
      simulated: true,
    };
    this.worker.pushTrades([trade], this.generation);
    this.worker.flush(now + TRADE_AGGREGATION_CONFIG.aggregationWindowMs, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFallbackTimer();
    this.stopSimulation();
    this.stopWorkerSubscription();
    this.stopStreamSubscription();
    this.stopHealthSubscription();
    this.stream.dispose();
    this.worker.dispose();
    this.batchListeners.clear();
    this.stateListeners.clear();
  }

  private startSimulation(): void {
    if (this.simulationTimer || this.paused || this.disposed) return;
    this.updateMode('simulated');
    const produce = (): void => {
      if (this.paused || this.disposed) return;
      this.worker.pushTrades(this.simulator.next(), this.generation);
    };
    produce();
    this.simulationTimer = setInterval(produce, TRADE_AGGREGATION_CONFIG.simulationIntervalMs);
  }

  private stopSimulation(): void {
    if (this.simulationTimer) clearInterval(this.simulationTimer);
    this.simulationTimer = null;
  }

  private acceptWorkerBatch(batch: TradeTapeBatch): void {
    if (this.disposed || batch.generation !== this.generation || batch.symbol !== this.symbol) return;
    this.stateValue = {
      ...this.stateValue,
      stats: batch.stats,
      updatedAt: batch.publishedAt,
    };
    for (const listener of this.batchListeners) listener(batch);
    this.emitState();
  }

  private acceptHealth(health: readonly TradeTapeHealth[]): void {
    if (this.disposed || this.usesForcedSimulation()) return;
    const hasLiveSource = health.some((item) => item.mode === 'live');
    if (hasLiveSource && this.automaticFallback) {
      this.automaticFallback = false;
      this.clearFallbackTimer();
      this.stopSimulation();
      // Remove any unflushed synthetic flow before accepting genuine prints.
      this.generation += 1;
      this.worker.configure(this.symbol, this.generation);
      this.stateValue = {
        ...this.stateValue,
        stats: emptyRollingTradeStats(this.symbol),
        updatedAt: Date.now(),
      };
    }
    const mode = !this.worker.available
      ? 'unavailable'
      : hasLiveSource
        ? 'live'
        : this.automaticFallback
          ? 'simulated'
        : health.some((item) => item.mode === 'reconnecting')
          ? 'reconnecting'
          : health.length > 0
            ? 'connecting'
            : 'unavailable';
    this.stateValue = { ...this.stateValue, mode, health: [...health], updatedAt: Date.now() };
    this.emitState();
    if (!this.started || this.paused || !this.worker.available || hasLiveSource) {
      if (hasLiveSource) this.clearFallbackTimer();
      return;
    }
    if (health.length === 0) {
      this.startAutomaticFallback();
      return;
    }
    this.scheduleAutomaticFallback();
  }

  private updateMode(mode: TradeTapeSnapshot['mode']): void {
    if (this.stateValue.mode === mode) return;
    this.stateValue = { ...this.stateValue, mode, updatedAt: Date.now() };
    this.emitState();
  }

  private emitState(): void {
    for (const listener of this.stateListeners) listener(this.stateValue);
  }

  private startStream(): void {
    if (this.streamStarted) return;
    this.streamStarted = true;
    this.stream.start();
  }

  private scheduleAutomaticFallback(): void {
    if (this.fallbackTimer || this.automaticFallback || this.usesForcedSimulation()
      || isDexAssetSymbol(this.symbol)) return;
    const generation = this.generation;
    const symbol = this.symbol;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.disposed || this.paused || generation !== this.generation || symbol !== this.symbol
        || this.stream.getHealth().some((item) => item.mode === 'live')) return;
      this.startAutomaticFallback();
    }, TRADE_AGGREGATION_CONFIG.fallbackAfterMs);
  }

  private startAutomaticFallback(): void {
    if (this.automaticFallback || this.usesForcedSimulation() || isDexAssetSymbol(this.symbol)
      || this.disposed || this.paused) return;
    this.automaticFallback = true;
    this.clearFallbackTimer();
    // Synthetic fallback is a new provenance epoch. Clear genuine rolling
    // statistics so imbalance and tier rates can never mix real and fake flow.
    this.generation += 1;
    this.worker.configure(this.symbol, this.generation);
    this.stateValue = {
      ...this.stateValue,
      stats: emptyRollingTradeStats(this.symbol),
      updatedAt: Date.now(),
    };
    this.startSimulation();
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private usesForcedSimulation(): boolean {
    return this.simulationRequested || this.symbol === 'TEST';
  }
}
