import { describe, expect, it } from 'vitest';
import type { AccountProfile } from '../shared/src/index.js';
import {
  DEFAULT_GUEST_APPEARANCE,
  DEFAULT_ANONYMOUS_ANIMAL,
  clearSignedGuestIdentity,
  classifyIdentityTransition,
  createIdentityRefreshMessage,
  createRoomJoinOptions,
  readGuestAppearance,
  readSignedGuestIdentity,
  readGuestIdentity,
  writeGuestAppearance,
  writeSignedGuestIdentity,
} from '../src/net';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const profile: AccountProfile = {
  id: 'account-1',
  actorId: 'player_1234567890123456',
  username: 'TickerFox',
  selectedAnimal: 'rabbit',
  selectedSkin: 'amethyst-rabbit',
  entitlements: ['username-claim', 'amethyst-rabbit'],
  lastMarket: 'eth',
};

describe('signed room identity', () => {
  it('starts as fox and preserves a complete browser appearance independently from room credentials', () => {
    const session = new MemoryStorage();
    const browser = new MemoryStorage();
    expect(readGuestAppearance(browser)).toEqual(DEFAULT_GUEST_APPEARANCE);
    expect(readGuestIdentity(session, browser).animal).toBe(DEFAULT_ANONYMOUS_ANIMAL);
    expect(writeGuestAppearance({
      animal: 'cat',
      skin: 'tide-cat',
      username: 'Magic_Cat',
    }, browser)).toEqual({ animal: 'cat', skin: 'tide-cat', username: 'Magic_Cat' });
    expect(readGuestAppearance(browser)).toEqual({
      animal: 'cat', skin: 'tide-cat', username: 'Magic_Cat',
    });
    expect(readGuestIdentity(session, browser).animal).toBe('cat');

    writeSignedGuestIdentity({
      actorId: 'anon_12345678901234567890123456789012',
      animal: 'frog',
      token: 'signed-token-with-enough-entropy',
      expiresAt: 50_000,
    }, session);
    expect(readGuestAppearance(browser)).toEqual({
      animal: 'cat', skin: 'tide-cat', username: 'Magic_Cat',
    });
  });

  it('safely degrades corrupt, cross-species, and invalid-name appearance data', () => {
    const browser = new MemoryStorage();
    browser.setItem('tickerworld:v2:guest-appearance', JSON.stringify({
      animal: 'fox', skin: 'tide-cat', username: 'not valid',
    }));
    expect(readGuestAppearance(browser)).toEqual({ animal: 'fox', skin: 'base', username: null });
    browser.setItem('tickerworld:v2:guest-appearance', '{broken');
    expect(readGuestAppearance(browser)).toEqual(DEFAULT_GUEST_APPEARANCE);
  });

  it('persists a signed anonymous token only for its live browser session', () => {
    const storage = new MemoryStorage();
    const identity = {
      actorId: 'anon_12345678901234567890123456789012',
      animal: 'frog' as const,
      token: 'signed-token-with-enough-entropy',
      expiresAt: 50_000,
    };
    writeSignedGuestIdentity(identity, storage);
    expect(readSignedGuestIdentity(storage, 1_000)).toEqual(identity);
    expect(readSignedGuestIdentity(storage, 46_000)).toBeNull();
    clearSignedGuestIdentity(storage);
    expect(readSignedGuestIdentity(storage, 1_000)).toBeNull();
  });

  it('never sends a client-controlled actor id in protocol-v2 join options', () => {
    const anonymous = createRoomJoinOptions('btc', {
      actorId: 'anon_12345678901234567890123456789012',
      animal: 'cat',
      token: 'server-signed-token-value',
      expiresAt: Date.now() + 60_000,
    }, null);
    expect(anonymous).toMatchObject({ market: 'btc', animal: 'cat', anonymousToken: 'server-signed-token-value' });
    expect('actorId' in anonymous).toBe(false);

    const account = createRoomJoinOptions('eth', null, { token: 'account-session', profile });
    expect(account).toMatchObject({
      market: 'eth',
      animal: 'rabbit',
      skin: 'amethyst-rabbit',
      sessionToken: 'account-session',
    });
    expect('actorId' in account).toBe(false);

    const travelling = createRoomJoinOptions('sol', null, { token: 'account-session', profile }, 'btc');
    expect(travelling).toMatchObject({ market: 'sol', fromMarket: 'btc' });
  });

  it('fails closed before entering a room without either signed authority', () => {
    expect(() => createRoomJoinOptions('sol', null, null)).toThrow('signed anonymous identity');
  });

  it('refreshes signed wallet or anonymous identity without a new join payload', () => {
    expect(createIdentityRefreshMessage({ token: 'account-session', profile }, null)).toEqual({
      protocolVersion: 2,
      sessionToken: 'account-session',
    });
    expect(createIdentityRefreshMessage(null, {
      actorId: 'anon_12345678901234567890123456789012',
      animal: 'cat',
      token: 'signed-anonymous',
      expiresAt: Date.now() + 60_000,
    })).toEqual({ protocolVersion: 2, anonymousToken: 'signed-anonymous' });
    expect(createIdentityRefreshMessage(null, null)).toBeNull();
  });

  it('keeps same-actor profile changes in place and rejoins for actor swaps', () => {
    expect(classifyIdentityTransition('anon-a', 'anon-a')).toBe('refresh');
    expect(classifyIdentityTransition('account-b', 'account-b')).toBe('refresh');
    expect(classifyIdentityTransition('anon-a', 'account-b')).toBe('rejoin');
    expect(classifyIdentityTransition(null, 'anon-a')).toBe('refresh');
  });
});
