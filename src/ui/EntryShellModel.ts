import type { AssetSymbol, FeedMode } from '../types';

export type EntryRoomStatus = 'offline' | 'connecting' | 'online';

export interface EntryShellModel {
  readonly symbol: AssetSymbol;
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
  readonly enterLabel: string;
}

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
      description: 'Walk inside the live CL crude-oil perpetual chart with other tiny animals.',
      enterLabel: 'Enter WTI world',
    };
  }
  if (symbol === 'PUMP' || symbol === 'ANSEM' || symbol === 'SHFL') {
    const chain = symbol === 'SHFL' ? 'Ethereum' : 'Solana';
    return {
      symbol,
      kicker: `${symbol} WORLD · LIVE DEX`,
      title: 'Tickerworld',
      description: `Walk inside ${symbol}'s live ${chain} DEX chart with other tiny animals.`,
      enterLabel: `Enter ${symbol} world`,
    };
  }
  return {
    symbol,
    kicker: `${symbol} WORLD · LIVE`,
    title: 'Tickerworld',
    description: `Walk inside ${symbol}\u2019s live one-minute chart with other tiny animals.`,
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
    case 'offline': return 'Solo mode ready';
  }
}
