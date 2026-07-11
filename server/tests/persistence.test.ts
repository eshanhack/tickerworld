import { generateKeyPairSync, sign } from 'node:crypto';
import { toAddress } from '@solana/client';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrateDatabase } from '../src/db/database.js';
import type { DatabaseSchema } from '../src/db/types.js';
import {
  AuthService,
  Ed25519WalletSignatureVerifier,
} from '../src/services/auth.js';
import {
  EconomyService,
  type ChainPaymentVerifier,
  type QuoteAuthority,
  type VerifiedPayment,
} from '../src/services/economy.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function decodeBase58(value: string): Uint8Array {
  let numeric = 0n;
  for (const character of value) numeric = numeric * 58n + BigInt(BASE58.indexOf(character));
  const bytes: number[] = [];
  while (numeric > 0n) {
    bytes.push(Number(numeric & 255n));
    numeric >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

const config = loadConfig({
  NODE_ENV: 'test',
  SQLITE_PATH: ':memory:',
  PUBLIC_ORIGIN: 'http://localhost:4173',
  SERVER_HMAC_SECRET: 'server-test-secret-that-is-long-enough',
  IP_HMAC_SECRET: 'different-ip-test-secret-long-enough',
  TREASURY_ADDRESS: '11111111111111111111111111111111',
  SOLANA_CLUSTER: 'devnet',
});

describe('persistence, auth, and economy invariants', () => {
  let db: Kysely<DatabaseSchema>;

  beforeEach(async () => {
    db = createDatabase(config);
    await migrateDatabase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('runs the portable migration idempotently', async () => {
    await migrateDatabase(db);
    const tables = await db.selectFrom('accounts').selectAll().execute();
    expect(tables).toEqual([]);
  });

  it('verifies a nonce-bound Ed25519 wallet message and creates a revocable session', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    const walletAddress = encodeBase58(publicDer.subarray(publicDer.length - 32));
    const auth = new AuthService(db, new Ed25519WalletSignatureVerifier());
    const challenge = await auth.issueChallenge(
      walletAddress,
      'anon_0123456789abcdef0123456789abcdef',
      'fox',
      'a'.repeat(64),
      1_000,
    );
    const signature = encodeBase58(sign(null, Buffer.from(challenge.message), privateKey));
    const verified = await auth.verifyChallenge({
      challengeId: challenge.id,
      walletAddress,
      actorId: 'anon_0123456789abcdef0123456789abcdef',
      signature,
    }, 2_000);
    const account = await auth.authenticate(verified.token, 2_001);
    expect(account.walletAddress).toBe(walletAddress);
    expect(account.actorId).toBe('anon_0123456789abcdef0123456789abcdef');
    await auth.revoke(verified.token, 2_002);
    await expect(auth.authenticate(verified.token, 2_003)).rejects.toMatchObject({ status: 401 });
  });

  it('grants a matching confirmed payment exactly once', async () => {
    const now = 10_000;
    await db.insertInto('accounts').values({
      id: 'account_test',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_1234567890abcdef',
      username: null,
      username_normalized: null,
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: now,
      updated_at: now,
    }).execute();
    const quoteAuthority: QuoteAuthority = {
      available: true,
      async lamportsForUsdCents() { return 12_345n; },
    };
    let verifiedPayment: VerifiedPayment | null = null;
    const paymentVerifier: ChainPaymentVerifier = {
      available: true,
      async verify() {
        return verifiedPayment
          ? { state: 'confirmed', payment: verifiedPayment }
          : { state: 'pending' };
      },
    };
    const economy = new EconomyService(db, config, quoteAuthority, paymentVerifier);
    const quote = await economy.createQuote('account_test', 'sunrise-fox', {}, now);
    expect(decodeBase58(quote.reference)).toHaveLength(32);
    expect(() => toAddress(quote.reference)).not.toThrow();
    const signature = '5'.repeat(88);
    expect(await economy.confirmPayment('account_test', quote.id, signature, now + 500)).toEqual({
      state: 'pending',
      entitlement: 'sunrise-fox',
      idempotent: false,
    });
    expect(await db.selectFrom('purchase_quotes')
      .select(['status', 'claim_signature'])
      .where('id', '=', quote.id)
      .executeTakeFirst()).toEqual({ status: 'processing', claim_signature: signature });
    await expect(economy.confirmPayment('account_test', quote.id, '4'.repeat(88), now + 750))
      .rejects.toMatchObject({ status: 409, code: 'quote_processing' });
    verifiedPayment = {
      signature,
      payer: '11111111111111111111111111111111',
      recipient: quote.recipient,
      reference: quote.reference,
      lamports: BigInt(quote.lamports),
      cluster: quote.cluster,
      confirmationStatus: 'confirmed',
      blockTimeMs: now + 750,
    };
    // A process restart or a slow chain confirmation must not reopen the quote
    // or discard its bound signature, even after the two-minute quote window.
    const resumedEconomy = new EconomyService(db, config, quoteAuthority, paymentVerifier);
    expect(await resumedEconomy.confirmPayment(
      'account_test', quote.id, verifiedPayment.signature, quote.expiresAt + 1,
    )).toEqual({
      state: 'confirmed',
      entitlement: 'sunrise-fox',
      idempotent: false,
    });
    expect(await economy.confirmPayment('account_test', quote.id, verifiedPayment.signature, quote.expiresAt + 2)).toEqual({
      state: 'confirmed',
      entitlement: 'sunrise-fox',
      idempotent: true,
    });
    const entitlements = await db.selectFrom('entitlements').selectAll().execute();
    expect(entitlements).toHaveLength(1);
  });

  it('fails closed when payment verification is unavailable', async () => {
    await db.insertInto('accounts').values({
      id: 'account_closed',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_abcdef1234567890',
      username: null,
      username_normalized: null,
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 1n; } },
      { available: false, async verify() { return { state: 'pending' }; } },
    );
    const quote = await economy.createQuote('account_closed', 'golden-duck', {}, 10);
    await expect(economy.confirmPayment('account_closed', quote.id, '4'.repeat(88), 20))
      .rejects.toMatchObject({ status: 503, code: 'payment_verifier_unavailable' });
  });

  it('rejects a matching transfer whose authoritative block time is after quote expiry', async () => {
    await db.insertInto('accounts').values({
      id: 'account_late_broadcast',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_latebroadcast12',
      username: null,
      username_normalized: null,
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    let payment: VerifiedPayment | null = null;
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 123n; } },
      { available: true, async verify() {
        return payment ? { state: 'confirmed', payment } : { state: 'pending' };
      } },
    );
    const quote = await economy.createQuote('account_late_broadcast', 'honey-bear', {}, 1_000);
    payment = {
      signature: '9'.repeat(88),
      payer: '11111111111111111111111111111111',
      recipient: quote.recipient,
      reference: quote.reference,
      lamports: BigInt(quote.lamports),
      cluster: quote.cluster,
      confirmationStatus: 'confirmed',
      blockTimeMs: quote.expiresAt + 1,
    };
    await expect(economy.confirmPayment(
      'account_late_broadcast', quote.id, payment.signature, quote.expiresAt - 1,
    )).rejects.toMatchObject({ status: 400, code: 'payment_invalid' });
    expect(await db.selectFrom('entitlements')
      .selectAll()
      .where('account_id', '=', 'account_late_broadcast')
      .execute()).toEqual([]);
    expect(await db.selectFrom('purchase_quotes')
      .select('status')
      .where('id', '=', quote.id)
      .executeTakeFirst()).toEqual({ status: 'expired' });
  });

  it('recovers an in-window transfer when the first confirmation request arrives late', async () => {
    await db.insertInto('accounts').values({
      id: 'account_late_confirm',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_lateconfirm123',
      username: null,
      username_normalized: null,
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    let payment!: VerifiedPayment;
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 123n; } },
      { available: true, async verify() { return { state: 'confirmed', payment }; } },
    );
    const quote = await economy.createQuote('account_late_confirm', 'bluebell-penguin', {}, 1_000);
    payment = {
      signature: '3'.repeat(88),
      payer: '11111111111111111111111111111111',
      recipient: quote.recipient,
      reference: quote.reference,
      lamports: BigInt(quote.lamports),
      cluster: quote.cluster,
      confirmationStatus: 'finalized',
      blockTimeMs: 2_000,
    };
    await expect(economy.confirmPayment(
      'account_late_confirm',
      quote.id,
      payment.signature,
      quote.expiresAt + 24 * 60 * 60_000,
    )).resolves.toMatchObject({ state: 'confirmed', idempotent: false });
    expect(await db.selectFrom('entitlements')
      .select('sku')
      .where('account_id', '=', 'account_late_confirm')
      .execute()).toEqual([{ sku: 'bluebell-penguin' }]);
  });

  it('rejects a verifier result whose payment signature is not the submitted signature', async () => {
    await db.insertInto('accounts').values({
      id: 'account_signature_boundary',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_signaturebound1',
      username: null,
      username_normalized: null,
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    let payment!: VerifiedPayment;
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 123n; } },
      { available: true, async verify() { return { state: 'confirmed', payment }; } },
    );
    const quote = await economy.createQuote('account_signature_boundary', 'golden-duck', {}, 1_000);
    payment = {
      signature: '8'.repeat(88),
      payer: '11111111111111111111111111111111',
      recipient: quote.recipient,
      reference: quote.reference,
      lamports: BigInt(quote.lamports),
      cluster: quote.cluster,
      confirmationStatus: 'confirmed',
      blockTimeMs: 2_000,
    };
    await expect(economy.confirmPayment(
      'account_signature_boundary', quote.id, '7'.repeat(88), 3_000,
    )).rejects.toMatchObject({ status: 400, code: 'payment_invalid' });
    expect(await db.selectFrom('entitlements')
      .selectAll()
      .where('account_id', '=', 'account_signature_boundary')
      .execute()).toEqual([]);
  });

  it('keeps a persisted claim reconcilable and grants a late-confirmed in-window transfer', async () => {
    await db.insertInto('accounts').values({
      id: 'account_stale_claim',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_staleclaim1234',
      username: null,
      username_normalized: null,
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    let payment: VerifiedPayment | null = null;
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 123n; } },
      { available: true, async verify() {
        return payment ? { state: 'confirmed', payment } : { state: 'pending' };
      } },
    );
    const quote = await economy.createQuote('account_stale_claim', 'alpine-frog', {}, 500_000);
    const signature = 'A'.repeat(88);
    await expect(economy.confirmPayment('account_stale_claim', quote.id, signature, 500_100))
      .resolves.toMatchObject({ state: 'pending' });
    await expect(economy.confirmPayment('account_stale_claim', quote.id, signature, 650_101))
      .resolves.toMatchObject({ state: 'pending' });
    payment = {
      signature,
      payer: '11111111111111111111111111111111',
      recipient: quote.recipient,
      reference: quote.reference,
      lamports: BigInt(quote.lamports),
      cluster: quote.cluster,
      confirmationStatus: 'confirmed',
      blockTimeMs: 500_200,
    };
    await expect(economy.confirmPayment('account_stale_claim', quote.id, signature, 700_000))
      .resolves.toMatchObject({ state: 'confirmed' });
    expect(await db.selectFrom('entitlements').select('sku').where('account_id', '=', 'account_stale_claim').execute())
      .toEqual([{ sku: 'alpine-frog' }]);
  });

  it('atomically grants and assigns the username captured by the paid quote', async () => {
    await db.insertInto('accounts').values({
      id: 'account_name',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_name1234567890',
      username: null,
      username_normalized: null,
      selected_animal: 'rabbit',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    let payment: VerifiedPayment | null = null;
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 300n; } },
      { available: true, async verify() {
        return payment ? { state: 'confirmed', payment } : { state: 'pending' };
      } },
      (canonical) => canonical === 'admin',
    );
    const quote = await economy.createQuote(
      'account_name',
      'username-claim',
      { username: 'Magic_Rabbit' },
      1_000,
    );
    payment = {
      signature: '6'.repeat(88),
      payer: '11111111111111111111111111111111',
      recipient: quote.recipient,
      reference: quote.reference,
      lamports: BigInt(quote.lamports),
      cluster: quote.cluster,
      confirmationStatus: 'confirmed',
      blockTimeMs: 1_500,
    };
    await economy.confirmPayment('account_name', quote.id, payment.signature, 2_000);
    const account = await db.selectFrom('accounts').selectAll().where('id', '=', 'account_name').executeTakeFirstOrThrow();
    const entitlements = await db.selectFrom('entitlements').select('sku').where('account_id', '=', 'account_name').execute();
    expect(account.username).toBe('Magic_Rabbit');
    expect(account.username_normalized).toBe('magic_rabbit');
    expect(entitlements).toEqual([{ sku: 'username-claim' }]);
    expect(await db.selectFrom('username_credits').select(['status', 'consumed_username_normalized']).execute())
      .toEqual([{ status: 'consumed', consumed_username_normalized: 'magic_rabbit' }]);
    expect(await db.selectFrom('username_reservations').selectAll().execute()).toEqual([]);
    const auth = new AuthService(db, new Ed25519WalletSignatureVerifier());
    await expect(auth.claimUsername('account_name', 'Different_Name', () => false, 2_001))
      .rejects.toMatchObject({ status: 409, code: 'username_immutable' });
  });

  it('reserves username quotes and converts an unassignable paid name into a claim credit', async () => {
    const rows = [
      { id: 'account_reserve_a', wallet: '11111111111111111111111111111111', actor: 'player_aaaaaaaaaaaaaaaa' },
      { id: 'account_reserve_b', wallet: '22222222222222222222222222222222', actor: 'player_bbbbbbbbbbbbbbbb' },
    ];
    for (const row of rows) {
      await db.insertInto('accounts').values({
        id: row.id,
        wallet_address: row.wallet,
        actor_id: row.actor,
        username: null,
        username_normalized: null,
        selected_animal: 'fox',
        selected_skin: 'base',
        last_market: 'btc',
        created_at: 1,
        updated_at: 1,
      }).execute();
    }
    let payment: VerifiedPayment | null = null;
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 300n; } },
      { available: true, async verify() {
        return payment ? { state: 'confirmed', payment } : { state: 'pending' };
      } },
    );
    const first = await economy.createQuote(
      'account_reserve_a', 'username-claim', { username: 'Moon_Fox' }, 1_000,
    );
    await expect(economy.createQuote(
      'account_reserve_b', 'username-claim', { username: 'moon_fox' }, 1_001,
    )).rejects.toMatchObject({ status: 409, code: 'username_reserved' });

    // A reservation can disappear because of operational recovery while a paid
    // quote is still open. The payment must remain valuable without stealing a name.
    await db.deleteFrom('username_reservations').where('quote_id', '=', first.id).execute();
    payment = {
      signature: '7'.repeat(88),
      payer: rows[0]!.wallet,
      recipient: first.recipient,
      reference: first.reference,
      lamports: BigInt(first.lamports),
      cluster: first.cluster,
      confirmationStatus: 'confirmed',
      blockTimeMs: 1_500,
    };
    expect(await economy.confirmPayment('account_reserve_a', first.id, payment.signature, 2_000))
      .toMatchObject({ state: 'credited', entitlement: 'username-claim' });
    expect((await db.selectFrom('accounts').select('username').where('id', '=', rows[0]!.id).executeTakeFirst())?.username)
      .toBeNull();
    expect(await db.selectFrom('username_credits').select('status').executeTakeFirst())
      .toMatchObject({ status: 'available' });
    const auth = new AuthService(db, new Ed25519WalletSignatureVerifier());
    expect(await auth.profileForAccount('account_reserve_a'))
      .toMatchObject({ username: null, usernameCreditAvailable: true });
    await auth.claimUsername('account_reserve_a', 'Star_Fox', () => false, 2_001);
    expect(await auth.profileForAccount('account_reserve_a'))
      .toMatchObject({ username: 'Star_Fox', usernameCreditAvailable: false });
    expect(await db.selectFrom('username_credits').select('status').executeTakeFirst())
      .toMatchObject({ status: 'consumed' });
  });

  it('atomically claims a quote before external payment verification', async () => {
    await db.insertInto('accounts').values({
      id: 'account_atomic',
      wallet_address: '11111111111111111111111111111111',
      actor_id: 'player_atomicatomicatom',
      username: null,
      username_normalized: null,
      selected_animal: 'fox',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: 1,
      updated_at: 1,
    }).execute();
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    let enteredVerification!: () => void;
    const entered = new Promise<void>((resolve) => { enteredVerification = resolve; });
    let expectedPayment: VerifiedPayment | null = null;
    const economy = new EconomyService(
      db,
      config,
      { available: true, async lamportsForUsdCents() { return 600n; } },
      {
        available: true,
        async verify() {
          enteredVerification();
          await verificationGate;
          return expectedPayment
            ? { state: 'confirmed', payment: expectedPayment }
            : { state: 'pending' };
        },
      },
    );
    const quote = await economy.createQuote('account_atomic', 'sunrise-fox', {}, 10_000);
    expectedPayment = {
      signature: '8'.repeat(88),
      payer: '11111111111111111111111111111111',
      recipient: quote.recipient,
      reference: quote.reference,
      lamports: BigInt(quote.lamports),
      cluster: quote.cluster,
      confirmationStatus: 'confirmed',
      blockTimeMs: 10_500,
    };
    const first = economy.confirmPayment('account_atomic', quote.id, expectedPayment.signature, 11_000);
    await entered;
    await expect(economy.confirmPayment('account_atomic', quote.id, expectedPayment.signature, 11_001))
      .rejects.toMatchObject({ status: 409, code: 'quote_processing' });
    releaseVerification();
    await expect(first).resolves.toMatchObject({ idempotent: false });
  });
});
