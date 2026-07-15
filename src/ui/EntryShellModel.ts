import type { AssetSymbol, FeedMode } from '../types';
import { marketDefinitionForSymbol } from '../../shared/src/index.js';

export type EntryRoomStatus = 'offline' | 'connecting' | 'online';

export interface EntryShellModel {
  readonly symbol: AssetSymbol;
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
  readonly enterLabel: string;
}

export function marketWorldDocumentTitle(symbol: AssetSymbol): string {
  return `${marketDefinitionForSymbol(symbol).displayName} World · Tickerworld`;
}

const SIGNATURE_ENTRY_DESCRIPTIONS: Readonly<Partial<Record<AssetSymbol, string>>> = {
  SKHYNIX: 'Explore SK hynix\u2019s live 24/7 share-tracking perpetual chart in a stacked-memory garden.',
  HYPE: 'Explore HYPE\u2019s live 24/7 perpetual chart across a HyperCore archipelago.',
  XYZ100: 'Explore the live 24/7 modified U.S. 100 index-tracking perpetual chart inside an innovation skyline.',
  SP500: 'Explore the live 24/7 S&P 500 index-tracking perpetual chart inside a market mosaic.',
  MU: 'Explore Micron\u2019s live 24/7 share-tracking perpetual chart inside a memory canyon.',
  SPACEX: 'Explore the live 24/7 SpaceX share-tracking perpetual chart from a reusable-launch coast.',
  NVDA: 'Explore NVIDIA\u2019s live 24/7 share-tracking perpetual chart inside an AI factory garden.',
  GOLD: 'Explore the live 24/7 gold perpetual chart inside an auric vault grotto.',
  AAPL: 'Explore Apple\u2019s live 24/7 share-tracking perpetual chart inside an orchard of ideas.',
  META: 'Explore Meta\u2019s live 24/7 share-tracking perpetual chart inside a connection loom.',
  GOOGL: 'Explore Google\u2019s live 24/7 share-tracking perpetual chart inside an information atlas.',
};

export function entryShellForMarket(symbol: AssetSymbol): EntryShellModel {
  if (symbol === 'TEST') {
    return {
      symbol,
      kicker: 'TEST WORLD · SIMULATED',
      title: 'Tickerworld',
      description: 'A deliberately wild demo market for testing trades, sounds, fireworks, and sky events.',
      enterLabel: 'Enter TEST lab',
    };
  }
  if (symbol === 'WTI') {
    return {
      symbol,
      kicker: 'WTI WORLD · LIVE',
      title: 'Tickerworld',
      description: 'Walk inside the live CL crude-oil perpetual chart with other tiny characters.',
      enterLabel: 'Enter WTI world',
    };
  }
  if (symbol === 'PUMP' || symbol === 'ANSEM' || symbol === 'SHFL') {
    const chain = symbol === 'SHFL' ? 'Ethereum' : 'Solana';
    return {
      symbol,
      kicker: `${symbol} WORLD · LIVE DEX`,
      title: 'Tickerworld',
      description: `Walk inside ${symbol}'s live ${chain} DEX chart with other tiny characters.`,
      enterLabel: `Enter ${symbol} world`,
    };
  }
  const signatureDescription = SIGNATURE_ENTRY_DESCRIPTIONS[symbol];
  if (signatureDescription) {
    const displayName = marketDefinitionForSymbol(symbol).displayName;
    return {
      symbol,
      kicker: `${symbol} WORLD · LIVE`,
      title: 'Tickerworld',
      description: `${signatureDescription} Walk it with other tiny characters.`,
      enterLabel: `Enter ${displayName} world`,
    };
  }
  return {
    symbol,
    kicker: `${symbol} WORLD · LIVE`,
    title: 'Tickerworld',
    description: `Walk inside ${symbol}\u2019s live one-minute chart with other tiny characters.`,
    enterLabel: `Enter ${symbol} world`,
  };
}

export function entryFeedStatusLabel(mode: FeedMode): string {
  switch (mode) {
    case 'live': return 'Market live';
    case 'simulated': return 'Demo market';
    case 'reconnecting': return 'Market reconnecting';
    case 'connecting': return 'Market connecting';
  }
}

export function entryRoomStatusLabel(status: EntryRoomStatus): string {
  switch (status) {
    case 'online': return 'Shared plaza online';
    case 'connecting': return 'Finding wanderers';
    case 'offline': return 'Shared plaza reconnecting';
  }
}
