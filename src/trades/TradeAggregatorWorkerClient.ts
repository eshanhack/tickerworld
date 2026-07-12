import type { AssetSymbol } from '../types';
import { TRADE_AGGREGATION_CONFIG } from './config';
import type {
  NormalizedTrade,
  TradeTapeBatch,
  TradeWorkerCommand,
  TradeWorkerEvent,
} from './types';

export interface TradeWorkerLike {
  postMessage(message: TradeWorkerCommand): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<TradeWorkerEvent>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<TradeWorkerEvent>) => void): void;
  terminate(): void;
}

export type TradeWorkerFactory = () => TradeWorkerLike;

function defaultWorkerFactory(): TradeWorkerLike {
  return new Worker(new URL('./tradeAggregator.worker.ts', import.meta.url), {
    type: 'module',
    name: 'tickerworld-trade-aggregator',
  });
}

export class TradeAggregatorWorkerClient {
  private readonly listeners = new Set<(batch: TradeTapeBatch) => void>();
  private worker: TradeWorkerLike | null = null;
  private generation = 0;
  private disposed = false;
  private readyValue = false;

  constructor(factory: TradeWorkerFactory = defaultWorkerFactory) {
    try {
      this.worker = factory();
      this.worker.addEventListener('message', this.handleMessage);
    } catch {
      this.worker = null;
    }
  }

  get available(): boolean {
    return this.worker !== null && !this.disposed;
  }

  get ready(): boolean {
    return this.readyValue && this.available;
  }

  configure(symbol: AssetSymbol, generation: number): void {
    if (!this.worker || this.disposed) return;
    this.generation = Math.max(0, Math.floor(generation));
    this.worker.postMessage({ type: 'configure', generation: this.generation, symbol });
  }

  pushTrades(trades: readonly NormalizedTrade[], generation = this.generation): void {
    if (!this.worker || this.disposed || generation !== this.generation || trades.length === 0) return;
    const maximum = TRADE_AGGREGATION_CONFIG.maxInputBatch;
    for (let offset = 0; offset < trades.length; offset += maximum) {
      this.worker.postMessage({
        type: 'trades',
        generation,
        trades: trades.slice(offset, offset + maximum),
      });
    }
  }

  flush(now = Date.now(), force = false): void {
    this.worker?.postMessage({ type: 'flush', generation: this.generation, now, force });
  }

  subscribe(listener: (batch: TradeTapeBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.removeEventListener('message', this.handleMessage);
      try {
        worker.postMessage({ type: 'dispose' });
      } catch {
        // A crashed worker can still be terminated safely.
      }
      worker.terminate();
    }
    this.listeners.clear();
  }

  private readonly handleMessage = (event: MessageEvent<TradeWorkerEvent>): void => {
    if (this.disposed) return;
    const message = event.data;
    if (message.type === 'ready') {
      this.readyValue = true;
      return;
    }
    if (message.type !== 'batch' || message.batch.generation !== this.generation) return;
    for (const listener of this.listeners) listener(message.batch);
  };
}
