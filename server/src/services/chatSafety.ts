import { CHAT_MAX_LENGTH } from '@tickerworld/shared';
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';
import { sha256 } from './crypto.js';

const IMPERSONATION_PATTERNS = [
  /\btickerworld\s+(?:support|admin|moderator)\b/i,
  /\bofficial\s+(?:tickerworld\s+)?(?:support|admin|moderator)\b/i,
  /\bi(?:'m| am)\s+(?:an?\s+)?(?:tickerworld\s+)?(?:admin|moderator|support)\b/i,
] as const;
const LINK_PATTERN = /(?:https?:\/\/|www\.|(?:^|\s)[a-z0-9-]+\.(?:com|io|net|org|gg|xyz|app)(?:[/:?#]|\s|$))/i;
const WALLET_OR_CONTRACT_PATTERN = /(?:\b0x[a-fA-F0-9]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b)/;
const SEED_PHRASE_PATTERN = /\b(?:seed|recovery|secret)\s+phrase\b|\bprivate\s+key\b|\b(?:12|24)\s+(?:seed\s+)?words?\b|\bverify\s+(?:your\s+)?wallet\b/i;
const INVISIBLE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;
const RESERVED_USERNAMES = ['admin', 'administrator', 'mod', 'moderator', 'tickerworld', 'support'] as const;

export class ChatSafety {
  readonly phraseListVersion = 1;
  private readonly matcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });

  evaluate(rawText: string): { ok: true; text: string } | { ok: false; code:
    | 'empty'
    | 'too_long'
    | 'profanity'
    | 'links'
    | 'wallet_or_contract'
    | 'seed_phrase'
    | 'invisible_spam'
    | 'impersonation' } {
    if (INVISIBLE_CONTROL_PATTERN.test(rawText)) return { ok: false, code: 'invisible_spam' };
    const text = rawText.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!text) return { ok: false, code: 'empty' };
    if ([...text].length > CHAT_MAX_LENGTH) return { ok: false, code: 'too_long' };
    if (LINK_PATTERN.test(text)) return { ok: false, code: 'links' };
    if (WALLET_OR_CONTRACT_PATTERN.test(text)) return { ok: false, code: 'wallet_or_contract' };
    if (SEED_PHRASE_PATTERN.test(text)) return { ok: false, code: 'seed_phrase' };
    if (IMPERSONATION_PATTERNS.some((pattern) => pattern.test(text))) {
      return { ok: false, code: 'impersonation' };
    }
    if (this.matcher.hasMatch(text)) return { ok: false, code: 'profanity' };
    return { ok: true, text };
  }

  isReservedUsername(value: string): boolean {
    return RESERVED_USERNAMES.includes(value.toLocaleLowerCase('en-US') as typeof RESERVED_USERNAMES[number]);
  }
}

export class ChatRateLimiter {
  private tokens = 3;
  private updatedAt: number;

  constructor(now = Date.now()) {
    this.updatedAt = now;
  }

  consume(now = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(3, this.tokens + elapsed / 2_000);
    this.updatedAt = now;
    if (this.tokens < 1) {
      return { allowed: false, retryAfterMs: Math.ceil((1 - this.tokens) * 2_000) };
    }
    this.tokens -= 1;
    return { allowed: true };
  }
}

interface SharedChatBucket {
  readonly limiter: ChatRateLimiter;
  touchedAt: number;
}

/** Actor and IP buckets survive reconnects and room hops within one process. */
export class SharedChatRateLimiter {
  private readonly buckets = new Map<string, SharedChatBucket>();
  private readonly repeated = new Map<string, { count: number; expiresAt: number }>();
  private calls = 0;

  constructor(private readonly maxBuckets = 20_000) {}

  consume(actorId: string, ipHash: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    if (++this.calls % 256 === 0) this.prune(now);
    const actor = this.bucket(`actor:${actorId}`, now).limiter.consume(now);
    const ip = this.bucket(`ip:${ipHash}`, now).limiter.consume(now);
    if (actor.allowed && ip.allowed) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: Math.max(
        actor.allowed ? 0 : actor.retryAfterMs,
        ip.allowed ? 0 : ip.retryAfterMs,
      ),
    };
  }

  isRepeatedSpam(actorId: string, ipHash: string, text: string, now = Date.now()): boolean {
    const digest = sha256(text.toLocaleLowerCase('en-US'));
    const keys = [`actor:${actorId}:${digest}`, `ip:${ipHash}:${digest}`];
    let blocked = false;
    for (const key of keys) {
      const existing = this.repeated.get(key);
      const count = existing && existing.expiresAt > now ? existing.count : 0;
      const threshold = key.startsWith('actor:') ? 2 : 6;
      if (count >= threshold) blocked = true;
      this.repeated.set(key, { count: count + 1, expiresAt: now + 30_000 });
    }
    if (this.repeated.size > this.maxBuckets) {
      for (const [key, value] of this.repeated) {
        if (value.expiresAt <= now) this.repeated.delete(key);
      }
      while (this.repeated.size > this.maxBuckets) {
        const key = this.repeated.keys().next().value as string | undefined;
        if (!key) break;
        this.repeated.delete(key);
      }
    }
    return blocked;
  }

  clear(): void {
    this.buckets.clear();
    this.repeated.clear();
  }

  private bucket(key: string, now: number): SharedChatBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) this.evictOldest();
      bucket = { limiter: new ChatRateLimiter(now), touchedAt: now };
      this.buckets.set(key, bucket);
    }
    bucket.touchedAt = now;
    return bucket;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt <= now - 60_000) this.buckets.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt < oldestAt) {
        oldestAt = bucket.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}
