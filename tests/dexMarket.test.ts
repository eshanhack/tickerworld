import { describe, expect, it, vi } from 'vitest';
import { handleDexMarketRequest } from '../api/dex-market';
import {
  DEX_ASSET_SYMBOLS,
  DEX_MARKETS,
  parseDexHistoryResponse,
  parseDexQuotesResponse,
  parseDexScreenerQuote,
  parseGeckoTerminalCandles,
} from '../src/markets';

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
      checkedAt: NOW,
    }, NOW)?.candles).toHaveLength(3);
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
    const fetcher = vi.fn(async () => Response.json(historyPayload()));
    const response = await handleDexMarketRequest(
      new Request('https://tickerworld.test/api/dex-market?history=PUMP'),
      NOW,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toContain('s-maxage=55');
    expect(parseDexHistoryResponse(await response.json(), NOW)?.candles).toHaveLength(3);
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
