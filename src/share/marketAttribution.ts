import { marketDefinitionForSymbol } from '../../shared/src/index.js';
import type { AssetSymbol, MarketProvider } from '../types';

const SHARE_TRACKING_MARKETS = new Set<AssetSymbol>([
  'SKHYNIX', 'MU', 'SPACEX', 'NVDA', 'AAPL', 'META', 'GOOGL',
]);
const INDEX_TRACKING_MARKETS = new Set<AssetSymbol>(['XYZ100', 'SP500']);
const COMMODITY_TRACKING_MARKETS = new Set<AssetSymbol>(['WTI', 'GOLD']);

export interface MarketShareAttribution {
  readonly displayName: string;
  readonly providerLabel: string;
  readonly disclosureLabel: string | null;
}

/**
 * Keeps captures and native-share copy explicit about what the displayed
 * instrument is. XYZ markets are perpetual derivatives, not ownership of the
 * company, index, or commodity represented by the world.
 */
export function marketShareAttribution(
  symbol: AssetSymbol,
  provider: MarketProvider,
): MarketShareAttribution {
  const definition = marketDefinitionForSymbol(symbol);
  if (provider === 'simulation') {
    return {
      displayName: definition.displayName,
      providerLabel: 'SIMULATED DATA',
      disclosureLabel: 'NOT LIVE MARKET DATA',
    };
  }
  if (provider === 'dexscreener') {
    return { displayName: definition.displayName, providerLabel: 'DEXSCREENER DEX', disclosureLabel: null };
  }
  if (provider === 'geckoterminal') {
    return { displayName: definition.displayName, providerLabel: 'GECKOTERMINAL DEX', disclosureLabel: null };
  }

  const providerLabel = definition.hyperliquidDex === 'xyz'
    ? 'HYPERLIQUID XYZ PERP'
    : 'HYPERLIQUID PERP';
  const disclosureLabel = SHARE_TRACKING_MARKETS.has(symbol)
    ? 'DERIVATIVE · NOT SHARES'
    : INDEX_TRACKING_MARKETS.has(symbol)
      ? 'DERIVATIVE · NOT INDEX OWNERSHIP'
      : COMMODITY_TRACKING_MARKETS.has(symbol)
        ? 'DERIVATIVE · NOT SPOT'
        : null;
  return { displayName: definition.displayName, providerLabel, disclosureLabel };
}

export function marketShareDescription(symbol: AssetSymbol, provider: MarketProvider): string {
  const attribution = marketShareAttribution(symbol, provider);
  const source = attribution.providerLabel.toLocaleLowerCase('en-US');
  const disclosure = attribution.disclosureLabel
    ? ` (${attribution.disclosureLabel.toLocaleLowerCase('en-US')})`
    : '';
  return `A ${attribution.displayName} moment from Tickerworld · ${source}${disclosure}.`;
}
