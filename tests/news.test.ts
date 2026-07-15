import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserNewsFeed,
  NEWS_ITEM_TTL_MS,
  createDemoNewsItem,
  dedupeNewsItems,
  findGenuinelyNewItems,
  mergeNewsItems,
  parseNewsApiResponse,
  pruneExpiredNewsItems,
  type NewsApiMode,
  type NewsApiResponse,
  type NewsFeedUpdate,
  type NewsItem,
} from '../src/news';
import {
  buildXTimelineUrl,
  handleNewsRequest,
  normalizeXTimelineResponse,
} from '../api/news';

const NOW = Date.parse('2026-07-11T04:00:00.000Z');

function item(
  id: string,
  createdAt: number,
  overrides: Partial<NewsItem> = {},
): NewsItem {
  return {
    id,
    source: 'x',
    text: `Headline ${id}`,
    links: [],
    createdAt,
    expiresAt: createdAt + NEWS_ITEM_TTL_MS,
    authorName: 'Walter Bloomberg',
    authorHandle: 'DeItaone',
    authorAvatarUrl: 'https://example.com/avatar.jpg',
    permalink: `https://x.com/DeItaone/status/${id}`,
    demo: false,
    scope: 'global',
    ...overrides,
  };
}

function response(mode: NewsApiMode, items: readonly NewsItem[], checkedAt = NOW): Response {
  const body: NewsApiResponse = { mode, items, checkedAt };
  return Response.json(body);
}

describe('news item helpers', () => {
  it('parses valid API data while enforcing the client-owned ten-minute expiry', () => {
    const validLink = {
      kind: 'url' as const,
      start: 0,
      end: 10,
      label: 'x.com/story',
      href: 'https://t.co/story',
    };
    const payload = {
      mode: 'live',
      checkedAt: NOW,
      items: [{
        ...item('1', NOW - 1_000),
        authorId: '123456789',
        links: [validLink, { ...validLink, href: 'https://evil.example/story' }],
        expiresAt: NOW + 99_000_000,
      }],
    };
    const parsed = parseNewsApiResponse(payload, NOW);
    expect(parsed?.mode).toBe('live');
    expect(parsed?.items[0]).toMatchObject({
      id: '1',
      expiresAt: NOW - 1_000 + NEWS_ITEM_TTL_MS,
      demo: false,
      authorId: '123456789',
      links: [validLink],
    });
    expect(parseNewsApiResponse({ mode: 'live', checkedAt: NOW, items: 'bad' }, NOW)).toBeUndefined();

    const invalidAuthor = { ...item('invalid-author', NOW - 1_000), authorId: '   ' };
    expect(parseNewsApiResponse({ mode: 'live', checkedAt: NOW, items: [invalidAuthor] }, NOW)?.items)
      .toEqual([]);

    const legacyItem = { ...item('legacy', NOW - 1_000) } as Record<string, unknown>;
    delete legacyItem.links;
    expect(parseNewsApiResponse({ mode: 'live', checkedAt: NOW, items: [legacyItem] }, NOW)?.items[0]?.links)
      .toEqual([]);
  });

  it('deduplicates newest-first, lets incoming edits win, and expires at exactly ten minutes', () => {
    const old = item('old', NOW - NEWS_ITEM_TTL_MS);
    const first = item('same', NOW - 2_000, { text: 'Original' });
    const edited = item('same', NOW - 2_000, { text: 'Edited' });
    const latest = item('latest', NOW - 1_000);

    expect(pruneExpiredNewsItems([old, first], NOW)).toEqual([first]);
    expect(dedupeNewsItems([first, latest, first]).map((value) => value.id)).toEqual(['latest', 'same']);
    expect(mergeNewsItems([first], [edited], NOW)[0]?.text).toBe('Edited');
  });

  it('treats the initial response as silent and forwards every later unseen id', () => {
    const baseline = [item('2', NOW - 2_000), item('1', NOW - 3_000)];
    const first = findGenuinelyNewItems(
      baseline,
      { seenIds: new Set(), newestCreatedAt: Number.NEGATIVE_INFINITY },
      true,
    );
    expect(first.added).toEqual([]);

    const next = findGenuinelyNewItems(
      [item('3', NOW - 1_000), ...baseline, item('backfill', NOW - 9_000)],
      first,
      false,
    );
    expect(next.added.map((value) => value.id)).toEqual(['3', 'backfill']);
  });

  it('creates deterministic, clearly labelled fictional demo items', () => {
    const first = createDemoNewsItem(2, NOW);
    const second = createDemoNewsItem(2, NOW);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      source: 'simulation',
      demo: true,
      links: [],
      authorHandle: 'tickerworld_demo',
      permalink: null,
    });
    expect(first.text).toMatch(/^DEMO · FICTIONAL TICKERWORLD NEWS/);
  });
});

describe('BrowserNewsFeed lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests only the active market scope from the centralized cache', async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return response('live', []);
    });
    const feed = new BrowserNewsFeed({ fetcher, activeMarket: 'ETH' });
    await feed.start();
    expect(requested).toEqual(['/api/news?scope=ETH']);
    feed.dispose();
  });

  it('emits one silent demo immediately, then one notifiable item every five minutes', async () => {
    const updates: NewsFeedUpdate[] = [];
    const feed = new BrowserNewsFeed({ forceSimulation: true });
    feed.subscribe((update) => updates.push(update));
    await feed.start();

    expect(updates.at(-1)).toMatchObject({ mode: 'simulated', added: [] });
    expect(updates.at(-1)?.items).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(updates.at(-1)?.items).toHaveLength(2);
    expect(updates.at(-1)?.added).toHaveLength(1);

    feed.pause();
    const pausedCount = updates.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(updates).toHaveLength(pausedCount);

    feed.resume();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(updates.at(-1)?.added).toHaveLength(1);
    feed.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps initial live history silent and notifies every subsequent unseen item', async () => {
    const firstItems = [item('2', NOW - 2_000), item('1', NOW - 3_000)];
    const secondItems = [
      item('3', NOW + 500),
      ...firstItems,
      item('older-backfill', NOW - 8_000),
    ];
    const replies = [response('live', firstItems), response('live', secondItems, NOW + 1_000)];
    const fetcher = vi.fn(async () => replies.shift() ?? response('live', secondItems, Date.now()));
    const updates: NewsFeedUpdate[] = [];
    const feed = new BrowserNewsFeed({ fetcher, pollIntervalMs: 1_000 });
    feed.subscribe((update) => updates.push(update));

    await feed.start();
    expect(updates.at(-1)).toMatchObject({ mode: 'live', added: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.at(-1)?.added.map((value) => value.id)).toEqual(['3', 'older-backfill']);
    expect(feed.getSnapshot().added).toEqual([]);

    const lateSubscriber = vi.fn();
    feed.subscribe(lateSubscriber);
    expect(lateSubscriber.mock.calls[0]?.[0].added).toEqual([]);
    feed.dispose();
  });

  it('shows clearly labelled demo news while unconfigured and silently adopts live backfill later', async () => {
    const replies = [
      response('unconfigured', []),
      response('live', [item('live-1', NOW + 1_000)], NOW + 1_000),
    ];
    const fetcher = vi.fn(async () => replies.shift() ?? response('live', [], Date.now()));
    const updates: NewsFeedUpdate[] = [];
    const feed = new BrowserNewsFeed({ fetcher, pollIntervalMs: 1_000 });
    feed.subscribe((update) => updates.push(update));

    await feed.start();
    expect(updates.at(-1)).toMatchObject({
      mode: 'simulated',
      added: [],
      items: [expect.objectContaining({ demo: true, source: 'simulation' })],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.at(-1)).toMatchObject({ mode: 'live', added: [] });
    expect(updates.at(-1)?.items.map((value) => value.id)).toEqual(['live-1']);
    feed.dispose();
  });

  it('keeps the real account catalog available while showing labelled demo news', async () => {
    const fetcher = vi.fn(async () => Response.json({
      mode: 'unconfigured',
      items: [],
      checkedAt: NOW,
      maxAccounts: 8,
      accounts: [{
        id: 'x-user-1',
        handle: 'DeItaone',
        name: 'Delta One',
        avatarUrl: 'https://pbs.twimg.com/profile_images/delta.jpg',
        isDefault: true,
        status: 'unavailable',
        lastPostAt: null,
      }],
    }));
    const feed = new BrowserNewsFeed({ fetcher, activeMarket: 'BTC' });
    await feed.start();
    expect(feed.getSnapshot()).toMatchObject({
      mode: 'simulated',
      accounts: [expect.objectContaining({ handle: 'DeItaone', status: 'unavailable' })],
      maxAccounts: 8,
    });
    feed.dispose();
  });

  it('keeps a labelled demo visible when the player changes markets while X is unconfigured', async () => {
    const fetcher = vi.fn(async () => response('unconfigured', []));
    const feed = new BrowserNewsFeed({ fetcher, activeMarket: 'BTC' });

    await feed.start();
    expect(feed.getSnapshot()).toMatchObject({
      mode: 'simulated',
      items: [expect.objectContaining({ source: 'simulation', demo: true })],
    });

    feed.setActiveMarket('ETH');
    await vi.waitFor(() => {
      expect(feed.getSnapshot()).toMatchObject({
        mode: 'simulated',
        items: [expect.objectContaining({ source: 'simulation', demo: true })],
      });
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/news?scope=ETH',
      expect.objectContaining({ method: 'GET' }),
    );
    feed.dispose();
  });

  it('surfaces a delayed unseen post once after an empty silent baseline', async () => {
    const replies = [
      response('live', []),
      response('live', [item('delayed-backfill', NOW - 1_000)], NOW + 1_000),
    ];
    const fetcher = vi.fn(async () => replies.shift() ?? response('live', [], Date.now()));
    const updates: NewsFeedUpdate[] = [];
    const feed = new BrowserNewsFeed({ fetcher, pollIntervalMs: 1_000 });
    feed.subscribe((update) => updates.push(update));

    await feed.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.at(-1)?.items.map((value) => value.id)).toEqual(['delayed-backfill']);
    expect(updates.at(-1)?.added.map((value) => value.id)).toEqual(['delayed-backfill']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.at(-1)?.added).toEqual([]);
    feed.dispose();
  });

  it('refreshes immediately and resets the background poll cadence', async () => {
    const fetcher = vi.fn(async () => response('live', []));
    const feed = new BrowserNewsFeed({ fetcher, pollIntervalMs: 5_000 });
    await feed.start();

    await feed.refreshNow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/news',
      expect.objectContaining({ cache: 'no-store' }),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    feed.dispose();
  });

  it('keeps every active id in a burst larger than 512 without replaying alerts', async () => {
    const burst = Array.from({ length: 600 }, (_, index) => (
      item(`burst-${index}`, NOW - index)
    ));
    const fetcher = vi.fn(async () => response('live', burst));
    const updates: NewsFeedUpdate[] = [];
    const feed = new BrowserNewsFeed({ fetcher, pollIntervalMs: 1_000 });
    feed.subscribe((update) => updates.push(update));

    await feed.start();
    expect(updates.at(-1)?.added).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.at(-1)?.items).toHaveLength(600);
    expect(updates.at(-1)?.added).toEqual([]);
    feed.dispose();
  });

  it('lets an explicit refresh own the cadence when it supersedes a slow poll', async () => {
    let call = 0;
    let refreshSignal: AbortSignal | undefined;
    let resolveRefresh!: () => void;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      if (call === 1 || call >= 4) return Promise.resolve(response('live', []));
      if (call === 2) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Superseded', 'AbortError'));
          }, { once: true });
        });
      }
      refreshSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveRefresh = () => resolve(response('live', []));
      });
    });
    const feed = new BrowserNewsFeed({ fetcher, pollIntervalMs: 1_000 });
    await feed.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const refresh = feed.refreshNow();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refreshSignal?.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);

    resolveRefresh();
    await refresh;
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
    feed.dispose();
  });
});

describe('X timeline endpoint helpers', () => {
  it('requests authored posts including replies while excluding reposts', () => {
    const url = new URL(buildXTimelineUrl('123', NOW));
    expect(`${url.origin}${url.pathname}`).toBe('https://api.x.com/2/users/123/tweets');
    expect(url.searchParams.get('max_results')).toBe('100');
    expect(url.searchParams.get('exclude')).toBe('retweets');
    expect(url.searchParams.get('tweet.fields')).toContain('created_at');
    expect(url.searchParams.get('tweet.fields')).toContain('note_tweet');
    expect(url.searchParams.get('tweet.fields')).toContain('entities');
    expect(url.searchParams.get('expansions')).toBe('author_id');
    expect(url.searchParams.get('user.fields')).toContain('profile_image_url');
  });

  it('preserves full long-post text and normalizes expanded author attribution', () => {
    const author = { id: '123', name: 'Fallback', username: 'fallback' };
    const fullText = '  Full unmodified long-form headline with spacing.  ';
    const items = normalizeXTimelineResponse({
      data: [{
        id: '456',
        author_id: '123',
        created_at: new Date(NOW - 1_000).toISOString(),
        text: 'Truncated…',
        note_tweet: { text: fullText },
      }],
      includes: {
        users: [{
          id: '123',
          name: 'Walter Bloomberg',
          username: 'DeItaone',
          profile_image_url: 'https://example.com/delta.jpg',
        }],
      },
    }, author, NOW);

    expect(items).toEqual([expect.objectContaining({
      id: '456',
      authorId: '123',
      text: fullText,
      authorName: 'Walter Bloomberg',
      authorHandle: 'DeItaone',
      authorAvatarUrl: 'https://example.com/delta.jpg',
      permalink: 'https://x.com/DeItaone/status/456',
      demo: false,
    })]);
  });

  it('normalizes every standard entity into safe, display-compliant links', () => {
    const author = { id: '123', name: 'Walter Bloomberg', username: 'DeItaone' };
    const text = 'Breaking @alice #Markets $BTC https://t.co/abc';
    const range = (token: string) => {
      const start = text.indexOf(token);
      return { start, end: start + token.length };
    };
    const items = normalizeXTimelineResponse({
      data: [{
        id: 'entities-1',
        author_id: '123',
        created_at: new Date(NOW - 1_000).toISOString(),
        text,
        entities: {
          urls: [{
            ...range('https://t.co/abc'),
            url: 'https://t.co/abc',
            expanded_url: 'https://example.com/a-very-long-story',
            display_url: 'example.com/a-very-long-story',
          }],
          mentions: [{ ...range('@alice'), username: 'alice', id: '99' }],
          hashtags: [{ ...range('#Markets'), tag: 'Markets' }],
          cashtags: [{ ...range('$BTC'), tag: 'BTC' }],
        },
      }],
    }, author, NOW);

    expect(items[0]?.text).toBe(text);
    expect(items[0]?.links).toEqual([
      {
        kind: 'mention',
        ...range('@alice'),
        label: '@alice',
        href: 'https://x.com/alice',
      },
      {
        kind: 'hashtag',
        ...range('#Markets'),
        label: '#Markets',
        href: 'https://x.com/search?q=%23Markets&src=hashtag_click',
      },
      {
        kind: 'cashtag',
        ...range('$BTC'),
        label: '$BTC',
        href: 'https://x.com/search?q=%24BTC&src=cashtag_click',
      },
      {
        kind: 'url',
        ...range('https://t.co/abc'),
        label: 'example.com/a-very-long-story',
        href: 'https://t.co/abc',
      },
    ]);
  });

  it('uses long-form note text and its own entity ranges without mixing truncated root entities', () => {
    const author = { id: '123', name: 'Walter Bloomberg', username: 'DeItaone' };
    const fullText = '  Long form headline keeps spacing and ends with #Macro https://t.co/long  ';
    const range = (token: string) => {
      const start = fullText.indexOf(token);
      return { start, end: start + token.length };
    };
    const items = normalizeXTimelineResponse({
      data: [{
        id: 'long-1',
        author_id: '123',
        created_at: new Date(NOW - 1_000).toISOString(),
        text: 'Truncated https://t.co/short',
        entities: {
          urls: [{ start: 10, end: 28, url: 'https://t.co/short', display_url: 'wrong.example' }],
        },
        note_tweet: {
          text: fullText,
          entities: {
            hashtags: [{ ...range('#Macro'), tag: 'Macro' }],
            urls: [{
              ...range('https://t.co/long'),
              url: 'https://t.co/long',
              display_url: 'example.com/full-story',
            }],
          },
        },
      }],
    }, author, NOW);

    expect(items[0]?.text).toBe(fullText);
    expect(items[0]?.links.map((link) => link.label)).toEqual([
      '#Macro',
      'example.com/full-story',
    ]);
    expect(items[0]?.links.some((link) => link.href.includes('short'))).toBe(false);
  });

  it('drops malformed or unsafe entity destinations without changing the post text', () => {
    const author = { id: '123', name: 'Walter Bloomberg', username: 'DeItaone' };
    const text = 'Unsafe https://evil.example/path and @bad-name';
    const items = normalizeXTimelineResponse({
      data: [{
        id: 'unsafe-1',
        created_at: new Date(NOW - 1_000).toISOString(),
        text,
        entities: {
          urls: [{ start: 7, end: 32, url: 'javascript:alert(1)', display_url: 'evil.example' }],
          mentions: [{ start: 37, end: 46, username: 'bad-name' }],
          hashtags: [{ start: -1, end: 2, tag: 'bad' }],
        },
      }],
    }, author, NOW);

    expect(items[0]?.text).toBe(text);
    expect(items[0]?.links).toEqual([]);
  });

  it('returns a cacheable unconfigured payload without making the secret browser-visible', async () => {
    const result = await handleNewsRequest(new Request('https://tickerworld.test/api/news'), '', NOW);
    expect(result.status).toBe(200);
    expect(result.headers.get('Vercel-CDN-Cache-Control')).toBe(
      'public, max-age=2, stale-while-revalidate=2',
    );
    expect(result.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(await result.json()).toEqual({ mode: 'unconfigured', items: [], checkedAt: NOW });

    const method = await handleNewsRequest(
      new Request('https://tickerworld.test/api/news', { method: 'POST' }),
      '',
      NOW,
    );
    expect(method.status).toBe(405);
    expect(method.headers.get('Allow')).toBe('GET');
  });

  it('reads only the centralized cache and permits one bounded market scope variant', async () => {
    const cacheFetch = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      mode: 'live',
      items: [],
      checkedAt: NOW - 250,
      maxAccounts: 8,
      accounts: [{
        id: 'x-user-1',
        handle: 'DeItaone',
        name: 'Delta One',
        avatarUrl: 'https://pbs.twimg.com/profile_images/delta.jpg',
        isDefault: true,
        status: 'live',
        lastPostAt: NOW - 500,
      }],
    }));
    const result = await handleNewsRequest(
      new Request('https://tickerworld.test/api/news?scope=BTC'),
      '',
      NOW,
      'https://multiplayer.tickerworld.test',
      cacheFetch,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      mode: 'live',
      items: [],
      checkedAt: NOW - 250,
      maxAccounts: 8,
      accounts: [expect.objectContaining({ handle: 'DeItaone', isDefault: true })],
    });
    expect(cacheFetch).toHaveBeenCalledTimes(1);
    expect(String(cacheFetch.mock.calls[0]?.[0])).toBe(
      'https://multiplayer.tickerworld.test/api/news?scope=BTC',
    );
  });

  it('rejects cache-busting request variants before they can spend X API reads', async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    try {
      const query = await handleNewsRequest(
        new Request('https://tickerworld.test/api/news?cache-bust=1'),
        'paid-secret-token',
        NOW,
      );
      const authorized = await handleNewsRequest(
        new Request('https://tickerworld.test/api/news', {
          headers: { Authorization: 'Bearer cache-bypass' },
        }),
        'paid-secret-token',
        NOW,
      );
      const ranged = await handleNewsRequest(
        new Request('https://tickerworld.test/api/news', { headers: { Range: 'bytes=0-1' } }),
        'paid-secret-token',
        NOW,
      );

      expect([query.status, authorized.status, ranged.status]).toEqual([400, 400, 400]);
      expect(query.headers.get('Cache-Control')).toBe('private, no-store');
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
