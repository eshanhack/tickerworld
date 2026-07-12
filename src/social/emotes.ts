import {
  CLIENT_MESSAGES,
  EMOTE_KINDS as SHARED_EMOTE_KINDS,
  SERVER_MESSAGES,
  type EmoteBroadcastMessage,
  type EmoteKind as SharedEmoteKind,
  type EmoteSendMessage,
} from '../../shared/src/index.js';

export const EMOTE_KINDS = SHARED_EMOTE_KINDS;
export type EmoteKind = SharedEmoteKind;
export const EMOTE_CLIENT_MESSAGE = CLIENT_MESSAGES.emote;
export const EMOTE_SERVER_MESSAGE = SERVER_MESSAGES.emote;
export type ClientEmoteMessage = EmoteSendMessage;
export type ServerEmoteMessage = EmoteBroadcastMessage;

export function isEmoteKind(value: unknown): value is EmoteKind {
  return typeof value === 'string' && EMOTE_KINDS.includes(value as EmoteKind);
}

export function parseServerEmote(value: unknown): ServerEmoteMessage | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<ServerEmoteMessage>;
  if (!isEmoteKind(source.kind)
    || typeof source.actorId !== 'string'
    || source.actorId.length < 1
    || source.actorId.length > 96
    || typeof source.nonce !== 'string'
    || !/^[A-Za-z0-9_-]{6,64}$/.test(source.nonce)
    || !Number.isFinite(source.sentAt)
    || !Number.isSafeInteger(source.protocolVersion)) return null;
  return {
    protocolVersion: source.protocolVersion!,
    actorId: source.actorId,
    kind: source.kind,
    nonce: source.nonce,
    sentAt: source.sentAt!,
  };
}

/** A small local courtesy gate; the server remains authoritative. */
export class EmoteRateGate {
  private readonly intervalMs: number;
  private nextAt = Number.NEGATIVE_INFINITY;

  constructor(intervalMs = 650) {
    this.intervalMs = Math.max(100, intervalMs);
  }

  tryTake(now = Date.now()): boolean {
    if (now < this.nextAt) return false;
    this.nextAt = now + this.intervalMs;
    return true;
  }

  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.nextAt - now);
  }
}

export function createEmoteNonce(random = Math.random, now = Date.now()): string {
  const time = Math.max(0, Math.floor(now)).toString(36);
  const entropy = Math.floor(Math.max(0, Math.min(0.999999999, random())) * 0xffffffffff)
    .toString(36)
    .padStart(8, '0');
  return `${time}-${entropy}`.slice(0, 64);
}
