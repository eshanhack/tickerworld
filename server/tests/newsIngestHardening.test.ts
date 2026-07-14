import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrateDatabase } from '../src/db/database.js';
import {
  DatabaseNewsIngestLease,
  NewsIngestService,
  type NewsIngestLease,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class DeferredLease implements NewsIngestLease {
  readonly acquisitionStarted = deferred<void>();
  readonly acquisition = deferred<boolean>();
  readonly releases: string[] = [];

  async acquire(): Promise<boolean> {
    this.acquisitionStarted.resolve();
    return this.acquisition.promise;
  }

  async release(ownerId: string): Promise<void> {
    this.releases.push(ownerId);
  }
}

describe('X news ingestor leadership hardening', () => {
  const databases: Array<ReturnType<typeof createDatabase>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it('quiesces disposal during lease acquisition and releases a late-acquired lease before provider work', async () => {
    const lease = new DeferredLease();
    const fetcher = vi.fn(async () => {
      throw new Error('disposed ingestor must not call X');
    });
    const service = new NewsIngestService(
      'token', [], 20, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, null, lease,
    );

    const acquisition = service.addAccount('BTC', 'LateLease', NOW);
    await lease.acquisitionStarted.promise;
    const disposal = service.dispose();
    lease.acquisition.resolve(true);

    await expect(acquisition).rejects.toMatchObject({
      status: 503,
      code: 'news_ingestor_standby',
    });
    await disposal;

    expect(fetcher).not.toHaveBeenCalled();
    expect(lease.releases.length).toBeGreaterThanOrEqual(1);
    expect(new Set(lease.releases)).toHaveLength(1);
    expect(service.leaderStatus()).toBe('standby');
  });

  it('keeps standby catalog writes fenced, then reloads durable sources and posts on promotion', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);

    const rulesApi = createStatefulXRulesApi();
    const leaderFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/SharedNews')) {
        return Response.json({ data: {
          id: '1000000000000000711',
          name: 'Shared News',
          username: 'SharedNews',
          profile_image_url: 'https://pbs.twimg.com/shared-news.jpg',
          protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) {
        return Response.json({ data: [{
          id: '2000000000000000711',
          author_id: '1000000000000000711',
          text: 'Durable promotion headline',
          created_at: new Date(NOW - 1_000).toISOString(),
        }] });
      }
      throw new Error(`Unexpected leader X request: ${url}`);
    });
    const standbyFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        throw new Error('promotion should reuse the durable source profile');
      }
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [] });
      throw new Error(`Unexpected standby X request: ${url}`);
    });

    const standby = new NewsIngestService(
      'token', [], 100, switchboard(), standbyFetcher as typeof fetch, () => NOW + 2_000,
      60_000, undefined, db, new DatabaseNewsIngestLease(db),
    );
    await standby.initialize(NOW - 1_000);

    const leader = new NewsIngestService(
      'token', [], 100, switchboard(), leaderFetcher as typeof fetch, () => NOW,
      60_000, undefined, db, new DatabaseNewsIngestLease(db),
    );
    await leader.initialize(NOW);
    await leader.addAccount('BTC', 'SharedNews', NOW);
    expect(leader.leaderStatus()).toBe('leader');

    await expect(standby.addAccount('ETH', 'MustNotPersist', NOW + 1_000)).rejects.toMatchObject({
      status: 503,
      code: 'news_ingestor_standby',
    });
    expect(standbyFetcher).not.toHaveBeenCalled();
    expect(await db.selectFrom('x_news_sources').select('handle').execute()).toEqual([
      { handle: 'SharedNews' },
    ]);
    expect(await db.selectFrom('x_news_worlds').select('scope').execute()).toEqual([
      { scope: 'BTC' },
    ]);

    await leader.dispose();
    const promotedAccount = await standby.addAccount('ETH', 'SharedNews', NOW + 2_000);

    expect(standby.leaderStatus()).toBe('leader');
    expect(promotedAccount).toMatchObject({
      id: '1000000000000000711',
      handle: 'SharedNews',
    });
    expect(standby.snapshot('ETH', NOW + 2_000).items).toEqual([
      expect.objectContaining({
        id: '2000000000000000711',
        scope: 'ETH',
        text: 'Durable promotion headline',
      }),
    ]);
    expect(standbyFetcher.mock.calls.some(([input]) => (
      new URL(String(input)).pathname.includes('/users/by/username/')
    ))).toBe(false);
    expect(await db.selectFrom('x_news_worlds').select('scope').orderBy('scope').execute()).toEqual([
      { scope: 'BTC' },
      { scope: 'ETH' },
    ]);

    await standby.dispose();
  });

  it('uses a DB-side NOT EXISTS guard when another instance associates a locally unused source', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const sourceId = '1000000000000000712';
    await db.insertInto('x_news_sources').values({
      id: sourceId,
      handle: 'RacingSource',
      handle_normalized: 'racingsource',
      name: 'Racing Source',
      avatar_url: null,
      status: 'active',
      since_id: null,
      last_profile_at: NOW,
      last_poll_at: null,
      last_success_at: null,
      last_post_at: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();

    const service = new NewsIngestService(
      'token', [], 20, switchboard(), vi.fn() as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);
    expect(service.isAccountAssociated('BTC', 'RacingSource')).toBe(false);
    const internals = service as unknown as {
      leadershipGeneration: number;
      ensureLeadership(now: number): Promise<boolean>;
      deleteUnusedSource(id: string, leadershipGeneration: number): Promise<void>;
    };
    expect(await internals.ensureLeadership(NOW)).toBe(true);

    // Simulate another leader inserting the association after this instance loaded its catalog.
    await db.insertInto('x_news_worlds').values({
      source_id: sourceId,
      scope: 'BTC',
      is_default: 0,
      last_requested_at: NOW + 1,
      created_at: NOW + 1,
    }).execute();
    await internals.deleteUnusedSource(sourceId, internals.leadershipGeneration);

    expect(await db.selectFrom('x_news_sources').select('id').executeTakeFirst()).toEqual({ id: sourceId });
    expect(await db.selectFrom('x_news_worlds').select(['source_id', 'scope']).execute()).toEqual([
      { source_id: sourceId, scope: 'BTC' },
    ]);
    expect(service.isAccountAssociated('BTC', 'RacingSource')).toBe(true);
    expect(service.accounts('BTC', NOW)).toEqual([
      expect.objectContaining({ id: sourceId, handle: 'RacingSource' }),
    ]);

    await service.dispose();
  });

  it('rejects a stale owner at the durable mutation fence after lease handoff', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const first = new DatabaseNewsIngestLease(db);
    const second = new DatabaseNewsIngestLease(db);
    expect(await first.acquire('owner-a', NOW, 1_000)).toBe(true);
    await expect(first.runFenced!('owner-a', NOW + 500, async () => 'guarded'))
      .resolves.toBe('guarded');
    expect(await second.acquire('owner-b', NOW + 1_000, 1_000)).toBe(true);
    await expect(first.runFenced!('owner-a', NOW + 1_001, async () => 'stale'))
      .rejects.toThrow('x_503');
  });

  it('sweeps durable orphan sources even when no stale world association exists', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    await db.insertInto('x_news_sources').values({
      id: '1000000000000000713',
      handle: 'OrphanSource',
      handle_normalized: 'orphansource',
      name: 'Orphan Source',
      avatar_url: null,
      status: 'active',
      since_id: null,
      last_profile_at: NOW,
      last_poll_at: null,
      last_success_at: null,
      last_post_at: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();
    const service = new NewsIngestService(
      'token', [], 20, switchboard(), vi.fn() as typeof fetch, () => NOW,
      60_000, undefined, db, new DatabaseNewsIngestLease(db),
    );
    await service.initialize(NOW);
    expect(await service.pruneInactiveWorlds(NOW)).toBe(0);
    expect(await db.selectFrom('x_news_sources').selectAll().execute()).toEqual([]);
    await service.dispose();
  });

  it('awaits an already-fired activation-gap repair before releasing on dispose', async () => {
    const service = new NewsIngestService(
      'token', [], 20, switchboard(), vi.fn() as typeof fetch, () => NOW,
    );
    const repair = deferred<void>();
    const internals = service as unknown as { gapBackfillOperations: Set<Promise<void>> };
    internals.gapBackfillOperations.add(repair.promise);
    let disposed = false;
    const disposal = service.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    repair.resolve();
    await disposal;
    expect(disposed).toBe(true);
  });

  it('prunes the shared ten-minute cache on an API replica without an X token', async () => {
    vi.useFakeTimers();
    let clock = NOW;
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const sourceId = '1000000000000000714';
    await db.insertInto('x_news_sources').values({
      id: sourceId, handle: 'ExpiredDesk', handle_normalized: 'expireddesk',
      name: 'Expired Desk', avatar_url: null, status: 'active', since_id: null,
      last_profile_at: NOW, last_poll_at: NOW, last_success_at: NOW, last_post_at: NOW,
      created_at: NOW, updated_at: NOW,
    }).execute();
    await db.insertInto('x_news_worlds').values({
      source_id: sourceId, scope: 'BTC', is_default: 0,
      last_requested_at: NOW, created_at: NOW,
    }).execute();
    await db.insertInto('x_news_posts').values({
      id: '2000000000000000714', source_id: sourceId, text: 'Short lived headline',
      links_json: '[]', created_at: NOW, expires_at: NOW + 1_000,
      author_name: 'Expired Desk', author_handle: 'ExpiredDesk', author_avatar_url: null,
      permalink: 'https://x.com/ExpiredDesk/status/2000000000000000714', updated_at: NOW,
    }).execute();
    const service = new NewsIngestService(
      null, [], 20, switchboard(), vi.fn() as typeof fetch, () => clock,
      60_000, undefined, db,
    );
    await service.initialize(clock);
    expect(service.snapshot('BTC', clock).items).toHaveLength(1);
    service.start();

    clock += 5_001;
    await vi.advanceTimersByTimeAsync(5_001);
    await Promise.resolve();

    expect(await db.selectFrom('x_news_posts').selectAll().execute()).toEqual([]);
    expect(service.snapshot('BTC', clock).items).toEqual([]);
    await service.dispose();
  });

  it('retains immutable selections without paid lookups before 24h and cools down failed id refreshes', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const sourceId = '1000000000000000715';
    const otherSourceId = '1000000000000000716';
    for (const [id, handle, scope] of [
      [sourceId, 'TouchDesk', 'BTC'],
      [otherSourceId, 'OtherTouchDesk', 'ETH'],
    ] as const) {
      await db.insertInto('x_news_sources').values({
        id, handle, handle_normalized: handle.toLowerCase(), name: handle,
        avatar_url: null, status: 'active', since_id: null, last_profile_at: NOW,
        last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW, updated_at: NOW,
      }).execute();
      await db.insertInto('x_news_worlds').values({
        source_id: id, scope, is_default: 0,
        last_requested_at: NOW, created_at: NOW,
      }).execute();
    }
    let providerCalls = 0;
    const fetcher = vi.fn(async () => {
      providerCalls += 1;
      return new Response('provider plan outage', { status: 403 });
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => NOW,
      60_000, undefined, db,
    );
    await service.initialize(NOW);

    await service.touchAccount('BTC', sourceId, NOW + 6 * 60_000);
    await service.touchAccount('BTC', sourceId, NOW + 7 * 60_000);
    expect(providerCalls).toBe(0);

    await service.touchAccount('BTC', sourceId, NOW + 25 * 60 * 60_000);
    // A distinct public catalog id must hit the shared circuit, not spend a
    // second paid request under a per-id-only cooldown.
    await service.touchAccount('ETH', otherSourceId, NOW + 25 * 60 * 60_000 + 1);
    expect(providerCalls).toBe(1);
    expect(await db.selectFrom('x_news_sources')
      .select(['id', 'status'])
      .where('id', 'in', [sourceId, otherSourceId])
      .orderBy('id')
      .execute()).toEqual([
      { id: sourceId, status: 'active' },
      { id: otherSourceId, status: 'active' },
    ]);
    await service.dispose();
  });
});
