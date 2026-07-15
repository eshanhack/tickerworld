import { describe, expect, it } from 'vitest';
import {
  ASSET_SYMBOLS,
  HYPERLIQUID_ASSET_SYMBOLS,
  MARKET_DEFINITIONS,
  MARKET_SLUGS,
  assetSymbolForHyperliquidCoin,
  assetSymbolForMarket,
  hyperliquidCoinForAsset,
  marketDefinitionForSymbol,
  marketSlugForAsset,
} from '../shared/src/index.js';
import {
  hyperliquidCoinForSymbol,
} from '../src/markets/marketFeed';
import {
  marketSlugForSymbol,
  symbolForMarketSlug,
} from '../src/routing';

const NEW_WORLD_MAPPINGS = [
  ['SKHYNIX', 'skhynix', 'xyz:SKHX'],
  ['HYPE', 'hype', 'HYPE'],
  ['XYZ100', 'xyz100', 'xyz:XYZ100'],
  ['SP500', 'sp500', 'xyz:SP500'],
  ['MU', 'micron', 'xyz:MU'],
  ['SPACEX', 'spacex', 'xyz:SPCX'],
  ['NVDA', 'nvidia', 'xyz:NVDA'],
  ['GOLD', 'gold', 'xyz:GOLD'],
  ['AAPL', 'apple', 'xyz:AAPL'],
  ['META', 'meta', 'xyz:META'],
  ['GOOGL', 'google', 'xyz:GOOGL'],
] as const;

describe('shared market registry', () => {
  it('covers every symbol and slug exactly once', () => {
    expect(Object.keys(MARKET_DEFINITIONS)).toEqual(ASSET_SYMBOLS);
    expect(new Set(Object.values(MARKET_DEFINITIONS).map(({ slug }) => slug))).toEqual(
      new Set(MARKET_SLUGS),
    );
    for (const symbol of ASSET_SYMBOLS) {
      const slug = marketSlugForAsset(symbol);
      expect(assetSymbolForMarket(slug)).toBe(symbol);
      expect(marketSlugForSymbol(symbol)).toBe(slug);
      expect(symbolForMarketSlug(slug)).toBe(symbol);
    }
  });

  it.each(NEW_WORLD_MAPPINGS)(
    'maps %s through route %s to exact Hyperliquid coin %s',
    (symbol, slug, coin) => {
      expect(marketSlugForAsset(symbol)).toBe(slug);
      expect(hyperliquidCoinForAsset(symbol)).toBe(coin);
      expect(hyperliquidCoinForSymbol(symbol)).toBe(coin);
      expect(assetSymbolForHyperliquidCoin(coin.toLocaleLowerCase('en-US'))).toBe(symbol);
      expect(HYPERLIQUID_ASSET_SYMBOLS).toContain(symbol);
    },
  );

  it('keeps explicit simulation and on-chain markets out of Hyperliquid subscriptions', () => {
    for (const symbol of ['TEST', 'PUMP', 'ANSEM', 'SHFL'] as const) {
      expect(hyperliquidCoinForAsset(symbol)).toBeNull();
      expect(HYPERLIQUID_ASSET_SYMBOLS).not.toContain(symbol);
    }
  });

  it.each([
    ['SKHYNIX', 'skhynix', 'SK hynix'],
    ['HYPE', 'hype', 'HYPE'],
    ['XYZ100', 'xyz100', 'XYZ100'],
    ['SP500', 'sp500', 'S&P 500'],
    ['MU', 'micron', 'Micron'],
    ['SPACEX', 'spacex', 'SpaceX'],
    ['NVDA', 'nvidia', 'NVIDIA'],
    ['GOLD', 'gold', 'Gold'],
    ['AAPL', 'apple', 'Apple'],
    ['META', 'meta', 'Meta'],
    ['GOOGL', 'google', 'Google'],
  ] as const)('keeps %s internal identity separate from /%s and display name %s', (
    symbol,
    slug,
    displayName,
  ) => {
    expect(marketDefinitionForSymbol(symbol)).toMatchObject({ symbol, slug, displayName });
    expect(marketSlugForSymbol(symbol)).toBe(slug);
    expect(symbolForMarketSlug(slug)).toBe(symbol);
  });
});
