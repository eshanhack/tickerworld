import { describe, expect, it } from 'vitest';
import {
  BlockStore,
  ChatRateGate,
  socialInteractionLocksMovement,
  validateChatDraft,
} from '../src/social';
import {
  ChatReplayGuard,
  chatConnectionStatus,
  chatMessageIdentity,
  chatMessageScope,
  isChatScopeAvailable,
  visibleChatMessages,
} from '../src/social/SocialSystem';
import type { ChatMessage } from '../shared/src';

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
  it('distinguishes a deliberate tab handoff from a network reconnect', () => {
    expect(chatConnectionStatus('online', 1)).toBe('1 PLAYER · THIS ROOM');
    expect(chatConnectionStatus('connecting', 0)).toBe('CONNECTING TO CHAT');
    expect(chatConnectionStatus('reconnecting', 0)).toBe('CHAT RECONNECTING…');
    expect(chatConnectionStatus('offline', 0)).toBe('CHAT OFFLINE');
    expect(chatConnectionStatus('offline', 0, 'session_replaced')).toBe('CHAT OPEN IN ANOTHER TAB');
  });

  it('keeps world available while proximity waits for explicit room confirmation', () => {
    expect(isChatScopeAvailable('world', false)).toBe(true);
    expect(isChatScopeAvailable('proximity', false)).toBe(false);
    expect(isChatScopeAvailable('proximity', true)).toBe(true);
  });

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

  it('keeps world and proximity conversations in separate logs', () => {
    const world: ChatMessage = {
      id: 'world-1', actorId: 'actor-world', username: 'WorldFox', animal: 'fox',
      text: 'hello world', sentAt: 1, scope: 'world',
    };
    const nearby: ChatMessage = {
      id: 'nearby-1', actorId: 'actor-nearby', username: 'NearbyFrog', animal: 'frog',
      text: 'hello nearby', sentAt: 2, scope: 'proximity',
    };
    const messages = [world, nearby];

    expect(visibleChatMessages(messages, 'world', new Set(), false)).toEqual([world]);
    expect(visibleChatMessages(messages, 'proximity', new Set(), false)).toEqual([nearby]);
  });

  it('treats previous-protocol chat as world chat and hides blocked or private-view messages', () => {
    const legacy = {
      id: 'legacy-1', actorId: 'actor-legacy', username: null, animal: 'cat',
      text: 'legacy hello', sentAt: 1,
    } as ChatMessage;
    const world = { ...legacy, id: 'world-2', actorId: 'blocked', scope: 'world' as const };

    expect(chatMessageScope(legacy)).toBe('world');
    expect(visibleChatMessages([legacy, world], 'world', new Set(['blocked']), false)).toEqual([legacy]);
    expect(visibleChatMessages([legacy], 'world', new Set(), true)).toEqual([]);
  });

  it('deduplicates live/history overlap within one room and resets on market or channel travel', () => {
    const message: ChatMessage = {
      id: 'chat-stable-1', actorId: 'actor-1', username: 'MossyFox', animal: 'fox',
      text: 'one canonical message', sentAt: 10, scope: 'world',
    };
    const guard = new ChatReplayGuard();

    expect(guard.setContext('btc', 'btc-channel-1')).toBe(true);
    expect(guard.accept(message)).toBe(true);
    expect(guard.accept({ ...message })).toBe(false);
    expect(guard.setContext('btc', 'btc-channel-1')).toBe(false);
    expect(guard.accept(message)).toBe(false);

    expect(guard.setContext('btc', 'btc-channel-2')).toBe(true);
    expect(guard.accept(message)).toBe(true);
    expect(guard.setContext('eth', 'eth-channel-1')).toBe(true);
    expect(guard.accept(message)).toBe(true);
  });

  it('gives previous-protocol messages a deterministic replay identity', () => {
    const legacy = {
      id: '', actorId: 'legacy-actor', username: null, animal: 'rabbit',
      text: 'hello from before scopes', sentAt: 42,
    } as ChatMessage;
    expect(chatMessageIdentity(legacy)).toBe(
      'legacy:legacy-actor:42:world:hello from before scopes',
    );
    expect(chatMessageIdentity({ ...legacy })).toBe(chatMessageIdentity(legacy));
  });
});
