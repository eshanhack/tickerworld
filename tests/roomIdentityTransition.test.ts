import { CLIENT_MESSAGES, SERVER_MESSAGES, type AccountProfile } from '../shared/src/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomClientSystem } from '../src/net';

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
  readonly state: { players: Map<string, ReturnType<typeof player>> };
  readonly reconnection = { enabled: false, minDelay: 0, maxDelay: 0 };
  readonly sent: Array<{ type: string; payload: unknown }> = [];
  readonly leave = vi.fn(async () => undefined);
  readonly removeAllListeners = vi.fn();
  private readonly messages = new Map<string, (payload: any) => void>();

  constructor(actorId: string, animal: 'fox' | 'rabbit' = 'fox') {
    this.state = { players: new Map([['local', player(actorId, animal)]]) };
  }

  onStateChange(_listener: (state: unknown) => void): () => void { return () => undefined; }
  onMessage(type: string, listener: (payload: any) => void): () => void {
    this.messages.set(type, listener);
    return () => undefined;
  }
  onDrop(_listener: () => void): () => void { return () => undefined; }
  onReconnect(_listener: () => void): () => void { return () => undefined; }
  onError(_listener: () => void): () => void { return () => undefined; }
  onLeave(_listener: () => void): () => void { return () => undefined; }
  send(type: string, payload: unknown): void { this.sent.push({ type, payload }); }
  emit(type: string, payload: unknown): void { this.messages.get(type)?.(payload); }
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
  rooms: Array<FakeRoom | Promise<FakeRoom>>,
  onIdentityChanged = vi.fn(),
  joinTimeoutMs = 8_000,
) {
  const joinOrCreate = vi.fn(async () => {
    const room = rooms.shift();
    if (!room) throw new Error('No fake room queued.');
    return await room;
  });
  const system = new RoomClientSystem({
    endpoint: 'ws://multiplayer.test',
    anonymousIdentity: anonymous,
    snapshot: () => ({
      x: 0, y: 0, z: 0, yaw: 0, speed: 0, verticalSpeed: 0, grounded: true, gait: 'idle',
    }),
    clientFactory: () => ({ joinOrCreate } as any),
    joinTimeoutMs,
    onIdentityChanged,
  });
  return { system, joinOrCreate, onIdentityChanged };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('RoomClientSystem identity transitions', () => {
  afterEach(() => vi.useRealTimers());

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

    const refreshedProfile = { ...accountProfile('anon-a'), username: 'SameSeat' };
    const profileRefresh = system.setAccountSession('paid-session', refreshedProfile);
    await flushMicrotasks();
    expect(joinOrCreate).toHaveBeenCalledTimes(1);
    expect(room.leave).not.toHaveBeenCalled();
    room.emit(SERVER_MESSAGES.identityRefreshed, {
      actorId: 'anon-a', username: 'SameSeat', animal: 'rabbit', skin: 'base', walletConnected: true,
    });
    await expect(profileRefresh).resolves.toBe(true);

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
});
