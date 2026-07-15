import { describe, expect, it, vi } from 'vitest';
import {
  NewsWatchlistClient,
  normalizeNewsHandle,
  parseNewsApiResponse,
  type NewsItem,
  type TrackedNewsAccount,
} from '../src/news';

const NOW = Date.parse('2026-07-14T08:00:00.000Z');

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

function account(handle: string, overrides: Partial<TrackedNewsAccount> = {}): TrackedNewsAccount {
  return {
    id: `x-${handle.toLowerCase()}`,
    handle,
    name: `${handle} News`,
    avatarUrl: `https://pbs.twimg.com/profile_images/${handle}.jpg`,
    isDefault: false,
    status: 'live',
    lastPostAt: NOW - 1_000,
    ...overrides,
  };
}

function item(handle: string, source: NewsItem['source'] = 'x'): NewsItem {
  return {
    id: `${source}-${handle}`,
    source,
    text: source === 'simulation' ? 'DEMO · FICTIONAL NEWS' : `Post from ${handle}`,
    links: [],
    createdAt: NOW - 1_000,
    expiresAt: NOW + 599_000,
    authorName: `${handle} News`,
    authorHandle: handle,
    authorAvatarUrl: null,
    permalink: source === 'x' ? `https://x.com/${handle}/status/1` : null,
    demo: source === 'simulation',
    scope: 'BTC',
  };
}

function itemByAccount(
  handle: string,
  authorId: string | undefined,
  id = `${authorId ?? 'legacy'}-${handle}`,
): NewsItem {
  return {
    ...item(handle),
    id,
    ...(authorId ? { authorId } : {}),
  };
}

describe('personal news watchlists', () => {
  it('migrates legacy handle arrays to immutable account ids after catalog reconciliation', () => {
    const storage = memoryStorage();
    storage.setItem('tickerworld:v2:news-watchlists', JSON.stringify({
      BTC: ['DeItaone'],
      ETH: ['WatcherGuru'],
    }));
    const client = new NewsWatchlistClient({ activeMarket: 'BTC', storage, baseUrl: null });
    expect(client.snapshot.selectedHandles).toEqual(['DeItaone']);
    client.setCatalog([account('DeItaone', { id: 'x-user-123' })]);
    expect(JSON.parse(storage.getItem('tickerworld:v2:news-watchlists') ?? '{}')).toEqual({
      BTC: [{ id: 'x-user-123', handle: 'DeItaone' }],
      ETH: [{ id: null, handle: 'WatcherGuru' }],
    });
    client.setActiveMarket('ETH');
    client.setCatalog([account('WatcherGuru', { id: 'x-user-456' })]);
    expect(JSON.parse(storage.getItem('tickerworld:v2:news-watchlists') ?? '{}')).toEqual({
      BTC: [{ id: 'x-user-123', handle: 'DeItaone' }],
      ETH: [{ id: 'x-user-456', handle: 'WatcherGuru' }],
    });
  });

  it('follows a handle rename by immutable account id and persists the verified handle', () => {
    const storage = memoryStorage();
    storage.setItem('tickerworld:v2:news-watchlists', JSON.stringify({
      BTC: [{ id: 'x-user-123', handle: 'DeItaone' }],
    }));
    const client = new NewsWatchlistClient({ activeMarket: 'BTC', storage, baseUrl: null });
    client.setCatalog([
      account('DeltaOneNews', { id: 'x-user-123' }),
      account('DeItaone', { id: 'x-user-reclaimer' }),
    ]);
    expect(client.snapshot.selectedHandles).toEqual(['DeltaOneNews']);
    expect(client.snapshot.accounts).toEqual([
      expect.objectContaining({ id: 'x-user-123', handle: 'DeltaOneNews' }),
    ]);
    expect(JSON.parse(storage.getItem('tickerworld:v2:news-watchlists') ?? '{}')).toEqual({
      BTC: [{ id: 'x-user-123', handle: 'DeltaOneNews' }],
    });
    expect(client.filterItems([
      itemByAccount('DeItaone', 'x-user-reclaimer'),
      itemByAccount('DeltaOneNews', 'x-user-123'),
    ]).map((post) => post.authorId)).toEqual(['x-user-123']);
  });

  it('never follows a different account that reclaims a selected handle', async () => {
    const storage = memoryStorage();
    storage.setItem('tickerworld:v2:news-watchlists', JSON.stringify({
      BTC: [{ id: 'x-user-original', handle: 'DeItaone' }],
    }));
    const client = new NewsWatchlistClient({ activeMarket: 'BTC', storage, baseUrl: null });
    client.setCatalog([account('DeItaone', { id: 'x-user-reclaimer' })]);

    expect(client.snapshot.accounts).toEqual([
      expect.objectContaining({ id: 'x-user-original', handle: 'DeItaone', status: 'reconnecting' }),
    ]);
    const original = itemByAccount('DeltaOneNews', 'x-user-original', 'original');
    const reclaimer = itemByAccount('DeItaone', 'x-user-reclaimer', 'reclaimer');
    const legacyReclaimer = itemByAccount('DeItaone', undefined, 'legacy-reclaimer');
    expect(client.filterItems([reclaimer, legacyReclaimer, original])).toEqual([original]);
    expect(client.latestItemFor([reclaimer, legacyReclaimer, original], 'DeItaone')).toBe(original);
    await expect(client.add('DeItaone')).resolves.toEqual({
      ok: false,
      error: '@DeItaone is already selected.',
    });
    expect(JSON.parse(storage.getItem('tickerworld:v2:news-watchlists') ?? '{}')).toEqual({
      BTC: [{ id: 'x-user-original', handle: 'DeItaone' }],
    });
  });

  it('rejects an association response when a saved handle resolves to another account id', async () => {
    const storage = memoryStorage();
    storage.setItem('tickerworld:v2:news-watchlists', JSON.stringify({
      BTC: [{ id: 'x-user-original', handle: 'DeItaone' }],
    }));
    const reclaimer = account('DeItaone', { id: 'x-user-reclaimer' });
    const fetcher = vi.fn(async () => Response.json({ account: reclaimer }));
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage,
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher,
    });
    client.setCatalog([reclaimer]);
    await vi.waitFor(() => expect(client.snapshot.accounts[0]?.status).toBe('unavailable'));
    expect(client.snapshot.accounts[0]).toMatchObject({
      id: 'x-user-original',
      handle: 'DeItaone',
    });
    expect(JSON.parse(storage.getItem('tickerworld:v2:news-watchlists') ?? '{}')).toEqual({
      BTC: [{ id: 'x-user-original', handle: 'DeItaone' }],
    });
  });

  it('normalizes handles and persists independent selections for every world', () => {
    expect(normalizeNewsHandle(' @DeItaone ')).toBe('DeItaone');
    expect(normalizeNewsHandle('https://x.com/DeItaone')).toBeNull();
    const storage = memoryStorage();
    const first = new NewsWatchlistClient({ activeMarket: 'BTC', storage, baseUrl: null });
    first.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('WatcherGuru', { isDefault: true }),
    ]);
    expect(first.snapshot.selectedHandles).toEqual(['DeItaone', 'WatcherGuru']);
    expect(first.remove('DeItaone')).toBe(true);

    first.setActiveMarket('ETH');
    first.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('tier10k', { isDefault: true }),
    ]);
    expect(first.snapshot.selectedHandles).toEqual(['DeItaone', 'tier10k']);
    first.dispose();

    const restored = new NewsWatchlistClient({ activeMarket: 'BTC', storage, baseUrl: null });
    restored.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('WatcherGuru', { isDefault: true }),
    ]);
    expect(restored.snapshot.selectedHandles).toEqual(['WatcherGuru']);
    restored.setActiveMarket('ETH');
    restored.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('tier10k', { isDefault: true }),
    ]);
    expect(restored.snapshot.selectedHandles).toEqual(['DeItaone', 'tier10k']);
  });

  it('canonically verifies both catalog hits and new handles through the signed endpoint', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const handle = (JSON.parse(String(init?.body)) as { handle: string }).handle;
      return Response.json({ account: account(handle) });
    });
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage: memoryStorage(),
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher,
    });
    client.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('WatcherGuru', { isDefault: true }),
    ]);
    client.remove('WatcherGuru');
    expect((await client.add('@WatcherGuru')).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const result = await client.add('unusual_whales');
    expect(result).toMatchObject({ ok: true, account: { handle: 'unusual_whales' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://multiplayer.tickerworld.test/api/news/accounts');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      scope: 'BTC',
      handle: 'unusual_whales',
      anonymousToken: 'signed-anonymous-token',
    });
    expect(client.snapshot.selectedHandles).toContain('unusual_whales');
  });

  it('waits for the shared anonymous identity before adding an account', async () => {
    let resolveToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { resolveToken = resolve; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const handle = (JSON.parse(String(init?.body)) as { handle: string }).handle;
      return Response.json({ account: account(handle) });
    });
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage: memoryStorage(),
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => token,
      fetcher,
    });

    const adding = client.add('unusual_whales');
    expect(client.snapshot).toMatchObject({ adding: true, error: null });
    expect(fetcher).not.toHaveBeenCalled();

    resolveToken('signed-anonymous-token');
    await expect(adding).resolves.toMatchObject({
      ok: true,
      account: { handle: 'unusual_whales' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.snapshot).toMatchObject({ adding: false, error: null });
  });

  it('uses the canonical acquire response instead of a stale catalog owner', async () => {
    const storage = memoryStorage();
    const stale = account('headline_alerts', { id: 'x-user-old-owner' });
    const current = account('headline_alerts', { id: 'x-user-new-owner' });
    const fetcher = vi.fn(async () => Response.json({ account: current }));
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage,
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher,
    });
    client.setCatalog([stale]);

    await expect(client.add('headline_alerts')).resolves.toMatchObject({
      ok: true,
      account: { id: 'x-user-new-owner' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.snapshot.accounts).toEqual([
      expect.objectContaining({ id: 'x-user-new-owner', handle: 'headline_alerts' }),
    ]);
    expect(client.snapshot.catalog).toEqual([
      expect.objectContaining({ id: 'x-user-new-owner' }),
    ]);
    expect(JSON.parse(storage.getItem('tickerworld:v2:news-watchlists') ?? '{}')).toEqual({
      BTC: [{ id: 'x-user-new-owner', handle: 'headline_alerts' }],
    });
  });

  it('debounces immediate failed acquire retries for the same world and handle', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage: memoryStorage(),
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher,
    });
    await expect(client.add('headline_alerts')).resolves.toMatchObject({ ok: false });
    await expect(client.add('headline_alerts')).resolves.toEqual({
      ok: false,
      error: 'Please wait a moment before retrying that account.',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('filters live posts by selection while always retaining clearly labelled demo content', () => {
    const client = new NewsWatchlistClient({ activeMarket: 'BTC', storage: memoryStorage(), baseUrl: null });
    client.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('WatcherGuru', { isDefault: true }),
    ]);
    client.remove('WatcherGuru');
    const posts = [item('DeItaone'), item('WatcherGuru'), item('tickerworld_demo', 'simulation')];
    expect(client.filterItems(posts).map((post) => post.authorHandle)).toEqual([
      'DeItaone',
      'tickerworld_demo',
    ]);
    expect(client.latestItemFor(posts, 'DeItaone')?.authorHandle).toBe('DeItaone');
    expect(client.latestItemFor(posts, 'WatcherGuru')?.authorHandle).toBe('WatcherGuru');
  });

  it('cancels an in-flight add when the active world changes', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const handle = (JSON.parse(String(init?.body)) as { handle: string }).handle;
      if (handle !== 'DeItaone') return Promise.resolve(Response.json({ account: account(handle) }));
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    });
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage: memoryStorage(),
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher,
    });
    client.setCatalog([account('stale_source', { isDefault: true })]);
    const pending = client.add('DeItaone');
    expect(client.snapshot.adding).toBe(true);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    client.setActiveMarket('ETH');
    client.setCatalog([account('WatcherGuru', { isDefault: true })]);
    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'Account request was cancelled when the world changed.',
    });
    expect(client.snapshot.adding).toBe(false);
    expect(client.snapshot.selectedHandles).toEqual(['WatcherGuru']);

    client.setActiveMarket('BTC');
    client.setCatalog([account('DeItaone')]);
    expect(client.snapshot.selectedHandles).toEqual(['stale_source']);
    expect(client.snapshot.accounts).toEqual([
      expect.objectContaining({ handle: 'stale_source', status: 'reconnecting' }),
    ]);
  });

  it('bounds account requests with an abortable deadline', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    });
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage: memoryStorage(),
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher,
      requestTimeoutMs: 5,
    });
    client.setCatalog([account('DeItaone', { isDefault: true })]);
    await expect(client.add('unusual_whales')).resolves.toEqual({
      ok: false,
      error: 'The news service took too long to respond. Try again.',
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(client.snapshot.adding).toBe(false);
  });

  it('honours an explicit watchlist while the server catalog is absent', () => {
    const posts = [item('DeItaone'), item('WatcherGuru'), item('tickerworld_demo', 'simulation')];
    const fresh = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage: memoryStorage(),
      baseUrl: null,
    });
    expect(fresh.filterItems(posts)).toEqual(posts);

    fresh.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('WatcherGuru', { isDefault: true }),
    ]);
    fresh.remove('WatcherGuru');
    fresh.setCatalog([]);
    expect(fresh.filterItems(posts).map((post) => post.authorHandle)).toEqual([
      'DeItaone',
      'tickerworld_demo',
    ]);
    fresh.remove('DeItaone');
    expect(fresh.filterItems(posts).map((post) => post.authorHandle)).toEqual([
      'tickerworld_demo',
    ]);
  });

  it('best-effort refreshes custom source associations and marks failed touches unavailable', async () => {
    const storage = memoryStorage();
    storage.setItem('tickerworld:v2:news-watchlists', JSON.stringify({
      BTC: [{ id: 'x-unusual_whales', handle: 'unusual_whales' }],
    }));
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response('{}', { status: 503 })
    ));
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage,
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher,
    });
    client.setCatalog([account('unusual_whales')]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.snapshot.accounts[0]?.status).toBe('unavailable'));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      scope: 'BTC',
      handle: 'unusual_whales',
      anonymousToken: 'signed-anonymous-token',
      accountId: 'x-unusual_whales',
    });
    expect(client.snapshot.selectedHandles).toEqual(['unusual_whales']);
  });

  it('aborts saved-source association requests when leaving a world', async () => {
    const storage = memoryStorage();
    storage.setItem('tickerworld:v2:news-watchlists', JSON.stringify({
      BTC: [{ id: 'x-unusual_whales', handle: 'unusual_whales' }],
    }));

    let requestSignal: AbortSignal | undefined;
    const client = new NewsWatchlistClient({
      activeMarket: 'BTC',
      storage,
      baseUrl: 'https://multiplayer.tickerworld.test',
      anonymousToken: () => 'signed-anonymous-token',
      fetcher: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    });
    client.setCatalog([account('unusual_whales')]);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    client.setActiveMarket('ETH');
    expect(requestSignal?.aborted).toBe(true);
    client.setCatalog([account('WatcherGuru', { isDefault: true })]);
    await Promise.resolve();
    expect(client.snapshot.accounts).toEqual([
      expect.objectContaining({ handle: 'WatcherGuru', status: 'live' }),
    ]);
    client.dispose();
  });

  it('never auto-selects community-added accounts for a new visitor', () => {
    const client = new NewsWatchlistClient({ activeMarket: 'BTC', storage: memoryStorage(), baseUrl: null });
    client.setCatalog([
      account('DeItaone', { isDefault: true }),
      account('untrusted_custom_source'),
    ]);
    expect(client.snapshot.selectedHandles).toEqual(['DeItaone']);
    expect(client.snapshot.accounts.map((value) => value.handle)).toEqual(['DeItaone']);
  });

  it('parses a bounded account catalog and rejects unsafe profile metadata', () => {
    const parsed = parseNewsApiResponse({
      mode: 'live',
      checkedAt: NOW,
      maxAccounts: 99,
      items: [],
      accounts: [
        account('DeItaone', { isDefault: true }),
        account('unsafe', { avatarUrl: 'javascript:alert(1)' }),
      ],
    }, NOW);
    expect(parsed?.maxAccounts).toBe(8);
    expect(parsed?.accounts).toEqual([expect.objectContaining({
      handle: 'DeItaone',
      isDefault: true,
      status: 'live',
    })]);
  });
});
