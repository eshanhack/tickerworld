import { ASSET_SYMBOLS } from '../types';
import type { AssetSymbol } from '../types';
import {
  MARKET_SLUGS,
  assetSymbolForMarket,
  marketDefinitionForSlug,
  marketSlugForAsset,
  type MarketSlug,
} from '../../shared/src/index.js';

export { MARKET_SLUGS };
export type { MarketSlug };
export type MarketRouteReason = 'route' | 'remembered' | 'default' | 'unknown';

export interface MarketChoice {
  readonly symbol: AssetSymbol;
  readonly slug: MarketSlug;
  readonly path: `/${MarketSlug}`;
  readonly label: string;
}

export interface ResolvedMarketRoute {
  readonly kind: 'market';
  readonly market: AssetSymbol;
  readonly slug: MarketSlug;
  readonly canonicalPath: `/${MarketSlug}`;
  readonly requestedPath: string;
  readonly reason: Exclude<MarketRouteReason, 'unknown'>;
  /** True when history.replaceState should canonicalise the current URL. */
  readonly shouldReplace: boolean;
}

export interface MarketChooserRoute {
  readonly kind: 'chooser';
  readonly canonicalPath: null;
  readonly requestedPath: string;
  readonly reason: 'unknown';
  readonly title: string;
  readonly message: string;
  readonly choices: readonly MarketChoice[];
}

export type MarketRouteModel = ResolvedMarketRoute | MarketChooserRoute;

const MARKET_CHOICES: readonly MarketChoice[] = MARKET_SLUGS.map((slug) => {
  const definition = marketDefinitionForSlug(slug);
  return {
    symbol: definition.symbol,
    slug,
    path: `/${slug}`,
    label: `${definition.displayName} world`,
  };
});

function pathnameOnly(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '/';
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
      return new URL(trimmed).pathname;
    }
  } catch {
    return trimmed;
  }
  const boundary = trimmed.search(/[?#]/);
  return boundary < 0 ? trimmed : trimmed.slice(0, boundary);
}

function normalizedRequestedPath(input: string): string {
  const pathname = pathnameOnly(input);
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

export function marketSlugForSymbol(symbol: AssetSymbol): MarketSlug {
  return marketSlugForAsset(symbol);
}

export function marketPath(symbol: AssetSymbol): `/${MarketSlug}` {
  return `/${marketSlugForSymbol(symbol)}`;
}

/** Accepts a stored slug, symbol, or one-segment path. */
export function parseMarketSlug(value: string | null | undefined): MarketSlug | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  return (MARKET_SLUGS as readonly string[]).includes(normalized)
    ? normalized as MarketSlug
    : null;
}

export function symbolForMarketSlug(slug: MarketSlug): AssetSymbol {
  return assetSymbolForMarket(slug);
}

/**
 * Resolves route intent without touching browser globals. Root remembers the
 * last valid market and unknown paths deliberately remain chooser routes.
 */
export function resolveMarketRoute(
  inputPath: string,
  rememberedMarket?: string | null,
): MarketRouteModel {
  const requestedPath = normalizedRequestedPath(inputPath);
  const root = requestedPath === '/' || requestedPath === '';
  const routeSlug = root ? null : parseMarketSlug(requestedPath);
  const hasSingleSegment = /^\/[^/]+\/?$/.test(requestedPath);

  if (!root && routeSlug && hasSingleSegment) {
    const market = symbolForMarketSlug(routeSlug);
    const canonicalPath = marketPath(market);
    return {
      kind: 'market',
      market,
      slug: routeSlug,
      canonicalPath,
      requestedPath,
      reason: 'route',
      shouldReplace: requestedPath !== canonicalPath,
    };
  }

  if (root) {
    const rememberedSlug = parseMarketSlug(rememberedMarket);
    const market = rememberedSlug ? symbolForMarketSlug(rememberedSlug) : 'BTC';
    const slug = marketSlugForSymbol(market);
    return {
      kind: 'market',
      market,
      slug,
      canonicalPath: marketPath(market),
      requestedPath,
      reason: rememberedSlug ? 'remembered' : 'default',
      shouldReplace: true,
    };
  }

  const readableName = requestedPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return {
    kind: 'chooser',
    canonicalPath: null,
    requestedPath,
    reason: 'unknown',
    title: readableName ? `${readableName.toUpperCase()} isn't open yet` : 'Choose a market',
    message: 'Pick a live market world, or enter TEST to explore the volatility demo.',
    choices: MARKET_CHOICES,
  };
}

export function isAssetSymbol(value: string): value is AssetSymbol {
  return (ASSET_SYMBOLS as readonly string[]).includes(value);
}
