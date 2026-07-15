import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSET_SYMBOLS } from '@tickerworld/shared';
import { configureHttp } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrateDatabase } from '../src/db/database.js';
import { createRuntime, type ServerRuntime } from '../src/runtime.js';
import { DatabaseNewsRequestBudget, NewsIngestService } from '../src/services/newsIngest.js';
import { createStatefulXRulesApi } from './helpers/xRules.js';

describe('news account HTTP acquisition', () => {
  let runtime: ServerRuntime;
  let api: ReturnType<typeof request>;
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      PUBLIC_ORIGIN: 'http://localhost:4173',
      SERVER_HMAC_SECRET: 'news-http-server-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'news-http-ip-secret-that-is-long-enough',
      ENABLE_NEWS_INGEST: 'true',
      X_BEARER_TOKEN: 'paid-test-token',
      // The invalid value is filtered from static defaults, keeping this fixture deterministic.
      X_TRACKED_HANDLES: 'not-a-valid-handle',
      X_DAILY_REQUEST_LIMIT: '100',
    });
    const db = createDatabase(config);
    await migrateDatabase(db);
    runtime = await createRuntime(config, { db });
    await runtime.news.dispose();
    // The production runtime owns an asynchronous persisted-lease release.
    // Let it drain before this fixture substitutes its isolated service.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rulesApi = createStatefulXRulesApi();
    fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname === '/2/users/1000000000000000010') {
        return Response.json({ data: {
          id: '1000000000000000010', name: 'Headline Desk', username: 'HeadlineDesk',
          profile_image_url: 'https://pbs.twimg.com/headline.jpg', protected: false,
        } });
      }
      if (url.pathname.includes('/users/by/username/')) {
        return Response.json({ data: {
          id: '1000000000000000010', name: 'Headline Desk', username: 'HeadlineDesk',
          profile_image_url: 'https://pbs.twimg.com/headline.jpg', protected: false,
        } });
      }
      if (url.pathname.endsWith('/tweets')) return Response.json({ data: [] });
      throw new Error(`Unexpected X request: ${url}`);
    });
    runtime.news = new NewsIngestService(
      'paid-test-token', [], 100, runtime.switches, fetcher as typeof fetch,
      Date.now, 60_000, new DatabaseNewsRequestBudget(runtime.db), runtime.db,
    );
    await runtime.news.initialize();
    const app = express();
    configureHttp(app, runtime);
    api = request(app);
  });

  afterEach(async () => {
    await runtime.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.db.destroy();
  });

  it('requires a signed anonymous identity and returns the backward-compatible catalog shape', async () => {
    // Invalid proofs must not consume the small IP budget for users sharing a
    // household, office, mobile carrier, or other NAT address.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rejected = await api.post('/api/news/accounts').send({
        scope: 'BTC', handle: 'HeadlineDesk', anonymousToken: `${'x'.repeat(80)}.${'y'.repeat(64)}`,
      });
      expect(rejected.status).toBe(401);
    }

    const identity = runtime.anonymous.issue();
    const added = await api.post('/api/news/accounts').send({
      scope: 'BTC', handle: '@HeadlineDesk', anonymousToken: identity.token,
    });
    expect(added.status).toBe(201);
    expect(added.headers['cache-control']).toBe('private, no-store');
    expect(added.body).toEqual({ account: expect.objectContaining({
      id: '1000000000000000010', handle: 'HeadlineDesk', avatarUrl: 'https://pbs.twimg.com/headline.jpg',
      isDefault: false, status: 'live', lastPostAt: null,
    }) });

    const snapshot = await api.get('/api/news?scope=BTC');
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({
      accounts: [expect.objectContaining({ id: '1000000000000000010' })],
      maxAccounts: 8,
    });

    fetcher.mockClear();
    for (let touch = 0; touch < 3; touch += 1) {
      const touched = await api.post('/api/news/accounts').send({
        scope: 'BTC', handle: 'HeadlineDesk', accountId: '1000000000000000010',
        anonymousToken: identity.token,
      });
      expect(touched.status).toBe(201);
      expect(touched.body.account.id).toBe('1000000000000000010');
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await runtime.db.selectFrom('x_news_worlds')
      .select('last_requested_at')
      .where('source_id', '=', '1000000000000000010')
      .where('scope', '=', 'BTC')
      .executeTakeFirstOrThrow()).last_requested_at).toBeGreaterThan(0);
  });

  it('serves the bounded account/news view for every registered tickerworld scope', async () => {
    for (const scope of ASSET_SYMBOLS) {
      const snapshot = await api.get(`/api/news?scope=${scope}`);
      expect(snapshot.status, scope).toBe(200);
      expect(snapshot.body).toMatchObject({
        items: expect.any(Array),
        accounts: expect.any(Array),
        maxAccounts: 8,
      });
      expect(['live', 'unconfigured', 'unavailable']).toContain(snapshot.body.mode);
    }
  });

  it('limits new acquisitions to two per actor per day', async () => {
    const identity = runtime.anonymous.issue();
    const body = { scope: 'BTC', handle: 'bad-handle', anonymousToken: identity.token };
    for (let index = 0; index < 2; index += 1) {
      const response = await api.post('/api/news/accounts').send(body);
      expect(response.status).toBe(400);
    }
    const limited = await api.post('/api/news/accounts').send(body);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('news_account_add_actor_rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(23 * 60 * 60);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reacquires a pruned saved selection by immutable id instead of its stale handle', async () => {
    const identity = runtime.anonymous.issue();
    const response = await api.post('/api/news/accounts').send({
      scope: 'BTC',
      handle: 'StaleOldHandle',
      accountId: '1000000000000000010',
      anonymousToken: identity.token,
    });
    expect(response.status).toBe(201);
    expect(response.body.account).toMatchObject({
      id: '1000000000000000010',
      handle: 'HeadlineDesk',
    });
    expect(fetcher.mock.calls.some(([input]) => (
      new URL(String(input)).pathname.includes('/users/by/username/')
    ))).toBe(false);
  });

  it('limits new acquisitions to three per IP per day across actors', async () => {
    for (let index = 0; index < 3; index += 1) {
      const identity = runtime.anonymous.issue();
      const response = await api.post('/api/news/accounts').send({
        scope: 'BTC', handle: `bad-handle-${index}`, anonymousToken: identity.token,
      });
      expect(response.status).toBe(400);
    }
    const identity = runtime.anonymous.issue();
    const limited = await api.post('/api/news/accounts').send({
      scope: 'BTC', handle: 'bad-four', anonymousToken: identity.token,
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('news_account_add_ip_rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(23 * 60 * 60);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
