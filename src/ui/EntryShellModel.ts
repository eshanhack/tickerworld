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
