import { CHAT_MAX_LENGTH } from '../../shared/src/index.js';

export interface ChatDraftValidation {
  readonly text: string;
  readonly error: 'empty' | 'too_long' | null;
}

export function validateChatDraft(value: string): ChatDraftValidation {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return { text: '', error: 'empty' };
  if (text.length > CHAT_MAX_LENGTH) return { text, error: 'too_long' };
  return { text, error: null };
}

/** Client-side courtesy gate. The room remains authoritative. */
export class ChatRateGate {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity = 3,
    private readonly refillMs = 2_000,
    now = 0,
  ) {
    this.tokens = Math.max(1, capacity);
    this.lastRefillAt = now;
  }

  tryTake(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  retryAfterMs(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.max(0, this.refillMs - (now - this.lastRefillAt));
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefillAt);
    const additions = Math.floor(elapsed / this.refillMs);
    if (additions <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + additions);
    this.lastRefillAt += additions * this.refillMs;
  }
}
