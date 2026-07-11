import { Client, type Room } from '@colyseus/sdk';
import {
  CLIENT_MESSAGES,
  MARKET_ROOM_NAME,
  MOVE_SEND_RATE_HZ,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  type AnimalKind,
  type AccountProfile,
  type AppearanceMessage,
  type ChatMessage,
  type ChatRejection,
  type ChatSendMessage,
  type CorrectionMessage,
  type IdentityRefreshMessage,
  type IdentityRefreshResult,
  type IdentityRejection,
  type JoinOptions,
  type MarketSlug,
  type ModerationReason,
  type MoveSnapshot,
  type NetPlayerState,
  type ReportSendMessage,
  type ReportRejection,
  type RoomConnectionState,
  type RoomPopulation,
  type SkinId,
} from '../../shared/src/index.js';
import type { GameSystem } from '../types';
import {
  readGuestIdentity,
  readSignedGuestIdentity,
  writeSignedGuestIdentity,
  type GuestIdentity,
  type SignedGuestIdentity,
} from './identity';

type RoomStateShape = {
  readonly players?: {
    forEach?: (callback: (player: unknown, key: string) => void) => void;
  };
};

export interface LocalNetworkSnapshot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly speed: number;
  readonly verticalSpeed: number;
  readonly grounded: boolean;
  readonly gait: MoveSnapshot['gait'];
}

export interface RoomClientSnapshot {
  readonly connection: RoomConnectionState;
  readonly market: MarketSlug;
  readonly remotes: readonly NetPlayerState[];
  readonly populations: ReadonlyMap<MarketSlug, RoomPopulation>;
  readonly lastError: string | null;
}

export interface RoomClientSystemOptions {
  readonly endpoint?: string;
  readonly apiEndpoint?: string;
  readonly identity?: GuestIdentity;
  readonly anonymousIdentity?: SignedGuestIdentity;
  readonly fetch?: typeof fetch;
  /** Test seam; production uses the Colyseus SDK client directly. */
  readonly clientFactory?: (endpoint: string) => Pick<Client, 'joinOrCreate'>;
  /** Bounds a blackholed matchmaking request. Defaults to eight seconds. */
  readonly joinTimeoutMs?: number;
  readonly snapshot: () => LocalNetworkSnapshot;
  readonly onCorrection?: (correction: CorrectionMessage) => void;
  readonly onSpawn?: (market: MarketSlug, player: NetPlayerState) => void;
  readonly onChat?: (message: ChatMessage) => void;
  readonly onChatRejected?: (rejection: ChatRejection) => void;
  readonly onReportAccepted?: () => void;
  readonly onReportRejected?: (rejection: ReportRejection) => void;
  readonly onIdentityRefreshRejected?: (rejection: IdentityRejection) => void;
  readonly onIdentityChanged?: (identity: GuestIdentity) => void;
  readonly random?: () => number;
}

type SnapshotListener = (snapshot: RoomClientSnapshot) => void;
type ChatListener = (message: ChatMessage) => void;
type ChatRejectionListener = (rejection: ChatRejection) => void;
type ReportAcceptedListener = () => void;
type ReportRejectionListener = (rejection: ReportRejection) => void;

const EMPTY_POPULATIONS = new Map<MarketSlug, RoomPopulation>();

export interface AccountRoomSession {
  readonly token: string;
  readonly profile: AccountProfile;
}

export type IdentityTransitionMode = 'refresh' | 'rejoin';

/** Same-actor credential/profile changes are safe in place; actor swaps are not. */
export function classifyIdentityTransition(
  boundActorId: string | null,
  targetActorId: string,
): IdentityTransitionMode {
  return boundActorId && boundActorId !== targetActorId ? 'rejoin' : 'refresh';
}

interface PendingIdentityRefresh {
  readonly session: AccountRoomSession | null;
  readonly actorId: string;
  readonly resolve: (accepted: boolean) => void;
  readonly timer: number;
}

interface JoinIdentityOptions {
  readonly session: AccountRoomSession | null;
  readonly retryOnFailure?: boolean;
  readonly publishIdentity?: boolean;
}

export function createRoomJoinOptions(
  market: MarketSlug,
  anonymousIdentity: SignedGuestIdentity | null,
  accountSession: AccountRoomSession | null,
  fromMarket?: MarketSlug,
): JoinOptions {
  const travel = fromMarket && fromMarket !== market ? { fromMarket } : {};
  if (accountSession) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      market,
      animal: accountSession.profile.selectedAnimal,
      skin: accountSession.profile.selectedSkin,
      sessionToken: accountSession.token,
      ...travel,
    };
  }
  if (!anonymousIdentity) throw new Error('A signed anonymous identity is required.');
  return {
    protocolVersion: PROTOCOL_VERSION,
    market,
    animal: anonymousIdentity.animal,
    skin: 'base',
    anonymousToken: anonymousIdentity.token,
    ...travel,
  };
}

export function createIdentityRefreshMessage(
  accountSession: AccountRoomSession | null,
  anonymousIdentity: SignedGuestIdentity | null,
): IdentityRefreshMessage | null {
  if (accountSession) {
    return { protocolVersion: PROTOCOL_VERSION, sessionToken: accountSession.token };
  }
  if (anonymousIdentity) {
    return { protocolVersion: PROTOCOL_VERSION, anonymousToken: anonymousIdentity.token };
  }
  return null;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function parseRemote(value: unknown): NetPlayerState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const actorId = stringValue(source.actorId);
  if (!actorId) return null;
  return {
    actorId,
    x: finite(source.x),
    y: finite(source.y),
    z: finite(source.z),
    yaw: finite(source.yaw),
    speed: Math.max(0, finite(source.speed)),
    verticalSpeed: finite(source.verticalSpeed),
    grounded: source.grounded !== false,
    gait: ['idle', 'walk', 'run', 'air', 'glide'].includes(stringValue(source.gait))
      ? source.gait as NetPlayerState['gait']
      : 'idle',
    animal: stringValue(source.animal, 'fox') as AnimalKind,
    skin: stringValue(source.skin, 'base') as SkinId,
    username: typeof source.username === 'string' && source.username ? source.username : null,
    updatedAt: finite(source.updatedAt, Date.now()),
  };
}

export class RoomClientSystem implements GameSystem {
  private readonly fallbackIdentity: GuestIdentity;
  private readonly endpoint: string;
  private readonly apiEndpoint: string;
  private readonly requestFetch: typeof fetch;
  private readonly snapshotProvider: () => LocalNetworkSnapshot;
  private readonly options: RoomClientSystemOptions;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly chatListeners = new Set<ChatListener>();
  private readonly chatRejectionListeners = new Set<ChatRejectionListener>();
  private readonly reportAcceptedListeners = new Set<ReportAcceptedListener>();
  private readonly reportRejectionListeners = new Set<ReportRejectionListener>();
  private readonly populations = new Map<MarketSlug, RoomPopulation>();
  private readonly random: () => number;
  private readonly clientFactory: (endpoint: string) => Pick<Client, 'joinOrCreate'>;
  private readonly joinTimeoutMs: number;
  private client: Pick<Client, 'joinOrCreate'> | null = null;
  private room: Room | null = null;
  private market: MarketSlug = 'btc';
  private connection: RoomConnectionState = 'offline';
  private remotes: NetPlayerState[] = [];
  private lastError: string | null = null;
  private sendAccumulator = 0;
  private sequence = 0;
  private retryAttempt = 0;
  private retryTimer: number | undefined;
  private generation = 0;
  private visible = true;
  private disposed = false;
  private anonymousIdentity: SignedGuestIdentity | null;
  private accountSession: AccountRoomSession | null = null;
  private boundActorId: string | null = null;
  private pendingIdentityRefresh: PendingIdentityRefresh | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private joinFromMarket: MarketSlug | undefined;
  private authoritativeSpawnReceived = false;

  constructor(options: RoomClientSystemOptions) {
    this.options = options;
    this.fallbackIdentity = options.identity ?? readGuestIdentity();
    this.anonymousIdentity = options.anonymousIdentity ?? readSignedGuestIdentity();
    this.endpoint = (options.endpoint ?? import.meta.env.VITE_MULTIPLAYER_URL ?? '').trim();
    this.apiEndpoint = normalizeApiEndpoint(options.apiEndpoint ?? this.endpoint);
    // Calling Window.fetch as an object method supplies the wrong receiver in
    // some browsers. Keep the native function in a lexical wrapper.
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.clientFactory = options.clientFactory ?? ((endpoint) => new Client(endpoint));
    this.joinTimeoutMs = Number.isFinite(options.joinTimeoutMs) && Number(options.joinTimeoutMs) > 0
      ? Math.max(1, Number(options.joinTimeoutMs))
      : 8_000;
    this.snapshotProvider = options.snapshot;
    this.random = options.random ?? Math.random;
  }

  get state(): RoomClientSnapshot {
    return {
      connection: this.connection,
      market: this.market,
      remotes: this.remotes,
      populations: this.populations.size > 0 ? new Map(this.populations) : EMPTY_POPULATIONS,
      lastError: this.lastError,
    };
  }

  get identity(): GuestIdentity {
    if (this.accountSession) {
      return {
        actorId: this.accountSession.profile.actorId,
        animal: this.accountSession.profile.selectedAnimal,
      };
    }
    return this.anonymousIdentity ?? this.fallbackIdentity;
  }

  /** Signed server identity used to bind wallet auth to the visible anonymous actor. */
  get anonymousToken(): string | null {
    return this.anonymousIdentity?.token ?? null;
  }

  get sessionToken(): string | null {
    return this.accountSession?.token ?? null;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  subscribeChat(listener: ChatListener): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  subscribeChatRejected(listener: ChatRejectionListener): () => void {
    this.chatRejectionListeners.add(listener);
    return () => this.chatRejectionListeners.delete(listener);
  }

  subscribeReportAccepted(listener: ReportAcceptedListener): () => void {
    this.reportAcceptedListeners.add(listener);
    return () => this.reportAcceptedListeners.delete(listener);
  }

  subscribeReportRejected(listener: ReportRejectionListener): () => void {
    this.reportRejectionListeners.add(listener);
    return () => this.reportRejectionListeners.delete(listener);
  }

  connect(market: MarketSlug): Promise<boolean> {
    return this.enqueueOperation(() => this.connectInternal(market));
  }

  private async connectInternal(market: MarketSlug): Promise<boolean> {
    if (this.disposed) return false;
    this.market = market;
    this.joinFromMarket = undefined;
    this.authoritativeSpawnReceived = false;
    this.retryAttempt = 0;
    this.clearRetry();
    return this.join(++this.generation);
  }

  switchMarket(market: MarketSlug): Promise<boolean> {
    return this.enqueueOperation(() => this.switchMarketInternal(market));
  }

  private async switchMarketInternal(market: MarketSlug): Promise<boolean> {
    if (this.disposed) return false;
    const fromMarket = this.market;
    this.market = market;
    this.joinFromMarket = fromMarket === market ? undefined : fromMarket;
    this.authoritativeSpawnReceived = false;
    const generation = ++this.generation;
    this.clearRetry();
    await this.leaveRoom();
    this.remotes = [];
    this.emit();
    return this.join(generation);
  }

  setAccountSession(token: string | null, profile: AccountProfile | null): Promise<boolean> {
    return this.enqueueOperation(() => this.setAccountSessionInternal(token, profile));
  }

  private async setAccountSessionInternal(
    token: string | null,
    profile: AccountProfile | null,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const targetSession = token && profile ? { token, profile } : null;
    if (!targetSession) {
      if (!this.accountSession) return this.connection === 'online' || !this.room;
      await this.ensureAnonymousIdentity();
    }

    const targetIdentity = this.identityForSession(targetSession);
    const transitionMode = classifyIdentityTransition(this.boundActorId, targetIdentity.actorId);
    if (this.room && transitionMode === 'rejoin') {
      return this.rejoinForIdentity(targetSession, targetIdentity);
    }

    if (!this.room) {
      this.commitAccountSession(targetSession, targetIdentity);
      return true;
    }

    const refreshed = await this.refreshIdentityInPlace(targetSession, targetIdentity.actorId);
    if (refreshed) return true;
    // Logging out must remove wallet-only presentation even if an in-place
    // refresh is rejected or interrupted. A same-actor rejoin keeps the seat's
    // deterministic spawn while guaranteeing the old paid room state is gone.
    if (!targetSession) return this.rejoinForIdentity(targetSession, targetIdentity);
    return false;
  }

  update(deltaSeconds: number): void {
    if (this.disposed
      || !this.visible
      || this.connection !== 'online'
      || !this.room
      || !this.authoritativeSpawnReceived) return;
    this.sendAccumulator += Math.max(0, deltaSeconds);
    const interval = 1 / MOVE_SEND_RATE_HZ;
    if (this.sendAccumulator < interval) return;
    this.sendAccumulator %= interval;
    const local = this.snapshotProvider();
    const move: MoveSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: ++this.sequence,
      sentAt: Date.now(),
      ...local,
    };
    this.room.send(CLIENT_MESSAGES.move, move);
  }

  sendChat(text: string): boolean {
    if (!this.room || this.connection !== 'online') return false;
    const message: ChatSendMessage = { protocolVersion: PROTOCOL_VERSION, text };
    this.room.send(CLIENT_MESSAGES.chat, message);
    return true;
  }

  report(targetActorId: string, reason: ModerationReason, note?: string): boolean {
    if (!this.room || this.connection !== 'online') return false;
    const message: ReportSendMessage = {
      protocolVersion: PROTOCOL_VERSION,
      targetActorId,
      reason,
      ...(note ? { note } : {}),
    };
    this.room.send(CLIENT_MESSAGES.report, message);
    return true;
  }

  setAppearance(animal: AnimalKind, skin: SkinId = 'base'): boolean {
    if (!this.room || this.connection !== 'online') return false;
    const message: AppearanceMessage = { protocolVersion: PROTOCOL_VERSION, animal, skin };
    this.room.send(CLIENT_MESSAGES.appearance, message);
    return true;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.sendAccumulator = 0;
    else if (this.connection === 'offline' && this.endpoint) this.scheduleRetry(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearRetry();
    this.finishIdentityRefresh(false);
    this.listeners.clear();
    this.chatListeners.clear();
    this.chatRejectionListeners.clear();
    this.reportAcceptedListeners.clear();
    this.reportRejectionListeners.clear();
    void this.leaveRoom();
    this.client = null;
    this.remotes = [];
    this.populations.clear();
  }

  private async join(
    generation: number,
    identityOptions?: JoinIdentityOptions,
  ): Promise<boolean> {
    if (!this.endpoint) {
      this.setConnection('offline', 'Multiplayer is not configured yet.');
      return false;
    }
    this.setConnection(this.retryAttempt > 0 ? 'reconnecting' : 'connecting', null);
    this.authoritativeSpawnReceived = false;
    try {
      const session = identityOptions ? identityOptions.session : this.accountSession;
      if (!session) await this.ensureAnonymousIdentity();
      const targetIdentity = this.identityForSession(session);
      this.client ??= this.clientFactory(this.endpoint);
      const options = createRoomJoinOptions(
        this.market,
        this.anonymousIdentity,
        session,
        this.joinFromMarket,
      );
      const room = await this.joinRoomWithTimeout(
        this.client.joinOrCreate(MARKET_ROOM_NAME, options),
      );
      if (this.disposed || generation !== this.generation) {
        await room.leave(true);
        return false;
      }
      this.room = room;
      this.boundActorId = targetIdentity.actorId;
      this.joinFromMarket = undefined;
      this.retryAttempt = 0;
      room.reconnection.enabled = true;
      // A process restart invalidates the old room id, so long SDK retries only
      // delay the client's normal join-or-create fallback. Try the same seat a
      // few times for brief network drops, then create/join a healthy shard.
      room.reconnection.maxRetries = 3;
      room.reconnection.minDelay = 500;
      room.reconnection.maxDelay = 2_000;
      room.onStateChange((state: RoomStateShape) => this.acceptState(state));
      this.acceptState(room.state as RoomStateShape);
      room.onMessage<CorrectionMessage>(SERVER_MESSAGES.correction, (message) => this.options.onCorrection?.(message));
      room.onMessage<ChatMessage>(SERVER_MESSAGES.chat, (message) => {
        this.options.onChat?.(message);
        for (const listener of this.chatListeners) listener(message);
      });
      room.onMessage<ChatRejection>(SERVER_MESSAGES.chatRejected, (message) => {
        this.options.onChatRejected?.(message);
        for (const listener of this.chatRejectionListeners) listener(message);
      });
      room.onMessage<RoomPopulation | readonly RoomPopulation[]>(SERVER_MESSAGES.population, (message) => {
        const updates = Array.isArray(message) ? message : [message];
        for (const update of updates) this.populations.set(update.market, update);
        this.emit();
      });
      room.onMessage(SERVER_MESSAGES.reportAccepted, () => {
        this.options.onReportAccepted?.();
        for (const listener of this.reportAcceptedListeners) listener();
      });
      room.onMessage<ReportRejection>(SERVER_MESSAGES.reportRejected, (rejection) => {
        this.options.onReportRejected?.(rejection);
        for (const listener of this.reportRejectionListeners) listener(rejection);
      });
      room.onMessage<IdentityRefreshResult>(SERVER_MESSAGES.identityRefreshed, (identity) => {
        const pending = this.pendingIdentityRefresh;
        if (!pending || identity.actorId !== pending.actorId) return;
        const acceptedSession = pending.session;
        this.finishIdentityRefresh(true);
        this.commitAccountSession(acceptedSession, {
          actorId: identity.actorId,
          animal: identity.animal,
        });
      });
      room.onMessage<IdentityRejection>(SERVER_MESSAGES.identityRejected, (rejection) => {
        this.lastError = `Identity refresh rejected: ${rejection.code}`;
        this.finishIdentityRefresh(false);
        this.options.onIdentityRefreshRejected?.(rejection);
        this.emit();
      });
      room.onMessage(SERVER_MESSAGES.protocolRejected, () => {
        this.setConnection('incompatible', 'Multiplayer is updating. Solo mode is still available.');
      });
      room.onDrop(() => this.setConnection('reconnecting', null));
      room.onReconnect(() => {
        this.setConnection('online', null);
        this.sendIdentityRefresh(this.pendingIdentityRefresh?.session ?? this.accountSession);
      });
      room.onError((_code, message) => {
        if (message) this.lastError = message;
      });
      room.onLeave(() => {
        if (room !== this.room || this.disposed || generation !== this.generation) return;
        this.room = null;
        this.boundActorId = null;
        this.remotes = [];
        this.finishIdentityRefresh(false);
        this.setConnection('offline', this.lastError ?? 'Room connection lost.');
        this.scheduleRetry();
      });
      this.setConnection('online', null);
      if (identityOptions?.publishIdentity !== false) {
        this.options.onIdentityChanged?.(targetIdentity);
      }
      return true;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return false;
      const message = error instanceof Error ? error.message : 'Room server unavailable.';
      this.setConnection('offline', message);
      if (identityOptions?.retryOnFailure !== false) this.scheduleRetry();
      return false;
    }
  }

  private acceptState(state: RoomStateShape): void {
    const next: NetPlayerState[] = [];
    state.players?.forEach?.((value) => {
      const parsed = parseRemote(value);
      if (!parsed) return;
      if (parsed.actorId === this.boundActorId) {
        if (!this.authoritativeSpawnReceived) {
          this.authoritativeSpawnReceived = true;
          this.options.onSpawn?.(this.market, parsed);
        }
        return;
      }
      next.push(parsed);
    });
    this.remotes = next;
    this.emit();
  }

  private sendIdentityRefresh(session: AccountRoomSession | null): boolean {
    const room = this.room;
    if (!room || this.connection !== 'online') return false;
    const message = createIdentityRefreshMessage(session, this.anonymousIdentity);
    if (!message) return false;
    room.send(CLIENT_MESSAGES.identityRefresh, message);
    return true;
  }

  private async ensureAnonymousIdentity(): Promise<void> {
    const cached = this.anonymousIdentity ?? readSignedGuestIdentity();
    if (cached && cached.expiresAt > Date.now() + 5_000) {
      this.anonymousIdentity = cached;
      return;
    }
    if (!this.apiEndpoint) throw new Error('Multiplayer identity service is not configured.');
    const response = await this.requestFetch(`${this.apiEndpoint}/api/anonymous/session`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null) as Partial<SignedGuestIdentity> | null;
    if (!response.ok
      || !payload
      || typeof payload.actorId !== 'string'
      || typeof payload.token !== 'string'
      || typeof payload.expiresAt !== 'number'
      || !['fox', 'penguin', 'frog', 'duck', 'bear', 'rabbit', 'cat', 'axolotl'].includes(String(payload.animal))) {
      throw new Error('Could not establish a safe anonymous multiplayer identity.');
    }
    this.anonymousIdentity = {
      actorId: payload.actorId,
      animal: payload.animal as AnimalKind,
      token: payload.token,
      expiresAt: payload.expiresAt,
    };
    writeSignedGuestIdentity(this.anonymousIdentity);
  }

  private async joinRoomWithTimeout(roomRequest: Promise<Room>): Promise<Room> {
    let timedOut = false;
    let timer: number | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = Number(globalThis.setTimeout(() => {
        timedOut = true;
        reject(new Error(`Matchmaking timed out after ${this.joinTimeoutMs}ms.`));
      }, this.joinTimeoutMs));
    });

    // The SDK request cannot currently be aborted. If it resolves after the
    // deadline, leave that detached room immediately so it cannot consume a
    // server seat or retain transport resources.
    void roomRequest.then((lateRoom) => {
      if (!timedOut) return;
      lateRoom.removeAllListeners();
      void lateRoom.leave(true).catch(() => undefined);
    }, () => undefined);

    try {
      return await Promise.race([roomRequest, timeout]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }

  private identityForSession(session: AccountRoomSession | null): GuestIdentity {
    if (session) {
      return {
        actorId: session.profile.actorId,
        animal: session.profile.selectedAnimal,
      };
    }
    return this.anonymousIdentity ?? this.fallbackIdentity;
  }

  private commitAccountSession(
    session: AccountRoomSession | null,
    identity = this.identityForSession(session),
  ): void {
    this.accountSession = session;
    this.options.onIdentityChanged?.(identity);
  }

  private async rejoinForIdentity(
    session: AccountRoomSession | null,
    identity: GuestIdentity,
  ): Promise<boolean> {
    this.clearRetry();
    this.joinFromMarket = undefined;
    this.authoritativeSpawnReceived = false;
    const generation = ++this.generation;
    await this.leaveRoom();
    this.remotes = [];
    this.emit();

    const joined = await this.join(generation, {
      session,
      retryOnFailure: false,
      publishIdentity: false,
    });
    if (this.disposed || generation !== this.generation) return false;
    if (joined) {
      this.commitAccountSession(session, identity);
      return true;
    }

    // Once logout has left the paid room, its wallet-only identity is gone even
    // if the anonymous room is temporarily unavailable. Commit anonymous local
    // state and let the normal reconnect path restore presence later.
    if (!session) {
      this.commitAccountSession(null, identity);
      this.scheduleRetry();
      return true;
    }

    // A failed paid activation never becomes the committed identity. Retry the
    // previously committed anonymous/account session instead.
    this.scheduleRetry();
    return false;
  }

  private refreshIdentityInPlace(
    session: AccountRoomSession | null,
    actorId: string,
  ): Promise<boolean> {
    this.finishIdentityRefresh(false);
    return new Promise<boolean>((resolve) => {
      const timer = globalThis.setTimeout(() => this.finishIdentityRefresh(false), 5_000);
      this.pendingIdentityRefresh = {
        session,
        actorId,
        resolve,
        timer: Number(timer),
      };
      // A temporarily dropped room keeps the transition pending. onReconnect
      // sends the candidate credential; a missing room fails closed.
      if (!this.sendIdentityRefresh(session) && !this.room) this.finishIdentityRefresh(false);
    });
  }

  private finishIdentityRefresh(accepted: boolean): void {
    const pending = this.pendingIdentityRefresh;
    if (!pending) return;
    this.pendingIdentityRefresh = null;
    globalThis.clearTimeout(pending.timer);
    pending.resolve(accepted);
  }

  private async leaveRoom(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.boundActorId = null;
    this.finishIdentityRefresh(false);
    if (!room) return;
    // Intentional transfers must never enter the SDK's automatic reconnect
    // loop. Keep listeners until the leave acknowledgement arrives: leave()
    // itself resolves through onLeave, and removing them first can strand the
    // transfer veil indefinitely on real WebSockets.
    room.reconnection.enabled = false;
    try {
      const acknowledged = await Promise.race([
        room.leave(true).then(() => true),
        new Promise<false>((resolve) => globalThis.setTimeout(() => resolve(false), 1_500)),
      ]);
      if (!acknowledged) void room.leave(false).catch(() => undefined);
    } catch {
      // Closing a half-open socket is best effort during transfer/disposal.
    } finally {
      room.removeAllListeners();
    }
  }

  private scheduleRetry(delay?: number): void {
    if (this.disposed || !this.visible || !this.endpoint || this.retryTimer !== undefined) return;
    const attempt = this.retryAttempt++;
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(5, attempt));
    const jittered = delay ?? base * (0.78 + this.random() * 0.44);
    const generation = this.generation;
    this.retryTimer = Number(globalThis.setTimeout(() => {
      this.retryTimer = undefined;
      void this.enqueueOperation(() => this.join(generation));
    }, jittered));
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private setConnection(connection: RoomConnectionState, error: string | null): void {
    this.connection = connection;
    this.lastError = error;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeApiEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed, typeof location === 'undefined' ? 'http://localhost' : location.href);
    url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/$/, '');
  }
}
