import {
  DEX_ASSET_SYMBOLS,
  DEX_MARKETS,
  parseDexScreenerQuote,
  parseGeckoTerminalCandles,
  type DexAssetSymbol,
  type DexHistoryResponse,
  type DexQuotesResponse,
} from '../src/markets/dexMarket.js';

declare const process: { readonly env: Record<string, string | undefined> };

type ServerFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 7_000;
const FAILURE_CIRCUIT_MS = 2_000;
let quoteFailureUntil = 0;
const historyFailureUntil = new Map<DexAssetSymbol, number>();

function headers(cacheControl: string): HeadersInit {
  return {
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Vercel-CDN-Cache-Control': cacheControl,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

function reject(status: 400 | 405): Response {
  return new Response(status === 405 ? 'Method Not Allowed' : 'Bad Request', {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 405 ? { Allow: 'GET' } : {}),
    },
  });
}

function unavailable(checkedAt: number): Response {
  return Response.json({ error: 'dex_market_unavailable', checkedAt }, {
    status: 503,
    headers: {
      ...headers('public, s-maxage=2, stale-while-revalidate=5'),
      'Retry-After': '2',
    },
  });
}

async function fetchJson(
  url: string,
  fetcher: ServerFetcher,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', ...extraHeaders },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('upstream_unavailable');
  return response.json();
}

async function currentQuotes(checkedAt: number, fetcher: ServerFetcher): Promise<Response> {
  const settled = await Promise.allSettled(DEX_ASSET_SYMBOLS.map(async (symbol) => {
    const market = DEX_MARKETS[symbol];
    const url = `https://api.dexscreener.com/latest/dex/pairs/${market.chain}/${encodeURIComponent(market.poolAddress)}`;
    const quote = parseDexScreenerQuote(await fetchJson(url, fetcher), market, checkedAt);
    if (!quote) throw new Error('invalid_pair_identity');
    return quote;
  }));
  const markets = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (markets.length === 0) throw new Error('all_dex_markets_unavailable');
  const body: DexQuotesResponse = { provider: 'dexscreener', markets, checkedAt };
  return Response.json(body, { headers: headers('public, s-maxage=3, stale-while-revalidate=7') });
}

async function candleHistory(
  symbol: DexAssetSymbol,
  checkedAt: number,
  fetcher: ServerFetcher,
): Promise<Response> {
  const market = DEX_MARKETS[symbol];
  const proKey = process.env.COINGECKO_PRO_API_KEY?.trim();
  const apiRoot = proKey
    ? 'https://pro-api.coingecko.com/api/v3/onchain'
    : 'https://api.geckoterminal.com/api/v2';
  const url = new URL(`${apiRoot}/networks/${market.geckoNetwork}/pools/${encodeURIComponent(market.poolAddress)}/ohlcv/minute`);
  url.searchParams.set('aggregate', '1');
  // Keep the rendered chart at 30 while retaining enough source history for
  // the existing one-hour horizon indicator.
  url.searchParams.set('limit', '120');
  url.searchParams.set('currency', 'usd');
  const candles = parseGeckoTerminalCandles(await fetchJson(
    url.toString(),
    fetcher,
    proKey ? { 'x-cg-pro-api-key': proKey } : {},
  ), checkedAt);
  if (candles.length < 2) throw new Error('invalid_candle_history');
  const body: DexHistoryResponse = { provider: 'geckoterminal', market, candles, checkedAt };
  return Response.json(body, { headers: headers('public, s-maxage=55, stale-while-revalidate=15') });
}

export async function handleDexMarketRequest(
  request: Request,
  checkedAt = Date.now(),
  fetcher: ServerFetcher = fetch,
): Promise<Response> {
  if (request.method !== 'GET') return reject(405);
  if (request.headers.has('authorization') || request.headers.has('range')) return reject(400);
  const url = new URL(request.url);
  const historyValues = url.searchParams.getAll('history');
  if ([...url.searchParams.keys()].some((key) => key !== 'history') || historyValues.length > 1) return reject(400);
  const history = historyValues[0]?.toUpperCase();
  if (history !== undefined && !(DEX_ASSET_SYMBOLS as readonly string[]).includes(history)) return reject(400);
  if (history) {
    const retryAt = historyFailureUntil.get(history as DexAssetSymbol) ?? 0;
    if (checkedAt < retryAt) return unavailable(checkedAt);
  } else if (checkedAt < quoteFailureUntil) {
    return unavailable(checkedAt);
  }
  try {
    const response = history
      ? await candleHistory(history as DexAssetSymbol, checkedAt, fetcher)
      : await currentQuotes(checkedAt, fetcher);
    if (history) historyFailureUntil.delete(history as DexAssetSymbol);
    else quoteFailureUntil = 0;
    return response;
  } catch {
    if (history) historyFailureUntil.set(history as DexAssetSymbol, checkedAt + FAILURE_CIRCUIT_MS);
    else quoteFailureUntil = checkedAt + FAILURE_CIRCUIT_MS;
    return unavailable(checkedAt);
  }
}

export default {
  fetch: (request: Request) => handleDexMarketRequest(request),
};
