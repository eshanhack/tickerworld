export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  hits: number[];
  touchedAt: number;
  windowMs: number;
}

/** Small single-process sliding-window limiter. Keys should be opaque actor/account/IP hashes. */
export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  constructor(private readonly maxBuckets = 20_000) {}

  consume(
    namespace: string,
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): RateLimitResult {
    if (++this.calls % 256 === 0) this.prune(now);
    const bucketKey = `${namespace}:${key}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) this.evictOldest();
      bucket = { hits: [], touchedAt: now, windowMs };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.windowMs = windowMs;
    bucket.hits = bucket.hits.filter((timestamp) => timestamp > now - bucket.windowMs);
    bucket.touchedAt = now;
    if (bucket.hits.length >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, (bucket.hits[0] ?? now) + bucket.windowMs - now),
      };
    }
    bucket.hits.push(now);
    return { allowed: true, remaining: Math.max(0, limit - bucket.hits.length), retryAfterMs: 0 };
  }

  clear(): void {
    this.buckets.clear();
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const cutoff = now - bucket.windowMs;
      bucket.hits = bucket.hits.filter((hit) => hit > cutoff);
      if (bucket.touchedAt <= cutoff && bucket.hits.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt < oldestAt) {
        oldestKey = key;
        oldestAt = bucket.touchedAt;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}
