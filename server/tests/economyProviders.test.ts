import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { createRuntime } from '../src/runtime.js';
import {
  HttpSolUsdQuoteAuthority,
  SolanaRpcPaymentVerifier,
  type PaymentExpectation,
} from '../src/services/economy.js';

describe('production economy authorities', () => {
  it('creates lamport quotes from a live-style SOL/USD response', async () => {
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({ solana: { usd: 150 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const authority = new HttpSolUsdQuoteAuthority('https://prices.example/sol', requestFetch as typeof fetch);
    expect(authority.available).toBe(false);
    expect(await authority.lamportsForUsdCents(300)).toBe(20_000_000n);
    expect(authority.available).toBe(true);
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it('accepts only a confirmed RPC transfer matching every quote field', async () => {
    const signature = '5'.repeat(88);
    const expected: PaymentExpectation = {
      payer: '2'.repeat(44),
      recipient: '3'.repeat(44),
      reference: '4'.repeat(44),
      lamports: 20_000_000n,
      cluster: 'mainnet-beta',
    };
    const requestFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; id: number };
      const result = request.method === 'getGenesisHash'
        ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
        : request.method === 'getSignatureStatuses'
        ? { context: { slot: 1 }, value: [{ err: null, confirmationStatus: 'confirmed' }] }
        : {
          blockTime: 1_700_000_000,
          meta: { err: null },
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [
                { pubkey: expected.payer, signer: true, writable: true },
                { pubkey: expected.recipient, signer: false, writable: true },
                { pubkey: expected.reference, signer: false, writable: false },
              ],
              instructions: [{
                program: 'system',
                parsed: {
                  type: 'transfer',
                  info: {
                    source: expected.payer,
                    destination: expected.recipient,
                    lamports: Number(expected.lamports),
                  },
                },
              }],
            },
          },
        };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const verifier = new SolanaRpcPaymentVerifier(
      'https://rpc.example',
      'mainnet-beta',
      requestFetch as typeof fetch,
    );
    await expect(verifier.verify(signature, expected)).resolves.toMatchObject({
      state: 'confirmed',
      payment: {
        ...expected,
        signature,
        confirmationStatus: 'confirmed',
        blockTimeMs: 1_700_000_000_000,
      },
    });
    await expect(verifier.verify(signature, { ...expected, reference: '6'.repeat(44) }))
      .resolves.toMatchObject({ state: 'invalid' });
  });

  it('fails closed on unconfirmed signatures or unavailable providers', async () => {
    const requestFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; id: number };
      const result = request.method === 'getGenesisHash'
        ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
        : request.method === 'getSignatureStatuses'
        ? { value: [{ err: null, confirmationStatus: 'processed' }] }
        : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const verifier = new SolanaRpcPaymentVerifier('https://rpc.example', 'devnet', requestFetch as typeof fetch);
    await expect(verifier.verify('5'.repeat(88), {
      payer: '2'.repeat(44),
      recipient: '3'.repeat(44),
      reference: '4'.repeat(44),
      lamports: 1n,
      cluster: 'devnet',
    })).resolves.toEqual({ state: 'pending' });
    expect(new SolanaRpcPaymentVerifier(null, 'devnet').available).toBe(false);
    expect(new HttpSolUsdQuoteAuthority(null).available).toBe(false);
  });

  it('never becomes ready when an RPC reports the wrong cluster genesis', async () => {
    const requestFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const verifier = new SolanaRpcPaymentVerifier(
      'https://wrong-cluster.example',
      'mainnet-beta',
      requestFetch as typeof fetch,
    );
    await expect(verifier.initialize()).resolves.toBe(false);
    expect(verifier.available).toBe(false);
  });

  it('expires provider readiness and fails a fresh re-probe closed', async () => {
    let now = 1_000;
    let providersHealthy = true;
    const priceFetch = vi.fn(async () => {
      if (!providersHealthy) throw new Error('price provider offline');
      return new Response(JSON.stringify({ solana: { usd: 150 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const quoteAuthority = new HttpSolUsdQuoteAuthority(
      'https://prices.example/sol',
      priceFetch as typeof fetch,
      () => now,
    );
    await expect(quoteAuthority.initialize()).resolves.toBe(true);
    expect(quoteAuthority.available).toBe(true);

    const rpcFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: providersHealthy ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' : null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const verifier = new SolanaRpcPaymentVerifier(
      'https://rpc.example',
      'devnet',
      rpcFetch as typeof fetch,
      () => now,
    );
    await expect(verifier.initialize()).resolves.toBe(true);
    expect(verifier.available).toBe(true);

    providersHealthy = false;
    now += 121_000;
    expect(quoteAuthority.available).toBe(false);
    expect(verifier.available).toBe(false);
    await expect(quoteAuthority.initialize()).resolves.toBe(false);
    await expect(verifier.initialize()).resolves.toBe(false);
    expect(quoteAuthority.available).toBe(false);
    expect(verifier.available).toBe(false);
  });

  it('keeps a confirmed transaction with missing block time pending for recovery', async () => {
    const signature = '5'.repeat(88);
    const requestFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; id: number };
      const result = request.method === 'getGenesisHash'
        ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
        : request.method === 'getSignatureStatuses'
          ? { value: [{ err: null, confirmationStatus: 'confirmed' }] }
          : {
            blockTime: null,
            meta: { err: null },
            transaction: { signatures: [signature], message: {} },
          };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const verifier = new SolanaRpcPaymentVerifier(
      'https://rpc.example', 'devnet', requestFetch as typeof fetch,
    );
    await expect(verifier.verify(signature, {
      payer: '2'.repeat(44),
      recipient: '3'.repeat(44),
      reference: '4'.repeat(44),
      lamports: 1n,
      cluster: 'devnet',
    })).resolves.toEqual({ state: 'pending' });
  });

  it('refuses production startup when either economy authority fails initialization', async () => {
    const production = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'verify-full',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      PUBLIC_ORIGIN: 'https://tickerworld.io',
      SERVER_HMAC_SECRET: 'server-production-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
      TREASURY_ADDRESS: '11111111111111111111111111111111',
      ADMIN_WALLETS: '11111111111111111111111111111111',
      SOLANA_RPC_URL: 'https://rpc.example.test',
      SOL_USD_PRICE_URL: 'https://prices.example.test/sol-usd',
      ENABLE_PURCHASES: 'true',
    });

    for (const failed of ['quote', 'payment'] as const) {
      const database = createDatabase(loadConfig({ NODE_ENV: 'test', SQLITE_PATH: ':memory:' }));
      try {
        await expect(createRuntime(production, {
          db: database,
          quoteAuthority: {
            available: failed !== 'quote',
            async initialize() { return failed !== 'quote'; },
            async lamportsForUsdCents() { return 1n; },
          },
          paymentVerifier: {
            available: failed !== 'payment',
            async initialize() { return failed !== 'payment'; },
            async verify() { return { state: 'pending' as const }; },
          },
        })).rejects.toThrow('Production economy providers failed readiness checks');
      } finally {
        await database.destroy();
      }
    }
  });
});
