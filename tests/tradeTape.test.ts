import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetSymbol } from '../src/types';
import {
  MARKET_TRADE_CONFIG,
  MultiExchangeTradeStream,
  TRADE_AGGREGATION_CONFIG,
  TradeAggregator,
  TradeAggregatorWorkerClient,
  TradeTapeFeed,
  TradeTapeSimulator,
  classifyTradeTier,
  coalesceTradeAudioOrders,
  computeTradeReconnectDelay,
  exchangesForMarket,
  parseBinanceTrades,
  parseCoinbaseTrades,
  parseHyperliquidTapeTrades,
  parseOkxTrades,
  tradeTierProgress,
  type AggregatedOrder,
  type NormalizedTrade,
  type TradeSocketLike,
  type TradeTapeBatch,
  type TradeWorkerCommand,
  type TradeWorkerEvent,
  type TradeWorkerLike,
} from '../src/trades';

function trade(overrides: Partial<NormalizedTrade> = {}): NormalizedTrade {
  return {
    id: 'trade-1',
    exchange: 'binance',
    symbol: 'BTC',
    side: 'buy',
    kind: 'trade',
    price: 100,
    baseSize: 10,
    notionalUsd: 1_000,
    timestampMs: 1_020,
    receivedAt: 1_025,
    simulated: false,
    ...overrides,
  };
}

function tapeBatch(
  generation: number,
  buyNotionalUsd = 0,
  symbol: AssetSymbol = 'BTC',
): TradeTapeBatch {
  const flow = (notionalUsd: number) => ({
    notionalUsd,
    tradeCount: notionalUsd > 0 ? 1 : 0,
    liquidationNotionalUsd: 0,
    liquidationCount: 0,
  });
  const window = {
    buy: flow(buyNotionalUsd),
    sell: flow(0),
    imbalance: buyNotionalUsd > 0 ? 1 : 0,
  };
  return {
    generation,
    sequence: 1,
    symbol,
    orders: [],
    stats: {
      symbol,
      asOf: 2_000 + generation,
      windows: { '1s': window, '10s': window, '1m': window },
    },
    publishedAt: 2_000 + generation,
    droppedTrades: 0,
  };
}

function order(
  id: string,
  side: 'buy' | 'sell',
  notionalUsd: number,
): AggregatedOrder {
  return {
    id,
    symbol: 'BTC',
    side,
    tier: classifyTradeTier('BTC', notionalUsd),
    kind: 'trade',
    notionalUsd,
    vwap: 100,
    baseSize: notionalUsd / 100,
    tradeCount: 1,
    sources: ['binance'],
    sourceCount: 1,
    simulated: false,
    startedAt: 1_000,
    endedAt: 1_050,
    timestampMs: 1_050,
  };
}

describe('trade exchange normalizers', () => {
  it('normalizes Binance aggregate taker direction, notional, and identity', () => {
    expect(parseBinanceTrades({
      e: 'aggTrade', s: 'BTCUSDT', a: 42, p: '65000', q: '0.2', T: 1_000, m: true,
    }, 'BTC', 'BTCUSDT', 1_010)).toEqual([expect.objectContaining({
      id: 'BTCUSDT:42', exchange: 'binance', symbol: 'BTC', side: 'sell',
      price: 65_000, baseSize: 0.2, notionalUsd: 13_000, timestampMs: 1_000,
    })]);
    expect(parseBinanceTrades({
      e: 'aggTrade', s: 'ETHUSDT', a: 42, p: '65000', q: '0.2', T: 1_000, m: false,
    }, 'BTC', 'BTCUSDT')).toEqual([]);
  });

  it('ignores Coinbase snapshots and inverts documented maker side', () => {
    const row = {
      trade_id: 'cb-1', product_id: 'BTC-USD', price: '65010', size: '0.1',
      side: 'BUY', time: '2026-07-13T00:00:00.000Z',
    };
    const payload = (type: string) => ({
      channel: 'market_trades', timestamp: '2026-07-13T00:00:00.100Z',
      events: [{ type, trades: [row] }],
    });
    expect(parseCoinbaseTrades(payload('snapshot'), 'BTC', 'BTC-USD')).toEqual([]);
    expect(parseCoinbaseTrades(payload('update'), 'BTC', 'BTC-USD', 2_000)).toEqual([
      expect.objectContaining({ exchange: 'coinbase', side: 'sell', notionalUsd: 6_501 }),
    ]);
  });

  it('normalizes OKX taker-side public trades', () => {
    const parsed = parseOkxTrades({
      arg: { channel: 'trades', instId: 'SOL-USDT' },
      data: [{ instId: 'SOL-USDT', tradeId: '7', px: '200', sz: '12', side: 'buy', ts: '1234' }],
    }, 'SOL', 'SOL-USDT', 1_240);
    expect(parsed).toEqual([expect.objectContaining({
      id: 'SOL-USDT:7', exchange: 'okx', side: 'buy', notionalUsd: 2_400,
    })]);
  });

  it('normalizes Hyperliquid B/A trades and rejects invalid sizes', () => {
    const parsed = parseHyperliquidTapeTrades({
      channel: 'trades',
      data: [
        { coin: 'ETH', side: 'B', px: '3500', sz: '2', time: 2_000, tid: 12 },
        { coin: 'ETH', side: 'A', px: '3499', sz: 'bad', time: 2_001, tid: 13 },
      ],
    }, 'ETH', 'ETH', 2_010);
    expect(parsed).toEqual([expect.objectContaining({
      exchange: 'hyperliquid', side: 'buy', notionalUsd: 7_000,
    })]);
  });
});

describe('trade configuration', () => {
  it('provides complete, ordered thresholds for every Tickerworld market', () => {
    expect(Object.keys(MARKET_TRADE_CONFIG)).toHaveLength(13);
    for (const config of Object.values(MARKET_TRADE_CONFIG)) {
      expect(config.tiers.minor).toBeGreaterThan(0);
      expect(config.tiers.notable).toBeGreaterThan(config.tiers.minor);
      expect(config.tiers.big).toBeGreaterThan(config.tiers.notable);
      expect(config.tiers.whale).toBeGreaterThan(config.tiers.big);
      expect(config.audio.maxVoices).toBe(8);
      expect(config.audio.defaultVolume).toBeGreaterThan(0);
      expect(config.surge.cooldownSeconds).toBeGreaterThanOrEqual(10);
    }
    expect(exchangesForMarket('BTC')).toEqual(['hyperliquid', 'binance', 'coinbase', 'okx']);
    expect(exchangesForMarket('PUMP')).toEqual([]);
  });

  it('classifies exact boundaries and provides monotonic in-tier progress', () => {
    const thresholds = MARKET_TRADE_CONFIG.BTC.tiers;
    expect(classifyTradeTier('BTC', thresholds.minor - 1)).toBe('dust');
    expect(classifyTradeTier('BTC', thresholds.minor)).toBe('minor');
    expect(classifyTradeTier('BTC', thresholds.notable)).toBe('notable');
    expect(classifyTradeTier('BTC', thresholds.big)).toBe('big');
    expect(classifyTradeTier('BTC', thresholds.whale)).toBe('whale');
    expect(tradeTierProgress('BTC', 'big', thresholds.big)).toBe(0);
    expect(tradeTierProgress('BTC', 'big', Math.sqrt(thresholds.big * thresholds.whale))).toBeCloseTo(0.5);
    expect(tradeTierProgress('BTC', 'big', thresholds.whale)).toBe(1);
  });

  it('keeps the largest voices and folds overflow into one side-dominant flush voice', () => {
    const orders = [
      order('largest', 'sell', 120_000),
      order('buy-a', 'buy', 9_000),
      order('buy-b', 'buy', 8_000),
      order('sell-a', 'sell', 2_000),
    ];
    const selected = coalesceTradeAudioOrders(orders, 3);

    expect(selected).toHaveLength(3);
    expect(selected.slice(0, 2).map((item) => item.id)).toEqual(['largest', 'buy-a']);
    expect(selected[2]).toMatchObject({
      id: expect.stringContaining('audio-overflow:BTC:buy'),
      side: 'buy',
      tier: 'notable',
      notionalUsd: 10_000,
      tradeCount: 2,
    });
  });
});

describe('TradeAggregator', () => {
  it('groups cross-venue prints by side/window with exact VWAP and source attribution', () => {
    const aggregator = new TradeAggregator('BTC');
    aggregator.configure('BTC', 4);
    aggregator.pushTrades([
      trade({ id: 'a', exchange: 'binance', price: 100, baseSize: 10, notionalUsd: 1_000 }),
      trade({ id: 'b', exchange: 'coinbase', price: 110, baseSize: 20, notionalUsd: 2_200, timestampMs: 1_030 }),
      trade({ id: 'c', exchange: 'okx', side: 'sell', price: 105, baseSize: 5, notionalUsd: 525 }),
    ], 4);
    const batch = aggregator.flush(1_200);
    expect(batch).toMatchObject({ generation: 4, sequence: 1, symbol: 'BTC', droppedTrades: 0 });
    expect(batch.orders).toHaveLength(2);
    const buy = batch.orders.find((order) => order.side === 'buy')!;
    expect(buy).toMatchObject({
      notionalUsd: 3_200, baseSize: 30, tradeCount: 2,
      sources: ['binance', 'coinbase'], sourceCount: 2, tier: 'minor', simulated: false,
    });
    expect(buy.vwap).toBeCloseTo(106.6666667);
    expect(buy.timestampMs).toBe(buy.endedAt);
    expect(batch.stats.windows['1s']).toMatchObject({
      buy: { notionalUsd: 3_200, tradeCount: 2 },
      sell: { notionalUsd: 525, tradeCount: 1 },
    });
  });

  it('deduplicates venue identities and drops wrong generation/market safely', () => {
    const aggregator = new TradeAggregator('BTC');
    aggregator.configure('BTC', 2);
    expect(aggregator.pushTrades([trade(), trade()], 2)).toBe(1);
    expect(aggregator.pushTrades([trade({ id: 'eth', symbol: 'ETH' })], 2)).toBe(0);
    expect(aggregator.pushTrades([trade({ id: 'stale' })], 1)).toBe(0);
    const batch = aggregator.flush(1_200);
    expect(batch.orders[0]?.tradeCount).toBe(1);
    expect(batch.droppedTrades).toBe(1);
  });

  it('evicts rolling windows independently and retains the one-minute view', () => {
    const aggregator = new TradeAggregator('BTC');
    aggregator.configure('BTC', 1);
    aggregator.pushTrades([
      trade({ id: 'old', receivedAt: 1_000, timestampMs: 1_000, notionalUsd: 10_000, baseSize: 100 }),
      trade({ id: 'new', receivedAt: 10_500, timestampMs: 10_500, notionalUsd: 20_000, baseSize: 200 }),
    ]);
    const batch = aggregator.flush(11_000, true);
    expect(batch.stats.windows['1s'].buy.notionalUsd).toBe(20_000);
    expect(batch.stats.windows['10s'].buy.notionalUsd).toBe(30_000);
    expect(batch.stats.windows['1m'].buy.notionalUsd).toBe(30_000);
    const expired = aggregator.flush(72_000);
    expect(expired.stats.windows['1m'].buy.notionalUsd).toBe(0);
  });

  it('bounds oversized input batches and reports dropped rows', () => {
    const aggregator = new TradeAggregator('BTC');
    const rows = Array.from({ length: TRADE_AGGREGATION_CONFIG.maxInputBatch + 25 }, (_, index) => (
      trade({ id: `bounded-${index}`, timestampMs: 1_000 + index, receivedAt: 1_000 + index })
    ));
    aggregator.pushTrades(rows);
    const batch = aggregator.flush(5_000, true);
    expect(batch.droppedTrades).toBe(25);
    expect(batch.stats.windows['10s'].buy.tradeCount).toBe(TRADE_AGGREGATION_CONFIG.maxInputBatch);
  });
});

class FakeWorker implements TradeWorkerLike {
  readonly sent: TradeWorkerCommand[] = [];
  terminated = false;
  private readonly listeners = new Set<(event: MessageEvent<TradeWorkerEvent>) => void>();

  postMessage(message: TradeWorkerCommand): void { this.sent.push(message); }
  addEventListener(_type: 'message', listener: (event: MessageEvent<TradeWorkerEvent>) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<TradeWorkerEvent>) => void): void {
    this.listeners.delete(listener);
  }
  terminate(): void { this.terminated = true; }
  emit(message: TradeWorkerEvent): void {
    for (const listener of this.listeners) listener({ data: message } as MessageEvent<TradeWorkerEvent>);
  }
}

describe('TradeAggregatorWorkerClient', () => {
  it('chunks worker input, rejects stale output generations, and terminates cleanly', () => {
    const worker = new FakeWorker();
    const client = new TradeAggregatorWorkerClient(() => worker);
    const batches: TradeTapeBatch[] = [];
    client.subscribe((batch) => batches.push(batch));
    client.configure('BTC', 3);
    client.pushTrades(Array.from({ length: 600 }, (_, index) => trade({ id: String(index) })), 3);
    expect(worker.sent.filter((message) => message.type === 'trades')).toHaveLength(2);
    worker.emit({ type: 'batch', batch: tapeBatch(2) });
    worker.emit({ type: 'batch', batch: tapeBatch(3) });
    expect(batches).toHaveLength(1);
    client.dispose();
    expect(worker.sent.at(-1)).toEqual({ type: 'dispose' });
    expect(worker.terminated).toBe(true);
  });
});

// Deliberately broad implementation signature so this fake can model the
// event-specific overloads exposed by WebSocket.
type SocketListener = (event: any) => void;

class FakeSocket implements TradeSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<SocketListener>>();
  closed = false;

  send(data: string): void { this.sent.push(data); }
  close(_code?: number, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', new Event('close'));
  }
  addEventListener(type: 'open', listener: (event: Event) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'close', listener: (event: Event) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  open(): void { this.readyState = 1; this.emit('open', new Event('open')); }
  message(data: unknown): void { this.emit('message', { data } as MessageEvent<unknown>); }
  private emit(type: string, event: Event | MessageEvent<unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('MultiExchangeTradeStream', () => {
  afterEach(() => vi.useRealTimers());

  it('opens all configured venues, emits normalized batches, switches cleanly, and disposes', () => {
    vi.useFakeTimers();
    const sockets: Array<{ url: string; socket: FakeSocket }> = [];
    let now = 5_000;
    const stream = new MultiExchangeTradeStream({
      socketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
      now: () => now,
      random: () => 0.5,
    });
    const received: NormalizedTrade[] = [];
    stream.subscribe((trades) => received.push(...trades));
    stream.start();
    expect(sockets).toHaveLength(4);
    sockets.forEach(({ socket }) => socket.open());
    expect(stream.getHealth().every((health) => health.mode === 'connecting')).toBe(true);

    const binance = sockets.find(({ url }) => url.includes('binance'))!.socket;
    binance.message(JSON.stringify({
      e: 'aggTrade', s: 'BTCUSDT', a: 1, p: '65000', q: '0.1', T: 4_990, m: false,
    }));
    expect(received).toEqual([expect.objectContaining({ exchange: 'binance', side: 'buy' })]);
    expect(stream.getHealth().find((health) => health.exchange === 'binance')?.mode).toBe('live');

    now = 6_000;
    stream.setActiveMarket('WTI');
    expect(sockets.slice(0, 4).every(({ socket }) => socket.closed)).toBe(true);
    expect(sockets).toHaveLength(5);
    expect(sockets[4]?.url).toContain('hyperliquid');
    stream.dispose();
    expect(sockets[4]?.socket.closed).toBe(true);
  });

  it('uses bounded jittered reconnect timing', () => {
    expect(computeTradeReconnectDelay(0, () => 0)).toBe(1_000);
    expect(computeTradeReconnectDelay(1, () => 1)).toBe(2_000);
    expect(computeTradeReconnectDelay(20, () => 1)).toBe(30_000);
  });

  it('times out sockets that never open and resets the timeout for each fresh attempt', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new MultiExchangeTradeStream({
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => Date.now(),
      random: () => 0,
    });
    stream.start();
    const firstAttempt = sockets.slice();

    vi.advanceTimersByTime(TRADE_AGGREGATION_CONFIG.socketOpenTimeoutMs + 2_000);
    expect(firstAttempt.every((socket) => socket.closed)).toBe(true);
    expect(stream.getHealth().every((health) => health.mode === 'reconnecting')).toBe(true);

    vi.advanceTimersByTime(TRADE_AGGREGATION_CONFIG.reconnectMinimumMs);
    const secondAttempt = sockets.slice(firstAttempt.length);
    expect(secondAttempt).toHaveLength(4);
    expect(secondAttempt.every((socket) => !socket.closed)).toBe(true);

    // The reconnect gets a full new open window instead of inheriting the
    // first attempt's creation time.
    vi.advanceTimersByTime(TRADE_AGGREGATION_CONFIG.socketOpenTimeoutMs - 1);
    expect(secondAttempt.every((socket) => !socket.closed)).toBe(true);
    stream.dispose();
  });

  it('times out an opened socket that never yields a valid subscribed trade', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new MultiExchangeTradeStream({
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => Date.now(),
      random: () => 0,
    });
    stream.start();
    sockets.forEach((socket) => {
      socket.open();
      socket.message(JSON.stringify({ result: null, id: 1 }));
    });

    vi.advanceTimersByTime(TRADE_AGGREGATION_CONFIG.subscriptionTimeoutMs + 2_000);
    expect(sockets.slice(0, 4).every((socket) => socket.closed)).toBe(true);
    expect(stream.getHealth().every((health) => health.mode === 'reconnecting')).toBe(true);
    stream.dispose();
  });

  it('keeps exponential retry pressure across open-close loops until a valid trade arrives', () => {
    vi.useFakeTimers();
    const sockets: Array<{ url: string; socket: FakeSocket }> = [];
    const stream = new MultiExchangeTradeStream({
      socketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
      now: () => Date.now(),
      random: () => 1,
    });
    stream.start();
    const binanceSockets = () => sockets.filter(({ url }) => url.includes('binance'));

    const first = binanceSockets()[0]!.socket;
    first.open();
    first.close();
    vi.advanceTimersByTime(999);
    expect(binanceSockets()).toHaveLength(1);
    vi.advanceTimersByTime(1);

    const second = binanceSockets()[1]!.socket;
    second.open();
    second.message(JSON.stringify({ result: null, id: 1 }));
    second.close();
    vi.advanceTimersByTime(1_999);
    expect(binanceSockets()).toHaveLength(2);
    vi.advanceTimersByTime(1);

    const third = binanceSockets()[2]!.socket;
    third.open();
    third.message(JSON.stringify({
      e: 'aggTrade', s: 'BTCUSDT', a: 9, p: '65000', q: '0.1', T: Date.now(), m: false,
    }));
    expect(stream.getHealth().find((item) => item.exchange === 'binance')?.reconnectAttempt).toBe(0);
    third.close();
    vi.advanceTimersByTime(999);
    expect(binanceSockets()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(binanceSockets()).toHaveLength(4);
    stream.dispose();
  });
});

describe('TradeTapeSimulator', () => {
  it('is deterministic, labelled, bounded, and never exposes candle state', () => {
    const first = new TradeTapeSimulator('BTC', 'seed');
    const second = new TradeTapeSimulator('BTC', 'seed');
    expect(first.next(1_000)).toEqual(second.next(1_000));
    const rows = first.next(1_400);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.simulated && row.exchange === 'simulation')).toBe(true);
    expect(rows.every((row) => !('candles' in row))).toBe(true);
    first.setActiveMarket('TEST');
    expect(first.next(2_000).every((row) => row.symbol === 'TEST')).toBe(true);
  });
});

describe('TradeTapeFeed simulation policy', () => {
  afterEach(() => vi.useRealTimers());

  it('uses labelled simulation in TEST after a live route and resumes live sockets afterward', () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    const feed = new TradeTapeFeed({
      activeMarket: 'BTC',
      workerFactory: () => worker,
      streamOptions: {
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      seed: 'route-test',
    });
    feed.start();
    expect(sockets).toHaveLength(4);
    feed.setActiveMarket('TEST');
    const simulationMessages = worker.sent.filter((message) => (
      message.type === 'trades' && message.trades.some((row) => row.simulated)
    ));
    expect(simulationMessages.length).toBeGreaterThan(0);
    expect(feed.getState().mode).toBe('simulated');
    feed.setActiveMarket('ETH');
    expect(sockets).toHaveLength(8);
    expect(feed.getState().symbol).toBe('ETH');
    feed.dispose();
  });

  it('falls back immediately for a market with no live adapters', () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const feed = new TradeTapeFeed({
      activeMarket: 'PUMP',
      workerFactory: () => worker,
      streamOptions: { socketFactory: () => new FakeSocket() },
      seed: 'no-adapter',
    });
    feed.start();
    expect(feed.getState().mode).toBe('simulated');
    expect(worker.sent.some((message) => (
      message.type === 'trades' && message.trades.every((row) => row.simulated)
    ))).toBe(true);
    feed.dispose();
  });

  it('uses a bounded labelled fallback during an outage and clears it when a venue returns', () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    const feed = new TradeTapeFeed({
      activeMarket: 'BTC',
      workerFactory: () => worker,
      streamOptions: {
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      seed: 'outage',
    });
    feed.start();
    const initialGeneration = worker.sent.find((message) => message.type === 'configure')?.generation;
    expect(initialGeneration).toBeTypeOf('number');
    worker.emit({ type: 'batch', batch: tapeBatch(initialGeneration!, 125_000) });
    expect(feed.getState().stats.windows['1m'].buy.notionalUsd).toBe(125_000);

    vi.advanceTimersByTime(TRADE_AGGREGATION_CONFIG.fallbackAfterMs - 1);
    expect(feed.getState().mode).toBe('connecting');
    expect(worker.sent.some((message) => message.type === 'trades')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(feed.getState().mode).toBe('simulated');
    expect(feed.getState().stats.windows['1m'].buy.notionalUsd).toBe(0);
    expect(worker.sent.some((message) => (
      message.type === 'trades' && message.trades.some((row) => row.simulated)
    ))).toBe(true);

    const fallbackConfigurations = worker.sent.filter((message) => message.type === 'configure');
    expect(fallbackConfigurations).toHaveLength(2);
    const fallbackGeneration = fallbackConfigurations.at(-1)!.generation;
    expect(fallbackGeneration).toBeGreaterThan(initialGeneration!);
    worker.emit({ type: 'batch', batch: tapeBatch(fallbackGeneration, 75_000) });
    expect(feed.getState().stats.windows['1m'].buy.notionalUsd).toBe(75_000);

    const countSimulatedMessages = (): number => worker.sent.filter((message) => (
      message.type === 'trades' && message.trades.some((row) => row.simulated)
    )).length;
    const beforeRecovery = countSimulatedMessages();
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      channel: 'trades',
      data: [{ coin: 'BTC', side: 'B', px: '65000', sz: '0.01', time: 8_001, tid: 1 }],
    }));
    expect(feed.getState().mode).toBe('live');
    const configurations = worker.sent.filter((message) => message.type === 'configure');
    expect(configurations).toHaveLength(3);
    const recoveredGeneration = configurations.at(-1)?.generation;
    expect(recoveredGeneration).toBeGreaterThan(fallbackGeneration);
    expect(feed.getState().stats.windows['1m'].buy.notionalUsd).toBe(0);
    const genuine = [...worker.sent].reverse().find((message) => (
      message.type === 'trades' && message.trades.some((row) => !row.simulated)
    ));
    expect(genuine?.type === 'trades' ? genuine.generation : null).toBe(recoveredGeneration);

    // A late synthetic worker result from the abandoned epoch is ignored.
    worker.emit({ type: 'batch', batch: tapeBatch(fallbackGeneration, 999_000) });
    expect(feed.getState().stats.windows['1m'].buy.notionalUsd).toBe(0);
    worker.emit({ type: 'batch', batch: tapeBatch(recoveredGeneration!, 5_000) });
    expect(feed.getState().stats.windows['1m'].buy.notionalUsd).toBe(5_000);
    vi.advanceTimersByTime(TRADE_AGGREGATION_CONFIG.simulationIntervalMs * 3);
    expect(countSimulatedMessages()).toBe(beforeRecovery);
    feed.dispose();
  });
});

// Compile-time coverage: the full market map must remain keyed by AssetSymbol.
const _allMarketConfigs: Readonly<Record<AssetSymbol, unknown>> = MARKET_TRADE_CONFIG;
void _allMarketConfigs;
