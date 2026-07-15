import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrateDatabase } from '../src/db/database.js';
import { PartyInviteService } from '../src/services/partyInvites.js';
import {
  applyRelayedTrade,
  parseRelayedCandle,
  reconcileRelayedCandles,
} from '../src/services/marketRelay.js';
import { RuntimeSwitchboard } from '../src/services/runtimeSwitches.js';
import { DatabaseNewsRequestBudget, NewsIngestService } from '../src/services/newsIngest.js';
import { RetentionService } from '../src/services/retention.js';
import { SafeLogger } from '../src/services/safeLogger.js';
import { createStatefulXRulesApi } from './helpers/xRules.js';

const switches = {
  admissions: true,
  chatSend: true,
  newsIngest: true,
  directMarketFallback: false,
  publicWalletAuth: false,
  purchases: false,
  adminActions: false,
};

describe('viral launch services', () => {
  it('requires the durable database and X token when production news ingestion is enabled', () => {
    const productionNewsEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      COLYSEUS_CLOUD: '1',
      DATABASE_SSL: 'verify-full',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      PUBLIC_ORIGIN: 'https://tickerworld.io',
      SERVER_HMAC_SECRET: 'server-production-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
      ENABLE_NEWS_INGEST: 'true',
    };

    expect(() => loadConfig({
      ...productionNewsEnv,
      X_BEARER_TOKEN: 'paid-production-token',
    })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({
      ...productionNewsEnv,
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
    })).toThrow(/X_BEARER_TOKEN/);
    expect(loadConfig({
      ...productionNewsEnv,
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      X_BEARER_TOKEN: 'paid-production-token',
    })).toMatchObject({
      databaseUrl: 'postgres://user:pass@db.example/tickerworld',
      xBearerToken: 'paid-production-token',
      launchSwitches: { newsIngest: true },
    });
  });

  it('treats a paid X token as the durable Colyseus Cloud news opt-in', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      COLYSEUS_CLOUD: '1',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'verify-full',
      X_BEARER_TOKEN: 'paid-production-token',
      ENABLE_NEWS_INGEST: 'false',
    });

    expect(config.launchSwitches.newsIngest).toBe(true);
  });

  it('keeps production wallet and purchases fail-closed without credentials', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'verify-full',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      PUBLIC_ORIGIN: 'https://tickerworld.io',
      SERVER_HMAC_SECRET: 'server-production-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
    });
    expect(config.launchSwitches).toMatchObject({
      publicWalletAuth: false,
      purchases: false,
      newsIngest: false,
    });
    expect(config.treasuryAddress).toBeNull();
    expect(config.solanaRpcUrl).toBeNull();
    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'verify-full',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      PUBLIC_ORIGIN: 'https://tickerworld.io',
      SERVER_HMAC_SECRET: 'server-production-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
      MAX_PROCESS_CONNECTIONS: '401',
    })).toThrow(/MAX_PROCESS_CONNECTIONS/);
    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'verify-full',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      PUBLIC_ORIGIN: 'https://tickerworld.io',
      SERVER_HMAC_SECRET: 'replace-with-at-least-32-random-characters',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
    })).toThrow(/SERVER_HMAC_SECRET/);
  });

  it('issues signed 30-minute invites and caps them at twelve successful joins', () => {
    const service = new PartyInviteService('party-test-secret-that-is-long-enough', 30 * 60_000, 12);
    const issued = service.issue('actor', 'room-a', 'btc', 1_000);
    expect(issued).toMatchObject({ market: 'btc', expiresAt: 1_801_000, remainingJoins: 12 });
    expect(service.inspect(`${issued.token}tampered`, 2_000)).toEqual({ ok: false, code: 'party_invalid' });
    expect(service.consume(issued.token, 'room-b', 'btc', 2_000)).toEqual({ ok: false, code: 'party_invalid' });
    for (let index = 0; index < 12; index += 1) {
      expect(service.consume(issued.token, 'room-a', 'btc', 2_000)).toMatchObject({ ok: true });
    }
    expect(service.inspect(issued.token, 2_000)).toEqual({ ok: false, code: 'party_full' });
    const expiring = service.issue('actor', 'room-a', 'btc', 5_000);
    expect(service.inspect(expiring.token, expiring.expiresAt)).toEqual({ ok: false, code: 'party_expired' });
  });

  it('parses string candles, reconciles in place, and retains exactly thirty', () => {
    const parsed = parseRelayedCandle({ t: '60000', o: '10', h: '12', l: '9', c: '11' });
    expect(parsed).toEqual({ openTime: 60_000, open: 10, high: 12, low: 9, close: 11 });
    let window = [] as NonNullable<typeof parsed>[];
    for (let index = 0; index < 35; index += 1) {
      window = reconcileRelayedCandles(window, {
        openTime: index * 60_000,
        open: index,
        high: index + 2,
        low: index - 1,
        close: index + 1,
      });
    }
    expect(window).toHaveLength(30);
    expect(window[0]?.openTime).toBe(5 * 60_000);
    window = reconcileRelayedCandles(window, { ...window.at(-1)!, close: 999 });
    expect(window).toHaveLength(30);
    expect(window.at(-1)?.close).toBe(999);
    const traded = applyRelayedTrade(window, 1_001, window.at(-1)!.openTime + 30_000);
    expect(traded.at(-1)).toMatchObject({ close: 1_001, high: 1_001 });
    expect(applyRelayedTrade(traded, 2, traded.at(-1)!.openTime - 60_000)).toEqual(traded);
  });

  it('centralizes X reads, scopes explicit cashtags, and stops at the daily budget', async () => {
    const now = Date.parse('2026-07-12T00:05:00.000Z');
    const rulesApi = createStatefulXRulesApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ruleResponse = rulesApi.respond(input, init);
      if (ruleResponse) return ruleResponse;
      const url = new URL(String(input));
      if (url.pathname.includes('/users/by/username/')) return Response.json({
        data: { id: '1000000000000000001', name: 'Delta One', username: 'DeItaone' },
      });
      if (url.pathname.endsWith('/tweets')) return Response.json({
        data: [{
          id: '2000000000000000001',
          text: '$BTC move',
          created_at: new Date(now - 1_000).toISOString(),
        }],
      });
      throw new Error(`Unexpected X request: ${url}`);
    });
    const switchboard = new RuntimeSwitchboard(switches, 400);
    const service = new NewsIngestService(
      'paid-token', ['DeItaone'], 5, switchboard, fetcher, () => now, 60_000,
    );
    await service.refresh(now);
    expect(service.snapshot('BTC', now)).toMatchObject({
      mode: 'live',
      items: [{ id: '2000000000000000001', scope: 'BTC', demo: false }],
    });
    expect(service.snapshot('ETH', now).items).toEqual([
      expect.objectContaining({ id: '2000000000000000001', scope: 'ETH', demo: false }),
    ]);
    await expect(service.refresh(now + 60_000)).rejects.toThrow('x_429');
    expect(fetcher).toHaveBeenCalledTimes(5);
    await service.dispose();
  });

  it('persists the paid X request kill across service instances', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    await migrateDatabase(db);
    try {
      const first = new DatabaseNewsRequestBudget(db);
      const second = new DatabaseNewsRequestBudget(db);
      expect(await first.consume('2026-07-12', 2, 1)).toBe(true);
      expect(await first.consume('2026-07-12', 2, 2)).toBe(true);
      expect(await second.consume('2026-07-12', 2, 3)).toBe(false);
      expect(await second.consume('2026-07-13', 2, 4)).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it('enforces IP, report, audit, and provider-budget retention', async () => {
    const db = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
    await migrateDatabase(db);
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    const day = 24 * 60 * 60_000;
    try {
      await db.insertInto('accounts').values({
        id: 'admin', wallet_address: '1'.repeat(32), actor_id: 'actor_admin', username: null,
        username_normalized: null, selected_animal: 'fox', selected_skin: 'base', last_market: 'btc',
        created_at: 1, updated_at: 1,
      }).execute();
      await db.insertInto('auth_challenges').values([
        { id: 'challenge_old', wallet_address: '1'.repeat(32), actor_id: 'actor_a', actor_animal: 'fox', nonce_hash: 'a', message: 'a', ip_hash: 'a'.repeat(64), expires_at: now, consumed_at: null, created_at: now - day - 1 },
        { id: 'challenge_new', wallet_address: '1'.repeat(32), actor_id: 'actor_a', actor_animal: 'fox', nonce_hash: 'b', message: 'b', ip_hash: 'b'.repeat(64), expires_at: now + day, consumed_at: null, created_at: now },
      ]).execute();
      await db.insertInto('moderation_reports').values([
        { id: 'report_old', reporter_actor_id: 'actor_a', reporter_account_id: null, target_actor_id: 'actor_b', market: 'btc', reason: 'other', note: null, evidence_json: '[]', ip_hash: 'c'.repeat(64), status: 'resolved', created_at: now - 90 * day - 1, resolved_at: now - day },
        { id: 'report_new', reporter_actor_id: 'actor_a', reporter_account_id: null, target_actor_id: 'actor_b', market: 'btc', reason: 'other', note: null, evidence_json: '[]', ip_hash: 'd'.repeat(64), status: 'open', created_at: now, resolved_at: null },
      ]).execute();
      await db.insertInto('moderation_actions').values([
        { id: 'action_ip', admin_account_id: 'admin', target_actor_id: null, target_wallet_address: null, target_ip_hash: 'e'.repeat(64), action: 'ip_throttle', reason: 'test', expires_at: now - day, created_at: now - 2 * day },
        { id: 'action_old', admin_account_id: 'admin', target_actor_id: 'actor_b', target_wallet_address: null, target_ip_hash: null, action: 'kick', reason: 'test', expires_at: null, created_at: now - 365 * day - 1 },
      ]).execute();
      await db.insertInto('provider_budgets').values([
        { provider: 'x', day_utc: '2026-06-01', request_count: 1, updated_at: now - 14 * day - 1 },
        { provider: 'x', day_utc: '2026-07-12', request_count: 1, updated_at: now },
      ]).execute();

      await new RetentionService(db, new SafeLogger()).run(now);
      expect(await db.selectFrom('auth_challenges').select('id').execute()).toEqual([{ id: 'challenge_new' }]);
      expect(await db.selectFrom('moderation_reports').select('id').execute()).toEqual([{ id: 'report_new' }]);
      expect(await db.selectFrom('moderation_actions').select(['id', 'target_ip_hash']).execute())
        .toEqual([{ id: 'action_ip', target_ip_hash: null }]);
      expect(await db.selectFrom('provider_budgets').select('day_utc').execute())
        .toEqual([{ day_utc: '2026-07-12' }]);
    } finally {
      await db.destroy();
    }
  });
});
