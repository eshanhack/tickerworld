import {
  CLIENT_MESSAGES,
  MARKET_SLUGS,
  SESSION_REPLACED_CLOSE_CODE,
  SESSION_REPLACED_REASON,
  SERVER_MESSAGES,
  type AccountProfile,
} from '../shared/src/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RoomClientSystem,
  parseRoomPopulations,
  type RoomClientSystemOptions,
} from '../src/net';
import {
  EMOTE_CLIENT_MESSAGE,
  EMOTE_SERVER_MESSAGE,
} from '../src/social';
import {
  PARTY_CLIENT_INVITE_REQUEST,
  PARTY_SERVER_INVITE,
} from '../src/share';

function player(actorId: string, animal: 'fox' | 'rabbit' = 'fox') {
  return {
    actorId,
    x: 1,
    y: 0,
    z: 2,
    yaw: 0,
    speed: 0,
    verticalSpeed: 0,
    grounded: true,
    gait: 'idle',
    animal,
    skin: 'base',
    username: '',
    updatedAt: 1,
  };
}

class FakeRoom {
  readonly roomId: string;
  readonly state: {
    players: Map<string, ReturnType<typeof player>>;
    scopedChat?: boolean;
    environment?: {
      elapsedSeconds: number;
      updatedAt: number;
      dayDurationSeconds: number;
    };
  };
  readonly reconnection = { enabled: false, minDelay: 0, maxDelay: 0 };
  readonly sent: Array<{ type: string; payload: unknown }> = [];
  readonly leave = vi.fn(async () => undefined);
  private readonly messages = new Map<string, (payload: any) => void>();
  private dropListener: (() => void) | null = null;
  private reconnectListener: (() => void) | null = null;
  private leaveListener: ((code: number, reason?: string) => void) | null = null;
  readonly removeAllListeners = vi.fn(() => this.messages.clear());

  constructor(
    actorId: string,
    animal: 'fox' | 'rabbit' = 'fox',
    environment?: {
      elapsedSeconds: number;
      updatedAt: number;
      dayDurationSeconds: number;
    },
    roomId = 'room-default',
    scopedChat = false,
  ) {
    this.roomId = roomId;
    this.state = {
      players: new Map([['local', player(actorId, animal)]]),
      ...(scopedChat ? { scopedChat: true } : {}),
      ...(environment ? { environment } : {}),
    };
  }

  onStateChange(_listener: (state: unknown) => void): () => void { return () => undefined; }
  onMessage(type: string, listener: (payload: any) => void): () => void {
    this.messages.set(type, listener);
    return () => undefined;
  }
  onDrop(listener: () => void): () => void {
    this.dropListener = listener;
    return () => { this.dropListener = null; };
  }
  onReconnect(listener: () => void): () => void {
    this.reconnectListener = listener;
    return () => { this.reconnectListener = null; };
  }
  onError(_listener: () => void): () => void { return () => undefined; }
  onLeave(listener: (code: number, reason?: string) => void): () => void {
    this.leaveListener = listener;
    return () => { this.leaveListener = null; };
  }
  send(type: string, payload: unknown): void { this.sent.push({ type, payload }); }
  emit(type: string, payload: unknown): void { this.messages.get(type)?.(payload); }
  drop(): void { this.dropListener?.(); }
  reconnect(): void { this.reconnectListener?.(); }
  leaveFromServer(code: number, reason?: string): void { this.leaveListener?.(code, reason); }
}

const anonymous = {
  actorId: 'anon-a',
  animal: 'fox' as const,
  token: 'signed-anonymous-a',
  expiresAt: Date.now() + 60_000,
};

function accountProfile(actorId: string): AccountProfile {
  return {
    id: `account-${actorId}`,
    actorId,
    username: null,
    selectedAnimal: 'rabbit',
    selectedSkin: 'base',
    entitlements: [],
    lastMarket: 'btc',
  };
}

function createSystem(
  rooms: Array<FakeRoom | Promise<FakeRoom> | Error>,
  onIdentityChanged = vi.fn(),
  joinTimeoutMs = 8_000,
  extra: Partial<RoomClientSystemOptions> = {},
) {
  const nextRoom = async () => {
    const room = rooms.shift();
    if (!room) throw new Error('No fake room queued.');
    if (room instanceof Error) throw room;
    return await room;
  };
  const joinOrCreate = vi.fn(nextRoom);
  const joinById = vi.fn(nextRoom);
  const system = new RoomClientSystem({
    ...extra,
    endpoint: 'ws://multiplayer.test',
    anonymousIdentity: anonymous,
    snapshot: () => ({
      x: 0, y: 0, z: 0, yaw: 0, speed: 0, verticalSpeed: 0, grounded: true, gait: 'idle',
    }),
    clientFactory: () => ({ joinOrCreate, joinById } as any),
    joinTimeoutMs,
    onIdentityChanged,
  });
  return { system, joinOrCreate, joinById, onIdentityChanged };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('RoomClientSystem identity transitions', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the complete free appearance and explicit display-name clearing', async () => {
    const room = new FakeRoom('anon-a');
    const { system } = createSystem([room]);
    expect(system.setAppearance('cat', 'tide-cat', 'Magic_Cat')).toBe(false);
    await expect(system.connect('btc')).resolves.toBe(true);
    expect(system.setAppearance('cat', 'tide-cat', 'Magic_Cat')).toBe(true);
    expect(system.setAppearance('fox', 'sunrise-fox', null)).toBe(true);
    expect(room.sent.slice(-2)).toEqual([
      {
        type: CLIENT_MESSAGES.appearance,
        payload: {
          protocolVersion: 2,
          animal: 'cat',
          skin: 'tide-cat',
          username: 'Magic_Cat',
        },
      },
      {
        type: CLIENT_MESSAGES.appearance,
        payload: {
          protocolVersion: 2,
          animal: 'fox',
          skin: 'sunrise-fox',
          username: null,
        },
      },
    ]);
    system.dispose();
  });

  it('queues world chat across a brief room drop and flushes it after reconnect', async () => {
    const room = new FakeRoom('anon-a');
    const { system } = createSystem([room]);
    await expect(system.connect('btc')).resolves.toBe(true);

    room.drop();
    expect(system.state.connection).toBe('reconnecting');
    expect(system.sendChat('wait for me', 'world')).toBe(true);
    expect(room.sent.filter(({ type }) => type === CLIENT_MESSAGES.chat)).toHaveLength(0);

    room.reconnect();
    expect(system.state.connection).toBe('online');
    expect(room.sent.at(-1)).toEqual({
      type: CLIENT_MESSAGES.chat,
      payload: {
        protocolVersion: 2,
        text: 'wait for me',
      },
    });
    system.dispose();
  });

  it('does not steal a displaced seat back automatically and reconnects on an explicit chat', async () => {
    vi.useFakeTimers();
    const room = new FakeRoom('anon-a');
    const replacement = new FakeRoom('anon-a');
    const { system, joinOrCreate } = createSystem([room, replacement]);
    await expect(system.connect('btc')).resolves.toBe(true);

    room.leaveFromServer(SESSION_REPLACED_CLOSE_CODE, SESSION_REPLACED_REASON);
    expect(system.state).toMatchObject({
      connection: 'offline',
      lastError: SESSION_REPLACED_REASON,
      currentRoomId: null,
    });

    // An ordinary retry would have fired after roughly one second. Five
    // seconds proves the terminal handoff stays parked without expiring the
    // short-lived identity used by this focused test.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(joinOrCreate).toHaveBeenCalledTimes(1);

    expect(system.sendChat('use chat in this tab', 'world')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(system.state.connection).toBe('online');
    expect(joinOrCreate).toHaveBeenCalledTimes(2);
    expect(replacement.sent.at(-1)).toEqual({
      type: CLIENT_MESSAGES.chat,
      payload: {
        protocolVersion: 2,
        text: 'use chat in this tab',
      },
    });
    system.dispose();
  });

  it('keeps an old protocol-v2 room on world chat when no capability handshake arrives', async () => {
    const room = new FakeRoom('anon-a');
    const { system } = createSystem([room]);
    await expect(system.connect('btc')).resolves.toBe(true);

    expect(system.state.scopedChatAvailable).toBe(false);
    expect(system.sendChat('legacy world hello', 'world')).toBe(true);
    expect(system.sendChat('must not leak as unscoped', 'proximity')).toBe(false);
    expect(room.sent.filter(({ type }) => type === CLIENT_MESSAGES.chat)).toEqual([{
      type: CLIENT_MESSAGES.chat,
      payload: { protocolVersion: 2, text: 'legacy world hello' },
    }]);
    system.dispose();
  });

  it('enables and transmits proximity only after a valid room capability handshake', async () => {
    const room = new FakeRoom('anon-a', 'fox', undefined, 'room-default', true);
    const legacyNextRoom = new FakeRoom('anon-a', 'fox', undefined, 'room-legacy-next');
    const { system } = createSystem([room, legacyNextRoom]);
    await expect(system.connect('btc')).resolves.toBe(true);

    expect(system.state.scopedChatAvailable).toBe(true);
    expect(system.sendChat('nearby hello', 'proximity')).toBe(true);
    expect(room.sent.at(-1)).toEqual({
      type: CLIENT_MESSAGES.chat,
      payload: { protocolVersion: 2, text: 'nearby hello', scope: 'proximity' },
    });

    await expect(system.switchMarket('eth')).resolves.toBe(true);
    expect(system.state.scopedChatAvailable).toBe(false);
    expect(system.sendChat('not confirmed here', 'proximity')).toBe(false);
    expect(system.sendChat('world remains compatible', 'world')).toBe(true);
    expect(legacyNextRoom.sent.at(-1)).toEqual({
      type: CLIENT_MESSAGES.chat,
      payload: { protocolVersion: 2, text: 'world remains compatible' },
    });
    system.dispose();
  });

  it('fails proximity chat closed during a drop so stale positions cannot receive it', async () => {
    const room = new FakeRoom('anon-a', 'fox', undefined, 'room-default', true);
    const { system } = createSystem([room]);
    await expect(system.connect('btc')).resolves.toBe(true);
    expect(system.state.scopedChatAvailable).toBe(true);

    room.drop();
    expect(system.sendChat('can anyone nearby hear me?', 'proximity')).toBe(false);
    room.reconnect();

    expect(room.sent.filter(({ type }) => type === CLIENT_MESSAGES.chat)).toHaveLength(0);
    system.dispose();
  });

  it('drops queued world chat instead of carrying it into another market', async () => {
    const btcRoom = new FakeRoom('anon-a', 'fox', undefined, 'room-btc');
    const ethRoom = new FakeRoom('anon-a', 'fox', undefined, 'room-eth');
    const { system } = createSystem([btcRoom, ethRoom]);
    await expect(system.connect('btc')).resolves.toBe(true);

    btcRoom.drop();
    expect(system.sendChat('btc-only thought', 'world')).toBe(true);
    await expect(system.switchMarket('eth')).resolves.toBe(true);

    expect(ethRoom.sent).toHaveLength(0);
    system.dispose();
  });

  it('uses the room-owned environment timeline while retaining a solo fallback', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const firstRoom = new FakeRoom('anon-a', 'fox', {
      elapsedSeconds: 420,
      updatedAt: 1_700_000_000_000,
      dayDurationSeconds: 18 * 60,
    });
    const secondRoom = new FakeRoom('anon-a', 'fox', {
      elapsedSeconds: 3,
      updatedAt: 1_700_000_010_000,
      dayDurationSeconds: 18 * 60,
    });
    const { system } = createSystem([firstRoom, secondRoom]);
    // No server clock has reached the browser yet, so an offline game retains
    // its existing session-relative timeline.
    expect(system.getWorldElapsedSeconds(12)).toBe(12);
    await system.connect('btc');
    expect(system.state.environment).toMatchObject({ elapsedSeconds: 420 });
    now.mockReturnValue(10_750);
    expect(system.getWorldElapsedSeconds(12)).toBeCloseTo(420.75, 8);

    await system.switchMarket('eth');
    expect(system.state.environment).toMatchObject({ elapsedSeconds: 3 });
    now.mockReturnValue(11_250);
    expect(system.getWorldElapsedSeconds(12)).toBeCloseTo(3.5, 8);
    system.dispose();
    now.mockRestore();
  });

  it('joins every supported ticker through the same market-filtered room contract', async () => {
    const rooms = MARKET_SLUGS.map(() => new FakeRoom('anon-a'));
    const { system, joinOrCreate } = createSystem([...rooms]);
    await expect(system.connect(MARKET_SLUGS[0])).resolves.toBe(true);
    for (const market of MARKET_SLUGS.slice(1)) {
      await expect(system.switchMarket(market)).resolves.toBe(true);
      expect(system.state).toMatchObject({ connection: 'online', market });
    }
    expect(joinOrCreate).toHaveBeenCalledTimes(MARKET_SLUGS.length);
    expect((joinOrCreate.mock.calls as unknown[][]).map((call) => (
      (call[1] as { market: string }).market
    ))).toEqual(MARKET_SLUGS);
    system.dispose();
  });

  it('accepts truthful bounded population snapshots for all worlds and ignores malformed counts', async () => {
    const room = new FakeRoom('anon-a');
    const { system } = createSystem([room]);
    await system.connect('btc');
    const updates = MARKET_SLUGS.map((market, index) => ({
      market,
      online: index,
      shards: index === 0 ? 0 : 1,
      channels: index === 0 ? [] : [{
        roomId: `room-${market}`,
        channel: 1,
        online: index,
        capacity: 50,
      }],
      updatedAt: 1_000,
    }));
    room.emit(SERVER_MESSAGES.population, [
      ...updates,
      { market: 'bogus', online: 99, shards: 1, updatedAt: 1_000 },
      { market: 'eth', online: -2, shards: 1, updatedAt: 1_000 },
    ]);
    expect([...system.state.populations.keys()]).toEqual(MARKET_SLUGS);
    for (const [index, market] of MARKET_SLUGS.entries()) {
      expect(system.state.populations.get(market)?.online).toBe(index);
    }
    expect(parseRoomPopulations({ market: 'btc', online: Number.NaN, shards: 1, updatedAt: 1_000 }))
      .toEqual([]);
    expect(parseRoomPopulations({ market: 'btc', online: 51, shards: 1, updatedAt: 1_000 }))
      .toEqual([]);
    expect(parseRoomPopulations({
      market: 'btc',
      online: 2,
      shards: 1,
      channels: [{ roomId: 'btc-1', channel: 1, online: 1, capacity: 50 }],
      updatedAt: 1_000,
    })).toEqual([]);
    expect(system.state.totalOnline).toBe(updates.reduce((sum, update) => sum + update.online, 0));
    system.dispose();
  });

  it('exposes exact channel members and joins a requested channel with a full-room fallback', async () => {
    const selected = new FakeRoom('anon-a', 'fox', undefined, 'eth-channel-2');
    selected.state.players.set('remote', {
      ...player('remote-b', 'rabbit'),
      username: 'MapleRabbit',
    });
    const exact = createSystem([selected]);
    await expect(exact.system.switchChannel('eth', 'eth-channel-2')).resolves.toEqual({
      status: 'joined',
      market: 'eth',
      requestedRoomId: 'eth-channel-2',
      roomId: 'eth-channel-2',
    });
    expect(exact.joinById).toHaveBeenCalledWith(
      'eth-channel-2',
      expect.objectContaining({ market: 'eth' }),
    );
    expect(exact.system.state).toMatchObject({
      currentRoomId: 'eth-channel-2',
      channelOnline: 2,
    });
    expect(exact.system.state.members.map(({ username }) => username)).toContain('MapleRabbit');
    exact.system.dispose();

    const fallbackRoom = new FakeRoom('anon-a', 'fox', undefined, 'eth-channel-3');
    const fallback = createSystem([new Error('room is full'), fallbackRoom]);
    await expect(fallback.system.switchChannel('eth', 'eth-channel-2')).resolves.toEqual({
      status: 'fallback',
      market: 'eth',
      requestedRoomId: 'eth-channel-2',
      roomId: 'eth-channel-3',
    });
    expect(fallback.joinById).toHaveBeenCalledTimes(1);
    expect(fallback.joinOrCreate).toHaveBeenCalledTimes(1);
    fallback.system.dispose();
  });

  it('keeps every destination playable offline when no room endpoint is configured', async () => {
    const clientFactory = vi.fn();
    const system = new RoomClientSystem({
      endpoint: '',
      anonymousIdentity: anonymous,
      snapshot: () => ({
        x: 0, y: 0, z: 0, yaw: 0, speed: 0, verticalSpeed: 0, grounded: true, gait: 'idle',
      }),
      clientFactory,
    });
    for (const market of MARKET_SLUGS) {
      await expect(system.connect(market)).resolves.toBe(false);
      expect(system.state).toMatchObject({ connection: 'offline', market });
    }
    expect(clientFactory).not.toHaveBeenCalled();
    system.dispose();
  });

  it('falls back offline when the canonical identity preflight is blackholed', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const clientFactory = vi.fn();
    const system = new RoomClientSystem({
      endpoint: 'wss://multiplayer.tickerworld.io',
      fetch: fetch as typeof globalThis.fetch,
      joinTimeoutMs: 8,
      snapshot: () => ({
        x: 0, y: 0, z: 0, yaw: 0, speed: 0, verticalSpeed: 0, grounded: true, gait: 'idle',
      }),
      clientFactory,
    });
    const connecting = system.connect('wti');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(8);
    await expect(connecting).resolves.toBe(false);
    expect(system.state).toMatchObject({
      connection: 'offline',
      market: 'wti',
      lastError: 'Multiplayer request timed out after 8ms.',
    });
    expect(clientFactory).not.toHaveBeenCalled();
    system.dispose();
  });

  it('restores anonymous credentials before reapplying the saved look after reconnect', async () => {
    const room = new FakeRoom('anon-a');
    const { system } = createSystem([room]);
    await system.connect('btc');
    let restoreAppearance = false;
    system.subscribe((snapshot) => {
      if (restoreAppearance && snapshot.connection === 'online') {
        system.setAppearance('cat', 'tide-cat', 'Magic_Cat');
      }
    });

    restoreAppearance = true;
    room.drop();
    room.reconnect();

    expect(room.sent.slice(-2).map(({ type }) => type)).toEqual([
      CLIENT_MESSAGES.identityRefresh,
      CLIENT_MESSAGES.appearance,
    ]);
    expect(room.sent.at(-1)?.payload).toMatchObject({
      animal: 'cat', skin: 'tide-cat', username: 'Magic_Cat',
    });
    system.dispose();
  });

  it('awaits a same-actor refresh without leaving or teleporting', async () => {
    const room = new FakeRoom('anon-a');
    const { system, joinOrCreate, onIdentityChanged } = createSystem([room]);
    await expect(system.connect('btc')).resolves.toBe(true);

    let settled = false;
    const transition = system.setAccountSession('paid-session', accountProfile('anon-a'))
      .then((value) => { settled = true; return value; });
    await flushMicrotasks();

    expect(settled).toBe(false);
    expect(joinOrCreate).toHaveBeenCalledTimes(1);
    expect(room.leave).not.toHaveBeenCalled();
    expect(room.sent.map(({ type }) => type)).toEqual([CLIENT_MESSAGES.identityRefresh]);
    expect(onIdentityChanged).toHaveBeenCalledTimes(1);

    room.emit(SERVER_MESSAGES.identityRefreshed, {
      actorId: 'anon-a', username: null, animal: 'rabbit', skin: 'base', walletConnected: true,
    });
    await expect(transition).resolves.toBe(true);
    expect(system.identity).toMatchObject({ actorId: 'anon-a', animal: 'rabbit' });
    expect(onIdentityChanged).toHaveBeenCalledTimes(2);
    expect(onIdentityChanged.mock.calls.at(-1)?.[0]).toMatchObject({
      actorId: 'anon-a', animal: 'rabbit', skin: 'base', username: null,
    });

    const refreshedProfile = { ...accountProfile('anon-a'), username: 'SameSeat' };
    const profileRefresh = system.setAccountSession('paid-session', refreshedProfile);
    await flushMicrotasks();
    expect(joinOrCreate).toHaveBeenCalledTimes(1);
    expect(room.leave).not.toHaveBeenCalled();
    room.emit(SERVER_MESSAGES.identityRefreshed, {
      actorId: 'anon-a', username: 'SameSeat', animal: 'rabbit', skin: 'base', walletConnected: true,
    });
    await expect(profileRefresh).resolves.toBe(true);
    expect(onIdentityChanged.mock.calls.at(-1)?.[0]).toMatchObject({
      actorId: 'anon-a', animal: 'rabbit', skin: 'base', username: 'SameSeat',
    });

    const logout = system.setAccountSession(null, null);
    await flushMicrotasks();
    expect(joinOrCreate).toHaveBeenCalledTimes(1);
    expect(room.leave).not.toHaveBeenCalled();
    room.emit(SERVER_MESSAGES.identityRefreshed, {
      actorId: 'anon-a', username: null, animal: 'fox', skin: 'base', walletConnected: false,
    });
    await expect(logout).resolves.toBe(true);
    expect(system.identity).toMatchObject({ actorId: 'anon-a', animal: 'fox' });
    system.dispose();
  });

  it('publishes a different actor only after rejoin and removes it again on logout', async () => {
    const anonymousRoom = new FakeRoom('anon-a');
    const paidRoom = new FakeRoom('account-b', 'rabbit');
    let resolvePaidRoom!: (room: FakeRoom) => void;
    const paidJoin = new Promise<FakeRoom>((resolve) => { resolvePaidRoom = resolve; });
    const anonymousReturnRoom = new FakeRoom('anon-a');
    const { system, joinOrCreate, onIdentityChanged } = createSystem([
      anonymousRoom,
      paidJoin,
      anonymousReturnRoom,
    ]);
    await system.connect('btc');

    let settled = false;
    const login = system.setAccountSession('returning-session', accountProfile('account-b'))
      .then((value) => { settled = true; return value; });
    await flushMicrotasks();
    expect(anonymousRoom.leave).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(onIdentityChanged.mock.calls.at(-1)?.[0].actorId).toBe('anon-a');
    expect(anonymousRoom.sent).toHaveLength(0);

    resolvePaidRoom(paidRoom);
    await expect(login).resolves.toBe(true);
    expect(joinOrCreate).toHaveBeenCalledTimes(2);
    expect(system.identity.actorId).toBe('account-b');
    expect(system.state.remotes).toHaveLength(0);
    expect(onIdentityChanged.mock.calls.at(-1)?.[0].actorId).toBe('account-b');

    await expect(system.setAccountSession(null, null)).resolves.toBe(true);
    expect(paidRoom.leave).toHaveBeenCalledTimes(1);
    expect(paidRoom.sent).toHaveLength(0);
    expect(joinOrCreate).toHaveBeenCalledTimes(3);
    expect(system.identity).toMatchObject({ actorId: 'anon-a', animal: 'fox' });
    expect(system.state.remotes).toHaveLength(0);
    system.dispose();
  });

  it('fails offline when matchmaking is blackholed', async () => {
    vi.useFakeTimers();
    const blackhole = new Promise<FakeRoom>(() => undefined);
    const { system } = createSystem([blackhole], vi.fn(), 8);

    const connection = system.connect('btc');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(8);

    await expect(connection).resolves.toBe(false);
    expect(system.state.connection).toBe('offline');
    expect(system.state.lastError).toContain('Matchmaking timed out');
    system.dispose();
  });

  it('leaves a room that resolves after the matchmaking deadline', async () => {
    vi.useFakeTimers();
    let resolveRoom!: (room: FakeRoom) => void;
    const delayedRoom = new Promise<FakeRoom>((resolve) => { resolveRoom = resolve; });
    const lateRoom = new FakeRoom('anon-a');
    const { system } = createSystem([delayedRoom], vi.fn(), 8);

    const connection = system.connect('btc');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(8);
    await expect(connection).resolves.toBe(false);

    resolveRoom(lateRoom);
    await flushMicrotasks();
    expect(lateRoom.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(lateRoom.leave).toHaveBeenCalledWith(true);
    system.dispose();
  });

  it('sends typed emotes and resolves same-shard invite replies', async () => {
    const room = new FakeRoom('anon-a');
    const onEmote = vi.fn();
    const { system } = createSystem([room], vi.fn(), 8_000, { onEmote, random: () => 0.25 });
    await system.connect('btc');

    const nonce = system.sendEmote('sparkle-heart');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    expect(system.sendEmote('wave')).toBeNull();
    expect(room.sent.at(-1)).toMatchObject({
      type: EMOTE_CLIENT_MESSAGE,
      payload: { protocolVersion: 2, kind: 'sparkle-heart', nonce },
    });
    room.emit(EMOTE_SERVER_MESSAGE, {
      protocolVersion: 2,
      actorId: 'remote-b',
      kind: 'wave',
      nonce: 'server_123',
      sentAt: 1_000,
    });
    expect(onEmote).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'remote-b', kind: 'wave' }));

    const invitePromise = system.requestPartyInvite();
    const request = room.sent.find(({ type }) => type === PARTY_CLIENT_INVITE_REQUEST)!;
    const requestId = (request.payload as { requestId: string }).requestId;
    room.emit(PARTY_SERVER_INVITE, { requestId, token: 'party_123456', expiresAt: Date.now() + 60_000 });
    await expect(invitePromise).resolves.toMatchObject({ requestId, token: 'party_123456' });
    expect(system.requestParkourRespawn('parkour-checkpoint-a')).toBe(true);
    expect(room.sent.at(-1)).toEqual({
      type: CLIENT_MESSAGES.parkourRespawn,
      payload: { protocolVersion: 2, checkpointId: 'parkour-checkpoint-a' },
    });
    system.dispose();
  });

  it('falls back truthfully to a normal shard when an invited shard is full', async () => {
    const normalRoom = new FakeRoom('anon-a');
    const onPartyJoinStatus = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, code: 'party_full', fallbackMarket: 'btc',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { system, joinOrCreate, joinById } = createSystem(
      [normalRoom],
      vi.fn(),
      8_000,
      { partyToken: 'party_123456', onPartyJoinStatus, fetch },
    );

    await expect(system.connect('btc')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://multiplayer.test/api/invites/redeem', expect.objectContaining({ method: 'POST' }));
    expect(joinById).not.toHaveBeenCalled();
    expect(joinOrCreate).toHaveBeenCalledTimes(1);
    expect((joinOrCreate.mock.calls as unknown[][])[0]?.[1]).not.toHaveProperty('partyToken');
    expect(onPartyJoinStatus).toHaveBeenCalledWith({
      status: 'full', token: 'party_123456', fallback: 'normal-shard',
    });
    expect(system.state.connection).toBe('online');
    system.dispose();
  });

  it('redeems a party hash token and joins the exact shard by id', async () => {
    const partyRoom = new FakeRoom('anon-a');
    const onPartyJoinStatus = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, market: 'btc', roomId: 'btc-shard-party', expiresAt: Date.now() + 60_000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { system, joinOrCreate, joinById } = createSystem(
      [partyRoom], vi.fn(), 8_000, { partyToken: 'party_123456', onPartyJoinStatus, fetch },
    );

    await expect(system.connect('btc')).resolves.toBe(true);
    expect(joinOrCreate).not.toHaveBeenCalled();
    expect(joinById).toHaveBeenCalledWith(
      'btc-shard-party',
      expect.objectContaining({ partyToken: 'party_123456', market: 'btc' }),
    );
    expect(onPartyJoinStatus).toHaveBeenCalledWith({ status: 'joined', token: 'party_123456' });
    system.dispose();
  });

  it('relays bounded market snapshots and detaches old-room handlers on transfer', async () => {
    const firstRoom = new FakeRoom('anon-a');
    const secondRoom = new FakeRoom('anon-a');
    const { system } = createSystem([firstRoom, secondRoom]);
    const onMarket = vi.fn();
    const onMids = vi.fn();
    const order: string[] = [];
    system.subscribeMarket((state) => { order.push('market'); onMarket(state); });
    system.subscribeMarketMids((mids) => { order.push('mids'); onMids(mids); });
    await system.connect('btc');

    const state = {
      instrument: 'BTC', candles: [], candle: null, price: 64_000,
      upstreamAt: 1, publishedAt: 2, ageMs: 1, stale: false,
    } as const;
    const instruments = [
      'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'LINK', 'AVAX', 'WTI', 'TEST',
      'PUMP', 'ANSEM', 'SHFL',
    ] as const;
    const mids = instruments.map((instrument, index) => ({
      instrument,
      price: 64_000 + index,
      upstreamAt: 1,
    }));
    firstRoom.emit(SERVER_MESSAGES.market, state);
    firstRoom.emit(SERVER_MESSAGES.marketMids, mids);
    expect(order).toEqual(['mids', 'market']);
    expect(onMarket).toHaveBeenCalledWith(state);
    expect(onMids).toHaveBeenCalledWith(mids.filter(({ instrument }) => instrument !== 'TEST'));

    await system.switchMarket('eth');
    firstRoom.emit(SERVER_MESSAGES.market, { ...state, price: 1 });
    expect(onMarket).toHaveBeenCalledTimes(1);
    secondRoom.emit(SERVER_MESSAGES.market, { ...state, instrument: 'ETH', price: 3_200 });
    secondRoom.emit(SERVER_MESSAGES.marketMids, []);
    expect(onMarket).toHaveBeenCalledTimes(2);
    system.dispose();
  });

  it('ignores old-room social and market packets as soon as a transfer starts', async () => {
    const firstRoom = new FakeRoom('anon-a');
    const secondRoom = new FakeRoom('anon-a');
    let acknowledgeLeave!: () => void;
    firstRoom.leave.mockImplementation(() => new Promise<undefined>((resolve) => {
      acknowledgeLeave = () => resolve(undefined);
    }));
    const onEmote = vi.fn();
    const { system } = createSystem([firstRoom, secondRoom], vi.fn(), 8_000, { onEmote });
    const onChat = vi.fn();
    const onMarket = vi.fn();
    system.subscribeChat(onChat);
    system.subscribeMarket(onMarket);
    await system.connect('btc');

    const transfer = system.switchMarket('eth');
    await flushMicrotasks();
    firstRoom.emit(SERVER_MESSAGES.chat, { actorId: 'remote-b', text: 'old room' });
    firstRoom.emit(EMOTE_SERVER_MESSAGE, {
      protocolVersion: 2,
      actorId: 'remote-b',
      kind: 'wave',
      nonce: 'old_room_1',
      sentAt: 1_000,
    });
    firstRoom.emit(SERVER_MESSAGES.market, {
      instrument: 'BTC', candles: [], candle: null, price: 64_000,
      upstreamAt: 1, publishedAt: 2, ageMs: 1, stale: false,
    });
    firstRoom.emit(SERVER_MESSAGES.marketMids, []);
    expect(onChat).not.toHaveBeenCalled();
    expect(onEmote).not.toHaveBeenCalled();
    expect(onMarket).not.toHaveBeenCalled();

    acknowledgeLeave();
    await expect(transfer).resolves.toBe(true);
    expect(system.sessionRoomEpoch).toBe(2);
    system.dispose();
  });

  it('flushes a relay state after a bounded wait when its mids packet is missing', async () => {
    vi.useFakeTimers();
    const room = new FakeRoom('anon-a');
    const { system } = createSystem([room]);
    const onMarket = vi.fn();
    system.subscribeMarket(onMarket);
    await system.connect('btc');
    room.emit(SERVER_MESSAGES.market, {
      instrument: 'BTC', candles: [], candle: null, price: 64_000,
      upstreamAt: 1, publishedAt: 2, ageMs: 1, stale: false,
    });
    expect(onMarket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(onMarket).toHaveBeenCalledTimes(1);
    system.dispose();
  });
});
