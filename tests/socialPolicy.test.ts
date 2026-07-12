import { describe, expect, it } from 'vitest';
import {
  BlockStore,
  ChatRateGate,
  socialInteractionLocksMovement,
  validateChatDraft,
} from '../src/social';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('social policy', () => {
  it('keeps ambient chat non-modal while player actions still lock movement', () => {
    expect(socialInteractionLocksMovement('chat')).toBe(false);
    expect(socialInteractionLocksMovement('player')).toBe(true);
  });

  it('allows a three-message burst and refills one token every two seconds', () => {
    const gate = new ChatRateGate(3, 2_000, 0);
    expect([gate.tryTake(0), gate.tryTake(0), gate.tryTake(0), gate.tryTake(0)]).toEqual([true, true, true, false]);
    expect(gate.retryAfterMs(500)).toBe(1_500);
    expect(gate.tryTake(1_999)).toBe(false);
    expect(gate.tryTake(2_000)).toBe(true);
    expect(gate.tryTake(2_000)).toBe(false);
  });

  it('normalizes whitespace without weakening the 140-character limit', () => {
    expect(validateChatDraft('  hello   little world  ')).toEqual({ text: 'hello little world', error: null });
    expect(validateChatDraft('  ')).toEqual({ text: '', error: 'empty' });
    expect(validateChatDraft('x'.repeat(141)).error).toBe('too_long');
  });

  it('persists and merges local safety blocks immediately', () => {
    const storage = new MemoryStorage();
    const first = new BlockStore(storage);
    expect(first.block('actor-1')).toBe(true);
    expect(first.block('actor-1')).toBe(false);
    expect(first.merge(['actor-2', 'actor-3'])).toBe(true);

    const restored = new BlockStore(storage);
    expect([...restored.snapshot].sort()).toEqual(['actor-1', 'actor-2', 'actor-3']);
    expect(restored.unblock('actor-2')).toBe(true);
    expect(restored.has('actor-2')).toBe(false);
  });
});
