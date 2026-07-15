import {
  DEX_ASSET_SYMBOLS,
  DEX_MARKETS,
  parseDexScreenerQuote,
  parseGeckoTerminalCandles,
  parseGeckoTerminalTrades,
  type DexAssetSymbol,
  type DexHistoryResponse,
  type DexQuotesResponse,
  type DexTradesResponse,
} from '../src/markets/dexMarket.js';

declare const process: { readonly env: Record<string, string | undefined> };

type ServerFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 7_000;
const FAILURE_CIRCUIT_MS = 2_000;
const GECKO_FAILURE_CIRCUIT_MS = 10_000;
const HISTORY_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=86400';
const STALE_HISTORY_CACHE_CONTROL = 'public, s-maxage=30, stale-while-revalidate=300';
const TRADE_CACHE_CONTROL = 'public, s-maxage=10, stale-while-revalidate=60';
const UPSTREAM_USER_AGENT = 'Tickerworld/1.0 (+https://tickerworld.io)';
let quoteFailureUntil = 0;
const historyFailureUntil = new Map<DexAssetSymbol, number>();
const tradeFailureUntil = new Map<DexAssetSymbol, number>();
const pendingHistory = new Map<DexAssetSymbol, Promise<Response>>();
const pendingTrades = new Map<DexAssetSymbol, Promise<Response>>();
const lastGoodHistory = new Map<DexAssetSymbol, DexHistoryResponse>();
const lastGoodTrades = new Map<DexAssetSymbol, DexTradesResponse>();

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

function unavailable(checkedAt: number, retrySeconds = 2): Response {
  return Response.json({ error: 'dex_market_unavailable', checkedAt }, {
    status: 503,
    headers: {
      ...headers(`public, s-maxage=${retrySeconds}, stale-while-revalidate=${retrySeconds * 2}`),
      'Retry-After': String(retrySeconds),
    },
  });
}

/** Collapse same-symbol cache misses inside a warm function isolate. The
 * Vercel cache handles steady-state traffic; this prevents a cold-edge burst
 * from multiplying the same constrained GeckoTerminal request. */
function coalesce(
  requests: Map<DexAssetSymbol, Promise<Response>>,
  symbol: DexAssetSymbol,
  create: () => Promise<Response>,
): Promise<Response> {
  const existing = requests.get(symbol);
  if (existing) return existing.then((response) => response.clone());
  let pending: Promise<Response>;
  pending = create().finally(() => {
    if (requests.get(symbol) === pending) requests.delete(symbol);
  });
  requests.set(symbol, pending);
  return pending.then((response) => response.clone());
}

/** Retain only a history payload that already passed exact pool/token parsing. */
function staleHistory(symbol: DexAssetSymbol): Response | null {
  const cached = lastGoodHistory.get(symbol);
  if (!cached) return null;
  return Response.json(cached, {
    headers: {
      ...headers(STALE_HISTORY_CACHE_CONTROL),
      'X-Tickerworld-Data': 'stale-onchain-history',
    },
  });
}

/** Retain only real, previously verified prints when an upstream has a brief outage. */
function staleTrades(symbol: DexAssetSymbol): Response | null {
  const cached = lastGoodTrades.get(symbol);
  if (!cached) return null;
  return Response.json(cached, {
    headers: {
      ...headers('public, s-maxage=1, stale-while-revalidate=5'),
      'X-Tickerworld-Data': 'stale-onchain-trades',
    },
  });
}

async function fetchJson(
  url: string,
  fetcher: ServerFetcher,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': UPSTREAM_USER_AGENT,
      ...extraHeaders,
    },
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
  const demoKey = process.env.COINGECKO_DEMO_API_KEY?.trim();
  const apiRoot = proKey
    ? 'https://pro-api.coingecko.com/api/v3/onchain'
    : demoKey
      ? 'https://api.coingecko.com/api/v3/onchain'
      : 'https://api.geckoterminal.com/api/v2';
  const apiHeaders: Readonly<Record<string, string>> = proKey
    ? { 'x-cg-pro-api-key': proKey }
    : demoKey
      ? { 'x-cg-demo-api-key': demoKey }
      : {};
  const candlesUrl = (timeframe: 'minute' | 'day', limit: number): string => {
    const url = new URL(`${apiRoot}/networks/${market.geckoNetwork}/pools/${encodeURIComponent(market.poolAddress)}/ohlcv/${timeframe}`);
    url.searchParams.set('aggregate', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('currency', 'usd');
    url.searchParams.set('token', 'base');
    url.searchParams.set('include_empty_intervals', 'true');
    return url.toString();
  };
  const [candles, dailyCandles] = await Promise.all([
    fetchJson(candlesUrl('minute', 120), fetcher, apiHeaders)
      .then((payload) => parseGeckoTerminalCandles(payload, checkedAt, 120)),
    fetchJson(candlesUrl('day', 370), fetcher, apiHeaders)
      .then((payload) => parseGeckoTerminalCandles(payload, checkedAt, 370))
      .catch(() => []),
  ]);
  if (candles.length < 2) throw new Error('invalid_candle_history');
  const body: DexHistoryResponse = { provider: 'geckoterminal', market, candles, dailyCandles, checkedAt };
  lastGoodHistory.set(symbol, body);
  return Response.json(body, { headers: headers(HISTORY_CACHE_CONTROL) });
}

async function recentTrades(
  symbol: DexAssetSymbol,
  checkedAt: number,
  fetcher: ServerFetcher,
): Promise<Response> {
  const market = DEX_MARKETS[symbol];
  const proKey = process.env.COINGECKO_PRO_API_KEY?.trim();
  const demoKey = process.env.COINGECKO_DEMO_API_KEY?.trim();
  const apiRoot = proKey
    ? 'https://pro-api.coingecko.com/api/v3/onchain'
    : demoKey
      ? 'https://api.coingecko.com/api/v3/onchain'
      : 'https://api.geckoterminal.com/api/v2';
  const apiHeaders: Readonly<Record<string, string>> = proKey
    ? { 'x-cg-pro-api-key': proKey }
    : demoKey
      ? { 'x-cg-demo-api-key': demoKey }
      : {};
  const url = `${apiRoot}/networks/${market.geckoNetwork}/pools/${encodeURIComponent(market.poolAddress)}/trades`;
  const trades = parseGeckoTerminalTrades(await fetchJson(url, fetcher, apiHeaders), market, checkedAt);
  const body: DexTradesResponse = { provider: 'geckoterminal', market, trades, checkedAt };
  lastGoodTrades.set(symbol, body);
  return Response.json(body, { headers: headers(TRADE_CACHE_CONTROL) });
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
  const tradeValues = url.searchParams.getAll('trades');
  if ([...url.searchParams.keys()].some((key) => key !== 'history' && key !== 'trades')
    || historyValues.length > 1 || tradeValues.length > 1
    || (historyValues.length > 0 && tradeValues.length > 0)) return reject(400);
  const history = historyValues[0]?.toUpperCase();
  const trades = tradeValues[0]?.toUpperCase();
  if (history !== undefined && !(DEX_ASSET_SYMBOLS as readonly string[]).includes(history)) return reject(400);
  if (trades !== undefined && !(DEX_ASSET_SYMBOLS as readonly string[]).includes(trades)) return reject(400);
  if (history) {
    const retryAt = historyFailureUntil.get(history as DexAssetSymbol) ?? 0;
    if (checkedAt < retryAt) {
      return staleHistory(history as DexAssetSymbol) ?? unavailable(checkedAt, 10);
    }
  } else if (trades) {
    const retryAt = tradeFailureUntil.get(trades as DexAssetSymbol) ?? 0;
    if (checkedAt < retryAt) return staleTrades(trades as DexAssetSymbol) ?? unavailable(checkedAt, 10);
  } else if (checkedAt < quoteFailureUntil) {
    return unavailable(checkedAt);
  }
  try {
    const response = history
      ? await coalesce(
        pendingHistory,
        history as DexAssetSymbol,
        () => candleHistory(history as DexAssetSymbol, checkedAt, fetcher),
      )
      : trades
        ? await coalesce(
          pendingTrades,
          trades as DexAssetSymbol,
          () => recentTrades(trades as DexAssetSymbol, checkedAt, fetcher),
        )
        : await currentQuotes(checkedAt, fetcher);
    if (history) historyFailureUntil.delete(history as DexAssetSymbol);
    else if (trades) tradeFailureUntil.delete(trades as DexAssetSymbol);
    else quoteFailureUntil = 0;
    return response;
  } catch {
    if (history) {
      historyFailureUntil.set(history as DexAssetSymbol, checkedAt + GECKO_FAILURE_CIRCUIT_MS);
      return staleHistory(history as DexAssetSymbol) ?? unavailable(checkedAt, 10);
    }
    else if (trades) {
      tradeFailureUntil.set(trades as DexAssetSymbol, checkedAt + GECKO_FAILURE_CIRCUIT_MS);
      return staleTrades(trades as DexAssetSymbol) ?? unavailable(checkedAt, 10);
    }
    else quoteFailureUntil = checkedAt + FAILURE_CIRCUIT_MS;
    return unavailable(checkedAt);
  }
}

export default {
  fetch: (request: Request) => handleDexMarketRequest(request),
};
