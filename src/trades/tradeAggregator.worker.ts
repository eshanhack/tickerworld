import { TradeAggregator } from './aggregation';
import { TRADE_AGGREGATION_CONFIG } from './config';
import type { TradeWorkerCommand, TradeWorkerEvent } from './types';

interface WorkerScope {
  onmessage: ((event: MessageEvent<TradeWorkerCommand>) => void) | null;
  postMessage(message: TradeWorkerEvent): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
const aggregator = new TradeAggregator();
let generation = 0;
let configured = false;
let timer: ReturnType<typeof setInterval> | null = null;

function postBatch(now = Date.now(), force = false): void {
  if (!configured) return;
  scope.postMessage({ type: 'batch', batch: aggregator.flush(now, force) });
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => postBatch(), TRADE_AGGREGATION_CONFIG.flushIntervalMs);
}

scope.onmessage = (event): void => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'configure':
      generation = message.generation;
      aggregator.configure(message.symbol, generation);
      configured = true;
      ensureTimer();
      break;
    case 'trades':
      if (configured && message.generation === generation) {
        aggregator.pushTrades(message.trades, generation);
      }
      break;
    case 'flush':
      if (configured && message.generation === generation) {
        postBatch(message.now, message.force ?? false);
      }
      break;
    case 'dispose':
      if (timer) clearInterval(timer);
      timer = null;
      configured = false;
      aggregator.dispose();
      scope.close();
      break;
  }
};

scope.postMessage({ type: 'ready' });
