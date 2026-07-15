import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrateDatabase } from '../src/db/database.js';
import {
  NewsIngestService,
  X_STREAM_HANDSHAKE_TIMEOUT_MS,
  xRuleTag,
  xRuleValue,
} from '../src/services/newsIngest.js';
import { RuntimeSwitchboard } from '../src/services/runtimeSwitches.js';
import { createStatefulXRulesApi } from './helpers/xRules.js';

const NOW = Date.parse('2026-07-14T01:00:00.000Z');
const switchboard = () => new RuntimeSwitchboard({
  admissions: true,
  chatSend: true,
  newsIngest: true,
  directMarketFallback: true,
  publicWalletAuth: false,
  purchases: false,
  adminActions: false,
}, 400);

describe('X ingest stream and rule hardening', () => {
  const databases: Array<ReturnType<typeof createDatabase>> = [];
  const services: NewsIngestService[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it('keeps the handshake open beyond X idle stream keep-alives', () => {
    expect(X_STREAM_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it('marks only rules verified by reread ready when a provider mutation is partially applied', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    await db.insertInto('x_news_sources').values([
      {
        id: '1000000000000000101', handle: 'VerifiedDesk', handle_normalized: 'verifieddesk',
        name: 'Verified Desk', avatar_url: null, status: 'active', since_id: null,
        last_profile_at: NOW, last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW, updated_at: NOW,
      },
      {
        id: '1000000000000000102', handle: 'MissingDesk', handle_normalized: 'missingdesk',
        name: 'Missing Desk', avatar_url: null, status: 'active', since_id: null,
        last_profile_at: NOW, last_poll_at: null, last_success_at: null, last_post_at: null,
        created_at: NOW, updated_at: NOW,
      },
    ]).execute();
    await db.insertInto('x_news_worlds').values([
      { source_id: '1000000000000000101', scope: 'BTC', is_default: 0, last_requested_at: NOW, created_at: NOW },
      { source_id: '1000000000000000102', scope: 'BTC', is_default: 0, last_requested_at: NOW, created_at: NOW },
    ]).execute();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/2/tweets/search/stream/rules') {
        throw new Error(`Unexpected X request: ${url}`);
      }
      if (init?.method === 'POST') return Response.json({ meta: { summary: { created: 1 } } });
      return Response.json({ data: [{
        id: 'verified-rule',
        tag: xRuleTag('1000000000000000101'),
        value: xRuleValue('VerifiedDesk'),
      }] });
    });
    const service = new NewsIngestService(
      'token', [], 50, switchboard(), fetcher as typeof fetch, () => NOW, 60_000,
      undefined, db,
    );
    services.push(service);
    await service.initialize(NOW);

    await expect(service.refresh(NOW)).rejects.toThrow('x_502');

    const rows = await db.selectFrom('x_news_sources')
      .select(['id', 'rule_ready_at', 'rule_pending_at'])
      .orderBy('id')
      .execute();
    expect(rows).toEqual([
      { id: '1000000000000000101', rule_ready_at: NOW, rule_pending_at: null },
      { id: '1000000000000000102', rule_ready_at: null, rule_pending_at: NOW },
    ]);
  });

  it('keeps the activation-gap cursor durable across restart until a verified rule and delayed backfill succeed', async () => {
    vi.useFakeTimers();
    let clock = NOW;
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    let exposeRule = false;
    let timelineReads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1000000000000000201', name: 'Gap Desk', username: 'GapDesk', protected: false,
        } });
      }
      if (url.pathname === '/2/tweets/search/stream/rules') {
        if (init?.method === 'POST') return Response.json({ meta: { summary: { created: 1 } } });
        return Response.json({ data: exposeRule ? [{
          id: 'gap-rule',
          tag: xRuleTag('1000000000000000201'),
          value: xRuleValue('GapDesk'),
        }] : [] });
      }
      if (url.pathname.endsWith('/tweets')) {
        timelineReads += 1;
        if (timelineReads === 3) return Response.json({ data: 'malformed-provider-page' });
        return Response.json({ data: timelineReads === 1 ? [{
          id: '2000000000000000201', author_id: '1000000000000000201', text: 'Gap headline',
          created_at: new Date(NOW - 1_000).toISOString(),
        }] : [] });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const first = new NewsIngestService(
      'token', [], 50, switchboard(), fetcher as typeof fetch, () => clock, 60_000,
      undefined, db,
    );
    services.push(first);
    await first.initialize(clock);
    expect(await first.addAccount('BTC', 'GapDesk', clock)).toMatchObject({ status: 'reconnecting' });
    expect(await db.selectFrom('x_news_sources')
      .select(['rule_pending_at', 'rule_pending_since_id', 'rule_ready_at'])
      .executeTakeFirstOrThrow()).toEqual({
      rule_pending_at: NOW,
      rule_pending_since_id: null,
      rule_ready_at: null,
    });
    await first.dispose();
    services.splice(services.indexOf(first), 1);

    exposeRule = true;
    clock += 1_000;
    const promoted = new NewsIngestService(
      'token', [], 50, switchboard(), fetcher as typeof fetch, () => clock, 60_000,
      undefined, db,
    );
    services.push(promoted);
    await promoted.initialize(clock);
    await promoted.refresh(clock);
    expect(await db.selectFrom('x_news_sources')
      .select(['rule_pending_at', 'rule_ready_at'])
      .executeTakeFirstOrThrow()).toEqual({
      rule_pending_at: NOW,
      rule_ready_at: NOW + 1_000,
    });

    clock += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await db.selectFrom('x_news_sources')
      .select('rule_pending_at')
      .executeTakeFirstOrThrow()).rule_pending_at).toBe(NOW);

    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await db.selectFrom('x_news_sources')
      .select(['rule_pending_at', 'rule_pending_since_id', 'rule_ready_at'])
      .executeTakeFirstOrThrow()).toEqual({
      rule_pending_at: null,
      rule_pending_since_id: null,
      rule_ready_at: NOW + 1_000,
    });
    expect(timelineReads).toBeGreaterThanOrEqual(4);
  });

  it('opens and preserves a healthy filtered stream while REST backfill is rate limited', async () => {
    const rulesApi = createStatefulXRulesApi();
    let streamSignal: AbortSignal | null = null;
    let closeStream!: () => void;
    let resolveStreamOpened!: () => void;
    const streamOpened = new Promise<void>((resolve) => { resolveStreamOpened = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1000000000000000301', name: 'Stream Desk', username: 'StreamDesk', protected: false,
        } });
      }
      if (url.pathname.endsWith('/users/1000000000000000301/tweets')) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
      }
      if (url.pathname === '/2/tweets/search/stream') {
        streamSignal = init?.signal ?? null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            closeStream = () => controller.close();
            const abort = () => controller.error(new DOMException('Aborted', 'AbortError'));
            streamSignal?.addEventListener('abort', abort, { once: true });
          },
        });
        resolveStreamOpened();
        return new Response(body, { status: 200 });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['StreamDesk'], 50, switchboard(), fetcher as typeof fetch, () => NOW, 60_000,
    );
    services.push(service);
    await service.initialize(NOW);
    await expect(service.refresh(NOW)).rejects.toThrow('x_429');

    service.start();
    await Promise.race([
      streamOpened,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not open')), 1_000)),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(streamSignal).not.toBeNull();
    expect(streamSignal!.aborted).toBe(false);
    expect(service.leaderStatus()).toBe('leader');
    expect(service.snapshot('BTC', NOW).mode).toBe('live');
    expect(fetcher.mock.calls.filter(([input]) => (
      new URL(String(input)).pathname === '/2/tweets/search/stream'
    ))).toHaveLength(1);

    closeStream();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.snapshot('BTC', NOW).mode).toBe('unavailable');
  });

  it('hot-adds an account to the connected stream and accepts its next authored post exactly once', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const rulesApi = createStatefulXRulesApi();
    const timelineUrls: URL[] = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamSignal: AbortSignal | null = null;
    let streamAttempts = 0;
    let resolveStreamOpened!: () => void;
    const streamOpened = new Promise<void>((resolve) => { resolveStreamOpened = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/WarmDesk')) {
        return Response.json({ data: {
          id: '1000000000000000501', name: 'Warm Desk', username: 'WarmDesk', protected: false,
        } });
      }
      if (url.pathname.includes('/users/by/username/HotDesk')) {
        return Response.json({ data: {
          id: '1000000000000000502', name: 'Hot Desk', username: 'HotDesk', protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) {
        timelineUrls.push(url);
        return Response.json({ data: [] });
      }
      if (url.pathname === '/2/tweets/search/stream') {
        streamAttempts += 1;
        streamSignal = init?.signal ?? null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            streamSignal?.addEventListener('abort', () => {
              try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* already closed */ }
            }, { once: true });
          },
        });
        resolveStreamOpened();
        return new Response(body, { status: 200 });
      }
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['WarmDesk'], 100, switchboard(), fetcher as typeof fetch, () => NOW, 60_000,
      undefined, db,
    );
    services.push(service);
    await service.initialize(NOW);
    service.start();

    await Promise.race([
      streamOpened,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not open')), 1_000)),
    ]);
    expect(streamAttempts).toBe(1);
    expect(streamSignal?.aborted).toBe(false);

    const account = await service.addAccount('BTC', 'HotDesk', NOW);
    expect(account).toMatchObject({
      id: '1000000000000000502', handle: 'HotDesk', status: 'live',
    });
    expect(rulesApi.snapshot()).toContainEqual(expect.objectContaining({
      tag: xRuleTag('1000000000000000502'),
      value: 'from:HotDesk -is:retweet',
    }));
    const hotTimeline = timelineUrls.find((url) => (
      url.pathname.endsWith('/users/1000000000000000502/tweets')
    ));
    expect(hotTimeline?.searchParams.get('exclude')).toBe('retweets');
    expect(streamAttempts).toBe(1);
    expect(streamSignal?.aborted).toBe(false);

    const streamLine = `${JSON.stringify({
      data: {
        id: '2000000000000000502',
        author_id: '1000000000000000502',
        text: 'An authored reply belongs in the tracked world feed.',
        created_at: new Date(NOW - 250).toISOString(),
        referenced_tweets: [{ type: 'replied_to', id: '2000000000000000001' }],
      },
      includes: { users: [{
        id: '1000000000000000502', name: 'Hot Desk', username: 'HotDesk', protected: false,
      }] },
    })}\n`;
    streamController?.enqueue(new TextEncoder().encode(streamLine));
    streamController?.enqueue(new TextEncoder().encode(streamLine));

    await vi.waitFor(() => {
      expect(service.snapshot('BTC', NOW).items.filter((item) => (
        item.id === '2000000000000000502'
      ))).toHaveLength(1);
    });
    expect(service.snapshot('ETH', NOW).items.some((item) => (
      item.id === '2000000000000000502'
    ))).toBe(false);
    expect(await db.selectFrom('x_news_posts').select('id')
      .where('id', '=', '2000000000000000502').execute()).toEqual([
      { id: '2000000000000000502' },
    ]);
    expect(streamAttempts).toBe(1);
    expect(streamSignal?.aborted).toBe(false);
  });

  it('activates and verifies cold-start rules before opening the filtered stream', async () => {
    const events: string[] = [];
    const rulesApi = createStatefulXRulesApi();
    let resolveStreamOpened!: () => void;
    const streamOpened = new Promise<void>((resolve) => { resolveStreamOpened = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) {
        events.push('profile');
        return Response.json({ data: {
          id: '1000000000000000401', name: 'Cold Desk', username: 'ColdDesk', protected: false,
        } });
      }
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) {
        events.push(init?.method === 'POST' ? 'rules-post' : 'rules-get');
        return ruleResponse;
      }
      if (url.pathname === '/2/tweets/search/stream') {
        events.push('stream');
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* already closed */ }
            }, { once: true });
          },
        });
        resolveStreamOpened();
        return new Response(body, { status: 200 });
      }
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', ['ColdDesk'], 50, switchboard(), fetcher as typeof fetch, () => NOW, 60_000,
    );
    services.push(service);
    await service.initialize(NOW);
    service.start();

    await Promise.race([
      streamOpened,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not open')), 1_000)),
    ]);

    const streamIndex = events.indexOf('stream');
    const mutationIndex = events.indexOf('rules-post');
    expect(mutationIndex).toBeGreaterThan(events.indexOf('profile'));
    expect(streamIndex).toBeGreaterThan(mutationIndex);
    expect(events.slice(mutationIndex + 1, streamIndex)).toContain('rules-get');
    expect(rulesApi.snapshot()).toEqual([expect.objectContaining({
      tag: xRuleTag('1000000000000000401'),
      value: xRuleValue('ColdDesk'),
    })]);
  });

  it('repairs externally deleted rules after a persisted-ready stream handshake is rejected', async () => {
    let clock = NOW;
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    databases.push(db);
    await migrateDatabase(db);
    const sourceId = '1000000000000000402';
    await db.insertInto('x_news_sources').values({
      id: sourceId, handle: 'ResetDesk', handle_normalized: 'resetdesk', name: 'Reset Desk',
      avatar_url: null, status: 'active', since_id: null,
      rule_pending_at: null, rule_pending_since_id: null, rule_ready_at: NOW,
      last_profile_at: NOW, last_poll_at: NOW, last_success_at: NOW, last_post_at: null,
      created_at: NOW, updated_at: NOW,
    }).execute();
    await db.insertInto('x_news_worlds').values({
      source_id: sourceId, scope: 'BTC', is_default: 0,
      last_requested_at: NOW, created_at: NOW,
    }).execute();
    const rulesApi = createStatefulXRulesApi();
    let streamAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname === '/2/tweets/search/stream') {
        streamAttempts += 1;
        if (rulesApi.snapshot().length === 0) {
          return new Response('This stream currently has no rules', { status: 409 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.close(); },
        }), { status: 200 });
      }
      if (url.pathname.endsWith(`/${sourceId}/tweets`)) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const service = new NewsIngestService(
      'token', [], 100, switchboard(), fetcher as typeof fetch, () => clock,
      60_000, undefined, db,
    );
    services.push(service);
    await service.initialize(NOW);
    const internals = service as unknown as {
      started: boolean;
      runConnection(): Promise<void>;
    };
    internals.started = true;

    await internals.runConnection();
    expect(streamAttempts).toBe(1);
    expect(rulesApi.snapshot()).toEqual([]);
    clock += 5_000;
    await internals.runConnection();

    expect(streamAttempts).toBe(2);
    expect(rulesApi.snapshot()).toEqual([expect.objectContaining({
      tag: xRuleTag(sourceId),
      value: xRuleValue('ResetDesk'),
    })]);
  });
});
