import { describe, expect, it, vi } from 'vitest';
import {
  pollPendingPurchase,
  readPendingPurchases,
  removePendingPurchase,
  upsertPendingPurchase,
} from '../src/economy';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('pending payment polling', () => {
  it('backs off until a confirmation arrives', async () => {
    let now = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const confirm = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'confirmed', profile: { id: 'account' } });

    const result = await pollPendingPurchase({ status: 'pending' }, {
      expiresAt: 30_000,
      now: () => now,
      sleep,
      confirm,
    });

    expect(result.status).toBe('confirmed');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1_000, 2_000]);
  });

  it('stops at expiry without another confirmation request', async () => {
    let now = 1_000;
    const confirm = vi.fn(async () => ({ status: 'pending' as const }));
    await expect(pollPendingPurchase({ status: 'pending' }, {
      expiresAt: 1_500,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      confirm,
    })).rejects.toThrow('expired');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('returns a reusable username credit without polling again', async () => {
    const confirm = vi.fn();
    const credited = { status: 'credited' as const, profile: { id: 'account' } as any };
    await expect(pollPendingPurchase(credited, {
      expiresAt: 30_000,
      confirm,
    })).resolves.toBe(credited);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('persists a bounded public confirmation reference across reloads', () => {
    const storage = memoryStorage();
    const now = Date.now();
    const first = {
      accountId: 'account_12345678', quoteId: 'quote_12345678', signature: '5'.repeat(88),
      pollUntil: now + 20_000, recoverUntil: now + 40_000,
    };
    const second = {
      accountId: 'account_87654321', quoteId: 'quote_87654321', signature: '6'.repeat(88),
      pollUntil: now + 20_000, recoverUntil: now + 40_000,
    };
    upsertPendingPurchase(storage, first);
    upsertPendingPurchase(storage, second);
    expect(readPendingPurchases(storage, first.accountId, now + 10_000)).toEqual([first]);
    removePendingPurchase(storage, second.accountId, second.quoteId);
    expect(readPendingPurchases(storage, undefined, now + 10_000)).toEqual([first]);
    expect(readPendingPurchases(storage, undefined, now + 40_000)).toEqual([]);
    expect(storage.length).toBe(0);
  });

  it('drops malformed persisted confirmation data', () => {
    const storage = memoryStorage();
    storage.setItem('tickerworld:v2:pending-purchases', JSON.stringify([{
      accountId: 'account_12345678', quoteId: 'quote_12345678',
      signature: 'not-a-solana-signature',
      pollUntil: 20_000, recoverUntil: 40_000,
    }]));
    expect(readPendingPurchases(storage, undefined, 10_000)).toEqual([]);
    expect(storage.length).toBe(0);
  });
});
