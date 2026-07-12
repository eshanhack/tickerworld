import { describe, expect, it } from 'vitest';
import { ChatRateLimiter, ChatSafety, SharedChatRateLimiter } from '../src/services/chatSafety.js';

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
    expect(safety.evaluate('Official Tickerworld Admin here')).toEqual({ ok: false, code: 'impersonation' });
    expect(safety.isReservedUsername('ADMIN')).toBe(true);
  });

  it('rejects launch scam vectors and invisible controls with typed reasons', () => {
    const safety = new ChatSafety();
    expect(safety.evaluate('visit https://scam.example')).toEqual({ ok: false, code: 'links' });
    expect(safety.evaluate('send 0x1234567890123456789012345678901234567890')).toEqual({
      ok: false,
      code: 'wallet_or_contract',
    });
    expect(safety.evaluate('verify your wallet with your seed phrase')).toEqual({
      ok: false,
      code: 'seed_phrase',
    });
    expect(safety.evaluate('normal\u200Bhidden')).toEqual({ ok: false, code: 'invisible_spam' });
  });

  it('allows a burst of three and refills one message every two seconds', () => {
    const limiter = new ChatRateLimiter(0);
    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0)).toEqual({ allowed: false, retryAfterMs: 2_000 });
    expect(limiter.consume(2_000).allowed).toBe(true);
  });

  it('detects repeated spam across actor and IP identities without retaining plaintext', () => {
    const limiter = new SharedChatRateLimiter();
    expect(limiter.isRepeatedSpam('actor-a', 'ip-a', 'same message', 0)).toBe(false);
    expect(limiter.isRepeatedSpam('actor-a', 'ip-a', 'same message', 1)).toBe(false);
    expect(limiter.isRepeatedSpam('actor-a', 'ip-a', 'same message', 2)).toBe(true);
    // A reconnect cannot reset the IP-level repetition window indefinitely.
    expect(limiter.isRepeatedSpam('actor-b', 'ip-a', 'same message', 3)).toBe(false);
    expect(limiter.isRepeatedSpam('actor-c', 'ip-a', 'same message', 4)).toBe(false);
    expect(limiter.isRepeatedSpam('actor-d', 'ip-a', 'same message', 5)).toBe(false);
    expect(limiter.isRepeatedSpam('actor-e', 'ip-a', 'same message', 6)).toBe(true);
    expect(limiter.isRepeatedSpam('actor-a', 'ip-a', 'same message', 30_007)).toBe(false);
  });
});
