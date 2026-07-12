import { MARKET_SLUGS, normalizeYaw } from '@tickerworld/shared';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTrustedPeerCapture } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PopulationDirectory } from '../src/rooms/PopulationDirectory.js';
import { isAllowedRoomOrigin } from '../src/rooms/roomServices.js';
import { AdmissionControl } from '../src/services/admission.js';
import {
  CanonicalIpResolver,
  TRUSTED_PEER_HEADER,
  websocketOrigin,
  websocketPeer,
} from '../src/services/canonicalIp.js';
import { SharedChatRateLimiter } from '../src/services/chatSafety.js';
import { SlidingWindowRateLimiter } from '../src/services/rateLimits.js';

describe('launch safety controls', () => {
  afterEach(() => vi.useRealTimers());

  it('ignores forwarding headers unless the immediate peer is trusted', () => {
    const resolver = new CanonicalIpResolver(['10.0.0.0/8', '2001:db8:abcd::/48']);
    expect(resolver.resolve('203.0.113.9', '198.51.100.4')).toBe('203.0.113.9');
    expect(resolver.resolve('10.0.0.2', '198.51.100.4, 10.2.3.4')).toBe('198.51.100.4');
    expect(resolver.resolve('2001:db8:abcd::2', '2001:db8:ffff::8')).toBe('2001:db8:ffff::8');
    expect(() => new CanonicalIpResolver(['10.0.0.0/99'])).toThrow(/Invalid trusted proxy CIDR/);
    expect(() => new CanonicalIpResolver(['0.0.0.0/0'])).toThrow(/Universal trusted proxy CIDR/);
    expect(() => new CanonicalIpResolver(['::/0'])).toThrow(/Universal trusted proxy CIDR/);
  });

  it('never treats Colyseus forwarded AuthContext.ip as the transport peer', () => {
    const forged = websocketPeer({
      ip: '198.51.100.4',
      headers: new Headers({ 'x-forwarded-for': '198.51.100.4' }),
    } as any);
    expect(forged.peer).toBeNull();

    const captured = websocketPeer({ headers: new Headers({
      [TRUSTED_PEER_HEADER]: '10.0.0.2',
      'x-forwarded-for': '198.51.100.4, 10.2.3.4',
    }) });
    expect(new CanonicalIpResolver(['10.0.0.0/8']).resolve(captured.peer, captured.forwarded))
      .toBe('198.51.100.4');
  });

  it('overwrites a forged internal peer header before later request listeners run', async () => {
    const server = createServer();
    const app = { transport: { server } } as any;
    expect(installTrustedPeerCapture(app)).toBe(true);
    expect(installTrustedPeerCapture(app)).toBe(true);
    server.on('request', (request, response) => {
      response.end(String(request.headers[TRUSTED_PEER_HEADER] ?? 'missing'));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        headers: { [TRUSTED_PEER_HEADER]: '10.0.0.99' },
      });
      expect(await response.text()).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('requires an allowlisted browser origin in production matchmaking', () => {
    const allowed = ['https://tickerworld.io'];
    expect(websocketOrigin({ headers: new Headers({ origin: allowed[0] }) })).toBe(allowed[0]);
    expect(isAllowedRoomOrigin(allowed[0]!, allowed, true)).toBe(true);
    expect(isAllowedRoomOrigin('https://evil.example', allowed, true)).toBe(false);
    expect(isAllowedRoomOrigin(null, allowed, true)).toBe(false);
    expect(isAllowedRoomOrigin(null, allowed, false)).toBe(true);
  });

  it('requires exact HTTPS production origins at configuration time', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'verify-full',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      SERVER_HMAC_SECRET: 'server-production-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
      TREASURY_ADDRESS: '11111111111111111111111111111111',
      ADMIN_WALLETS: '11111111111111111111111111111111',
      SOLANA_RPC_URL: 'https://rpc.example.test',
      SOL_USD_PRICE_URL: 'https://prices.example.test/sol-usd',
    } satisfies NodeJS.ProcessEnv;
    expect(() => loadConfig(production)).toThrow(/PUBLIC_ORIGIN is required/);
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: 'http://tickerworld.io' }))
      .toThrow(/exact HTTPS origins/);
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: 'https://tickerworld.io/path' }))
      .toThrow(/exact HTTPS origins/);
    expect(loadConfig({
      ...production,
      PUBLIC_ORIGIN: 'https://tickerworld.io,https://preview.tickerworld.io/',
    }).publicOrigins).toEqual(['https://tickerworld.io', 'https://preview.tickerworld.io']);
  });

  it('keeps actor and IP chat buckets across reconnects and room travel', () => {
    const limiter = new SharedChatRateLimiter();
    expect(limiter.consume('actor-a', 'ip-a', 0).allowed).toBe(true);
    expect(limiter.consume('actor-a', 'ip-a', 0).allowed).toBe(true);
    expect(limiter.consume('actor-a', 'ip-a', 0).allowed).toBe(true);
    expect(limiter.consume('actor-a', 'ip-a', 1)).toMatchObject({ allowed: false });
    // A new connection/actor cannot reset the shared IP bucket; changing IP
    // cannot reset the actor bucket either.
    expect(limiter.consume('actor-b', 'ip-a', 1)).toMatchObject({ allowed: false });
    expect(limiter.consume('actor-a', 'ip-b', 1)).toMatchObject({ allowed: false });
    expect(limiter.consume('actor-a', 'ip-a', 2_001).allowed).toBe(true);
  });

  it('rate-limits exact sliding windows and supplies a retry time', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.consume('quote', 'account', 2, 1_000, 0).allowed).toBe(true);
    expect(limiter.consume('quote', 'account', 2, 1_000, 100).allowed).toBe(true);
    expect(limiter.consume('quote', 'account', 2, 1_000, 500)).toMatchObject({
      allowed: false,
      retryAfterMs: 500,
    });
    expect(limiter.consume('quote', 'account', 2, 1_000, 1_001).allowed).toBe(true);
  });

  it('retains long-window buckets while pruning unrelated short windows', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.consume('hourly', 'account', 1, 60 * 60_000, 0).allowed).toBe(true);
    // The 256th consume invokes the global cleanup path. Every short bucket is
    // unrelated to the hour-long account bucket.
    for (let index = 0; index < 255; index += 1) {
      limiter.consume('minute', `ip-${index}`, 1, 60_000, 120_000);
    }
    expect(limiter.consume('hourly', 'account', 1, 60 * 60_000, 120_001)).toMatchObject({
      allowed: false,
      retryAfterMs: 60 * 60_000 - 120_001,
    });
  });

  it('enforces a single active actor and hard process/room caps', () => {
    const admissions = new AdmissionControl({
      maxProcessConnections: 2,
      maxRooms: 2,
      maxMarketShards: 1,
      maxConcurrentConnectionsPerIp: 2,
      actorJoinsPerMinute: 5,
      ipJoinsPerMinute: 10,
    });
    admissions.registerRoom('btc-room', 'btc');
    expect(() => admissions.registerRoom('btc-overflow', 'btc')).toThrowError('market_capacity');
    admissions.registerRoom('eth-room', 'eth');
    expect(() => admissions.registerRoom('sol-room', 'sol')).toThrowError('process_capacity');

    const first = admissions.reserve('anon_a', 'ip_a', 'btc', 1_000);
    expect(() => admissions.reserve('anon_a', 'ip_a', 'btc', 1_000))
      .toThrowError('actor_already_connected');
    admissions.activate(first, 'anon_a', 'btc', 'btc-room:one', 1_001);
    expect(() => admissions.reserve('anon_a', 'ip_a', 'eth', 1_002)).toThrowError('actor_already_connected');
    const second = admissions.reserve('anon_b', 'ip_b', 'eth', 1_003);
    admissions.activate(second, 'anon_b', 'eth', 'eth-room:two', 1_004);
    expect(() => admissions.reserve('anon_c', 'ip_c', 'eth', 1_005)).toThrowError('process_capacity');
    admissions.releaseConnection('btc-room:one');
    expect(admissions.reserve('anon_a', 'ip_a', 'btc', 1_006)).toBeTruthy();
  });

  it('reserves a room for every other market even when BTC is hot', () => {
    const admissions = new AdmissionControl({
      maxProcessConnections: 400,
      maxRooms: 18,
      maxMarketShards: 8,
      maxConcurrentConnectionsPerIp: 20,
      actorJoinsPerMinute: 12,
      ipJoinsPerMinute: 30,
    });
    for (let index = 0; index < 8; index += 1) admissions.registerRoom(`btc-${index}`, 'btc');
    for (const market of MARKET_SLUGS.filter((market) => market !== 'btc')) {
      admissions.registerRoom(`${market}-0`, market);
    }
    admissions.registerRoom('eth-1', 'eth');
    expect(admissions.snapshot().rooms).toBe(18);
    expect(() => admissions.registerRoom('sol-1', 'sol')).toThrowError('process_capacity');
  });

  it('coalesces population broadcasts to at most two per second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const directory = new PopulationDirectory();
    const publish = vi.fn();
    directory.register('btc-1', 'btc', publish);
    directory.update('btc-1', 1);
    directory.update('btc-1', 2);
    directory.update('btc-1', 3);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.at(-1)?.[0].find((entry: any) => entry.market === 'btc')).toMatchObject({ online: 3 });
    directory.clear();
  });

  it('uses explicit verified Postgres TLS policy and canonical yaw', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '2567',
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
    });
    expect(config.databaseSsl).toBe('verify-full');
    expect(config.limits).toMatchObject({
      maxProcessConnections: 400,
      maxRooms: 18,
      maxMarketShards: 8,
    });
    expect(() => loadConfig({
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'disable',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      PUBLIC_ORIGIN: 'https://tickerworld.io',
      SERVER_HMAC_SECRET: 'server-production-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
      TREASURY_ADDRESS: '11111111111111111111111111111111',
    })).toThrow(/DATABASE_SSL=verify-full/);
    expect(() => loadConfig({
      NODE_ENV: 'production',
      PORT: '2567',
      DATABASE_URL: 'postgres://user:pass@db.example/tickerworld',
      DATABASE_SSL: 'verify-full',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      PUBLIC_ORIGIN: 'https://tickerworld.io',
      SERVER_HMAC_SECRET: 'server-production-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'ip-production-secret-that-is-long-enough',
      // This is base58-shaped and long enough for the old regex, but it does
      // not decode to a 32-byte Solana public key.
      TREASURY_ADDRESS: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      ADMIN_WALLETS: '11111111111111111111111111111111',
      SOLANA_RPC_URL: 'https://rpc.example.test',
      SOL_USD_PRICE_URL: 'https://prices.example.test/sol-usd',
      ENABLE_PURCHASES: 'true',
    })).toThrow(/TREASURY_ADDRESS/);
    expect(normalizeYaw(Math.PI * 5)).toBeCloseTo(-Math.PI);
    expect(normalizeYaw(-Math.PI * 4.5)).toBeCloseTo(-Math.PI / 2);
  });
});
