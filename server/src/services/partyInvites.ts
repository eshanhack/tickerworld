import type { MarketSlug, PartyInvite, PartyJoinFailure } from '@tickerworld/shared';
import { hmacSha256, randomToken, safeEqual, sha256 } from './crypto.js';

interface PartyTokenPayload {
  v: 1;
  inviteId: string;
  roomId: string;
  market: MarketSlug;
  expiresAt: number;
}

interface InviteRecord extends PartyTokenPayload {
  tokenHash: string;
  issuerActorId: string;
  joins: number;
  anchor: { x: number; z: number } | null;
}

export type PartyInviteInspection =
  | { ok: true; market: MarketSlug; roomId: string; expiresAt: number; remainingJoins: number; anchor: { x: number; z: number } | null }
  | { ok: false; code: PartyJoinFailure };

/** Stores only token hashes. The token is an opaque random nonce plus HMAC. */
export class PartyInviteService {
  private readonly records = new Map<string, InviteRecord>();

  constructor(
    private readonly secret: string,
    private readonly ttlMs = 30 * 60_000,
    private readonly maxJoins = 12,
    private readonly maxRecords = 10_000,
  ) {}

  issue(
    issuerActorId: string,
    roomId: string,
    market: MarketSlug,
    now = Date.now(),
    anchor: { x: number; z: number } | null = null,
  ): PartyInvite {
    this.cleanup(now);
    while (this.records.size >= this.maxRecords) this.evictOldest();
    const payload: PartyTokenPayload = {
      v: 1,
      inviteId: randomToken(32),
      roomId,
      market,
      expiresAt: now + this.ttlMs,
    };
    const token = `${payload.inviteId}${hmacSha256(this.secret, payload.inviteId)}`;
    this.records.set(sha256(token), {
      ...payload,
      tokenHash: sha256(token),
      issuerActorId,
      joins: 0,
      anchor: anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.z)
        ? { x: anchor.x, z: anchor.z }
        : null,
    });
    return {
      market,
      token,
      expiresAt: payload.expiresAt,
      remainingJoins: this.maxJoins,
      maxJoins: this.maxJoins,
    };
  }

  inspect(token: string, now = Date.now()): PartyInviteInspection {
    if (!this.verifySignature(token)) return { ok: false, code: 'party_invalid' };
    const record = this.records.get(sha256(token));
    if (!record) return { ok: false, code: 'party_invalid' };
    if (record.expiresAt <= now) {
      this.records.delete(record.tokenHash);
      return { ok: false, code: 'party_expired' };
    }
    if (record.joins >= this.maxJoins) return { ok: false, code: 'party_full' };
    return {
      ok: true,
      market: record.market,
      roomId: record.roomId,
      expiresAt: record.expiresAt,
      remainingJoins: this.maxJoins - record.joins,
      anchor: record.anchor ? { ...record.anchor } : null,
    };
  }

  consume(token: string, roomId: string, market: MarketSlug, now = Date.now()): PartyInviteInspection {
    const inspected = this.inspect(token, now);
    if (!inspected.ok) return inspected;
    if (inspected.roomId !== roomId || inspected.market !== market) {
      return { ok: false, code: 'party_invalid' };
    }
    const record = this.records.get(sha256(token));
    if (!record) return { ok: false, code: 'party_invalid' };
    record.joins += 1;
    return { ...inspected, remainingJoins: this.maxJoins - record.joins };
  }

  clear(): void {
    this.records.clear();
  }

  private verifySignature(token: string): boolean {
    // 32 random bytes and a SHA-256 HMAC are both 43 base64url characters.
    if (!/^[A-Za-z0-9_-]{86}$/.test(token)) return false;
    const nonce = token.slice(0, 43);
    const signature = token.slice(43);
    return safeEqual(signature, hmacSha256(this.secret, nonce));
  }

  private cleanup(now: number): void {
    for (const [hash, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(hash);
    }
  }

  private evictOldest(): void {
    let key: string | null = null;
    let expiry = Number.POSITIVE_INFINITY;
    for (const [candidate, record] of this.records) {
      if (record.expiresAt < expiry) {
        expiry = record.expiresAt;
        key = candidate;
      }
    }
    if (key) this.records.delete(key);
  }
}
