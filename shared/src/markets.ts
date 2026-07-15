import type { AssetSymbol, MarketSlug } from './contracts.js';

export type MarketFeedSource = 'hyperliquid' | 'onchain' | 'simulation';
export type HyperliquidDex = 'xyz';

/**
 * One canonical identity for every Tickerworld market. UI names and routes are
 * intentionally separate from upstream symbols: `micron` remains a friendly
 * URL while Hyperliquid receives its exact `xyz:MU` instrument id.
 */
export interface MarketDefinition {
  readonly symbol: AssetSymbol;
  readonly slug: MarketSlug;
  readonly displayName: string;
  readonly feedSource: MarketFeedSource;
  readonly hyperliquidCoin: string | null;
  readonly hyperliquidDex: HyperliquidDex | null;
}

function hyperliquid(
  symbol: AssetSymbol,
  slug: MarketSlug,
  displayName: string,
  coin: string = symbol,
  dex: HyperliquidDex | null = null,
): MarketDefinition {
  return Object.freeze({
    symbol,
    slug,
    displayName,
    feedSource: 'hyperliquid',
    hyperliquidCoin: coin,
    hyperliquidDex: dex,
  });
}

function local(
  symbol: AssetSymbol,
  slug: MarketSlug,
  displayName: string,
  feedSource: Exclude<MarketFeedSource, 'hyperliquid'>,
): MarketDefinition {
  return Object.freeze({
    symbol,
    slug,
    displayName,
    feedSource,
    hyperliquidCoin: null,
    hyperliquidDex: null,
  });
}

/**
 * Exact HIP-3 coin ids were selected from Hyperliquid's live `perpDexs` and
 * `metaAndAssetCtxs` catalog. The `xyz` instruments are the active 24/7
 * contracts; they must retain their prefix in snapshots and subscriptions.
 */
export const MARKET_DEFINITIONS: Readonly<Record<AssetSymbol, MarketDefinition>> = Object.freeze({
  BTC: hyperliquid('BTC', 'btc', 'BTC'),
  ETH: hyperliquid('ETH', 'eth', 'ETH'),
  SOL: hyperliquid('SOL', 'sol', 'SOL'),
  XRP: hyperliquid('XRP', 'xrp', 'XRP'),
  DOGE: hyperliquid('DOGE', 'doge', 'DOGE'),
  BNB: hyperliquid('BNB', 'bnb', 'BNB'),
  LINK: hyperliquid('LINK', 'link', 'LINK'),
  AVAX: hyperliquid('AVAX', 'avax', 'AVAX'),
  WTI: hyperliquid('WTI', 'wti', 'WTI', 'xyz:CL', 'xyz'),
  TEST: local('TEST', 'test', 'TEST', 'simulation'),
  PUMP: local('PUMP', 'pump', 'PUMP', 'onchain'),
  ANSEM: local('ANSEM', 'ansem', 'ANSEM', 'onchain'),
  SHFL: local('SHFL', 'shfl', 'SHFL', 'onchain'),
  SKHYNIX: hyperliquid('SKHYNIX', 'skhynix', 'SK hynix', 'xyz:SKHX', 'xyz'),
  HYPE: hyperliquid('HYPE', 'hype', 'HYPE'),
  XYZ100: hyperliquid('XYZ100', 'xyz100', 'XYZ100', 'xyz:XYZ100', 'xyz'),
  SP500: hyperliquid('SP500', 'sp500', 'S&P 500', 'xyz:SP500', 'xyz'),
  MU: hyperliquid('MU', 'micron', 'Micron', 'xyz:MU', 'xyz'),
  SPACEX: hyperliquid('SPACEX', 'spacex', 'SpaceX', 'xyz:SPCX', 'xyz'),
  NVDA: hyperliquid('NVDA', 'nvidia', 'NVIDIA', 'xyz:NVDA', 'xyz'),
  GOLD: hyperliquid('GOLD', 'gold', 'Gold', 'xyz:GOLD', 'xyz'),
  AAPL: hyperliquid('AAPL', 'apple', 'Apple', 'xyz:AAPL', 'xyz'),
  META: hyperliquid('META', 'meta', 'Meta', 'xyz:META', 'xyz'),
  GOOGL: hyperliquid('GOOGL', 'google', 'Google', 'xyz:GOOGL', 'xyz'),
});

const DEFINITION_BY_SLUG = new Map<MarketSlug, MarketDefinition>(
  Object.values(MARKET_DEFINITIONS).map((definition) => [definition.slug, definition]),
);

const SYMBOL_BY_HYPERLIQUID_COIN = new Map<string, AssetSymbol>(
  Object.values(MARKET_DEFINITIONS)
    .filter((definition) => definition.hyperliquidCoin !== null)
    .map((definition) => [definition.hyperliquidCoin!.toLocaleLowerCase('en-US'), definition.symbol]),
);

export const HYPERLIQUID_ASSET_SYMBOLS = Object.freeze(
  Object.values(MARKET_DEFINITIONS)
    .filter((definition) => definition.feedSource === 'hyperliquid')
    .map((definition) => definition.symbol),
) as readonly AssetSymbol[];

export function marketDefinitionForSymbol(symbol: AssetSymbol): MarketDefinition {
  return MARKET_DEFINITIONS[symbol];
}

export function marketDefinitionForSlug(slug: MarketSlug): MarketDefinition {
  const definition = DEFINITION_BY_SLUG.get(slug);
  if (!definition) throw new Error(`Unknown Tickerworld market slug: ${slug}`);
  return definition;
}

export function marketSlugForAsset(symbol: AssetSymbol): MarketSlug {
  return MARKET_DEFINITIONS[symbol].slug;
}

export function assetSymbolForMarket(slug: MarketSlug): AssetSymbol {
  return marketDefinitionForSlug(slug).symbol;
}

export function hyperliquidCoinForAsset(symbol: AssetSymbol): string | null {
  return MARKET_DEFINITIONS[symbol].hyperliquidCoin;
}

export function hyperliquidDexForAsset(symbol: AssetSymbol): HyperliquidDex | null {
  return MARKET_DEFINITIONS[symbol].hyperliquidDex;
}

export function assetSymbolForHyperliquidCoin(coin: string): AssetSymbol | null {
  return SYMBOL_BY_HYPERLIQUID_COIN.get(coin.trim().toLocaleLowerCase('en-US')) ?? null;
}
