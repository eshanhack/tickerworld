import type { AssetSymbol, MarketSlug } from './contracts.js';

/** Runtime flags are positive capabilities: false means the feature is killed. */
export interface RuntimeKillSwitches {
  admissions: boolean;
  chatSend: boolean;
  newsIngest: boolean;
  directMarketFallback: boolean;
  publicWalletAuth: boolean;
  purchases: boolean;
  adminActions: boolean;
}

export interface RuntimeCapabilities {
  protocolVersion: number;
  updatedAt: number;
  switches: RuntimeKillSwitches;
  multiplayerAvailable: boolean;
  marketRelayAvailable: boolean;
  newsAvailable: boolean;
  maxPlayersPerShard: number;
  maxProcessConnections: number;
}

export const EMOTE_KINDS = [
  'wave',
  'sparkle-heart',
  'cheer',
  'spin',
  'gasp',
  'curl-nap',
] as const;

export type EmoteKind = (typeof EMOTE_KINDS)[number];

export interface EmoteSendMessage {
  protocolVersion: number;
  kind: EmoteKind;
  nonce: string;
}

export interface EmoteBroadcastMessage extends EmoteSendMessage {
  actorId: string;
  sentAt: number;
}

export interface PartyInviteRequestMessage {
  protocolVersion: number;
  requestId: string;
}

export interface PartyInviteMessage {
  requestId: string;
  token: string;
  expiresAt: number;
}

export type PartyJoinFailure = 'party_full' | 'party_invalid' | 'party_expired';

export interface PartyInvite {
  market: MarketSlug;
  token: string;
  expiresAt: number;
  remainingJoins: number;
  maxJoins: number;
}

export type PartyJoinResult =
  | { ok: true; market: MarketSlug; roomId: string; expiresAt: number }
  | { ok: false; code: PartyJoinFailure; fallbackMarket: MarketSlug | null };

export type NewsScope = AssetSymbol | 'global';

export interface RelayedMarketCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface RelayedMarketState {
  instrument: AssetSymbol;
  candles: readonly RelayedMarketCandle[];
  candle: RelayedMarketCandle | null;
  price: number | null;
  upstreamAt: number | null;
  publishedAt: number;
  ageMs: number | null;
  stale: boolean;
}

export interface CompactMarketMid {
  instrument: AssetSymbol;
  price: number;
  upstreamAt: number;
}
