import {
  CLIENT_MESSAGES,
  MARKET_SLUGS,
  PROTOCOL_VERSION,
  SESSION_REPLACED_CLOSE_CODE,
  SESSION_REPLACED_REASON,
  SERVER_MESSAGES,
  sampleBoundedTerrainHeight,
  type ChatMessage,
} from '@tickerworld/shared';
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServerApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createRuntime, type ServerRuntime } from '../src/runtime.js';
import { sha256 } from '../src/services/crypto.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = `${BASE58[Number(value % 58n)]}${encoded}`;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

describe.sequential('Colyseus market rooms', () => {
  let runtime: ServerRuntime;
  let testServer: ColyseusTestServer;

  beforeAll(async () => {
    runtime = await createRuntime(loadConfig({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      PUBLIC_ORIGIN: 'http://localhost:4173',
      SERVER_HMAC_SECRET: 'room-test-server-secret-that-is-long-enough',
      IP_HMAC_SECRET: 'room-test-ip-secret-that-is-long-enough',
      TREASURY_ADDRESS: '11111111111111111111111111111111',
      SOLANA_CLUSTER: 'devnet',
      IP_JOINS_PER_MINUTE: '200',
      MAX_CONCURRENT_PER_IP: '100',
    }));
    testServer = await boot(createServerApp(runtime));
  });

  afterAll(async () => {
    await testServer.shutdown();
    await runtime.dispose();
  });

  it('exposes health/readiness and server-minted anonymous identity', async () => {
    const health = await testServer.http.get('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.data).toMatchObject({ status: 'ok', protocolVersion: PROTOCOL_VERSION });
    const ready = await testServer.http.get('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.data).toMatchObject({
      status: 'ready',
      features: { database: true, walletAuth: true, purchases: false },
    });
    const anonymous = await testServer.http.post('/api/anonymous/session');
    expect(anonymous.statusCode).toBe(201);
    expect(anonymous.data.actorId).toMatch(/^anon_/);
    expect(anonymous.data.token).toContain('.');
    const capabilities = await testServer.http.get('/api/capabilities');
    expect(capabilities.data).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      switches: { admissions: true, chatSend: true, purchases: false },
      multiplayerAvailable: true,
      maxPlayersPerShard: 50,
      maxProcessConnections: 400,
    });
  });

  it('lets an opted-in same-actor connection replace the older seat and chat immediately', async () => {
    const identity = runtime.anonymous.issue();
    const options = {
      protocolVersion: PROTOCOL_VERSION,
      market: 'test' as const,
      animal: identity.animal,
      anonymousToken: identity.token,
      sessionTakeover: true,
    };
    const first = await testServer.sdk.joinOrCreate('market', options);
    const firstLeft = new Promise<{ code: number; reason?: string }>((resolve) => {
      first.onLeave.once((code, reason) => resolve({ code, reason }));
    });

    const replacement = await testServer.sdk.joinOrCreate('market', options);
    await expect(firstLeft).resolves.toEqual({
      code: SESSION_REPLACED_CLOSE_CODE,
      reason: SESSION_REPLACED_REASON,
    });
    const authoritativeRoom = testServer.getRoomById(replacement.roomId);
    const actorIds = [...authoritativeRoom.state.players.values()]
      .map((player: { actorId: string }) => player.actorId);
    expect(actorIds.filter((actorId: string) => actorId === identity.actorId)).toHaveLength(1);
    const occupiedSpawnSlots = (authoritativeRoom as unknown as {
      occupiedSpawnSlots: Set<number>;
    }).occupiedSpawnSlots;
    expect(occupiedSpawnSlots.size).toBe(authoritativeRoom.state.players.size);
    expect(runtime.admissions.snapshot()).toMatchObject({ activeConnections: 1 });

    const text = 'replacement chat is live';
    const echoed = new Promise<ChatMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replacement chat timed out')), 1_000);
      replacement.onMessage<ChatMessage>(SERVER_MESSAGES.chat, (message) => {
        if (message.actorId !== identity.actorId || message.text !== text) return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    replacement.send(CLIENT_MESSAGES.chat, {
      protocolVersion: PROTOCOL_VERSION,
      text,
      scope: 'world',
    });
    await expect(echoed).resolves.toMatchObject({
      actorId: identity.actorId,
      text,
      scope: 'world',
    });
    await replacement.leave();
  });

  it('invalidates a dropped actor reconnection token when a newer tab takes over', async () => {
    const identity = runtime.anonymous.issue();
    const options = {
      protocolVersion: PROTOCOL_VERSION,
      market: 'test' as const,
      animal: identity.animal,
      anonymousToken: identity.token,
      sessionTakeover: true,
    };
    const first = await testServer.sdk.joinOrCreate('market', options);
    const staleReconnectionToken = first.reconnectionToken;
    first.reconnection.enabled = false;
    const transport = first.connection.transport as unknown as { ws: { close(): void } };
    // A close without a status code is the portable browser/Node equivalent of
    // a dropped transport and enters the room's allowReconnection path.
    transport.ws.close();

    const authoritativeRoom = testServer.getRoomById(first.roomId) as unknown as {
      clients: { length: number };
      state: { players: Map<string, { actorId: string }> };
      pendingReconnections: Map<string, unknown>;
    };
    for (let attempt = 0; attempt < 50 && authoritativeRoom.pendingReconnections.size === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(authoritativeRoom.pendingReconnections.size).toBe(1);

    const replacement = await testServer.sdk.joinOrCreate('market', options);
    expect(authoritativeRoom.pendingReconnections.size).toBe(0);
    await expect(testServer.sdk.reconnect(staleReconnectionToken)).rejects.toThrow();
    expect(authoritativeRoom.clients.length).toBe(1);
    expect([...authoritativeRoom.state.players.values()]
      .filter((player) => player.actorId === identity.actorId)).toHaveLength(1);
    expect(runtime.admissions.snapshot()).toMatchObject({ activeConnections: 1 });
    await replacement.leave();
  });

  it('creates one correctly filtered room for every supported market slug', async () => {
    const rooms = [];
    for (const market of MARKET_SLUGS) {
      const identity = runtime.anonymous.issue();
      const room = await testServer.sdk.joinOrCreate('market', {
        protocolVersion: PROTOCOL_VERSION,
        market,
        animal: identity.animal,
        anonymousToken: identity.token,
      });
      room.onMessage(SERVER_MESSAGES.population, () => {});
      expect((testServer.getRoomById(room.roomId).state as { market?: string }).market).toBe(market);
      rooms.push(room);
    }
    expect(new Set(rooms.map(({ roomId }) => roomId)).size).toBe(MARKET_SLUGS.length);
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const market of MARKET_SLUGS) {
      expect(runtime.populations.snapshot().find((entry) => entry.market === market))
        .toMatchObject({ online: 1, shards: 1 });
    }
    await Promise.all(rooms.map((room) => room.leave()));
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it('replicates one monotonic day/night weather timeline to every player in a room', async () => {
    const firstIdentity = runtime.anonymous.issue();
    const secondIdentity = runtime.anonymous.issue();
    const options = {
      protocolVersion: PROTOCOL_VERSION,
      market: 'sol' as const,
      animal: firstIdentity.animal,
      anonymousToken: firstIdentity.token,
    };
    const first = await testServer.sdk.joinOrCreate('market', options);
    const second = await testServer.sdk.joinOrCreate('market', {
      ...options,
      animal: secondIdentity.animal,
      anonymousToken: secondIdentity.token,
    });
    first.onMessage(SERVER_MESSAGES.population, () => {});
    second.onMessage(SERVER_MESSAGES.population, () => {});

    await new Promise((resolve) => setTimeout(resolve, 650));
    const firstEnvironment = (first.state as unknown as { environment?: {
      elapsedSeconds?: number;
      updatedAt?: number;
      dayDurationSeconds?: number;
    } }).environment;
    const secondEnvironment = (second.state as unknown as { environment?: {
      elapsedSeconds?: number;
      updatedAt?: number;
      dayDurationSeconds?: number;
    } }).environment;
    expect(firstEnvironment).toBeDefined();
    expect(secondEnvironment).toBeDefined();
    expect(firstEnvironment).toMatchObject({ dayDurationSeconds: 18 * 60 });
    expect(secondEnvironment).toMatchObject({ dayDurationSeconds: 18 * 60 });
    expect(firstEnvironment?.elapsedSeconds).toBeGreaterThan(0.35);
    expect(secondEnvironment?.elapsedSeconds).toBeGreaterThan(0.35);
    expect(firstEnvironment?.elapsedSeconds).toBeCloseTo(secondEnvironment?.elapsedSeconds ?? -1, 2);
    expect(firstEnvironment?.updatedAt).toBeCloseTo(secondEnvironment?.updatedAt ?? -1, -2);

    // The timeline is global, not merely shared by people who happened to
    // create the same shard at the same moment. A different world receives
    // the same sky/weather phase immediately.
    const otherIdentity = runtime.anonymous.issue();
    const otherWorld = await testServer.sdk.joinOrCreate('market', {
      protocolVersion: PROTOCOL_VERSION,
      market: 'eth' as const,
      animal: otherIdentity.animal,
      anonymousToken: otherIdentity.token,
    });
    otherWorld.onMessage(SERVER_MESSAGES.population, () => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    const latestFirstEnvironment = (first.state as unknown as { environment?: {
      elapsedSeconds?: number;
    } }).environment;
    const otherEnvironment = (otherWorld.state as unknown as { environment?: {
      elapsedSeconds?: number;
    } }).environment;
    expect(otherEnvironment?.elapsedSeconds).toBeCloseTo(latestFirstEnvironment?.elapsedSeconds ?? -1, 0);

    const before = firstEnvironment?.elapsedSeconds ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 550));
    const after = (first.state as unknown as { environment?: { elapsedSeconds?: number } })
      .environment?.elapsedSeconds ?? 0;
    expect(after).toBeGreaterThan(before);
    await Promise.all([first.leave(), second.leave(), otherWorld.leave()]);
  });

  it('binds wallet authentication to the signed anonymous actor and serves the canonical account API', async () => {
    const identity = runtime.anonymous.issue();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    const publicKeyAddress = encodeBase58(publicDer.subarray(publicDer.length - 32));
    const challenge = await testServer.http.post('/api/auth/challenge', { body: {
      publicKey: publicKeyAddress,
      actorId: identity.actorId,
      anonymousToken: identity.token,
    } });
    expect(challenge.statusCode).toBe(201);
    expect(challenge.data).toMatchObject({ id: expect.any(String), message: expect.stringContaining(identity.actorId) });
    const signature = sign(null, Buffer.from(challenge.data.message), privateKey).toString('base64');
    const verified = await testServer.http.post('/api/auth/verify', { body: {
      challengeId: challenge.data.id,
      publicKey: publicKeyAddress,
      actorId: identity.actorId,
      signature,
      anonymousToken: identity.token,
    } });
    expect(verified.data).toMatchObject({
      sessionToken: expect.any(String),
      profile: { actorId: identity.actorId, selectedAnimal: identity.animal },
      blocks: [],
    });
    const authorization = { authorization: `Bearer ${verified.data.sessionToken}` };
    const account = await testServer.http.get('/api/account', { headers: authorization });
    expect(account.data.actorId).toBe(identity.actorId);
    const profile = await testServer.http.patch('/api/account/profile', {
      headers: authorization,
      body: { animal: 'cat', skin: 'base', lastMarket: 'eth' },
    });
    expect(profile.data).toMatchObject({ selectedAnimal: 'cat', lastMarket: 'eth' });
    const blockedActor = 'anon_abcdef0123456789abcdef0123456789';
    await testServer.http.put(`/api/account/blocks/${blockedActor}`, { headers: authorization });
    const blocks = await testServer.http.get('/api/account/blocks', { headers: authorization });
    expect(blocks.data).toEqual([blockedActor]);
  });

  it('packs the same market together, isolates other markets, syncs moves, and broadcasts chat', async () => {
    const firstIdentity = runtime.anonymous.issue();
    const secondIdentity = runtime.anonymous.issue();
    const thirdIdentity = runtime.anonymous.issue();
    const options = {
      protocolVersion: PROTOCOL_VERSION,
      market: 'btc' as const,
      animal: firstIdentity.animal,
      anonymousToken: firstIdentity.token,
    };
    const first = await testServer.sdk.joinOrCreate('market', options);
    first.onMessage(SERVER_MESSAGES.population, () => {});
    first.onMessage(SERVER_MESSAGES.chat, () => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((first.state as { scopedChat?: boolean }).scopedChat).toBe(true);
    const second = await testServer.sdk.joinOrCreate('market', {
      ...options,
      animal: secondIdentity.animal,
      anonymousToken: secondIdentity.token,
    });
    second.onMessage(SERVER_MESSAGES.population, () => {});
    const eth = await testServer.sdk.joinOrCreate('market', {
      ...options,
      market: 'eth',
      animal: thirdIdentity.animal,
      anonymousToken: thirdIdentity.token,
    });
    eth.onMessage(SERVER_MESSAGES.population, () => {});
    eth.onMessage(SERVER_MESSAGES.chat, () => {});
    expect(second.roomId).toBe(first.roomId);
    expect(eth.roomId).not.toBe(first.roomId);

    const localBeforeMove = [...(first.state as any).players.values()].find(
      (player: any) => player.actorId === firstIdentity.actorId,
    );
    const move = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: 1,
      sentAt: Date.now(),
      x: localBeforeMove.x + 0.2,
      y: sampleBoundedTerrainHeight(localBeforeMove.x + 0.2, localBeforeMove.z + 0.1),
      z: localBeforeMove.z + 0.1,
      yaw: 0.1,
      speed: 1,
      verticalSpeed: 0,
      grounded: true,
      gait: 'walk' as const,
    };
    first.send('move', move);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const remote = [...(second.state as any).players.values()].find(
      (player: any) => player.actorId === firstIdentity.actorId,
    );
    expect(remote).toMatchObject({ x: move.x, z: move.z, gait: 'walk' });

    const authoritative = [...(testServer.getRoomById(first.roomId).state as any).players.values()]
      .find((player: any) => player.actorId === firstIdentity.actorId);
    authoritative.x = 40;
    authoritative.z = 2;
    const checkpointCorrection = first.waitForMessage(SERVER_MESSAGES.correction);
    first.send(CLIENT_MESSAGES.parkourRespawn, {
      protocolVersion: PROTOCOL_VERSION,
      checkpointId: 'parkour-checkpoint-a',
    });
    await expect(checkpointCorrection).resolves.toMatchObject({
      x: 47,
      z: 2.2,
      reason: 'parkour',
      hard: true,
    });

    first.send(CLIENT_MESSAGES.appearance, {
      protocolVersion: PROTOCOL_VERSION,
      animal: 'fox',
      skin: 'sunrise-fox',
      username: 'MoonFox',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect([...(second.state as any).players.values()].find(
      (player: any) => player.actorId === firstIdentity.actorId,
    )).toMatchObject({ animal: 'fox', skin: 'sunrise-fox', username: 'MoonFox' });

    second.send(CLIENT_MESSAGES.appearance, {
      protocolVersion: PROTOCOL_VERSION,
      animal: 'rabbit',
      skin: 'amethyst-rabbit',
      username: 'moonfox',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect([...(first.state as any).players.values()].find(
      (player: any) => player.actorId === secondIdentity.actorId,
    )).toMatchObject({ animal: 'rabbit', skin: 'amethyst-rabbit', username: '' });

    first.send(CLIENT_MESSAGES.appearance, {
      protocolVersion: PROTOCOL_VERSION,
      animal: 'cat',
      skin: 'tide-cat',
      username: 'ab',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect([...(second.state as any).players.values()].find(
      (player: any) => player.actorId === firstIdentity.actorId,
    )).toMatchObject({ animal: 'cat', skin: 'tide-cat', username: 'MoonFox' });

    first.send(CLIENT_MESSAGES.appearance, {
      protocolVersion: PROTOCOL_VERSION,
      animal: 'saylor',
      skin: 'base',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect([...(second.state as any).players.values()].find(
      (player: any) => player.actorId === firstIdentity.actorId,
    )).toMatchObject({ animal: 'saylor', skin: 'base', username: 'MoonFox' });

    first.send(CLIENT_MESSAGES.appearance, {
      protocolVersion: PROTOCOL_VERSION,
      animal: 'saylor',
      skin: 'tide-cat',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect([...(second.state as any).players.values()].find(
      (player: any) => player.actorId === firstIdentity.actorId,
    )).toMatchObject({ animal: 'saylor', skin: 'base', username: 'MoonFox' });

    const waitingForReportRejection = first.waitForMessage(SERVER_MESSAGES.reportRejected);
    first.send(CLIENT_MESSAGES.report, {
      protocolVersion: PROTOCOL_VERSION,
      targetActorId: firstIdentity.actorId,
      reason: 'other',
    });
    await expect(waitingForReportRejection).resolves.toMatchObject({ code: 'self_report' });

    const waitingForChat = second.waitForMessage(SERVER_MESSAGES.chat);
    first.send('chat', { protocolVersion: PROTOCOL_VERSION, text: 'hello from btc' });
    await expect(waitingForChat).resolves.toMatchObject({
      actorId: firstIdentity.actorId,
      text: 'hello from btc',
    });

    const lateIdentity = runtime.anonymous.issue();
    const late = await testServer.sdk.joinOrCreate('market', {
      ...options,
      animal: lateIdentity.animal,
      anonymousToken: lateIdentity.token,
    });
    late.onMessage(SERVER_MESSAGES.population, () => {});
    await expect(late.waitForMessage(SERVER_MESSAGES.chat)).resolves.toMatchObject({
      actorId: firstIdentity.actorId,
      text: 'hello from btc',
    });

    await first.leave();
    await second.leave();
    await eth.leave();
    await late.leave();
  });

  it('accepts the immediately previous protocol during deployment skew', async () => {
    const identity = runtime.anonymous.issue();
    const room = await testServer.sdk.joinOrCreate('market', {
      protocolVersion: PROTOCOL_VERSION - 1,
      market: 'btc',
      animal: identity.animal,
      anonymousToken: identity.token,
    });
    expect(room.roomId).toBeTruthy();
    await room.leave();
  });

  it('issues same-shard invites through room and HTTP paths and relays bounded emotes', async () => {
    const hostIdentity = runtime.anonymous.issue();
    const host = await testServer.sdk.joinOrCreate('market', {
      protocolVersion: PROTOCOL_VERSION,
      market: 'sol',
      animal: hostIdentity.animal,
      anonymousToken: hostIdentity.token,
    });
    host.onMessage(SERVER_MESSAGES.population, () => {});
    host.onMessage(SERVER_MESSAGES.emote, () => {});
    const roomInvite = host.waitForMessage(SERVER_MESSAGES.partyInvite);
    host.send(CLIENT_MESSAGES.partyInviteRequest, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-room-1',
    });
    await expect(roomInvite).resolves.toMatchObject({
      requestId: 'request-room-1',
      token: expect.any(String),
      expiresAt: expect.any(Number),
    });

    await new Promise((resolve) => setTimeout(resolve, 225));
    const issued = await testServer.http.post('/api/invites', { body: {
      market: 'sol',
      roomId: host.roomId,
      anonymousToken: hostIdentity.token,
    } });
    expect(issued.statusCode).toBe(201);
    expect(issued.data).toMatchObject({ maxJoins: 12, remainingJoins: 12 });
    const redeemed = await testServer.http.post('/api/invites/redeem', {
      body: { token: issued.data.token },
    });
    expect(redeemed.data).toMatchObject({ ok: true, market: 'sol', roomId: host.roomId });

    const guestIdentity = runtime.anonymous.issue();
    const guest = await testServer.sdk.joinById(host.roomId, {
      protocolVersion: PROTOCOL_VERSION,
      market: 'sol',
      animal: guestIdentity.animal,
      anonymousToken: guestIdentity.token,
      partyToken: issued.data.token,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const partyPlayers = [...(host.state as any).players.values()];
    const hostPlayer = partyPlayers.find((player: any) => player.actorId === hostIdentity.actorId);
    const guestPlayer = partyPlayers.find((player: any) => player.actorId === guestIdentity.actorId);
    expect(Math.hypot(hostPlayer.x - guestPlayer.x, hostPlayer.z - guestPlayer.z)).toBeLessThanOrEqual(5.9);
    const emote = guest.waitForMessage(SERVER_MESSAGES.emote);
    host.send(CLIENT_MESSAGES.emote, {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'sparkle-heart',
      nonce: 'emote-1',
    });
    await expect(emote).resolves.toMatchObject({
      actorId: hostIdentity.actorId,
      kind: 'sparkle-heart',
      nonce: 'emote-1',
    });
    await host.leave();
    await guest.leave();
  });

  it('rejects unsigned identities and keeps one live connection per actor', async () => {
    await expect(testServer.sdk.joinOrCreate('market', {
      protocolVersion: PROTOCOL_VERSION - 1,
      market: 'btc',
      actorId: `player_${'a'.repeat(20)}`,
      animal: 'fox',
    })).rejects.toThrow();

    const identity = runtime.anonymous.issue();
    const options = {
      protocolVersion: PROTOCOL_VERSION,
      market: 'btc' as const,
      animal: identity.animal,
      anonymousToken: identity.token,
    };
    const first = await testServer.sdk.joinOrCreate('market', options);
    await expect(testServer.sdk.joinOrCreate('market', { ...options, market: 'eth' }))
      .rejects.toThrow();
    await first.leave();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const rejoined = await testServer.sdk.joinOrCreate('market', options);
    await rejoined.leave();
  });

  it('refreshes wallet and anonymous identity presentation without reconnecting', async () => {
    const identity = runtime.anonymous.issue();
    const now = Date.now();
    const accountId = `account_refresh_${now}`;
    const sessionToken = `refresh_${'s'.repeat(48)}`;
    await runtime.db.insertInto('accounts').values({
      id: accountId,
      wallet_address: '33333333333333333333333333333333',
      actor_id: identity.actorId,
      username: 'GlowFox',
      username_normalized: 'glowfox',
      selected_animal: 'cat',
      selected_skin: 'base',
      last_market: 'btc',
      created_at: now,
      updated_at: now,
    }).execute();
    await runtime.db.insertInto('auth_sessions').values({
      id: `session_refresh_${now}`,
      account_id: accountId,
      token_hash: sha256(sessionToken),
      expires_at: now + 60_000,
      revoked_at: null,
      created_at: now,
    }).execute();
    const room = await testServer.sdk.joinOrCreate('market', {
      protocolVersion: PROTOCOL_VERSION,
      market: 'btc',
      animal: identity.animal,
      anonymousToken: identity.token,
    });
    const upgraded = room.waitForMessage(SERVER_MESSAGES.identityRefreshed);
    room.send(CLIENT_MESSAGES.identityRefresh, { protocolVersion: PROTOCOL_VERSION, sessionToken });
    await expect(upgraded).resolves.toMatchObject({
      actorId: identity.actorId,
      username: 'GlowFox',
      animal: 'cat',
      walletConnected: true,
    });
    const downgraded = room.waitForMessage(SERVER_MESSAGES.identityRefreshed);
    room.send(CLIENT_MESSAGES.identityRefresh, {
      protocolVersion: PROTOCOL_VERSION,
      anonymousToken: identity.token,
    });
    await expect(downgraded).resolves.toMatchObject({
      actorId: identity.actorId,
      username: null,
      animal: identity.animal,
      skin: 'base',
      walletConnected: false,
    });
    await room.leave();
  });

  it('fills overflow shards and accepts canonical reports for world chat across channels', async () => {
    const participants = [];
    for (let index = 0; index < 75; index += 1) {
      const identity = runtime.anonymous.issue();
      const room = await testServer.sdk.joinOrCreate('market', {
        protocolVersion: PROTOCOL_VERSION,
        market: 'avax',
        animal: identity.animal,
        anonymousToken: identity.token,
      });
      room.onMessage(SERVER_MESSAGES.population, () => {});
      room.onMessage(SERVER_MESSAGES.chat, () => {});
      participants.push({ room, identity });
    }
    const clients = participants.map(({ room }) => room);
    const roomIds = new Set(clients.map((client) => client.roomId));
    expect(roomIds.size).toBe(2);
    const shardSizes = [...roomIds]
      .map((roomId) => testServer.getRoomById(roomId).clients.length)
      .sort((a, b) => b - a);
    expect(shardSizes).toEqual([50, 25]);

    const reporter = participants[0]!;
    const target = participants.find(({ room }) => room.roomId !== reporter.room.roomId)!;
    const crossChannelChat = reporter.room.waitForMessage(SERVER_MESSAGES.chat);
    target.room.send(CLIENT_MESSAGES.chat, {
      protocolVersion: PROTOCOL_VERSION,
      text: 'canonical cross-channel evidence',
      scope: 'world',
    });
    await expect(crossChannelChat).resolves.toMatchObject({
      actorId: target.identity.actorId,
      text: 'canonical cross-channel evidence',
      scope: 'world',
    });
    const reportAccepted = reporter.room.waitForMessage(SERVER_MESSAGES.reportAccepted);
    reporter.room.send(CLIENT_MESSAGES.report, {
      protocolVersion: PROTOCOL_VERSION,
      targetActorId: target.identity.actorId,
      reason: 'other',
    });
    const accepted = await reportAccepted as { reportId: string };
    const storedReport = await runtime.db.selectFrom('moderation_reports')
      .selectAll()
      .where('id', '=', accepted.reportId)
      .executeTakeFirstOrThrow();
    expect(storedReport.target_actor_id).toBe(target.identity.actorId);
    expect(JSON.parse(storedReport.evidence_json)).toEqual([
      expect.objectContaining({
        actorId: target.identity.actorId,
        text: 'canonical cross-channel evidence',
        scope: 'world',
      }),
    ]);
    for (const roomId of roomIds) {
      const room = testServer.getRoomById(roomId);
      const positions = [...(room.state as any).players.values()]
        .map((player: any) => `${player.x.toFixed(4)}:${player.z.toFixed(4)}`);
      expect(new Set(positions).size).toBe(positions.length);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runtime.populations.snapshot().find((entry) => entry.market === 'avax')).toMatchObject({
      online: 75,
      shards: 2,
    });
    await Promise.all(clients.map((client) => client.leave()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.populations.snapshot().find((entry) => entry.market === 'avax')).toMatchObject({
      online: 0,
      shards: 0,
    });
  }, 30_000);

  it('returns a typed 429 and retry window for anonymous identity abuse', async () => {
    // One identity was issued by the first test; fill the rest of the configured hourly window.
    for (let index = 1; index < runtime.config.limits.anonymousSessionsPerMinute; index += 1) {
      expect((await testServer.http.post('/api/anonymous/session')).statusCode).toBe(201);
    }
    let rejection: any;
    try {
      await testServer.http.post('/api/anonymous/session');
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ statusCode: 429 });
    expect(rejection.data).toMatchObject({ error: 'anonymous_session_rate_limited' });
    expect(Number(rejection.headers['retry-after'])).toBeGreaterThan(0);
  });
});
