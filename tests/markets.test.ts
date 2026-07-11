import { describe, expect, it } from 'vitest';
import type { AssetState, Candle } from '../src/types';
import {
  HEARTBEAT_INTERVAL_MS,
  HyperliquidMarketFeed,
  applyTradeToCandles,
  buildHyperliquidSubscriptions,
  computeHorizonChanges,
  computeReconnectDelay,
  createEmptyHorizonChanges,
  createSimulatedCandles,
  createSimulatedHistory,
  getCandleCountdown,
  isSocketActivityStale,
  mulberry32,
  parseHyperliquidCandles,
  parseHyperliquidTrades,
  reconcileCandle,
  stepSimulation,
} from '../src/markets';

describe('market candle helpers', () => {
  it('parses string-valued Hyperliquid objects into a bounded candle window', () => {
    const rows = Array.from({ length: 32 }, (_, index) => ({
      t: index * 60_000,
      T: (index + 1) * 60_000 - 1,
      s: 'BTC',
      i: '1m',
      o: '10',
      c: '11',
      h: '12',
      l: '9',
    }));
    const candles = parseHyperliquidCandles(rows, 31 * 60_000 + 30_000);
    expect(candles).toHaveLength(30);
    expect(candles[0]?.openTime).toBe(120_000);
    expect(candles.at(-1)?.closed).toBe(false);
  });

  it('accepts single objects and both supported compact array shapes', () => {
    const object = parseHyperliquidCandles(
      { t: '60000', o: '10', h: '12', l: '9', c: '11' },
      90_000,
    );
    const compact = parseHyperliquidCandles(
      ['120000', '179999', 'ETH', '1m', '20', '21', '22', '19'],
      150_000,
    );
    const common = parseHyperliquidCandles(['180000', '30', '32', '29', '31'], 210_000);
    expect(object[0]).toMatchObject({ openTime: 60_000, open: 10, close: 11 });
    expect(compact[0]).toMatchObject({ openTime: 120_000, open: 20, close: 21, high: 22, low: 19 });
    expect(common[0]).toMatchObject({ openTime: 180_000, open: 30, close: 31 });
  });

  it('reconciles by open time without duplicating candles', () => {
    const original: Candle[] = [{ openTime: 1, open: 1, high: 2, low: 1, close: 1.5, closed: false }];
    const next = reconcileCandle(original, { ...original[0]!, close: 1.8 });
    expect(next).toHaveLength(1);
    expect(next[0]?.close).toBe(1.8);
  });

  it('updates live OHLC, ignores stale trades, and rolls exactly once', () => {
    const candles = Array.from({ length: 30 }, (_, index): Candle => ({
      openTime: index * 60_000,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      closed: index < 29,
    }));
    const sameMinute = applyTradeToCandles(candles, 12, 29 * 60_000 + 5_000);
    expect(sameMinute.accepted).toBe(true);
    expect(sameMinute.rolled).toBe(false);
    expect(sameMinute.candles.at(-1)).toMatchObject({ high: 12, close: 12, closed: false });

    const stale = applyTradeToCandles(sameMinute.candles, 7, 28 * 60_000 + 59_000);
    expect(stale.accepted).toBe(false);
    expect(stale.candles.at(-1)?.close).toBe(12);

    const rolled = applyTradeToCandles(sameMinute.candles, 13, 30 * 60_000 + 1_000);
    expect(rolled.rolled).toBe(true);
    expect(rolled.candles).toHaveLength(30);
    expect(rolled.candles.at(-2)?.closed).toBe(true);
    expect(rolled.candles.at(-1)).toMatchObject({
      openTime: 30 * 60_000,
      open: 13,
      high: 13,
      low: 13,
      close: 13,
      closed: false,
    });
  });

  it('parses and orders object or array trade payloads while rejecting invalid data', () => {
    const trades = parseHyperliquidTrades([
      { coin: 'BTC', px: '12', time: 200 },
      { coin: 'BTC', px: '11', time: 100 },
      { coin: 'NOT_SUPPORTED', px: '10', time: 50 },
      { coin: 'ETH', px: 'bad', time: 300 },
    ]);
    expect(trades).toEqual([
      { symbol: 'BTC', price: 11, time: 100 },
      { symbol: 'BTC', price: 12, time: 200 },
    ]);
    expect(parseHyperliquidTrades({ coin: 'SOL', px: '150.5', time: '400' })).toEqual([
      { symbol: 'SOL', price: 150.5, time: 400 },
    ]);
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
      symbol: 'BTC', instrument: 'BTC', provider: 'simulation', candles, price, previousPrice: price,
      direction: 'flat', mode: 'simulated', updatedAt: 1_800_000, presentationTick: 0,
      horizonChanges: createEmptyHorizonChanges(),
    };
    const first = stepSimulation(state, mulberry32(42), 1_800_400);
    const second = stepSimulation(state, mulberry32(42), 1_800_400);
    expect(first.price).toBe(second.price);
    expect(first.price).not.toBeNull();
    expect(first.candles.at(-1)?.high).toBeGreaterThanOrEqual(first.price!);
  });

  it('keeps a combined socket healthy when any stream is active', () => {
    const now = 50_000;
    expect(isSocketActivityStale([1_000, 49_500, 2_000], now)).toBe(false);
    expect(isSocketActivityStale([1_000, 2_000, 3_000], now, 12_000)).toBe(true);
  });

  it('builds one all-mids and sixteen asset subscriptions', () => {
    const subscriptions = buildHyperliquidSubscriptions();
    expect(subscriptions).toHaveLength(17);
    expect(subscriptions[0]).toEqual({ type: 'allMids' });
    expect(subscriptions).toContainEqual({ type: 'trades', coin: 'AVAX' });
    expect(subscriptions).toContainEqual({ type: 'candle', coin: 'BTC', interval: '1m' });
  });

  it('uses a 25-second heartbeat and bounded jittered reconnect delays', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000);
    expect(computeReconnectDelay(0, () => 0)).toBe(1_000);
    expect(computeReconnectDelay(1, () => 0.5)).toBe(2_000);
    expect(computeReconnectDelay(20, () => 1)).toBe(30_000);
  });

  it('starts live-mode assets empty and explicitly connecting', () => {
    const feed = new HyperliquidMarketFeed();
    expect(feed.getState('BTC')).toMatchObject({
      instrument: 'BTC',
      provider: 'hyperliquid',
      candles: [],
      price: null,
      previousPrice: null,
      mode: 'connecting',
    });
  });

  it('freezes the last genuine candles and price while reconnecting', () => {
    const feed = new HyperliquidMarketFeed();
    const candle: Candle = {
      openTime: 60_000,
      open: 64_000,
      high: 64_150,
      low: 63_980,
      close: 64_123,
      closed: false,
    };
    const internals = feed as unknown as {
      states: Map<string, AssetState>;
      setAllModes(mode: AssetState['mode']): void;
    };
    internals.states.set('BTC', {
      symbol: 'BTC',
      instrument: 'BTC',
      provider: 'hyperliquid',
      candles: [candle],
      price: 64_123,
      previousPrice: 64_120,
      direction: 'up',
      mode: 'live',
      updatedAt: 65_000,
      presentationTick: 7,
      horizonChanges: createEmptyHorizonChanges(),
    });

    internals.setAllModes('reconnecting');

    expect(feed.getState('BTC')).toMatchObject({
      mode: 'reconnecting',
      provider: 'hyperliquid',
      price: 64_123,
      previousPrice: 64_120,
      candles: [candle],
      presentationTick: 7,
    });
  });

  it('derives signed direction ratios for every requested timeframe', () => {
    const now = 400 * 24 * 60 * 60_000;
    const minuteHistory = Array.from({ length: 66 }, (_, index): Candle => ({
      openTime: now - (65 - index) * 60_000,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      closed: index < 65,
    }));
    const dailyHistory = Array.from({ length: 370 }, (_, index): Candle => ({
      openTime: now - (369 - index) * 24 * 60 * 60_000,
      open: 80 + index * 0.05,
      high: 81 + index * 0.05,
      low: 79 + index * 0.05,
      close: 80 + index * 0.05,
      closed: index < 369,
    }));
    const changes = computeHorizonChanges(170, now, minuteHistory, dailyHistory);

    expect(changes.map((change) => change.horizon)).toEqual([
      '1m', '15m', '1h', '1d', '1w', '1mo', '1y',
    ]);
    expect(changes.every((change) => change.referencePrice !== null)).toBe(true);
    expect(changes.every((change) => change.changeRatio !== null)).toBe(true);
    expect(changes[0]?.changeRatio).toBeCloseTo(170 / 164 - 1, 8);
    expect(changes[0]?.direction).toBe('up');
  });

  it('keeps missing horizon history explicitly unavailable', () => {
    const changes = computeHorizonChanges(100, 1_000_000, [], []);
    expect(changes).toHaveLength(7);
    expect(changes.every((change) => (
      change.referenceTime === null
      && change.referencePrice === null
      && change.changeRatio === null
      && change.direction === 'flat'
    ))).toBe(true);
  });

  it('counts down cleanly across one-minute boundaries', () => {
    expect(getCandleCountdown(0)).toEqual({
      remainingMs: 60_000,
      remainingSeconds: 60,
      label: '1:00',
    });
    expect(getCandleCountdown(59_000).label).toBe('0:01');
    expect(getCandleCountdown(59_999).remainingSeconds).toBe(1);
    expect(getCandleCountdown(60_000).label).toBe('1:00');
  });

  it('builds deterministic aligned long-range simulation history', () => {
    const first = createSimulatedHistory('BTC', 1_800_000_000, 370, 86_400_000, 'qa', 120_000);
    const second = createSimulatedHistory('BTC', 1_800_000_000, 370, 86_400_000, 'qa', 120_000);
    expect(first).toEqual(second);
    expect(first).toHaveLength(370);
    expect(first.at(-1)?.close).toBeCloseTo(120_000, 6);
  });
});
