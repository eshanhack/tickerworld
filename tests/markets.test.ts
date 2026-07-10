import { describe, expect, it } from 'vitest';
import type { AssetState, Candle } from '../src/types';
import {
  createSimulatedCandles,
  isSocketActivityStale,
  mulberry32,
  parseKlines,
  reconcileCandle,
  stepSimulation,
} from '../src/markets';

describe('market candle helpers', () => {
  it('parses Binance kline rows into a bounded candle window', () => {
    const rows = Array.from({ length: 32 }, (_, index) => [index * 60_000, '10', '12', '9', '11']);
    const candles = parseKlines(rows);
    expect(candles).toHaveLength(30);
    expect(candles[0]?.openTime).toBe(120_000);
    expect(candles.at(-1)?.closed).toBe(false);
  });

  it('reconciles by open time without duplicating candles', () => {
    const original: Candle[] = [{ openTime: 1, open: 1, high: 2, low: 1, close: 1.5, closed: false }];
    const next = reconcileCandle(original, { ...original[0]!, close: 1.8 });
    expect(next).toHaveLength(1);
    expect(next[0]?.close).toBe(1.8);
  });

  it('produces deterministic valid simulation data', () => {
    const candles = createSimulatedCandles('BTC', 1_800_000, 30, 'test');
    expect(candles).toHaveLength(30);
    candles.forEach((candle) => {
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
    });
    const price = candles.at(-1)!.close;
    const state: AssetState = {
      symbol: 'BTC', pair: 'BTCUSDT', candles, price, previousPrice: price,
      direction: 'flat', mode: 'simulated', updatedAt: 1_800_000, presentationTick: 0,
    };
    const first = stepSimulation(state, mulberry32(42), 1_800_400);
    const second = stepSimulation(state, mulberry32(42), 1_800_400);
    expect(first.price).toBe(second.price);
    expect(first.candles.at(-1)?.high).toBeGreaterThanOrEqual(first.price);
  });

  it('keeps a combined socket healthy when any stream is active', () => {
    const now = 50_000;
    expect(isSocketActivityStale([1_000, 49_500, 2_000], now)).toBe(false);
    expect(isSocketActivityStale([1_000, 2_000, 3_000], now)).toBe(true);
  });
});
