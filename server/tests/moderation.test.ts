import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrateDatabase } from '../src/db/database.js';
import type { DatabaseSchema } from '../src/db/types.js';
import { ModerationService } from '../src/services/moderation.js';

const config = loadConfig({
  NODE_ENV: 'test',
  SQLITE_PATH: ':memory:',
  SERVER_HMAC_SECRET: 'moderation-server-secret-long-enough',
  IP_HMAC_SECRET: 'moderation-ip-secret-long-enough-value',
});

describe('moderation enforcement', () => {
  let db: Kysely<DatabaseSchema>;
  let moderation: ModerationService;

  beforeEach(async () => {
    db = createDatabase(config);
    await migrateDatabase(db);
    await db.insertInto('accounts').values({
      id: 'admin_account',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_admin123456789',
      username: 'AdminFox',
      username_normalized: 'adminfox',
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    moderation = new ModerationService(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('enforces live kicks and persistent wallet/IP admission actions', async () => {
    const disconnect = vi.fn();
    moderation.registerConnection('room:session', {
      actorId: 'anon_target',
      walletAddress: 'target-wallet',
      ipHash: 'b'.repeat(64),
      disconnect,
    });
    await moderation.createAction({
      admin_account_id: 'admin_account',
      target_actor_id: 'anon_target',
      target_wallet_address: null,
      target_ip_hash: null,
      action: 'kick',
      reason: 'testing kick enforcement',
      expires_at: null,
    }, 1_000);
    expect(disconnect).toHaveBeenCalledWith(4_201, 'kick');

    await moderation.createAction({
      admin_account_id: 'admin_account',
      target_actor_id: null,
      target_wallet_address: 'target-wallet',
      target_ip_hash: null,
      action: 'wallet_temp_ban',
      reason: 'temporary wallet ban',
      expires_at: 20_000,
    }, 2_000);
    expect(moderation.connectionRejection({ walletAddress: 'target-wallet', ipHash: 'c'.repeat(64) }, 3_000))
      .toBe('wallet_temp_ban');

    await moderation.createAction({
      admin_account_id: 'admin_account',
      target_actor_id: null,
      target_wallet_address: null,
      target_ip_hash: 'd'.repeat(64),
      action: 'ip_throttle',
      reason: 'temporary anonymous throttle',
      expires_at: 20_000,
    }, 2_000);
    const restored = new ModerationService(db);
    await restored.hydrate(3_000);
    expect(restored.connectionRejection({ walletAddress: null, ipHash: 'd'.repeat(64) }, 3_001))
      .toBe('ip_throttle');
    expect(restored.connectionRejection({ walletAddress: null, ipHash: 'd'.repeat(64) }, 20_001))
      .toBeNull();
  });

  it('persists server-owned report evidence rather than client-provided transcripts', async () => {
    const id = await moderation.createReport({
      reporterActorId: 'anon_reporter',
      reporterAccountId: null,
      targetActorId: 'anon_target',
      market: 'btc',
      reason: 'harassment',
      note: 'Please review',
      evidence: [{
        id: 'chat_1',
        actorId: 'anon_target',
        username: null,
        animal: 'fox',
        text: 'canonical room message',
        sentAt: 1_000,
      }],
      ipHash: 'e'.repeat(64),
    }, 2_000);
    const report = await db.selectFrom('moderation_reports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(JSON.parse(report.evidence_json)).toMatchObject([{ text: 'canonical room message' }]);
    expect(report.ip_hash).toBe('e'.repeat(64));
  });
});
