import { describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '../shared/src/index.js';
import {
  EconomyApi,
  EconomySystem,
  PREMIUM_SKIN_CATALOG,
  USERNAME_CLAIM_USD_CENTS,
} from '../src/economy';
import type { ConnectedWallet } from '../src/economy/walletTypes';

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
  actorId: 'actor-1',
  username: null,
  selectedAnimal: 'fox',
  selectedSkin: 'base',
  entitlements: [],
  lastMarket: 'btc',
};

describe('economy catalog', () => {
  it('ships one permanent premium palette for every base animal', () => {
    expect(PREMIUM_SKIN_CATALOG).toHaveLength(8);
    expect(new Set(PREMIUM_SKIN_CATALOG.map((skin) => skin.id)).size).toBe(8);
    expect(new Set(PREMIUM_SKIN_CATALOG.map((skin) => skin.animal)).size).toBe(8);
    expect(PREMIUM_SKIN_CATALOG.every((skin) => skin.usdCents === 600)).toBe(true);
    expect(USERNAME_CLAIM_USD_CENTS).toBe(300);
  });
});

describe('economy API boundary', () => {
  it('keeps the revocable token in session storage and uses bearer auth', async () => {
    const storage = new MemoryStorage();
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-session');
      return new Response(JSON.stringify(profile), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const api = new EconomyApi({
      baseUrl: 'wss://multiplayer.tickerworld.io/',
      fetch: request as typeof fetch,
      storage,
      anonymousToken: () => 'signed-anonymous',
    });
    api.setSessionToken('secret-session');
    await expect(api.getProfile()).resolves.toEqual(profile);
    expect(request).toHaveBeenCalledWith('https://multiplayer.tickerworld.io/api/account', expect.any(Object));
    await expect(api.updateLastMarket('eth')).resolves.toEqual(profile);
    expect(request).toHaveBeenLastCalledWith(
      'https://multiplayer.tickerworld.io/api/account/profile',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ lastMarket: 'eth' }) }),
    );
    await expect(api.claimUsername('Star_Fox')).resolves.toEqual(profile);
    expect(request).toHaveBeenLastCalledWith(
      'https://multiplayer.tickerworld.io/api/account/username',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ username: 'Star_Fox' }) }),
    );

    const restored = new EconomyApi({
      baseUrl: 'https://multiplayer.tickerworld.io',
      fetch: request as typeof fetch,
      storage,
      anonymousToken: () => 'signed-anonymous',
    });
    expect(restored.sessionToken).toBe('secret-session');
  });

  it('never attaches the account token to wallet challenge or verification calls', async () => {
    const storage = new MemoryStorage();
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      if (String(input).endsWith('/challenge')) {
        return new Response(JSON.stringify({ id: 'challenge-1', message: 'Sign in', expiresAt: Date.now() + 60_000 }), { status: 200 });
      }
      return new Response(JSON.stringify({ sessionToken: 'new-session', profile, blocks: [] }), { status: 200 });
    });
    const api = new EconomyApi({
      baseUrl: 'https://example.test',
      fetch: request as typeof fetch,
      storage,
      anonymousToken: () => 'signed-anonymous',
    });
    api.setSessionToken('stale-token');
    await api.challenge('public-key', 'actor-1');
    await api.verify('challenge-1', 'public-key', 'signature', 'actor-1');
    expect(api.sessionToken).toBe('new-session');
    const challengeRequest = request.mock.calls[0]!;
    expect(JSON.parse(String(challengeRequest[1]?.body))).toEqual({
      publicKey: 'public-key',
      actorId: 'actor-1',
      anonymousToken: 'signed-anonymous',
    });
    const verifyRequest = request.mock.calls[1]!;
    expect(JSON.parse(String(verifyRequest[1]?.body))).toEqual({
      challengeId: 'challenge-1',
      publicKey: 'public-key',
      signature: 'signature',
      actorId: 'actor-1',
      anonymousToken: 'signed-anonymous',
    });
  });

  it('clears a rejected session without exposing the response body requirement', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 }));
    const api = new EconomyApi({ baseUrl: 'https://example.test', fetch: request as typeof fetch, storage: null });
    api.setSessionToken('expired');
    await expect(api.getProfile()).rejects.toThrow('Session expired');
    expect(api.sessionToken).toBeNull();
  });

  it('fails closed before wallet auth when no signed anonymous actor is available', async () => {
    const request = vi.fn();
    const api = new EconomyApi({ baseUrl: 'https://example.test', fetch: request as typeof fetch, storage: null });
    await expect(api.challenge('public-key', 'actor-1')).rejects.toThrow('Anonymous identity');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('wallet disconnect safety', () => {
  it('revokes the session and restores anonymous state on an external disconnect', async () => {
    const wallet = { publicKey: 'wallet' } as ConnectedWallet;
    const removeDisconnectListener = vi.fn();
    const logout = vi.fn(async () => undefined);
    const applyProfile = vi.fn(async () => true);
    const setStatus = vi.fn();
    const system = Object.create(EconomySystem.prototype) as EconomySystem & Record<string, unknown>;
    Object.assign(system, {
      disposed: false,
      wallet,
      removeWalletDisconnectListener: removeDisconnectListener,
      api: { logout },
      applyProfile,
      setStatus,
    });

    await (system as any).handleExternalWalletDisconnect(wallet);

    expect((system as any).wallet).toBeNull();
    expect((system as any).removeWalletDisconnectListener).toBeNull();
    expect(removeDisconnectListener).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
    expect(applyProfile).toHaveBeenCalledWith(null);
    expect(setStatus).toHaveBeenCalledWith('Wallet disconnected. Paid identity is hidden, not lost.');
  });
});
