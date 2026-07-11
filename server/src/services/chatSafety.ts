import { CHAT_MAX_LENGTH } from '@tickerworld/shared';
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

const CUSTOM_DENY_PHRASES = ['tickerworld support', 'official tickerworld admin'] as const;
const RESERVED_USERNAMES = ['admin', 'administrator', 'mod', 'moderator', 'tickerworld', 'support'] as const;

export class ChatSafety {
  readonly phraseListVersion = 1;
  private readonly matcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });

  evaluate(rawText: string): { ok: true; text: string } | { ok: false; code: 'empty' | 'too_long' | 'profanity' } {
    const text = rawText.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!text) return { ok: false, code: 'empty' };
    if ([...text].length > CHAT_MAX_LENGTH) return { ok: false, code: 'too_long' };
    const canonical = text.toLocaleLowerCase('en-US');
    if (this.matcher.hasMatch(text)
      || CUSTOM_DENY_PHRASES.some((phrase) => canonical.includes(phrase))) {
      return { ok: false, code: 'profanity' };
    }
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

  clear(): void {
    this.buckets.clear();
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
