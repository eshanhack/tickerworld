import { describe, expect, it } from 'vitest';
import { ChatRateLimiter, ChatSafety } from '../src/services/chatSafety.js';

describe('chat safety', () => {
  it('normalizes whitespace and enforces the 140-character boundary', () => {
    const safety = new ChatSafety();
    expect(safety.evaluate('  hello    world  ')).toEqual({ ok: true, text: 'hello world' });
    expect(safety.evaluate('a'.repeat(141))).toEqual({ ok: false, code: 'too_long' });
    expect(safety.evaluate('   ')).toEqual({ ok: false, code: 'empty' });
  });

  it('rejects transformed profanity and impersonation phrases', () => {
    const safety = new ChatSafety();
    expect(safety.evaluate('fuuuuuck')).toEqual({ ok: false, code: 'profanity' });
    expect(safety.evaluate('Official Tickerworld Admin here')).toEqual({ ok: false, code: 'profanity' });
    expect(safety.isReservedUsername('ADMIN')).toBe(true);
  });

  it('allows a burst of three and refills one message every two seconds', () => {
    const limiter = new ChatRateLimiter(0);
    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0)).toEqual({ allowed: false, retryAfterMs: 2_000 });
    expect(limiter.consume(2_000).allowed).toBe(true);
  });
});
