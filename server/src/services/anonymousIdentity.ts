import { ANIMAL_KINDS, type AnimalKind } from '@tickerworld/shared';
import { randomInt, randomUUID } from 'node:crypto';
import { hmacSha256, safeEqual } from './crypto.js';

export interface AnonymousIdentity {
  actorId: string;
  animal: AnimalKind;
  expiresAt: number;
}

interface SignedPayload {
  version: 1;
  actorId: string;
  animal: AnimalKind;
  expiresAt: number;
}

export class AnonymousIdentityService {
  constructor(
    private readonly secret: string,
    private readonly lifetimeMs = 30 * 24 * 60 * 60 * 1_000,
  ) {}

  issue(now = Date.now()): AnonymousIdentity & { token: string } {
    const payload: SignedPayload = {
      version: 1,
      actorId: `anon_${randomUUID().replaceAll('-', '')}`,
      animal: ANIMAL_KINDS[randomInt(ANIMAL_KINDS.length)] ?? 'fox',
      expiresAt: now + this.lifetimeMs,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return { ...payload, token: `${encoded}.${hmacSha256(this.secret, encoded)}` };
  }

  verify(token: string, now = Date.now()): AnonymousIdentity | null {
    const [encoded, signature, trailing] = token.split('.');
    if (!encoded || !signature || trailing !== undefined) return null;
    if (!safeEqual(signature, hmacSha256(this.secret, encoded))) return null;
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SignedPayload>;
      if (parsed.version !== 1
        || typeof parsed.actorId !== 'string'
        || !/^anon_[a-f0-9]{32}$/.test(parsed.actorId)
        || typeof parsed.expiresAt !== 'number'
        || parsed.expiresAt <= now
        || !ANIMAL_KINDS.includes(parsed.animal as AnimalKind)) {
        return null;
      }
      return {
        actorId: parsed.actorId,
        animal: parsed.animal as AnimalKind,
        expiresAt: parsed.expiresAt,
      };
    } catch {
      return null;
    }
  }
}
