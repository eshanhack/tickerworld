import { ASSET_SYMBOLS } from '@tickerworld/shared';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrateDatabase } from '../src/db/database.js';
import {
  DatabaseNewsIngestLease,
  DatabaseNewsRequestBudget,
  NewsIngestService,
  parseXStreamEvent,
  planXRuleReconciliation,
  xReconnectDelayMs,
} from '../src/services/newsIngest.js';
import { RuntimeSwitchboard } from '../src/services/runtimeSwitches.js';
import { createStatefulXRulesApi } from './helpers/xRules.js';

const NOW = Date.parse('2026-07-14T01:00:00.000Z');
const switches = {
  admissions: true,
  chatSend: true,
  newsIngest: true,
  directMarketFallback: true,
  publicWalletAuth: false,
  purchases: false,
  adminActions: false,
};

function switchboard() {
  return new RuntimeSwitchboard(switches, 400);
}

describe('X filtered-stream news ingestion', () => {
  const databases: Array<ReturnType<typeof createDatabase>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it('reconciles namespaced rules without touching foreign rules or retaining duplicates', () => {
    const plan = planXRuleReconciliation([
      { id: 'foreign', tag: 'another-product', value: 'from:somebody' },
      { id: 'keep', tag: 'tickerworld:account:123', value: 'from:DeItaone -is:retweet -is:reply' },
      { id: 'duplicate', tag: 'tickerworld:account:123', value: 'from:DeItaone -is:retweet -is:reply' },
      { id: 'renamed', tag: 'tickerworld:account:456', value: 'from:OldHandle -is:retweet -is:reply' },
      { id: 'stale', tag: 'tickerworld:account:999', value: 'from:Gone -is:retweet -is:reply' },
    ], [
      { id: '123', username: 'DeItaone' },
      { id: '456', username: 'NewHandle' },
      { id: '789', username: 'Watcher' },
    ]);

    expect(plan.deleteIds).toEqual(['duplicate', 'renamed', 'stale']);
    expect(plan.add).toEqual([
      { tag: 'tickerworld:account:456', value: 'from:NewHandle -is:retweet -is:reply' },
      { tag: 'tickerworld:account:789', value: 'from:Watcher -is:retweet -is:reply' },
    ]);
    expect(plan.deleteIds).not.toContain('foreign');
  });

  it('parses long stream posts and author expansions while rejecting malformed events', () => {
    const createdAt = new Date(NOW - 1_000).toISOString();
    expect(parseXStreamEvent({
      data: {
        id: '2000000000000000001',
        author_id: '1000000000000000001',
        text: 'truncated',
        created_at: createdAt,
        note_tweet: { text: '$BTC full note', entities: { cashtags: [] } },
      },
      includes: { users: [{
        id: '1000000000000000001', name: 'Delta One', username: 'DeItaone',
        profile_image_url: 'https://pbs.twimg.com/avatar.jpg', protected: false,
      }] },
    })).toEqual({
      id: '2000000000000000001',
      authorId: '1000000000000000001',
      text: '$BTC full note',
      entities: { cashtags: [] },
      createdAt: Date.parse(createdAt),
      author: {
        id: '1000000000000000001', name: 'Delta One', username: 'DeItaone',
        profileImageUrl: 'https://pbs.twimg.com/avatar.jpg',
      },
    });
    expect(parseXStreamEvent({ data: { id: 'bad' } })).toBeNull();
  });

  it('uses bounded network, HTTP, and rate-limit reconnect schedules', () => {
    expect(xReconnectDelayMs(1, 0, NOW)).toBe(250);
    expect(xReconnectDelayMs(100, 0, NOW)).toBe(16_000);
    expect(xReconnectDelayMs(1, 503, NOW)).toBe(5_000);
    expect(xReconnectDelayMs(10, 503, NOW)).toBe(320_000);
    expect(xReconnectDelayMs(1, 429, NOW, NOW + 90_000)).toBe(90_000);
  });

  it('associates configured defaults with every world and advances since_id gap cursors', async () => {
    vi.useFakeTimers();
    const rulesApi = createStatefulXRulesApi([{
      id: 'existing-default-rule',
      tag: 'tickerworld:account:1000000000000000001',
      value: 'from:DeItaone -is:retweet -is:reply',
    }]);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1000000000000000001', name: 'Delta One', username: 'DeItaone',
          profile_image_url: 'https://pbs.twimg.com/avatar.jpg', protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) {
        return Response.json({ data: url.searchParams.has('since_id') ? [] : [{
          id: '2000000000000000001', author_id: '1000000000000000001',
          text: 'Headline', created_at: new Date(NOW - 1_000).toISOString(),
        }] });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['DeItaone'], 20, switchboard(), fetcher as typeof fetch, () => NOW,
    );
    await service.initialize(NOW);
    await service.refresh(NOW);

    for (const scope of ASSET_SYMBOLS) {
      expect(service.snapshot(scope, NOW).accounts).toEqual([
        expect.objectContaining({ id: '1000000000000000001', handle: 'DeItaone', isDefault: true }),
      ]);
      expect(service.snapshot(scope, NOW).items).toHaveLength(1);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await service.refresh(NOW + 60_000);
    const timelineUrls = fetcher.mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith('/tweets'));
    expect(timelineUrls).toHaveLength(3);
    expect(timelineUrls[0]?.searchParams.has('start_time')).toBe(true);
    expect(timelineUrls[1]?.searchParams.has('start_time')).toBe(true);
    expect(timelineUrls[2]?.searchParams.get('since_id')).toBe('2000000000000000001');
    await service.dispose();
  });

  it('persists custom acquisition and isolates it to the requested world', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1000000000000000002', name: 'Macro News', username: 'MacroNews',
          profile_image_url: 'https://pbs.twimg.com/macro.jpg', protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) return Response.json({
        data: url.searchParams.has('since_id') ? [] : [{
          id: '2000000000000000002', author_id: '1000000000000000002', text: 'Recent macro post',
          created_at: new Date(NOW - 1_000).toISOString(),
        }],
      });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 20, switchboard(), fetcher as typeof fetch, () => NOW, 60_000,
      undefined, db,
    );
    await service.initialize(NOW);
    const account = await service.addAccount('BTC', '@MacroNews', NOW);
    expect(account).toMatchObject({
      id: '1000000000000000002', handle: 'MacroNews', isDefault: false, status: 'live',
    });
    expect(service.snapshot('ETH', NOW).accounts).toEqual([]);
    expect(service.snapshot('BTC', NOW).items).toEqual([
      expect.objectContaining({ id: '2000000000000000002', scope: 'BTC' }),
    ]);
    expect(await db.selectFrom('x_news_worlds').selectAll().execute()).toEqual([
      expect.objectContaining({
        source_id: '1000000000000000002', scope: 'BTC', is_default: 0,
        last_requested_at: NOW,
      }),
    ]);
    const ruleWrite = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(ruleWrite?.[1]?.body))).toEqual({ add: [{
      tag: 'tickerworld:account:1000000000000000002',
      value: 'from:MacroNews -is:retweet -is:reply',
    }] });
    await service.addAccount('ETH', 'MacroNews', NOW + 1_000);
    expect(service.snapshot('ETH', NOW + 1_000).items).toEqual([
      expect.objectContaining({ id: '2000000000000000002', scope: 'ETH' }),
    ]);
    await service.dispose();
  });

  it('isolates a missing timeline source so other accounts keep updating', async () => {
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/First')) {
        return Response.json({ data: {
          id: '1000000000000000021', name: 'First', username: 'First', protected: false,
        } });
      }
      if (url.pathname.includes('/users/by/username/Second')) {
        return Response.json({ data: {
          id: '1000000000000000022', name: 'Second', username: 'Second', protected: false,
        } });
      }
      if (url.pathname.includes('/users/1000000000000000021/tweets')) {
        return new Response('gone', { status: 404 });
      }
      if (url.pathname.includes('/users/1000000000000000022/tweets')) {
        return Response.json({ data: [{
          id: '2000000000000000022', author_id: '1000000000000000022', text: 'Still live',
          created_at: new Date(NOW - 1_000).toISOString(),
        }] });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['First', 'Second'], 20, switchboard(), fetcher as typeof fetch, () => NOW,
    );
    await service.initialize(NOW);
    await service.refresh(NOW);
    expect(service.snapshot('BTC', NOW).accounts).toEqual([
      expect.objectContaining({ handle: 'First', status: 'unavailable' }),
      expect.objectContaining({ handle: 'Second', status: 'live' }),
    ]);
    expect(service.snapshot('BTC', NOW).items).toEqual([
      expect.objectContaining({ id: '2000000000000000022', authorHandle: 'Second' }),
    ]);
    await service.dispose();
  });

  it('stops immediately on a provider-wide timeline outage instead of fanning out', async () => {
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/First')) {
        return Response.json({ data: {
          id: '1000000000000000031', name: 'First', username: 'First', protected: false,
        } });
      }
      if (url.pathname.includes('/users/by/username/Second')) {
        return Response.json({ data: {
          id: '1000000000000000032', name: 'Second', username: 'Second', protected: false,
        } });
      }
      if (url.pathname.includes('/users/1000000000000000031/tweets')) {
        return new Response('provider unavailable', { status: 503 });
      }
      if (url.pathname.includes('/users/1000000000000000032/tweets')) {
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['First', 'Second'], 20, switchboard(), fetcher as typeof fetch, () => NOW,
    );
    await service.initialize(NOW);
    await expect(service.refresh(NOW)).rejects.toThrow('x_503');
    expect(fetcher.mock.calls.some(([input]) => (
      new URL(String(input)).pathname.includes('/users/1000000000000000032/tweets')
    ))).toBe(false);
    await service.dispose();
  });

  it('rehydrates the visible ten-minute window after restart even with a durable cursor', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    await db.insertInto('x_news_sources').values({
      id: '1000000000000000041', handle: 'RestartNews', handle_normalized: 'restartnews',
      name: 'Restart News', avatar_url: null, status: 'active',
      since_id: '2000000000000000040', last_profile_at: NOW - 1_000,
      last_poll_at: NOW - 1_000, last_success_at: NOW - 1_000, last_post_at: NOW - 1_000,
      created_at: NOW - 60_000, updated_at: NOW - 1_000,
    }).execute();
    await db.insertInto('x_news_worlds').values({
      source_id: '1000000000000000041', scope: 'BTC', is_default: 0,
      last_requested_at: NOW, created_at: NOW - 60_000,
    }).execute();
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [{
        id: '2000000000000000040', author_id: '1000000000000000041', text: 'Still visible',
        created_at: new Date(NOW - 1_000).toISOString(),
      }] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 20, switchboard(), fetcher as typeof fetch, () => NOW, 60_000, undefined, db,
    );
    await service.initialize(NOW);
    await service.refresh(NOW);
    const timelineUrl = fetcher.mock.calls.map(([input]) => new URL(String(input)))
      .find((url) => url.pathname.endsWith('/tweets'))!;
    expect(timelineUrl.searchParams.has('start_time')).toBe(true);
    expect(timelineUrl.searchParams.has('since_id')).toBe(false);
    expect(service.snapshot('BTC', NOW).items).toEqual([
      expect.objectContaining({ id: '2000000000000000040', text: 'Still visible' }),
    ]);
    await service.dispose();
  });

  it('shares the durable ten-minute post cache and provider health with standby instances', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1000000000000000042', name: 'Shared News', username: 'SharedNews',
          profile_image_url: 'https://pbs.twimg.com/shared.jpg', protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [{
        id: '2000000000000000042', author_id: '1000000000000000042', text: 'Shared headline',
        created_at: new Date(NOW - 1_000).toISOString(),
      }] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const leader = new NewsIngestService(
      'token', ['SharedNews'], 20, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db, new DatabaseNewsIngestLease(db),
    );
    await leader.initialize(NOW);
    await leader.refresh(NOW);
    expect(await db.selectFrom('provider_health')
      .select(['provider', 'connected', 'last_success_at', 'checked_at'])
      .where('provider', '=', 'x-news')
      .executeTakeFirstOrThrow()).toEqual({
      provider: 'x-news', connected: 0, last_success_at: NOW, checked_at: NOW,
    });
    expect(leader.snapshot('BTC', NOW)).toMatchObject({
      mode: 'live',
      checkedAt: NOW,
      items: [expect.objectContaining({
        id: '2000000000000000042', scope: 'BTC', text: 'Shared headline',
      })],
    });
    await leader.refresh(NOW - 5_000);
    expect(await db.selectFrom('provider_health')
      .select(['last_success_at', 'checked_at'])
      .where('provider', '=', 'x-news')
      .executeTakeFirstOrThrow()).toEqual({ last_success_at: NOW, checked_at: NOW });

    const noProviderCalls = vi.fn(async () => {
      throw new Error('A standby cache refresh must not call X');
    });
    const standby = new NewsIngestService(
      'token', [], 20, switchboard(), noProviderCalls as typeof fetch, () => NOW + 1_000,
      60_000, undefined, db,
    );
    await standby.initialize(NOW + 1_000);
    await standby.refreshSharedCache(NOW + 1_000);
    expect(noProviderCalls).not.toHaveBeenCalled();
    expect(standby.snapshot('BTC', NOW + 1_000)).toMatchObject({
      mode: 'live',
      checkedAt: NOW,
      items: [expect.objectContaining({
        id: '2000000000000000042', scope: 'BTC', text: 'Shared headline',
      })],
    });
    expect(await db.selectFrom('provider_health')
      .select(['last_success_at', 'checked_at'])
      .where('provider', '=', 'x-news')
      .executeTakeFirstOrThrow()).toEqual({ last_success_at: NOW, checked_at: NOW });

    const expiredAt = NOW + 10 * 60_000;
    await standby.refreshSharedCache(expiredAt);
    expect(standby.snapshot('BTC', expiredAt).items).toEqual([]);
    expect(await db.selectFrom('x_news_posts').selectAll().execute()).toEqual([]);

    const freshStandby = new NewsIngestService(
      'token', [], 20, switchboard(), noProviderCalls as typeof fetch, () => expiredAt,
      60_000, undefined, db,
    );
    await freshStandby.initialize(expiredAt);
    await freshStandby.refreshSharedCache(expiredAt);
    expect(freshStandby.snapshot('BTC', expiredAt).items).toEqual([]);
    expect(noProviderCalls).not.toHaveBeenCalled();

    await Promise.all([leader.dispose(), standby.dispose(), freshStandby.dispose()]);
  });

  it('prunes inactive custom worlds but never default associations', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    await db.insertInto('x_news_sources').values({
      id: '1000000000000000003', handle: 'Source', handle_normalized: 'source', name: 'Source',
      avatar_url: null, status: 'active', since_id: null, last_profile_at: NOW,
      last_poll_at: null, last_success_at: null, last_post_at: null,
      created_at: NOW - 100_000_000, updated_at: NOW,
    }).execute();
    await db.insertInto('x_news_worlds').values([
      { source_id: '1000000000000000003', scope: 'BTC', is_default: 1,
        last_requested_at: NOW - 100_000_000, created_at: NOW - 100_000_000 },
      { source_id: '1000000000000000003', scope: 'ETH', is_default: 0,
        last_requested_at: NOW - 100_000_000, created_at: NOW - 100_000_000 },
    ]).execute();
    const fetcher = vi.fn();
    const service = new NewsIngestService(
      'token', ['Source'], 20, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db, new DatabaseNewsIngestLease(db),
    );
    await service.initialize(NOW);
    expect(await service.pruneInactiveWorlds(NOW)).toBe(1);
    expect(service.snapshot('BTC', NOW)).toMatchObject({
      mode: 'unavailable',
      accounts: [expect.objectContaining({ handle: 'Source', isDefault: true })],
      maxAccounts: 8,
    });
    expect(service.snapshot('ETH', NOW).accounts).toEqual([]);
    expect(await db.selectFrom('x_news_worlds').select('scope').execute()).toEqual([{ scope: 'BTC' }]);
    expect(fetcher).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('enforces the 16-per-world and 64-source shared acquisition caps after canonical identity resolution', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const scopes = ['BTC', 'ETH', 'SOL', 'XRP'] as const;
    for (let index = 0; index < 64; index += 1) {
      const id = (1_000_000_000_000_000_000n + BigInt(index)).toString();
      await db.insertInto('x_news_sources').values({
        id, handle: `Source${index}`, handle_normalized: `source${index}`, name: `Source ${index}`,
        avatar_url: null, status: 'active', since_id: null, last_profile_at: NOW,
        last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW, updated_at: NOW,
      }).execute();
      await db.insertInto('x_news_worlds').values({
        source_id: id, scope: scopes[Math.floor(index / 16)]!, is_default: 0,
        last_requested_at: NOW, created_at: NOW,
      }).execute();
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1999999999999999999', name: 'Another Source', username: 'Another', protected: false,
        } });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 20, switchboard(), fetcher as typeof fetch, () => NOW, 60_000, undefined, db,
    );
    await service.initialize(NOW);
    await expect(service.addAccount('BTC', 'Another', NOW)).rejects.toMatchObject({
      status: 409, code: 'news_world_catalog_full',
    });
    await expect(service.addAccount('DOGE', 'Another', NOW)).rejects.toMatchObject({
      status: 409, code: 'news_catalog_full',
    });
    // Mutable handles must be resolved even at cap: the requested handle may
    // be a renamed source whose immutable id already occupies a catalog slot.
    expect(fetcher).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('evicts the deterministic inactive LRU while preserving defaults and active associations', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const hour = 60 * 60_000;
    for (let index = 0; index < 16; index += 1) {
      const id = (1_000_000_000_000_000_100n + BigInt(index)).toString();
      await db.insertInto('x_news_sources').values({
        id,
        handle: `Evict${index}`,
        handle_normalized: `evict${index}`,
        name: `Eviction candidate ${index}`,
        avatar_url: null,
        status: 'active',
        since_id: null,
        last_profile_at: NOW,
        last_poll_at: null,
        last_success_at: null,
        last_post_at: null,
        created_at: NOW - 23 * hour,
        updated_at: NOW,
      }).execute();
      const isDefault = index === 0;
      const lastRequestedAt = isDefault
        ? NOW - 23 * hour
        : index === 2 || index === 3
          ? NOW - 14 * hour
          : index === 1
            ? NOW - (13 * hour - 1)
            : NOW - hour;
      await db.insertInto('x_news_worlds').values({
        source_id: id,
        scope: 'BTC',
        is_default: isDefault ? 1 : 0,
        last_requested_at: lastRequestedAt,
        created_at: NOW - 23 * hour,
      }).execute();
    }
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1000000000000000999', name: 'Fresh Source', username: 'FreshSource', protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['Evict0'], 100, switchboard(), fetcher as typeof fetch, () => NOW, 60_000,
      undefined, db,
    );
    await service.initialize(NOW);
    await service.addAccount('BTC', 'FreshSource', NOW);

    const worlds = await db.selectFrom('x_news_worlds')
      .select(['source_id', 'is_default', 'last_requested_at'])
      .where('scope', '=', 'BTC')
      .orderBy('source_id')
      .execute();
    expect(worlds).toHaveLength(16);
    expect(worlds.some((row) => row.source_id === '1000000000000000100' && row.is_default === 1)).toBe(true);
    expect(worlds.some((row) => row.source_id === '1000000000000000101')).toBe(true);
    expect(worlds.some((row) => row.source_id === '1000000000000000102')).toBe(false);
    expect(worlds.some((row) => row.source_id === '1000000000000000103')).toBe(true);
    expect(worlds.some((row) => row.source_id === '1000000000000000999')).toBe(true);
    expect(await db.selectFrom('x_news_sources')
      .select('id')
      .where('id', '=', '1000000000000000102')
      .executeTakeFirst()).toBeUndefined();
    await service.dispose();
  });

  it('reconciles a renamed account and a reclaimed handle by immutable X user id', async () => {
    let clock = NOW;
    let reclaimed = false;
    let firstTimeline = true;
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const rulesApi = createStatefulXRulesApi();
    const originalId = '1000000000000000801';
    const reclaimedId = '1000000000000000802';
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.endsWith('/users/by/username/FooDesk')) {
        return Response.json({ data: reclaimed ? {
          id: reclaimedId, name: 'New Foo', username: 'FooDesk', protected: false,
        } : {
          id: originalId, name: 'Original Foo', username: 'FooDesk', protected: false,
        } });
      }
      if (url.pathname === `/2/users/${originalId}`) {
        return Response.json({ data: {
          id: originalId, name: 'Original Foo', username: 'BarDesk', protected: false,
        } });
      }
      if (url.pathname.endsWith(`/${originalId}/tweets`)) {
        if (!firstTimeline) return Response.json({ data: [] });
        firstTimeline = false;
        return Response.json({ data: [{
          id: '2000000000000000801', author_id: originalId, text: 'Immutable identity headline',
          created_at: new Date(clock - 1_000).toISOString(),
        }] });
      }
      if (url.pathname.endsWith(`/${reclaimedId}/tweets`)) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => clock,
      60_000, undefined, db,
    );
    await service.initialize(clock);
    await service.addAccount('BTC', 'FooDesk', clock);
    expect(service.snapshot('BTC', clock).items).toEqual([expect.objectContaining({
      id: '2000000000000000801', authorId: originalId, authorHandle: 'FooDesk',
    })]);

    reclaimed = true;
    clock += 6 * 60_000;
    const added = await service.addAccount('SOL', 'FooDesk', clock);
    expect(added).toMatchObject({ id: reclaimedId, handle: 'FooDesk' });
    expect(service.accounts('BTC', clock)).toEqual([
      expect.objectContaining({ id: originalId, handle: 'BarDesk' }),
    ]);
    expect(service.accounts('SOL', clock)).toEqual([
      expect.objectContaining({ id: reclaimedId, handle: 'FooDesk' }),
    ]);
    expect(await db.selectFrom('x_news_sources')
      .select(['id', 'handle', 'handle_normalized'])
      .where('id', 'in', [originalId, reclaimedId])
      .orderBy('id')
      .execute()).toEqual([
      { id: originalId, handle: 'BarDesk', handle_normalized: 'bardesk' },
      { id: reclaimedId, handle: 'FooDesk', handle_normalized: 'foodesk' },
    ]);
    expect(rulesApi.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'from:BarDesk -is:retweet -is:reply' }),
      expect.objectContaining({ value: 'from:FooDesk -is:retweet -is:reply' }),
    ]));
    await service.dispose();
  });

  it('allows a renamed existing immutable id to update at the 64-source catalog cap', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const scopes = ['BTC', 'ETH', 'SOL', 'XRP'] as const;
    const renamedId = '1000000000000000900';
    for (let index = 0; index < 64; index += 1) {
      const id = index === 0
        ? renamedId
        : (1_000_000_000_000_001_000n + BigInt(index)).toString();
      const handle = index === 0 ? 'OldDesk' : `CapSource${index}`;
      await db.insertInto('x_news_sources').values({
        id, handle, handle_normalized: handle.toLowerCase(), name: handle,
        avatar_url: null, status: 'active', since_id: null, last_profile_at: NOW - 10 * 60_000,
        last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW, updated_at: NOW,
      }).execute();
      await db.insertInto('x_news_worlds').values({
        source_id: id, scope: scopes[Math.floor(index / 16)]!, is_default: 0,
        last_requested_at: NOW, created_at: NOW,
      }).execute();
    }
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.endsWith('/users/by/username/NewDesk')) {
        return Response.json({ data: {
          id: renamedId, name: 'Renamed Desk', username: 'NewDesk', protected: false,
        } });
      }
      if (url.pathname.endsWith(`/${renamedId}/tweets`)) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 200, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    await expect(service.addAccount('DOGE', 'NewDesk', NOW)).resolves.toMatchObject({
      id: renamedId, handle: 'NewDesk',
    });
    expect(await db.selectFrom('x_news_sources').selectAll().execute()).toHaveLength(64);
    expect(await db.selectFrom('x_news_worlds')
      .select(['source_id', 'scope'])
      .where('source_id', '=', renamedId)
      .orderBy('scope')
      .execute()).toEqual([
      { source_id: renamedId, scope: 'BTC' },
      { source_id: renamedId, scope: 'DOGE' },
    ]);
    await service.dispose();
  });

  it('rolls back a full-world slot eviction when replacement association persistence fails', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const replacementId = '1000000000000000998';
    const candidateId = '1000000000000000950';
    for (let index = 0; index < 16; index += 1) {
      const id = index === 0
        ? candidateId
        : (1_000_000_000_000_000_950n + BigInt(index)).toString();
      await db.insertInto('x_news_sources').values({
        id, handle: `Atomic${index}`, handle_normalized: `atomic${index}`,
        name: `Atomic ${index}`, avatar_url: null, status: 'active', since_id: null,
        last_profile_at: NOW, last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW, updated_at: NOW,
      }).execute();
      await db.insertInto('x_news_worlds').values({
        source_id: id, scope: 'BTC', is_default: 0,
        last_requested_at: index === 0 ? NOW - 14 * 60 * 60_000 : NOW,
        created_at: NOW,
      }).execute();
    }
    await sql.raw(`
      create trigger fail_news_replacement
      before insert on x_news_worlds
      when NEW.source_id = '${replacementId}'
      begin
        select raise(abort, 'forced replacement failure');
      end
    `).execute(db);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: replacementId, name: 'Replacement', username: 'Replacement', protected: false,
        } });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    await expect(service.addAccount('BTC', 'Replacement', NOW))
      .rejects.toThrow('forced replacement failure');
    const worlds = await db.selectFrom('x_news_worlds')
      .select('source_id')
      .where('scope', '=', 'BTC')
      .execute();
    expect(worlds).toHaveLength(16);
    expect(worlds).toContainEqual({ source_id: candidateId });
    expect(worlds).not.toContainEqual({ source_id: replacementId });
    expect(await db.selectFrom('x_news_sources')
      .select('id')
      .where('id', '=', replacementId)
      .executeTakeFirst()).toBeUndefined();
    await service.dispose();
  });

  it('adds a configured default to non-full worlds even when one world has no replaceable slot', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const defaultId = '1000000000000000970';
    await db.insertInto('x_news_sources').values({
      id: defaultId, handle: 'DefaultDesk', handle_normalized: 'defaultdesk', name: 'Default Desk',
      avatar_url: null, status: 'active', since_id: null, last_profile_at: NOW,
      last_poll_at: null, last_success_at: null, last_post_at: null,
      created_at: NOW, updated_at: NOW,
    }).execute();
    await db.insertInto('x_news_worlds').values({
      source_id: defaultId, scope: 'BTC', is_default: 1,
      last_requested_at: NOW, created_at: NOW,
    }).execute();
    for (let index = 0; index < 16; index += 1) {
      const id = (1_000_000_000_000_009_800n + BigInt(index)).toString();
      await db.insertInto('x_news_sources').values({
        id, handle: `BusyEth${index}`, handle_normalized: `busyeth${index}`,
        name: `Busy ETH ${index}`, avatar_url: null, status: 'active', since_id: null,
        last_profile_at: NOW, last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW, updated_at: NOW,
      }).execute();
      await db.insertInto('x_news_worlds').values({
        source_id: id, scope: 'ETH', is_default: 0,
        last_requested_at: NOW, created_at: NOW,
      }).execute();
    }
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['DefaultDesk'], 200, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    await service.refresh(NOW);

    const defaultWorlds = await db.selectFrom('x_news_worlds')
      .select(['scope', 'is_default'])
      .where('source_id', '=', defaultId)
      .orderBy('scope')
      .execute();
    expect(defaultWorlds).toHaveLength(ASSET_SYMBOLS.length - 1);
    expect(defaultWorlds).not.toContainEqual({ scope: 'ETH', is_default: 1 });
    expect(defaultWorlds).toContainEqual({ scope: 'SOL', is_default: 1 });
    expect(defaultWorlds.every((row) => row.is_default === 1)).toBe(true);
    await service.dispose();
  });

  it('keeps sources active when a provider-wide timeline 403 prevents backfill', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const sourceId = '1000000000000000971';
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: sourceId, name: 'Forbidden Desk', username: 'ForbiddenDesk', protected: false,
        } });
      }
      if (url.pathname.endsWith(`/${sourceId}/tweets`)) {
        return new Response('plan does not allow this endpoint', { status: 403 });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    await expect(service.addAccount('BTC', 'ForbiddenDesk', NOW)).rejects.toMatchObject({
      status: 503, code: 'news_provider_unavailable',
    });
    expect(await db.selectFrom('x_news_sources')
      .select(['status', 'rule_ready_at'])
      .where('id', '=', sourceId)
      .executeTakeFirstOrThrow()).toEqual({ status: 'active', rule_ready_at: NOW });
    expect(await db.selectFrom('x_news_worlds')
      .select(['source_id', 'scope'])
      .execute()).toEqual([{ source_id: sourceId, scope: 'BTC' }]);
    expect(rulesApi.snapshot()).toEqual([expect.objectContaining({
      tag: `tickerworld:account:${sourceId}`,
    })]);
    await service.dispose();
  });

  it('refreshes quiet custom accounts by immutable id so a rename cannot remain wedged', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const sourceId = '1000000000000000972';
    await db.insertInto('x_news_sources').values({
      id: sourceId, handle: 'QuietOld', handle_normalized: 'quietold', name: 'Quiet Desk',
      avatar_url: null, status: 'active', since_id: null,
      last_profile_at: NOW - 25 * 60 * 60_000,
      last_poll_at: null, last_success_at: null, last_post_at: null,
      created_at: NOW - 25 * 60 * 60_000, updated_at: NOW - 25 * 60 * 60_000,
    }).execute();
    await db.insertInto('x_news_worlds').values({
      source_id: sourceId, scope: 'BTC', is_default: 0,
      last_requested_at: NOW, created_at: NOW,
    }).execute();
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname === `/2/users/${sourceId}`) {
        return Response.json({ data: {
          id: sourceId, name: 'Quiet Desk', username: 'QuietNew', protected: false,
        } });
      }
      if (url.pathname.endsWith(`/${sourceId}/tweets`)) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    await service.refresh(NOW);

    expect(service.accounts('BTC', NOW)).toEqual([
      expect.objectContaining({ id: sourceId, handle: 'QuietNew' }),
    ]);
    expect(await db.selectFrom('x_news_sources')
      .select(['handle', 'handle_normalized', 'last_profile_at'])
      .where('id', '=', sourceId)
      .executeTakeFirstOrThrow()).toEqual({
      handle: 'QuietNew', handle_normalized: 'quietnew', last_profile_at: NOW,
    });
    expect(rulesApi.snapshot()).toEqual([expect.objectContaining({
      value: 'from:QuietNew -is:retweet -is:reply',
    })]);
    await service.dispose();
  });

  it('reacquires a pruned saved selection by immutable id after rename and old-handle reclaim', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const originalId = '1000000000000000973';
    let mutableHandleLookups = 0;
    await db.insertInto('x_news_sources').values({
      id: originalId, handle: 'VacantOld', handle_normalized: 'vacantold', name: 'Original Desk',
      avatar_url: null, status: 'active', since_id: null,
      last_profile_at: NOW - 25 * 60 * 60_000,
      last_poll_at: null, last_success_at: null, last_post_at: null,
      created_at: NOW - 25 * 60 * 60_000, updated_at: NOW - 25 * 60 * 60_000,
    }).execute();
    await db.insertInto('x_news_worlds').values({
      source_id: originalId, scope: 'BTC', is_default: 0,
      last_requested_at: NOW - 25 * 60 * 60_000, created_at: NOW - 25 * 60 * 60_000,
    }).execute();
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname === `/2/users/${originalId}`) {
        return Response.json({ data: {
          id: originalId, name: 'Original Desk', username: 'CanonicalNew', protected: false,
        } });
      }
      if (url.pathname.includes('/users/by/username/')) {
        mutableHandleLookups += 1;
        // The old handle now belongs to someone else; immutable reacquisition
        // must never consult it.
        return Response.json({ data: {
          id: '1000000000000000974', name: 'Reclaimer', username: 'VacantOld', protected: false,
        } });
      }
      if (url.pathname.endsWith(`/${originalId}/tweets`)) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    expect(await service.pruneInactiveWorlds(NOW)).toBe(1);
    expect(await db.selectFrom('x_news_sources').selectAll().execute()).toEqual([]);

    await expect(service.addAccountById('BTC', originalId, NOW)).resolves.toMatchObject({
      id: originalId, handle: 'CanonicalNew',
    });
    expect(mutableHandleLookups).toBe(0);
    expect(await db.selectFrom('x_news_worlds').select(['source_id', 'scope']).execute()).toEqual([
      { source_id: originalId, scope: 'BTC' },
    ]);
    expect(rulesApi.snapshot()).toEqual([expect.objectContaining({
      value: 'from:CanonicalNew -is:retweet -is:reply',
    })]);
    await service.dispose();
  });

  it('advances bounded profile maintenance past a protected source on the next pass', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const protectedId = '1000000000000000975';
    const laterId = '1000000000000000976';
    for (const [id, handle] of [[protectedId, 'OldProtected'], [laterId, 'LaterOld']] as const) {
      await db.insertInto('x_news_sources').values({
        id, handle, handle_normalized: handle.toLowerCase(), name: handle,
        avatar_url: null, status: 'active', since_id: null,
        last_profile_at: NOW - 26 * 60 * 60_000,
        last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW - 26 * 60 * 60_000, updated_at: NOW - 26 * 60 * 60_000,
      }).execute();
      await db.insertInto('x_news_worlds').values({
        source_id: id, scope: 'BTC', is_default: 0,
        last_requested_at: NOW, created_at: NOW,
      }).execute();
    }
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname === `/2/users/${protectedId}`) {
        return Response.json({ data: {
          id: protectedId, name: 'Protected Desk', username: 'NowProtected', protected: true,
        } });
      }
      if (url.pathname === `/2/users/${laterId}`) {
        return Response.json({ data: {
          id: laterId, name: 'Later Desk', username: 'LaterNew', protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    await service.refresh(NOW);
    await service.refresh(NOW + 1);

    expect(await db.selectFrom('x_news_sources')
      .select(['id', 'handle', 'status'])
      .where('id', 'in', [protectedId, laterId])
      .orderBy('id')
      .execute()).toEqual([
      { id: protectedId, handle: 'NowProtected', status: 'unavailable' },
      { id: laterId, handle: 'LaterNew', status: 'active' },
    ]);
    await service.dispose();
  });

  it('holds the persisted ingest lease exclusively through renewal, expiry, and owner-safe release', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const first = new DatabaseNewsIngestLease(db);
    const second = new DatabaseNewsIngestLease(db);
    const initial = await Promise.all([
      first.acquire('owner-a', NOW, 1_000),
      second.acquire('owner-b', NOW, 1_000),
    ]);
    expect(initial.filter(Boolean)).toHaveLength(1);
    const winner = initial[0] ? { lease: first, id: 'owner-a' } : { lease: second, id: 'owner-b' };
    const loser = initial[0] ? { lease: second, id: 'owner-b' } : { lease: first, id: 'owner-a' };
    expect(await db.selectFrom('provider_leases').selectAll().executeTakeFirstOrThrow())
      .toEqual({
        provider: 'x-news-stream', owner_id: winner.id,
        expires_at: NOW + 1_000, updated_at: NOW,
      });
    expect(await loser.lease.acquire(loser.id, NOW + 999, 1_000)).toBe(false);
    expect(await winner.lease.acquire(winner.id, NOW + 500, 1_000)).toBe(true);
    expect(await loser.lease.acquire(loser.id, NOW + 1_499, 1_000)).toBe(false);
    expect(await loser.lease.acquire(loser.id, NOW + 1_500, 1_000)).toBe(true);

    await winner.lease.release(winner.id);
    expect(await db.selectFrom('provider_leases').select('owner_id').executeTakeFirstOrThrow())
      .toEqual({ owner_id: loser.id });
    await loser.lease.release(loser.id);
    expect(await db.selectFrom('provider_leases').selectAll().execute()).toEqual([]);
  });

  it('enforces the provider budget atomically under concurrent consumers', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const budget = new DatabaseNewsRequestBudget(db);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      budget.consume('2026-07-14', 5, NOW + index)
    )));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await db.selectFrom('provider_budgets').select('request_count').executeTakeFirstOrThrow())
      .toEqual({ request_count: 5 });
  });
});
