import { describe, expect, it, vi } from 'vitest';
import { handleDexMarketRequest } from '../api/dex-market';
import {
  DEX_ASSET_SYMBOLS,
  DEX_MARKETS,
  HyperliquidMarketFeed,
  createEmptyHorizonChanges,
  parseDexHistoryResponse,
  parseDexQuotesResponse,
  parseDexScreenerQuote,
  parseDexTradesResponse,
  parseGeckoTerminalCandles,
  parseGeckoTerminalTrades,
} from '../src/markets';
import type { AssetState, Candle } from '../src/types';

const NOW = 1_750_000_000_000;

function pairPayload(symbol: (typeof DEX_ASSET_SYMBOLS)[number], price = '0.25'): unknown {
  const market = DEX_MARKETS[symbol];
  return {
    pairs: [{
      chainId: market.chain,
      pairAddress: market.poolAddress,
      priceUsd: price,
      baseToken: { address: market.baseTokenAddress, symbol },
    }],
  };
}

function historyPayload(): unknown {
  const minute = Math.floor(NOW / 60_000) * 60;
  return {
    data: {
      attributes: {
        // GeckoTerminal returns newest first.
        ohlcv_list: [
          [minute, '1.2', '1.4', '1.1', '1.3', '100'],
          [minute - 60, '1.0', '1.25', '0.9', '1.2', '90'],
          [minute - 120, '0.95', '1.1', '0.9', '1.0', '80'],
        ],
      },
    },
  };
}

function tradesPayload(): unknown {
  const market = DEX_MARKETS.ANSEM;
  return {
    data: [
      {
        id: 'newer',
        type: 'trade',
        attributes: {
          from_token_address: 'QuoteToken',
          to_token_address: market.baseTokenAddress,
          from_token_amount: '20',
          to_token_amount: '10',
          price_from_in_usd: '1',
          price_to_in_usd: '2',
          volume_in_usd: '20',
          block_timestamp: new Date(NOW - 1_000).toISOString(),
          kind: 'buy',
        },
      },
      {
        id: 'older',
        type: 'trade',
        attributes: {
          from_token_address: market.baseTokenAddress,
          to_token_address: 'QuoteToken',
          from_token_amount: '4',
          to_token_amount: '7.6',
          price_from_in_usd: '1.9',
          price_to_in_usd: '1',
          volume_in_usd: '7.6',
          block_timestamp: new Date(NOW - 2_000).toISOString(),
          kind: 'sell',
        },
      },
    ],
  };
}

describe('contract-pinned DEX market parsing', () => {
  it('accepts every configured exact pair and rejects a same-symbol impostor', () => {
    for (const symbol of DEX_ASSET_SYMBOLS) {
      expect(parseDexScreenerQuote(pairPayload(symbol), DEX_MARKETS[symbol], NOW)).toMatchObject({
        symbol,
        poolAddress: DEX_MARKETS[symbol].poolAddress,
        checkedAt: NOW,
      });
    }
    const impostor = pairPayload('PUMP') as { pairs: Array<Record<string, unknown>> };
    impostor.pairs[0] = { ...impostor.pairs[0], pairAddress: 'ImpostorPool', priceUsd: '999' };
    expect(parseDexScreenerQuote(impostor, DEX_MARKETS.PUMP, NOW)).toBeNull();
  });

  it('normalizes newest-first numeric OHLCV rows into one ascending live window', () => {
    const candles = parseGeckoTerminalCandles(historyPayload(), NOW);
    expect(candles).toHaveLength(3);
    expect(candles.map(({ openTime }) => openTime)).toEqual([...candles.map(({ openTime }) => openTime)].sort());
    expect(candles.at(-1)).toMatchObject({ open: 1.2, high: 1.4, low: 1.1, close: 1.3, closed: false });
    expect(candles.slice(0, -1).every(({ closed }) => closed)).toBe(true);
  });

  it('validates normalized client quote and candle response identities', () => {
    const markets = DEX_ASSET_SYMBOLS.map((symbol, index) => ({
      symbol,
      chain: DEX_MARKETS[symbol].chain,
      poolAddress: DEX_MARKETS[symbol].poolAddress,
      priceUsd: 1 + index,
      checkedAt: NOW,
    }));
    expect(parseDexQuotesResponse({ provider: 'dexscreener', markets, checkedAt: NOW })?.markets).toHaveLength(3);
    const candles = parseGeckoTerminalCandles(historyPayload(), NOW);
    expect(parseDexHistoryResponse({
      provider: 'geckoterminal',
      market: DEX_MARKETS.SHFL,
      candles,
      dailyCandles: candles,
      checkedAt: NOW,
    }, NOW)?.candles).toHaveLength(3);
  });

  it('normalizes exact-pool base-token trades in chronological order', () => {
    const trades = parseGeckoTerminalTrades(tradesPayload(), DEX_MARKETS.ANSEM, NOW);
    expect(trades).toEqual([
      expect.objectContaining({ id: 'older', side: 'sell', priceUsd: 1.9, baseAmount: 4 }),
      expect.objectContaining({ id: 'newer', side: 'buy', priceUsd: 2, baseAmount: 10 }),
    ]);
    const normalized = parseDexTradesResponse({
      provider: 'geckoterminal',
      market: DEX_MARKETS.ANSEM,
      trades,
      checkedAt: NOW,
    }, NOW);
    expect(normalized?.trades).toHaveLength(2);
    expect(parseGeckoTerminalTrades({ data: [{
      id: 'impostor',
      attributes: {
        from_token_address: 'wrong', to_token_address: 'also-wrong',
        price_from_in_usd: '999', from_token_amount: '1', volume_in_usd: '999',
        block_timestamp: new Date(NOW).toISOString(),
      },
    }] }, DEX_MARKETS.ANSEM, NOW)).toEqual([]);
  });
});

describe('/api/dex-market', () => {
  it('coalesces all three exact pool quotes behind a short shared CDN cache', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const symbol = DEX_ASSET_SYMBOLS.find((candidate) => url.includes(DEX_MARKETS[candidate].poolAddress));
      return symbol
        ? Response.json(pairPayload(symbol))
        : new Response('missing', { status: 404 });
    });
    const response = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market'),
      NOW,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toContain('s-maxage=3');
    expect(parseDexQuotesResponse(await response.json())?.markets).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps healthy DEX markets live when one exact pool is temporarily unavailable', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(DEX_MARKETS.ANSEM.poolAddress)) return new Response('down', { status: 503 });
      const symbol = DEX_ASSET_SYMBOLS.find((candidate) => url.includes(DEX_MARKETS[candidate].poolAddress));
      return symbol ? Response.json(pairPayload(symbol)) : new Response('missing', { status: 404 });
    });
    const response = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market'),
      NOW,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(parseDexQuotesResponse(await response.json())?.markets.map(({ symbol }) => symbol))
      .toEqual(['PUMP', 'SHFL']);
  });

  it('serves one normalized history window and fails closed on invalid requests', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json(historyPayload()));
    const response = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market?history=PUMP'),
      NOW,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toContain('s-maxage=55');
    const history = parseDexHistoryResponse(await response.json(), NOW);
    expect(history?.candles).toHaveLength(3);
    expect(history?.dailyCandles).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/ohlcv/day'))).toBe(true);
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('include_empty_intervals=true'))).toBe(true);
    await expect(handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market?history=NOT_PUMP'),
      NOW,
      fetcher,
    )).resolves.toMatchObject({ status: 400 });
    await expect(handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market', { method: 'POST' }),
      NOW,
      fetcher,
    )).resolves.toMatchObject({ status: 405 });
  });

  it('serves identity-checked on-chain prints behind a short shared cache', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json(tradesPayload()));
    const response = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market?trades=ANSEM'),
      NOW,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toContain('s-maxage=2');
    const parsed = parseDexTradesResponse(await response.json(), NOW);
    expect(parsed?.trades.map(({ id }) => id)).toEqual(['older', 'newer']);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/networks/solana/pools/');
    await expect(handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market?history=PUMP&trades=PUMP'),
      NOW,
      fetcher,
    )).resolves.toMatchObject({ status: 400 });
  });

  it('retains only previously verified on-chain trades through a brief upstream outage', async () => {
    const healthy = vi.fn(async () => Response.json(tradesPayload()));
    const first = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market?trades=ANSEM'),
      NOW + 10_000,
      healthy,
    );
    expect(first.status).toBe(200);
    const unavailable = vi.fn(async () => new Response('upstream unavailable', { status: 503 }));
    const fallback = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market?trades=ANSEM'),
      NOW + 10_001,
      unavailable,
    );
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('X-Tickerworld-Data')).toBe('stale-onchain-trades');
    expect(parseDexTradesResponse(await fallback.json(), NOW + 10_001)?.trades).toHaveLength(2);
  });

  it('never returns a similarly named pair when the configured pool identity fails', async () => {
    const fetcher = vi.fn(async () => Response.json({
      pairs: [{
        chainId: 'solana',
        pairAddress: 'wrong',
        priceUsd: '5',
        baseToken: { address: DEX_MARKETS.PUMP.baseTokenAddress, symbol: 'PUMP' },
      }],
    }));
    const response = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market'),
      NOW,
      fetcher,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'dex_market_unavailable', checkedAt: NOW });
  });
});

describe('DEX chart presentation', () => {
  it('uses a changed genuine DEX quote as a labelled pulse only while exact prints are stale', async () => {
    const activeOpen = Math.floor(NOW / 60_000) * 60_000;
    const candles: Candle[] = [
      { openTime: activeOpen - 60_000, open: 2, high: 2, low: 2, close: 2, closed: true },
      { openTime: activeOpen, open: 2, high: 2, low: 2, close: 2, closed: false },
    ];
    const state: AssetState = {
      symbol: 'ANSEM', instrument: 'ANSEM', provider: 'dexscreener', candles, price: 2, previousPrice: 2,
      direction: 'flat', mode: 'live', updateKind: 'snapshot', updatedAt: NOW - 2_000,
      presentationTick: 0, horizonChanges: createEmptyHorizonChanges(),
    };
    const quote = (priceUsd: number, checkedAt: number) => Response.json({
      provider: 'dexscreener',
      markets: [{
        symbol: 'ANSEM', chain: 'solana', poolAddress: DEX_MARKETS.ANSEM.poolAddress, priceUsd, checkedAt,
      }],
      checkedAt,
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(quote(2.1, NOW))
      .mockResolvedValueOnce(quote(2.2, NOW + 3_000));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const feed = new HyperliquidMarketFeed();
    const internals = feed as unknown as {
      activeSymbol: 'ANSEM';
      states: Map<string, AssetState>;
      minuteHistories: Map<string, Candle[]>;
      initializedDexQuotes: Set<string>;
      lastExactDexFeedAt: Map<string, number>;
      lastDexPollAt: number;
      pollDexMarkets(): Promise<void>;
    };
    internals.activeSymbol = 'ANSEM';
    internals.states.set('ANSEM', state);
    internals.minuteHistories.set('ANSEM', candles);
    internals.initializedDexQuotes.add('ANSEM');

    await internals.pollDexMarkets();
    expect(feed.getState('ANSEM')).toMatchObject({
      price: 2.1, direction: 'up', updateKind: 'quote', presentationTick: 1,
    });

    internals.lastExactDexFeedAt.set('ANSEM', NOW + 3_000);
    internals.lastDexPollAt = Number.NEGATIVE_INFINITY;
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 3_000);
    await internals.pollDexMarkets();
    expect(feed.getState('ANSEM')).toMatchObject({
      price: 2.2, direction: 'up', updateKind: 'snapshot', presentationTick: 1,
    });
    feed.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('seeds silently, then turns each newly observed on-chain print into a real trade pulse', async () => {
    const activeOpen = Math.floor(NOW / 60_000) * 60_000;
    const candle: Candle = {
      openTime: activeOpen,
      open: 2,
      high: 2,
      low: 2,
      close: 2,
      closed: false,
    };
    const state: AssetState = {
      symbol: 'ANSEM',
      instrument: 'ANSEM',
      provider: 'dexscreener',
      candles: [candle],
      price: 2,
      previousPrice: 2,
      direction: 'flat',
      mode: 'live',
      updateKind: 'snapshot',
      updatedAt: NOW - 2_000,
      presentationTick: 0,
      horizonChanges: createEmptyHorizonChanges(),
    };
    const first = parseGeckoTerminalTrades(tradesPayload(), DEX_MARKETS.ANSEM, NOW);
    const responseFor = (trades: readonly unknown[]) => Response.json({
      provider: 'geckoterminal',
      market: DEX_MARKETS.ANSEM,
      trades,
      checkedAt: NOW,
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(responseFor(first))
      .mockResolvedValueOnce(responseFor([
        ...first,
        {
          id: 'new-print', symbol: 'ANSEM', side: 'buy', priceUsd: 2.1,
          baseAmount: 5, volumeUsd: 10.5, time: NOW,
        },
      ]));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const feed = new HyperliquidMarketFeed();
    const internals = feed as unknown as {
      activeSymbol: 'ANSEM';
      states: Map<string, AssetState>;
      minuteHistories: Map<string, Candle[]>;
      pollActiveDexTrades(): Promise<void>;
      flushTrades(): void;
    };
    internals.activeSymbol = 'ANSEM';
    internals.states.set('ANSEM', state);
    internals.minuteHistories.set('ANSEM', [candle]);

    await internals.pollActiveDexTrades();
    expect(feed.getState('ANSEM')).toMatchObject({
      provider: 'geckoterminal', updateKind: 'snapshot', presentationTick: 0,
    });
    await internals.pollActiveDexTrades();
    internals.flushTrades();
    expect(feed.getState('ANSEM')).toMatchObject({
      provider: 'geckoterminal', price: 2.1, previousPrice: 2, direction: 'up',
      updateKind: 'trade', presentationTick: 1,
    });
    feed.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
