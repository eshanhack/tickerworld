import {
  CLIENT_MESSAGES,
  SERVER_MESSAGES,
  type PartyInviteMessage,
  type PartyInviteRequestMessage,
  type PartyJoinFailure,
} from '../../shared/src/index.js';

export const PARTY_TOKEN_HASH_KEY = 'party';
export const PARTY_CLIENT_INVITE_REQUEST = CLIENT_MESSAGES.partyInviteRequest;
export const PARTY_SERVER_INVITE = SERVER_MESSAGES.partyInvite;

export interface PartyJoinOptions {
  readonly partyToken: string;
}

export type PartyInviteRequest = PartyInviteRequestMessage;
export type PartyInvite = PartyInviteMessage;

export type PartyJoinStatus =
  | { readonly status: 'joined'; readonly token: string }
  | { readonly status: 'full' | 'invalid' | 'expired'; readonly token: string; readonly fallback: 'normal-shard' };

export function isPartyToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

export function parsePartyToken(hash: string): string | null {
  const source = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(source).get(PARTY_TOKEN_HASH_KEY);
  return isPartyToken(token) ? token : null;
}

export function withPartyToken(url: string, token: string): string {
  if (!isPartyToken(token)) throw new Error('Invalid party token.');
  const target = new URL(url, typeof location === 'undefined' ? 'https://tickerworld.io' : location.href);
  const hash = new URLSearchParams(target.hash.startsWith('#') ? target.hash.slice(1) : target.hash);
  hash.set(PARTY_TOKEN_HASH_KEY, token);
  target.hash = hash.toString();
  return target.toString();
}

export function withoutPartyToken(url: string): string {
  const target = new URL(url, typeof location === 'undefined' ? 'https://tickerworld.io' : location.href);
  const hash = new URLSearchParams(target.hash.startsWith('#') ? target.hash.slice(1) : target.hash);
  hash.delete(PARTY_TOKEN_HASH_KEY);
  target.hash = hash.toString();
  return target.toString();
}

/** Removes deterministic QA switches that would make a public invite solo or simulated. */
export function publicShareUrl(url: string): string {
  const target = new URL(withoutPartyToken(url));
  for (const parameter of ['data', 'debug', 'seed', 'news', 'capture']) target.searchParams.delete(parameter);
  return target.toString();
}

export interface PartyShareBinding {
  readonly market: string;
  readonly roomEpoch: number;
  readonly expiresAt: number;
}

export function isPartyShareCurrent(
  binding: PartyShareBinding | null,
  market: string,
  roomEpoch: number,
  now: number,
): boolean {
  return Boolean(binding
    && binding.market === market
    && binding.roomEpoch === roomEpoch
    && binding.expiresAt > now);
}

export function parsePartyInvite(value: unknown): PartyInvite | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<PartyInvite>;
  if (typeof source.requestId !== 'string'
    || !/^[A-Za-z0-9_-]{6,64}$/.test(source.requestId)
    || !isPartyToken(source.token)
    || !Number.isFinite(source.expiresAt)) return null;
  return {
    requestId: source.requestId,
    token: source.token,
    expiresAt: source.expiresAt!,
  };
}

export function partyFailureFromError(error: unknown): PartyJoinFailure | null {
  const source = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null;
  const text = `${typeof source?.code === 'string' ? source.code : ''} ${typeof source?.message === 'string' ? source.message : String(error ?? '')}`.toLowerCase();
  if (text.includes('party_full')) return 'party_full';
  if (text.includes('party_invalid')) return 'party_invalid';
  if (text.includes('party_expired')) return 'party_expired';
  return null;
}
