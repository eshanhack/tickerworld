import { Client, type Room } from '@colyseus/sdk';
import {
  ASSET_SYMBOLS,
  CLIENT_MESSAGES,
  MARKET_ROOM_NAME,
  MARKET_ROOM_MAX_CLIENTS,
  MOVE_SEND_RATE_HZ,
  PROTOCOL_VERSION,
  SESSION_REPLACED_CLOSE_CODE,
  SESSION_REPLACED_REASON,
  SERVER_MESSAGES,
  type AnimalKind,
  type AccountProfile,
  type AppearanceMessage,
  type ChatMessage,
  type ChatRejection,
  type ChatScope,
  type ChatSendMessage,
  type CorrectionMessage,
  type IdentityRefreshMessage,
  type IdentityRefreshResult,
  type IdentityRejection,
  type JoinOptions,
  type MarketSlug,
  type CompactMarketMid,
  type RelayedMarketState,
  type ModerationReason,
  type MoveSnapshot,
  type NetPlayerState,
  type ReportSendMessage,
  type ReportRejection,
  type RoomChannelPopulation,
  type RoomConnectionState,
  type RoomPopulation,
  type SharedWorldEnvironment,
  type PartyJoinResult,
  type ParkourCheckpointId,
  type ParkourRespawnMessage,
  type SkinId,
  isAnimalKind,
  isMarketSlug,
  isProtocolVersionAccepted,
} from '../../shared/src/index.js';
import type { GameSystem } from '../types';
import {
  EMOTE_CLIENT_MESSAGE,
  EMOTE_SERVER_MESSAGE,
  EmoteRateGate,
  createEmoteNonce,
  parseServerEmote,
  type EmoteKind,
  type ServerEmoteMessage,
} from '../social/emotes';
import {
  PARTY_CLIENT_INVITE_REQUEST,
  PARTY_SERVER_INVITE,
  isPartyToken,
  parsePartyInvite,
  partyFailureFromError,
  type PartyInvite,
  type PartyJoinStatus,
} from '../share/party';
import {
  clearSignedGuestIdentity,
  readGuestIdentity,
  readSignedGuestIdentity,
  writeSignedGuestIdentity,
  type GuestIdentity,
  type SignedGuestIdentity,
} from './identity';
import { resolveMultiplayerEndpoint } from './RuntimeCapabilitiesClient';

const LIVE_MARKET_SYMBOLS = new Set<string>(ASSET_SYMBOLS.filter((symbol) => symbol !== 'TEST'));
const MAX_QUEUED_CHAT_MESSAGES = 12;

interface QueuedChatMessage {
  readonly market: MarketSlug;
  readonly text: string;
  readonly scope: ChatScope;
}

function boundRelayedMarketMids(value: unknown): CompactMarketMid[] {
  if (!Array.isArray(value)) return [];
  const bounded: CompactMarketMid[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const mid = candidate as Partial<CompactMarketMid>;
    if (
      typeof mid.instrument !== 'string'
      || !LIVE_MARKET_SYMBOLS.has(mid.instrument)
      || seen.has(mid.instrument)
      || typeof mid.price !== 'number'
      || !Number.isFinite(mid.price)
      || mid.price <= 0
      || typeof mid.upstreamAt !== 'number'
      || !Number.isFinite(mid.upstreamAt)
    ) continue;
    seen.add(mid.instrument);
    bounded.push(mid as CompactMarketMid);
    if (bounded.length >= LIVE_MARKET_SYMBOLS.size) break;
  }
  return bounded;
}

type RoomMatchClient = Pick<Client, 'joinOrCreate' | 'joinById'>;

type RoomStateShape = {
  /** Absent on the pre-scoped-chat protocol-v2 room schema. */
  readonly scopedChat?: unknown;
  readonly environment?: unknown;
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
  readonly movementState?: MoveSnapshot['movementState'];
  readonly gaitPhase?: number;
  readonly movementBlend?: number;
  readonly runBlend?: number;
  readonly airProgress?: number;
  readonly simulationTick?: number;
}

export interface RoomClientSnapshot {
  readonly connection: RoomConnectionState;
  readonly market: MarketSlug;
  readonly remotes: readonly NetPlayerState[];
  /** Every player in the current channel, including the local player. */
  readonly members: readonly NetPlayerState[];
  readonly populations: ReadonlyMap<MarketSlug, RoomPopulation>;
  readonly currentRoomId: string | null;
  readonly currentChannel: RoomChannelPopulation | null;
  readonly totalOnline: number;
  /** Aggregate across every channel of the active tickerworld. */
  readonly marketOnline: number;
  /** Exact replicated membership of the channel currently being rendered. */
  readonly channelOnline: number;
  /** False until this exact room positively confirms scoped-chat support. */
  readonly scopedChatAvailable: boolean;
  /** Null until an authoritative room clock arrives; reconnecting clients stay local. */
  readonly environment: SharedWorldEnvironment | null;
  readonly lastError: string | null;
}

export type ChannelJoinResult =
  | {
    readonly status: 'joined' | 'fallback';
    readonly market: MarketSlug;
    readonly requestedRoomId: string;
    readonly roomId: string;
  }
  | {
    readonly status: 'offline';
    readonly market: MarketSlug;
    readonly requestedRoomId: string;
    readonly roomId: null;
  };

export interface RoomClientSystemOptions {
  readonly endpoint?: string;
  readonly apiEndpoint?: string;
  readonly identity?: GuestIdentity;
  readonly anonymousIdentity?: SignedGuestIdentity;
  readonly fetch?: typeof fetch;
  /** Test seam; production uses the Colyseus SDK client directly. */
  readonly clientFactory?: (endpoint: string) => RoomMatchClient;
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
  readonly onEmote?: (event: ServerEmoteMessage) => void;
  readonly onPartyJoinStatus?: (status: PartyJoinStatus) => void;
  readonly partyToken?: string | null;
  readonly random?: () => number;
}

type SnapshotListener = (snapshot: RoomClientSnapshot) => void;
type ChatListener = (message: ChatMessage) => void;
type ChatRejectionListener = (rejection: ChatRejection) => void;
type ReportAcceptedListener = () => void;
type ReportRejectionListener = (rejection: ReportRejection) => void;
type MarketRelayListener = (state: RelayedMarketState) => void;
type MarketMidsListener = (mids: readonly CompactMarketMid[]) => void;

const EMPTY_POPULATIONS = new Map<MarketSlug, RoomPopulation>();

function isPublicRoomId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isUnavailableChannelError(error: unknown): boolean {
  const source = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : null;
  if (source?.code === 522 || source?.code === '522') return true;
  const message = typeof source?.message === 'string'
    ? source.message
    : typeof error === 'string' ? error : '';
  return /room.+(?:full|not found|unavailable|invalid)|(?:full|invalid).+room/i.test(message);
}

export function parseRoomChannels(value: unknown): readonly RoomChannelPopulation[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const channels: RoomChannelPopulation[] = [];
  const roomIds = new Set<string>();
  const numbers = new Set<number>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const channel = candidate as Partial<RoomChannelPopulation>;
    if (!isPublicRoomId(channel.roomId)
      || roomIds.has(channel.roomId)
      || !Number.isSafeInteger(channel.channel)
      || Number(channel.channel) < 1
      || Number(channel.channel) > 64
      || numbers.has(Number(channel.channel))
      || !Number.isSafeInteger(channel.online)
      || Number(channel.online) < 0
      || !Number.isSafeInteger(channel.capacity)
      || Number(channel.capacity) < 1
      || Number(channel.capacity) > MARKET_ROOM_MAX_CLIENTS
      || Number(channel.online) > Number(channel.capacity)) return null;
    roomIds.add(channel.roomId);
    numbers.add(Number(channel.channel));
    channels.push({
      roomId: channel.roomId,
      channel: Number(channel.channel),
      online: Number(channel.online),
      capacity: Number(channel.capacity),
    });
  }
  return channels.sort((first, second) => first.channel - second.channel);
}

export function parseRoomPopulations(value: unknown): readonly RoomPopulation[] {
  const candidates = Array.isArray(value) ? value : [value];
  const populations: RoomPopulation[] = [];
  const seen = new Set<MarketSlug>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const population = candidate as Partial<RoomPopulation>;
    if (!isMarketSlug(population.market)
      || seen.has(population.market)
      || !Number.isSafeInteger(population.online)
      || Number(population.online) < 0
      || !Number.isSafeInteger(population.shards)
      || Number(population.shards) < 0
      || Number(population.online) > Number(population.shards) * MARKET_ROOM_MAX_CLIENTS
      || typeof population.updatedAt !== 'number'
      || !Number.isFinite(population.updatedAt)
      || population.updatedAt < 0) continue;
    const channels = population.channels === undefined
      ? undefined
      : parseRoomChannels(population.channels);
    if (channels === null
      || (channels !== undefined && (
        channels.length !== Number(population.shards)
        || channels.reduce((sum, channel) => sum + channel.online, 0) !== Number(population.online)
      ))) continue;
    seen.add(population.market);
    populations.push({
      market: population.market,
      online: Number(population.online),
      shards: Number(population.shards),
      ...(channels === undefined ? {} : { channels }),
      updatedAt: population.updatedAt,
    });
  }
  return populations;
}

const MIN_WORLD_DAY_DURATION_SECONDS = 60;
const MAX_WORLD_DAY_DURATION_SECONDS = 3_600;
// The server uses one fixed global epoch, so this must permit a long-lived
// deployment instead of treating a healthy multi-year room clock as hostile.
const MAX_WORLD_ELAPSED_SECONDS = 3_153_600_000;

/** Validates the schema object without trusting an arbitrary room payload. */
export function parseSharedWorldEnvironment(value: unknown): SharedWorldEnvironment | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SharedWorldEnvironment>;
  if (
    typeof candidate.elapsedSeconds !== 'number'
    || !Number.isFinite(candidate.elapsedSeconds)
    || candidate.elapsedSeconds < 0
    || candidate.elapsedSeconds > MAX_WORLD_ELAPSED_SECONDS
    || typeof candidate.updatedAt !== 'number'
    || !Number.isFinite(candidate.updatedAt)
    || candidate.updatedAt < 0
    || typeof candidate.dayDurationSeconds !== 'number'
    || !Number.isFinite(candidate.dayDurationSeconds)
    || candidate.dayDurationSeconds < MIN_WORLD_DAY_DURATION_SECONDS
    || candidate.dayDurationSeconds > MAX_WORLD_DAY_DURATION_SECONDS
  ) return null;
  return {
    elapsedSeconds: candidate.elapsedSeconds,
    updatedAt: candidate.updatedAt,
    dayDurationSeconds: candidate.dayDurationSeconds,
  };
}

/**
 * Advances an authoritative patch from the local receipt time. The browser
 * clock never has to agree with the server clock: only elapsed time since the
 * same patch is projected.
 */
export function projectSharedWorldElapsed(
  environment: SharedWorldEnvironment,
  receivedAt: number,
  now: number,
): number {
  const elapsedSinceReceipt = Math.max(0, (now - receivedAt) / 1_000);
  return Math.max(0, environment.elapsedSeconds + elapsedSinceReceipt);
}

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

interface PendingPartyInvite {
  readonly requestId: string;
  readonly resolve: (invite: PartyInvite | null) => void;
  readonly timer: number;
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
      sessionTakeover: true,
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
    sessionTakeover: true,
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

export function parseRemote(value: unknown): NetPlayerState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const actorId = stringValue(source.actorId);
  if (!actorId) return null;
  const replicatedStates = [
    'idle', 'walk', 'run', 'jump-anticipate', 'jump-rise', 'apex', 'fall',
    'double-jump', 'glide', 'land-soft', 'land-heavy', 'skid',
  ] as const;
  const movementState = replicatedStates.includes(
    stringValue(source.movementState) as (typeof replicatedStates)[number],
  ) ? stringValue(source.movementState) as NetPlayerState['movementState'] : undefined;
  const optionalUnit = (value: unknown): number | undefined => {
    const parsed = finite(value, Number.NaN);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined;
  };
  const simulationTick = typeof source.simulationTick === 'number'
    && Number.isInteger(source.simulationTick)
    && source.simulationTick >= 0
      ? source.simulationTick >>> 0
      : undefined;
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
    ...(movementState ? { movementState } : {}),
    ...(movementState && optionalUnit(source.gaitPhase) !== undefined
      ? { gaitPhase: optionalUnit(source.gaitPhase) }
      : {}),
    ...(movementState && optionalUnit(source.movementBlend) !== undefined
      ? { movementBlend: optionalUnit(source.movementBlend) }
      : {}),
    ...(movementState && optionalUnit(source.runBlend) !== undefined
      ? { runBlend: optionalUnit(source.runBlend) }
      : {}),
    ...(movementState && optionalUnit(source.airProgress) !== undefined
      ? { airProgress: optionalUnit(source.airProgress) }
      : {}),
    ...(movementState && simulationTick !== undefined ? { simulationTick } : {}),
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
  private readonly marketListeners = new Set<MarketRelayListener>();
  private readonly marketMidsListeners = new Set<MarketMidsListener>();
  private readonly populations = new Map<MarketSlug, RoomPopulation>();
  private readonly queuedChats: QueuedChatMessage[] = [];
  private queuedChatTimer: number | undefined;
  private readonly random: () => number;
  private readonly emoteGate = new EmoteRateGate();
  private readonly clientFactory: (endpoint: string) => RoomMatchClient;
  private readonly joinTimeoutMs: number;
  private readonly now: () => number;
  private client: RoomMatchClient | null = null;
  private room: Room | null = null;
  private roomEpoch = 0;
  private market: MarketSlug = 'btc';
  private connection: RoomConnectionState = 'offline';
  private remotes: NetPlayerState[] = [];
  private members: NetPlayerState[] = [];
  private currentRoomId: string | null = null;
  private requestedChannelRoomId: string | null = null;
  private lastError: string | null = null;
  private sendAccumulator = 0;
  private sequence = 0;
  private retryAttempt = 0;
  private retryTimer: number | undefined;
  private generation = 0;
  private visible = true;
  private disposed = false;
  private anonymousIdentity: SignedGuestIdentity | null;
  private anonymousIdentityRequest: Promise<void> | null = null;
  private accountSession: AccountRoomSession | null = null;
  private boundActorId: string | null = null;
  private pendingIdentityRefresh: PendingIdentityRefresh | null = null;
  private pendingPartyInvite: PendingPartyInvite | null = null;
  private pendingPartyToken: string | null;
  private pendingMarketState: RelayedMarketState | null = null;
  private marketPairTimer: number | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private joinFromMarket: MarketSlug | undefined;
  private authoritativeSpawnReceived = false;
  private environment: SharedWorldEnvironment | null = null;
  private environmentReceivedAt = 0;
  private scopedChatAvailable = false;

  constructor(options: RoomClientSystemOptions) {
    this.options = options;
    this.fallbackIdentity = options.identity ?? readGuestIdentity();
    this.anonymousIdentity = options.anonymousIdentity ?? readSignedGuestIdentity();
    this.endpoint = options.endpoint === undefined
      ? resolveMultiplayerEndpoint()
      : options.endpoint.trim();
    this.apiEndpoint = normalizeApiEndpoint(options.apiEndpoint ?? this.endpoint);
    // Calling Window.fetch as an object method supplies the wrong receiver in
    // some browsers. Keep the native function in a lexical wrapper.
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.clientFactory = options.clientFactory ?? ((endpoint) => new Client(endpoint));
    this.joinTimeoutMs = Number.isFinite(options.joinTimeoutMs) && Number(options.joinTimeoutMs) > 0
      ? Math.max(1, Number(options.joinTimeoutMs))
      : 8_000;
    this.now = Date.now;
    this.snapshotProvider = options.snapshot;
    this.random = options.random ?? Math.random;
    this.pendingPartyToken = isPartyToken(options.partyToken) ? options.partyToken : null;
  }

  get state(): RoomClientSnapshot {
    const population = this.populations.get(this.market);
    const currentChannel = this.currentRoomId
      ? population?.channels?.find((channel) => channel.roomId === this.currentRoomId) ?? null
      : null;
    return {
      connection: this.connection,
      market: this.market,
      remotes: this.remotes,
      members: this.members,
      populations: this.populations.size > 0 ? new Map(this.populations) : EMPTY_POPULATIONS,
      currentRoomId: this.currentRoomId,
      currentChannel,
      totalOnline: [...this.populations.values()].reduce((sum, entry) => sum + entry.online, 0),
      marketOnline: population?.online ?? (this.connection === 'online' ? this.members.length : 0),
      channelOnline: this.connection === 'online' ? this.members.length : 0,
      scopedChatAvailable: this.scopedChatAvailable,
      environment: this.environment,
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

  /**
   * Ensures browser features that share the anonymous actor can safely start
   * before room matchmaking finishes. Concurrent callers reuse one identity
   * request so opening news controls during connection cannot mint two actors.
   */
  async ensureAnonymousToken(): Promise<string> {
    if (this.disposed) throw new Error('Multiplayer identity service is unavailable.');
    await this.ensureAnonymousIdentity();
    const token = this.anonymousIdentity?.token;
    if (!token) throw new Error('Could not establish a safe anonymous multiplayer identity.');
    return token;
  }

  get sessionToken(): string | null {
    return this.accountSession?.token ?? null;
  }

  /** Changes only when a new Colyseus room seat is successfully joined. */
  get sessionRoomEpoch(): number {
    return this.roomEpoch;
  }

  /**
   * The active room's shared timeline, projected from its latest state patch.
   * If multiplayer has never supplied a clock, preserve the original local
   * session-relative world clock. After a transient disconnect, retain the
   * last good anchor so rain and lighting do not visibly reset.
   */
  getWorldElapsedSeconds(localFallbackSeconds: number): number {
    const environment = this.environment;
    if (!environment) return Math.max(0, localFallbackSeconds);
    return projectSharedWorldElapsed(environment, this.environmentReceivedAt, this.now());
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

  subscribeMarket(listener: MarketRelayListener): () => void {
    this.marketListeners.add(listener);
    return () => this.marketListeners.delete(listener);
  }

  subscribeMarketMids(listener: MarketMidsListener): () => void {
    this.marketMidsListeners.add(listener);
    return () => this.marketMidsListeners.delete(listener);
  }

  connect(market: MarketSlug): Promise<boolean> {
    return this.enqueueOperation(() => this.connectInternal(market));
  }

  private async connectInternal(market: MarketSlug): Promise<boolean> {
    if (this.disposed) return false;
    this.market = market;
    this.keepQueuedChatsFor(market);
    this.requestedChannelRoomId = null;
    this.clearWorldEnvironment();
    this.joinFromMarket = undefined;
    this.authoritativeSpawnReceived = false;
    this.scopedChatAvailable = false;
    this.retryAttempt = 0;
    this.clearRetry();
    return this.join(++this.generation);
  }

  switchMarket(market: MarketSlug): Promise<boolean> {
    return this.enqueueOperation(() => this.switchMarketInternal(market, null));
  }

  /**
   * Joins the selected numbered channel when it still has a seat. A stale or
   * just-filled channel falls back to normal market matchmaking, keeping the
   * player online while returning an explicit result for the switcher UI.
   */
  switchChannel(market: MarketSlug, roomId: string): Promise<ChannelJoinResult> {
    return this.enqueueOperation(async () => {
      const requestedRoomId = isPublicRoomId(roomId) ? roomId : '';
      if (!requestedRoomId) {
        return { status: 'offline', market, requestedRoomId: roomId, roomId: null };
      }
      if (this.connection === 'online'
        && this.market === market
        && this.currentRoomId === requestedRoomId) {
        return { status: 'joined', market, requestedRoomId, roomId: requestedRoomId };
      }
      const joined = await this.switchMarketInternal(market, requestedRoomId);
      const actualRoomId = joined ? this.currentRoomId : null;
      if (!actualRoomId) return { status: 'offline', market, requestedRoomId, roomId: null };
      return {
        status: actualRoomId === requestedRoomId ? 'joined' : 'fallback',
        market,
        requestedRoomId,
        roomId: actualRoomId,
      };
    });
  }

  /** Refreshes channels even while the shared room connection is recovering. */
  async refreshPopulations(): Promise<readonly RoomPopulation[]> {
    if (!this.apiEndpoint) return [];
    try {
      const response = await this.fetchWithDeadline(`${this.apiEndpoint}/api/populations`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null) as { populations?: unknown } | null;
      if (!response.ok) return [];
      const updates = parseRoomPopulations(payload?.populations);
      for (const update of updates) this.populations.set(update.market, update);
      if (updates.length > 0) this.emit();
      return updates;
    } catch {
      return [];
    }
  }

  private async switchMarketInternal(
    market: MarketSlug,
    requestedChannelRoomId: string | null,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const fromMarket = this.market;
    this.market = market;
    this.keepQueuedChatsFor(market);
    this.requestedChannelRoomId = requestedChannelRoomId;
    this.clearWorldEnvironment();
    this.joinFromMarket = fromMarket === market ? undefined : fromMarket;
    this.authoritativeSpawnReceived = false;
    this.scopedChatAvailable = false;
    const generation = ++this.generation;
    this.clearRetry();
    await this.leaveRoom();
    this.remotes = [];
    this.members = [];
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

  sendChat(text: string, scope: ChatScope = 'world'): boolean {
    if (scope === 'proximity' && !this.scopedChatAvailable) return false;
    const message: ChatSendMessage = this.scopedChatAvailable
      ? { protocolVersion: PROTOCOL_VERSION, text, scope }
      : { protocolVersion: PROTOCOL_VERSION, text };
    if (this.room && this.connection === 'online' && this.queuedChats.length === 0) {
      try {
        this.room.send(CLIENT_MESSAGES.chat, message);
        return true;
      } catch {
        this.setConnection('reconnecting', 'Chat connection interrupted.');
      }
    }
    // Proximity delivery is defined by the server's current authoritative
    // room position. Queuing it across a drop could route a message from the
    // sender's stale pre-drop position, while retaining it across a channel
    // handoff could expose it to an entirely different group. Fail closed and
    // leave the composer text intact until this exact seat is online again.
    if (scope === 'proximity') return false;
    // A brief room handoff or network drop should not turn the composer into
    // a dead control. Keep a small, market-bound world-chat queue and publish
    // it after the automatic reconnect. Messages are never rerouted into a
    // different tickerworld.
    if (this.disposed || !this.endpoint || this.connection === 'incompatible') return false;
    if (this.queuedChats.length >= MAX_QUEUED_CHAT_MESSAGES) return false;
    this.queuedChats.push({ market: this.market, text, scope });
    if (this.connection === 'offline') this.scheduleRetry(0);
    return true;
  }

  requestParkourRespawn(checkpointId: ParkourCheckpointId): boolean {
    if (!this.room || this.connection !== 'online') return false;
    const message: ParkourRespawnMessage = { protocolVersion: PROTOCOL_VERSION, checkpointId };
    this.room.send(CLIENT_MESSAGES.parkourRespawn, message);
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

  setAppearance(animal: AnimalKind, skin: SkinId = 'base', username?: string | null): boolean {
    if (!this.room || this.connection !== 'online') return false;
    const message: AppearanceMessage = {
      protocolVersion: PROTOCOL_VERSION,
      animal,
      skin,
      ...(username !== undefined ? { username } : {}),
    };
    this.room.send(CLIENT_MESSAGES.appearance, message);
    return true;
  }

  sendEmote(kind: EmoteKind): string | null {
    if (!this.room || this.connection !== 'online' || !this.emoteGate.tryTake()) return null;
    const nonce = createEmoteNonce(this.random);
    this.room.send(EMOTE_CLIENT_MESSAGE, { protocolVersion: PROTOCOL_VERSION, kind, nonce });
    return nonce;
  }

  requestPartyInvite(): Promise<PartyInvite | null> {
    if (!this.room || this.connection !== 'online') return Promise.resolve(null);
    this.finishPartyInvite(null);
    const requestId = createEmoteNonce(this.random);
    return new Promise<PartyInvite | null>((resolve) => {
      const timer = Number(globalThis.setTimeout(() => this.finishPartyInvite(null), 5_000));
      this.pendingPartyInvite = { requestId, resolve, timer };
      this.room!.send(PARTY_CLIENT_INVITE_REQUEST, { protocolVersion: PROTOCOL_VERSION, requestId });
    });
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
    this.finishPartyInvite(null);
    this.clearPendingMarketState();
    this.listeners.clear();
    this.chatListeners.clear();
    this.chatRejectionListeners.clear();
    this.reportAcceptedListeners.clear();
    this.reportRejectionListeners.clear();
    this.marketListeners.clear();
    this.marketMidsListeners.clear();
    this.clearWorldEnvironment();
    void this.leaveRoom();
    this.client = null;
    this.remotes = [];
    this.members = [];
    this.currentRoomId = null;
    this.populations.clear();
    this.queuedChats.length = 0;
    this.clearQueuedChatTimer();
  }

  private async join(
    generation: number,
    identityOptions?: JoinIdentityOptions,
    refreshedAnonymousIdentity = false,
  ): Promise<boolean> {
    this.scopedChatAvailable = false;
    if (!this.endpoint) {
      this.setConnection('offline', 'Multiplayer is not configured yet.');
      return false;
    }
    this.populations.clear();
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
      const partyToken = this.pendingPartyToken;
      const joinOptions = partyToken ? { ...options, partyToken } : options;
      const requestedChannelRoomId = partyToken ? null : this.requestedChannelRoomId;
      let room: Room;
      if (partyToken) {
        const redemption = await this.redeemPartyToken(partyToken);
        if (!redemption.ok || redemption.market !== this.market) {
          const failure = redemption.ok ? 'party_invalid' : redemption.code;
          this.fallbackFromParty(partyToken, failure);
          return this.join(generation, identityOptions);
        }
        room = await this.joinRoomWithTimeout(this.client.joinById(redemption.roomId, joinOptions));
      } else if (requestedChannelRoomId) {
        try {
          room = await this.joinRoomWithTimeout(
            this.client.joinById(requestedChannelRoomId, joinOptions),
          );
        } catch (error) {
          if (this.disposed || generation !== this.generation) return false;
          if (!isUnavailableChannelError(error)) throw error;
          // Channel snapshots are deliberately short-lived. If the selected
          // room filled or disposed between menu selection and matchmaking,
          // keep the transfer useful by joining the healthiest normal shard.
          this.requestedChannelRoomId = null;
          room = await this.joinRoomWithTimeout(
            this.client.joinOrCreate(MARKET_ROOM_NAME, joinOptions),
          );
        }
      } else {
        room = await this.joinRoomWithTimeout(
          this.client.joinOrCreate(MARKET_ROOM_NAME, joinOptions),
        );
      }
      if (this.disposed || generation !== this.generation) {
        await room.leave(true);
        return false;
      }
      this.room = room;
      const joinedRoomId = (room as Room & { roomId?: unknown }).roomId;
      this.currentRoomId = isPublicRoomId(joinedRoomId) ? joinedRoomId : null;
      this.requestedChannelRoomId = null;
      this.clearWorldEnvironment();
      this.roomEpoch += 1;
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
      const isCurrentRoom = (): boolean => room === this.room
        && generation === this.generation
        && !this.disposed;
      room.onStateChange((state: RoomStateShape) => {
        if (isCurrentRoom()) this.acceptState(state);
      });
      this.acceptState(room.state as RoomStateShape);
      room.onMessage<CorrectionMessage>(SERVER_MESSAGES.correction, (message) => {
        if (isCurrentRoom()) this.options.onCorrection?.(message);
      });
      room.onMessage<ChatMessage>(SERVER_MESSAGES.chat, (message) => {
        if (!isCurrentRoom()) return;
        this.options.onChat?.(message);
        for (const listener of this.chatListeners) listener(message);
      });
      room.onMessage<ChatRejection>(SERVER_MESSAGES.chatRejected, (message) => {
        if (!isCurrentRoom()) return;
        this.options.onChatRejected?.(message);
        for (const listener of this.chatRejectionListeners) listener(message);
      });
      room.onMessage<unknown>(SERVER_MESSAGES.population, (message) => {
        if (!isCurrentRoom()) return;
        const updates = parseRoomPopulations(message);
        for (const update of updates) this.populations.set(update.market, update);
        if (updates.length > 0) this.emit();
      });
      room.onMessage<RelayedMarketState>(SERVER_MESSAGES.market, (state) => {
        if (isCurrentRoom()) this.queueMarketState(state);
      });
      room.onMessage<readonly CompactMarketMid[]>(SERVER_MESSAGES.marketMids, (mids) => {
        if (!isCurrentRoom()) return;
        const bounded = boundRelayedMarketMids(mids);
        for (const listener of this.marketMidsListeners) listener(bounded);
        this.flushPendingMarketState();
      });
      room.onMessage(SERVER_MESSAGES.reportAccepted, () => {
        if (!isCurrentRoom()) return;
        this.options.onReportAccepted?.();
        for (const listener of this.reportAcceptedListeners) listener();
      });
      room.onMessage<ReportRejection>(SERVER_MESSAGES.reportRejected, (rejection) => {
        if (!isCurrentRoom()) return;
        this.options.onReportRejected?.(rejection);
        for (const listener of this.reportRejectionListeners) listener(rejection);
      });
      room.onMessage<IdentityRefreshResult>(SERVER_MESSAGES.identityRefreshed, (identity) => {
        if (!isCurrentRoom()) return;
        const pending = this.pendingIdentityRefresh;
        if (!pending || identity.actorId !== pending.actorId) return;
        const acceptedSession = pending.session;
        this.finishIdentityRefresh(true);
        this.commitAccountSession(acceptedSession, {
          actorId: identity.actorId,
          animal: identity.animal,
          skin: identity.skin,
          username: identity.username,
        });
      });
      room.onMessage<IdentityRejection>(SERVER_MESSAGES.identityRejected, (rejection) => {
        if (!isCurrentRoom()) return;
        this.lastError = `Identity refresh rejected: ${rejection.code}`;
        this.finishIdentityRefresh(false);
        this.options.onIdentityRefreshRejected?.(rejection);
        this.emit();
      });
      room.onMessage<unknown>(EMOTE_SERVER_MESSAGE, (value) => {
        if (!isCurrentRoom()) return;
        const event = parseServerEmote(value);
        if (event && isProtocolVersionAccepted(event.protocolVersion)) this.options.onEmote?.(event);
      });
      room.onMessage<unknown>(PARTY_SERVER_INVITE, (value) => {
        if (!isCurrentRoom()) return;
        const invite = parsePartyInvite(value);
        if (!invite || invite.requestId !== this.pendingPartyInvite?.requestId) return;
        this.finishPartyInvite(invite);
      });
      room.onMessage<{ requestId?: unknown }>(SERVER_MESSAGES.partyRejected, (value) => {
        if (!isCurrentRoom()) return;
        if (value?.requestId === this.pendingPartyInvite?.requestId) this.finishPartyInvite(null);
      });
      room.onMessage(SERVER_MESSAGES.protocolRejected, () => {
        if (!isCurrentRoom()) return;
        this.setConnection('incompatible', 'Multiplayer is updating. Reconnecting shortly.');
      });
      room.onDrop(() => {
        if (isCurrentRoom()) this.setConnection('reconnecting', null);
      });
      room.onReconnect(() => {
        if (!isCurrentRoom()) return;
        // WebSocket messages are ordered. Restore the credential-owned baseline
        // before publishing `online`, so Game's saved anonymous appearance is
        // sent afterwards and remains the final room presentation.
        this.sendIdentityRefresh(
          this.pendingIdentityRefresh?.session ?? this.accountSession,
          true,
        );
        this.setConnection('online', null);
      });
      room.onError((_code, message) => {
        if (isCurrentRoom() && message) this.lastError = message;
      });
      room.onLeave((code, reason) => {
        if (room !== this.room || this.disposed || generation !== this.generation) return;
        const replaced = code === SESSION_REPLACED_CLOSE_CODE
          || reason === SESSION_REPLACED_REASON;
        this.room = null;
        this.currentRoomId = null;
        this.boundActorId = null;
        this.remotes = [];
        this.members = [];
        this.scopedChatAvailable = false;
        this.finishIdentityRefresh(false);
        this.finishPartyInvite(null);
        this.clearPendingMarketState();
        this.setConnection(
          'offline',
          replaced ? SESSION_REPLACED_REASON : this.lastError ?? 'Room connection lost.',
        );
        // A replacement is a deliberate ownership transfer, not an outage.
        // Retrying from the displaced tab would steal the seat back and make
        // both tabs bounce forever. Returning to this tab (visibility/focus)
        // or sending a world message explicitly reclaims it instead.
        if (!replaced) this.scheduleRetry();
      });
      this.setConnection('online', null);
      if (partyToken) {
        this.pendingPartyToken = null;
        this.options.onPartyJoinStatus?.({ status: 'joined', token: partyToken });
      }
      if (identityOptions?.publishIdentity !== false) {
        this.options.onIdentityChanged?.(targetIdentity);
      }
      return true;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return false;
      const partyToken = this.pendingPartyToken;
      const partyFailure = partyToken ? partyFailureFromError(error) : null;
      if (partyToken && partyFailure) {
        this.fallbackFromParty(partyToken, partyFailure);
        return this.join(generation, identityOptions);
      }
      const message = error instanceof Error ? error.message : 'Room server unavailable.';
      if (
        !refreshedAnonymousIdentity
        && !identityOptions?.session
        && !this.accountSession
        && message.includes('anonymous_token_required')
      ) {
        this.anonymousIdentity = null;
        clearSignedGuestIdentity();
        return this.join(generation, identityOptions, true);
      }
      this.setConnection('offline', message);
      if (identityOptions?.retryOnFailure !== false) this.scheduleRetry();
      return false;
    }
  }

  private acceptState(state: RoomStateShape): void {
    // Replicated state is a silent positive handshake: older clients ignore
    // the extra field, while an older v2 server has no field and therefore
    // cannot accidentally receive a Proximity message as unscoped World chat.
    this.scopedChatAvailable = state.scopedChat === true;
    const environment = parseSharedWorldEnvironment(state.environment);
    if (environment) this.acceptWorldEnvironment(environment);
    const next: NetPlayerState[] = [];
    const members: NetPlayerState[] = [];
    state.players?.forEach?.((value) => {
      const parsed = parseRemote(value);
      if (!parsed) return;
      members.push(parsed);
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
    this.members = members;
    this.emit();
  }

  private acceptWorldEnvironment(environment: SharedWorldEnvironment): void {
    const receivedAt = this.now();
    const previous = this.environment;
    if (previous) {
      // A schema patch should be monotonic. Preserve a tiny local lead caused
      // by packet jitter, while allowing an actual newly joined room to reset
      // after clearWorldEnvironment() has removed the prior anchor.
      const projected = projectSharedWorldElapsed(previous, this.environmentReceivedAt, receivedAt);
      if (environment.elapsedSeconds < projected && projected - environment.elapsedSeconds < 1) {
        this.environment = {
          ...environment,
          elapsedSeconds: projected,
        };
        this.environmentReceivedAt = receivedAt;
        return;
      }
    }
    this.environment = environment;
    this.environmentReceivedAt = receivedAt;
  }

  private clearWorldEnvironment(): void {
    this.environment = null;
    this.environmentReceivedAt = 0;
  }

  private sendIdentityRefresh(
    session: AccountRoomSession | null,
    allowReconnecting = false,
  ): boolean {
    const room = this.room;
    if (!room || (this.connection !== 'online'
      && !(allowReconnecting && this.connection === 'reconnecting'))) return false;
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
    if (this.anonymousIdentityRequest) return this.anonymousIdentityRequest;
    const request = this.requestAnonymousIdentity();
    this.anonymousIdentityRequest = request;
    try {
      await request;
    } finally {
      if (this.anonymousIdentityRequest === request) this.anonymousIdentityRequest = null;
    }
  }

  private async requestAnonymousIdentity(): Promise<void> {
    if (!this.apiEndpoint) throw new Error('Multiplayer identity service is not configured.');
    const response = await this.fetchWithDeadline(`${this.apiEndpoint}/api/anonymous/session`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null) as Partial<SignedGuestIdentity> | null;
    if (!response.ok
      || !payload
      || typeof payload.actorId !== 'string'
      || typeof payload.token !== 'string'
      || typeof payload.expiresAt !== 'number'
      || !isAnimalKind(payload.animal)) {
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

  private async redeemPartyToken(token: string): Promise<PartyJoinResult> {
    if (!this.apiEndpoint) throw new Error('Party invites are unavailable while multiplayer is offline.');
    const response = await this.fetchWithDeadline(`${this.apiEndpoint}/api/invites/redeem`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json().catch(() => null) as PartyJoinResult | null;
    if (!response.ok || !payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
      throw new Error('Party invite lookup failed.');
    }
    return payload;
  }

  private async fetchWithDeadline(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = Math.min(4_000, this.joinTimeoutMs);
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        controller.abort();
        reject(new Error(`Multiplayer request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.requestFetch(input, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }

  private fallbackFromParty(token: string, failure: 'party_full' | 'party_invalid' | 'party_expired'): void {
    this.pendingPartyToken = null;
    this.options.onPartyJoinStatus?.({
      status: failure === 'party_full' ? 'full' : failure === 'party_expired' ? 'expired' : 'invalid',
      token,
      fallback: 'normal-shard',
    });
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
        skin: session.profile.selectedSkin,
        username: session.profile.username,
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
    this.members = [];
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

  private finishPartyInvite(invite: PartyInvite | null): void {
    const pending = this.pendingPartyInvite;
    if (!pending) return;
    this.pendingPartyInvite = null;
    globalThis.clearTimeout(pending.timer);
    pending.resolve(invite);
  }

  private queueMarketState(state: RelayedMarketState): void {
    // The room broadcasts state immediately before its compact mids. Hold the
    // state briefly so consumers see both from the same relay tick rather than
    // applying portal prices one publication behind.
    if (this.pendingMarketState) this.flushPendingMarketState();
    this.pendingMarketState = state;
    this.marketPairTimer = Number(globalThis.setTimeout(() => {
      this.marketPairTimer = undefined;
      this.flushPendingMarketState();
    }, 50));
  }

  private flushPendingMarketState(): void {
    if (this.marketPairTimer !== undefined) {
      globalThis.clearTimeout(this.marketPairTimer);
      this.marketPairTimer = undefined;
    }
    const state = this.pendingMarketState;
    this.pendingMarketState = null;
    if (!state) return;
    for (const listener of this.marketListeners) listener(state);
  }

  private clearPendingMarketState(): void {
    if (this.marketPairTimer !== undefined) globalThis.clearTimeout(this.marketPairTimer);
    this.marketPairTimer = undefined;
    this.pendingMarketState = null;
  }

  private async leaveRoom(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.currentRoomId = null;
    this.members = [];
    this.scopedChatAvailable = false;
    this.boundActorId = null;
    this.finishIdentityRefresh(false);
    this.finishPartyInvite(null);
    this.clearPendingMarketState();
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
    if (connection === 'online') this.flushQueuedChats();
    this.emit();
  }

  private keepQueuedChatsFor(market: MarketSlug): void {
    this.clearQueuedChatTimer();
    for (let index = this.queuedChats.length - 1; index >= 0; index -= 1) {
      if (this.queuedChats[index]?.market !== market) this.queuedChats.splice(index, 1);
    }
  }

  private flushQueuedChats(): void {
    const room = this.room;
    if (!room
      || this.connection !== 'online'
      || this.queuedChats.length === 0
      || this.queuedChatTimer !== undefined) return;
    const queued = this.queuedChats[0];
    if (!queued) return;
    if (queued.market !== this.market) {
      this.queuedChats.shift();
      this.flushQueuedChats();
      return;
    }
    try {
      const message: ChatSendMessage = this.scopedChatAvailable
        ? { protocolVersion: PROTOCOL_VERSION, text: queued.text, scope: queued.scope }
        : { protocolVersion: PROTOCOL_VERSION, text: queued.text };
      room.send(CLIENT_MESSAGES.chat, message);
      this.queuedChats.shift();
      if (this.queuedChats.length > 0) {
        // Replaying an outage backlog all at once would collide with the
        // server's shared anti-spam bucket. Drain at its one-message refill
        // cadence so accepted messages remain reliable and ordered.
        this.queuedChatTimer = Number(globalThis.setTimeout(() => {
          this.queuedChatTimer = undefined;
          this.flushQueuedChats();
        }, 2_050));
      }
    } catch {
      // Keep the unsent item at the front. The room lifecycle will move to
      // reconnecting/offline and retry it against the next healthy socket.
    }
  }

  private clearQueuedChatTimer(): void {
    if (this.queuedChatTimer === undefined) return;
    globalThis.clearTimeout(this.queuedChatTimer);
    this.queuedChatTimer = undefined;
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
