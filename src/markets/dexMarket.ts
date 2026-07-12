import type { AssetSymbol, Candle } from '../types';

export const DEX_ASSET_SYMBOLS = ['PUMP', 'ANSEM', 'SHFL'] as const satisfies readonly AssetSymbol[];
export type DexAssetSymbol = (typeof DEX_ASSET_SYMBOLS)[number];

export interface DexMarketDefinition {
  readonly symbol: DexAssetSymbol;
  readonly chain: 'solana' | 'ethereum';
  readonly geckoNetwork: 'solana' | 'eth';
  readonly poolAddress: string;
  readonly baseTokenAddress: string;
}

/**
 * Contract and pool addresses are deliberately pinned. A symbol search is not
 * an identity check and can silently select an impersonator token.
 */
export const DEX_MARKETS: Readonly<Record<DexAssetSymbol, DexMarketDefinition>> = {
  PUMP: {
    symbol: 'PUMP',
    chain: 'solana',
    geckoNetwork: 'solana',
    poolAddress: '2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd',
    baseTokenAddress: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
  },
  ANSEM: {
    symbol: 'ANSEM',
    chain: 'solana',
    geckoNetwork: 'solana',
    poolAddress: 'FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC',
    baseTokenAddress: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  },
  SHFL: {
    symbol: 'SHFL',
    chain: 'ethereum',
    geckoNetwork: 'eth',
    poolAddress: '0xD0A4c8A1a14530C7C9EfDaD0BA37E8cF4204d230',
    baseTokenAddress: '0x8881562783028F5c1BCB985d2283D5E170D88888',
  },
};

export interface DexMarketQuote {
  readonly symbol: DexAssetSymbol;
  readonly chain: DexMarketDefinition['chain'];
  readonly poolAddress: string;
  readonly priceUsd: number;
  readonly checkedAt: number;
}

export interface DexQuotesResponse {
  readonly provider: 'dexscreener';
  readonly markets: readonly DexMarketQuote[];
  readonly checkedAt: number;
}

export interface DexHistoryResponse {
  readonly provider: 'geckoterminal';
  readonly market: DexMarketDefinition;
  readonly candles: readonly Candle[];
  readonly checkedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): number | null {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sameAddress(chain: DexMarketDefinition['chain'], left: string, right: string): boolean {
  return chain === 'ethereum' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isDexAssetSymbol(symbol: AssetSymbol): symbol is DexAssetSymbol {
  return (DEX_ASSET_SYMBOLS as readonly string[]).includes(symbol);
}

export function parseDexScreenerQuote(
  payload: unknown,
  market: DexMarketDefinition,
  checkedAt = Date.now(),
): DexMarketQuote | null {
  if (!isRecord(payload)) return null;
  const candidates = Array.isArray(payload.pairs)
    ? payload.pairs
    : isRecord(payload.pair) ? [payload.pair] : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)
      || candidate.chainId !== market.chain
      || typeof candidate.pairAddress !== 'string'
      || !sameAddress(market.chain, candidate.pairAddress, market.poolAddress)
      || !isRecord(candidate.baseToken)
      || typeof candidate.baseToken.address !== 'string'
      || !sameAddress(market.chain, candidate.baseToken.address, market.baseTokenAddress)) continue;
    const priceUsd = finitePositive(candidate.priceUsd);
    if (priceUsd === null) continue;
    return {
      symbol: market.symbol,
      chain: market.chain,
      poolAddress: market.poolAddress,
      priceUsd,
      checkedAt,
    };
  }
  return null;
}

export function parseGeckoTerminalCandles(
  payload: unknown,
  now = Date.now(),
  maxCount = 120,
): Candle[] {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.attributes)) return [];
  const rows = payload.data.attributes.ohlcv_list;
  if (!Array.isArray(rows)) return [];
  const byOpenTime = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const timestampSeconds = finitePositive(row[0]);
    const open = finitePositive(row[1]);
    const high = finitePositive(row[2]);
    const low = finitePositive(row[3]);
    const close = finitePositive(row[4]);
    if (timestampSeconds === null || open === null || high === null || low === null || close === null
      || high < low || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    const openTime = Math.floor(timestampSeconds) * 1_000;
    if (openTime > now + 60_000) continue;
    byOpenTime.set(openTime, { openTime, open, high, low, close, closed: true });
  }
  const candles = [...byOpenTime.values()]
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-Math.max(2, Math.floor(maxCount)));
  const latest = candles.at(-1);
  if (latest) latest.closed = false;
  return candles;
}

export function parseDexQuotesResponse(payload: unknown): DexQuotesResponse | null {
  if (!isRecord(payload) || payload.provider !== 'dexscreener' || !Array.isArray(payload.markets)) return null;
  const checkedAt = finitePositive(payload.checkedAt);
  if (checkedAt === null) return null;
  const markets: DexMarketQuote[] = [];
  const seen = new Set<DexAssetSymbol>();
  for (const item of payload.markets) {
    if (!isRecord(item) || typeof item.symbol !== 'string'
      || !(DEX_ASSET_SYMBOLS as readonly string[]).includes(item.symbol)
      || (item.chain !== 'solana' && item.chain !== 'ethereum')
      || typeof item.poolAddress !== 'string') return null;
    const symbol = item.symbol as DexAssetSymbol;
    const definition = DEX_MARKETS[symbol];
    if (seen.has(symbol)
      || item.chain !== definition.chain
      || !sameAddress(definition.chain, item.poolAddress, definition.poolAddress)) return null;
    const priceUsd = finitePositive(item.priceUsd);
    const itemCheckedAt = finitePositive(item.checkedAt);
    if (priceUsd === null || itemCheckedAt === null) return null;
    markets.push({
      symbol,
      chain: item.chain,
      poolAddress: item.poolAddress,
      priceUsd,
      checkedAt: itemCheckedAt,
    });
    seen.add(symbol);
  }
  return markets.length > 0 && markets.length <= DEX_ASSET_SYMBOLS.length
    ? { provider: 'dexscreener', markets, checkedAt }
    : null;
}

export function parseDexHistoryResponse(payload: unknown, now = Date.now()): DexHistoryResponse | null {
  if (!isRecord(payload) || payload.provider !== 'geckoterminal' || !isRecord(payload.market)) return null;
  const symbol = payload.market.symbol;
  if (typeof symbol !== 'string' || !(DEX_ASSET_SYMBOLS as readonly string[]).includes(symbol)) return null;
  const definition = DEX_MARKETS[symbol as DexAssetSymbol];
  if (payload.market.poolAddress !== definition.poolAddress
    || payload.market.baseTokenAddress !== definition.baseTokenAddress
    || payload.market.chain !== definition.chain
    || payload.market.geckoNetwork !== definition.geckoNetwork) return null;
  const checkedAt = finitePositive(payload.checkedAt);
  // The API returns normalized candle objects, so parse those separately.
  const normalized = Array.isArray(payload.candles)
    ? payload.candles.flatMap((item): Candle[] => {
      if (!isRecord(item)) return [];
      const openTime = finitePositive(item.openTime);
      const open = finitePositive(item.open);
      const high = finitePositive(item.high);
      const low = finitePositive(item.low);
      const close = finitePositive(item.close);
      if (openTime === null || open === null || high === null || low === null || close === null
        || openTime > now + 60_000 || high < Math.max(open, close) || low > Math.min(open, close)) return [];
      return [{ openTime, open, high, low, close, closed: item.closed === true }];
    }).sort((left, right) => left.openTime - right.openTime).slice(-120)
    : [];
  if (checkedAt === null || normalized.length < 2) return null;
  normalized.forEach((candle, index) => { candle.closed = index < normalized.length - 1; });
  return { provider: 'geckoterminal', market: definition, candles: normalized, checkedAt };
}
