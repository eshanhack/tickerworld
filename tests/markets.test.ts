import { describe, expect, it, vi } from 'vitest';
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
  mergeCandleHistories,
  mulberry32,
  parseHyperliquidCandles,
  parseHyperliquidMids,
  parseHyperliquidTrades,
  reconcileCandle,
  stepSimulation,
  stepTestSimulation,
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

  it('prepends REST history without rolling a newer live candle backwards', () => {
    const history = Array.from({ length: 66 }, (_, index): Candle => ({
      openTime: index * 60_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      closed: index < 65,
    }));
    const live: Candle = {
      ...history.at(-1)!,
      high: 999,
      close: 999,
      closed: false,
    };
    const merged = mergeCandleHistories(history, [live], 66);
    expect(merged).toHaveLength(66);
    expect(merged.at(-1)).toEqual(live);
    expect(merged.slice(0, -1).every((candle) => candle.closed)).toBe(true);
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
      direction: 'flat', mode: 'simulated', updateKind: 'simulation', updatedAt: 1_800_000, presentationTick: 0,
      horizonChanges: createEmptyHorizonChanges(),
    };
    const first = stepSimulation(state, mulberry32(42), 1_800_400);
    const second = stepSimulation(state, mulberry32(42), 1_800_400);
    expect(first.price).toBe(second.price);
    expect(first.price).not.toBeNull();
    expect(first.candles.at(-1)?.high).toBeGreaterThanOrEqual(first.price!);
    expect(first.updateKind).toBe('simulation');
  });

  it('cycles TEST through calm and exceptional moves in both directions', () => {
    const candles = createSimulatedCandles('TEST', 1_800_000, 30, 'event-lab');
    const price = candles.at(-1)!.close;
    let state: AssetState = {
      symbol: 'TEST', instrument: 'TEST', provider: 'simulation', candles, price, previousPrice: price,
      direction: 'flat', mode: 'simulated', updateKind: 'simulation', updatedAt: 1_800_000,
      presentationTick: 0, horizonChanges: createEmptyHorizonChanges(),
    };
    const ratios: number[] = [];
    for (let index = 0; index < 16; index += 1) {
      state = stepTestSimulation(state, 1_800_000 + index * 400);
      const active = state.candles.at(-1)!;
      ratios.push((state.price! / active.open) - 1);
    }
    expect(ratios.some((ratio) => Math.abs(ratio) < 0.00007)).toBe(true);
    expect(ratios.some((ratio) => ratio >= 0.02)).toBe(true);
    expect(ratios.some((ratio) => ratio <= -0.02)).toBe(true);
    for (let index = 1; index < ratios.length; index += 1) {
      expect(ratios[index]).not.toBe(ratios[index - 1]);
    }
  });

  it('keeps a combined socket healthy when any stream is active', () => {
    const now = 50_000;
    expect(isSocketActivityStale([1_000, 49_500, 2_000], now)).toBe(false);
    expect(isSocketActivityStale([1_000, 2_000, 3_000], now, 12_000)).toBe(true);
  });

  it('builds both dex mid streams and every real asset subscription', () => {
    const subscriptions = buildHyperliquidSubscriptions();
    expect(subscriptions).toHaveLength(42);
    expect(subscriptions[0]).toEqual({ type: 'allMids' });
    expect(subscriptions[1]).toEqual({ type: 'allMids', dex: 'xyz' });
    expect(subscriptions).toContainEqual({ type: 'trades', coin: 'AVAX' });
    expect(subscriptions).toContainEqual({ type: 'trades', coin: 'xyz:CL' });
    expect(subscriptions).toContainEqual({ type: 'trades', coin: 'xyz:SKHX' });
    expect(subscriptions).toContainEqual({ type: 'trades', coin: 'HYPE' });
    expect(subscriptions).toContainEqual({ type: 'trades', coin: 'xyz:SPCX' });
    expect(subscriptions).not.toContainEqual({ type: 'trades', coin: 'TEST' });
    expect(subscriptions).toContainEqual({ type: 'candle', coin: 'BTC', interval: '1m' });
  });

  it('limits the browser fallback to one active chart plus compact mids', () => {
    expect(buildHyperliquidSubscriptions('ETH')).toEqual([
      { type: 'allMids' },
      { type: 'allMids', dex: 'xyz' },
      { type: 'trades', coin: 'ETH' },
      { type: 'candle', coin: 'ETH', interval: '1m' },
    ]);
    expect(buildHyperliquidSubscriptions('TEST')).toEqual([
      { type: 'allMids' },
      { type: 'allMids', dex: 'xyz' },
    ]);
    // DEX worlds keep the exact DEX trade poll for their local chart while a
    // lightweight Hyperliquid socket supplies prices for the other portals.
    expect(buildHyperliquidSubscriptions('ANSEM')).toEqual([
      { type: 'allMids' },
      { type: 'allMids', dex: 'xyz' },
    ]);
    expect(parseHyperliquidMids({ mids: {
      BTC: '64123.5', ETH: 3120, 'xyz:CL': '73.42', 'xyz:SKHX': '350.5',
      'xyz:SPCX': '481', HYPE: '38.2', BAD: 1, SOL: 'nope',
    } })).toEqual({
      BTC: 64123.5,
      ETH: 3120,
      WTI: 73.42,
      SKHYNIX: 350.5,
      SPACEX: 481,
      HYPE: 38.2,
    });
  });

  it('keeps a DEX chart live when the passive portal-mids socket reconnects', () => {
    const feed = new HyperliquidMarketFeed();
    const internals = feed as unknown as {
      activeSymbol: 'ANSEM';
      setPassiveMidModes(mode: AssetState['mode']): void;
      applyCompactMids(mids: readonly { instrument: 'BTC'; price: number; upstreamAt: number }[], publishedAt: number): void;
    };
    internals.activeSymbol = 'ANSEM';
    internals.applyCompactMids([{ instrument: 'BTC', price: 99_000, upstreamAt: 1_000 }], 1_000);
    expect(feed.getState('BTC')).toMatchObject({ price: 99_000, mode: 'live' });
    expect(feed.getState('ANSEM').mode).toBe('connecting');

    internals.setPassiveMidModes('reconnecting');
    expect(feed.getState('BTC').mode).toBe('reconnecting');
    expect(feed.getState('ANSEM').mode).toBe('connecting');
    feed.dispose();
  });

  it('accepts only newly sequenced server trades and keeps repeated relay publications silent', () => {
    const feed = new HyperliquidMarketFeed();
    const relay = (price: number, publishedAt: number, tradeSequence: number, tradeAt: number | null) => feed.acceptRelayState({
      instrument: 'BTC',
      candles: [{ openTime: 60_000, open: 100, high: Math.max(100, price), low: 99, close: price }],
      candle: { openTime: 60_000, open: 100, high: Math.max(100, price), low: 99, close: price },
      price,
      tradeSequence,
      tradeAt,
      upstreamAt: publishedAt - 50,
      publishedAt,
      ageMs: 50,
      stale: false,
    }, [{ instrument: 'ETH', price: 3_200, upstreamAt: publishedAt - 25 }]);

    relay(101, 70_000, 12, 69_950);
    expect(feed.getState('BTC')).toMatchObject({ price: 101, mode: 'live', updateKind: 'snapshot' });
    expect(feed.getState('ETH')).toMatchObject({ price: 3_200, updateKind: 'snapshot' });
    relay(101, 70_400, 12, 69_950);
    expect(feed.getState('BTC')).toMatchObject({
      price: 101,
      updateKind: 'snapshot',
      presentationTick: 0,
    });
    relay(102, 70_800, 13, 70_750);
    expect(feed.getState('BTC')).toMatchObject({
      price: 102,
      previousPrice: 101,
      updateKind: 'trade',
      presentationTick: 1,
      ageMs: 50,
    });
    relay(102, 71_200, 13, 70_750);
    expect(feed.getState('BTC')).toMatchObject({ updateKind: 'snapshot', presentationTick: 1 });
    relay(103, 71_600, 14, 70_750);
    expect(feed.getState('BTC')).toMatchObject({
      price: 103,
      updateKind: 'trade',
      presentationTick: 2,
    });
    feed.dispose();
  });

  it('treats legacy relay packets without trade identity as silent snapshots', () => {
    const feed = new HyperliquidMarketFeed();
    const state = {
      instrument: 'BTC' as const,
      candles: [{ openTime: 60_000, open: 100, high: 102, low: 99, close: 101 }],
      candle: { openTime: 60_000, open: 100, high: 102, low: 99, close: 101 },
      price: 101,
      upstreamAt: 69_950,
      publishedAt: 70_000,
      ageMs: 50,
      stale: false,
    };
    feed.acceptRelayState(state);
    feed.acceptRelayState({ ...state, price: 102, publishedAt: 70_400 });
    expect(feed.getState('BTC')).toMatchObject({
      price: 102,
      updateKind: 'snapshot',
      presentationTick: 0,
    });
    feed.dispose();
  });

  it('keeps relay candles through a relay-before-REST race and silently enriches full horizons', async () => {
    let resolveSnapshot!: (value: {
      chartCandles: Candle[];
      minuteHistory: Candle[];
      dailyHistory: Candle[];
    }) => void;
    const snapshot = new Promise<{
      chartCandles: Candle[];
      minuteHistory: Candle[];
      dailyHistory: Candle[];
    }>((resolve) => { resolveSnapshot = resolve; });
    const feed = new HyperliquidMarketFeed();
    const internals = feed as unknown as {
      started: boolean;
      fetchSnapshot(symbol: 'BTC'): typeof snapshot;
      requestDexQuoteRefresh(): void;
      minuteHistories: Map<string, Candle[]>;
      dailyHistories: Map<string, Candle[]>;
    };
    internals.started = true;
    internals.fetchSnapshot = vi.fn(() => snapshot);
    internals.requestDexQuoteRefresh = vi.fn();
    feed.setRelayAvailable(true, true);

    const live = {
      openTime: 65 * 60_000,
      open: 165,
      high: 999,
      low: 164,
      close: 999,
    };
    feed.acceptRelayState({
      instrument: 'BTC',
      candles: [live],
      candle: live,
      price: 999,
      tradeSequence: 4,
      tradeAt: live.openTime + 20_000,
      upstreamAt: live.openTime + 20_000,
      publishedAt: live.openTime + 20_050,
      ageMs: 50,
      stale: false,
    });
    // An empty startup publication must never erase the chart that just won
    // the race from the socket.
    feed.acceptRelayState({
      instrument: 'BTC',
      candles: [],
      candle: null,
      price: 999,
      tradeSequence: 4,
      tradeAt: live.openTime + 20_000,
      upstreamAt: live.openTime + 20_000,
      publishedAt: live.openTime + 20_450,
      ageMs: 450,
      stale: false,
    });
    expect(feed.getState('BTC').candles).toHaveLength(1);

    const minuteHistory = Array.from({ length: 66 }, (_, index): Candle => ({
      openTime: index * 60_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      closed: index < 65,
    }));
    const dailyHistory = Array.from({ length: 370 }, (_, index): Candle => ({
      openTime: index * 86_400_000,
      open: 50 + index,
      high: 52 + index,
      low: 49 + index,
      close: 51 + index,
      closed: index < 369,
    }));
    resolveSnapshot({
      chartCandles: minuteHistory.slice(-30),
      minuteHistory,
      dailyHistory,
    });
    await snapshot;
    await Promise.resolve();
    await Promise.resolve();

    expect(internals.minuteHistories.get('BTC')).toHaveLength(66);
    expect(internals.dailyHistories.get('BTC')).toHaveLength(370);
    expect(feed.getState('BTC').candles).toHaveLength(30);
    expect(feed.getState('BTC').candles.at(-1)).toMatchObject({ close: 999, high: 999 });
    expect(feed.getState('BTC')).toMatchObject({
      price: 999,
      updateKind: 'snapshot',
      presentationTick: 0,
    });
    feed.dispose();
  });

  it('uses a 25-second heartbeat and bounded jittered reconnect delays', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000);
    expect(computeReconnectDelay(0, () => 0)).toBe(1_000);
    expect(computeReconnectDelay(1, () => 0.5)).toBe(2_000);
    expect(computeReconnectDelay(20, () => 1)).toBe(30_000);
  });

  it('does not restart the direct fallback while its live snapshot is still connecting', () => {
    const feed = new HyperliquidMarketFeed();
    const reconnect = vi.fn();
    const internals = feed as unknown as {
      started: boolean;
      connectPending: boolean;
      resyncAndConnect(initial: boolean): Promise<void>;
    };
    internals.started = true;
    internals.connectPending = true;
    internals.resyncAndConnect = reconnect;
    feed.setRelayAvailable(false, true);
    expect(reconnect).not.toHaveBeenCalled();

    internals.connectPending = false;
    feed.setRelayAvailable(false, true);
    expect(reconnect).toHaveBeenCalledWith(false);
    feed.dispose();
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
      updateKind: 'snapshot',
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
      updateKind: 'trade',
      updatedAt: 65_000,
      presentationTick: 7,
      horizonChanges: createEmptyHorizonChanges(),
    });

    internals.setAllModes('reconnecting');

    expect(feed.getState('BTC')).toMatchObject({
      mode: 'reconnecting',
      updateKind: 'snapshot',
      provider: 'hyperliquid',
      price: 64_123,
      previousPrice: 64_120,
      candles: [candle],
      presentationTick: 7,
    });
  });

  it('labels coalesced trades and authoritative candles at their source', () => {
    const feed = new HyperliquidMarketFeed();
    const candle: Candle = {
      openTime: 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      closed: false,
    };
    const internals = feed as unknown as {
      states: Map<string, AssetState>;
      minuteHistories: Map<string, Candle[]>;
      presentTrade(symbol: 'BTC', trade: { price: number; time: number }, presentedAt: number): void;
      handleCandlePayload(payload: unknown): void;
    };
    internals.states.set('BTC', {
      symbol: 'BTC',
      instrument: 'BTC',
      provider: 'hyperliquid',
      candles: [candle],
      price: 100,
      previousPrice: 100,
      direction: 'flat',
      mode: 'live',
      updateKind: 'snapshot',
      updatedAt: 60_000,
      presentationTick: 0,
      horizonChanges: createEmptyHorizonChanges(),
    });
    internals.minuteHistories.set('BTC', [candle]);

    internals.presentTrade('BTC', { price: 100, time: 65_000 }, 65_400);
    expect(feed.getState('BTC')).toMatchObject({
      updateKind: 'trade',
      direction: 'flat',
      presentationTick: 1,
    });

    internals.handleCandlePayload({
      s: 'BTC',
      t: 120_000,
      o: '100',
      h: '102',
      l: '99',
      c: '101',
    });
    expect(feed.getState('BTC')).toMatchObject({
      updateKind: 'candle',
      price: 101,
      presentationTick: 2,
    });
    feed.dispose();
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
