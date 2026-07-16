import type {
  ANIMAL_KINDS,
  ASSET_SYMBOLS,
  CHAT_SCOPES,
  ENTITLEMENT_SKUS,
  MARKET_SLUGS,
  MODERATION_REASONS,
  PARKOUR_CHECKPOINT_IDS,
  PREMIUM_SKINS,
} from './constants.js';

export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];
export type MarketSlug = (typeof MARKET_SLUGS)[number];
export type AnimalKind = (typeof ANIMAL_KINDS)[number];
export type PremiumSkinId = (typeof PREMIUM_SKINS)[number];
export type SkinId = 'base' | PremiumSkinId;
export type ModerationReason = (typeof MODERATION_REASONS)[number];
export type EntitlementSku = (typeof ENTITLEMENT_SKUS)[number];
export type ParkourCheckpointId = (typeof PARKOUR_CHECKPOINT_IDS)[number];
export type ChatScope = (typeof CHAT_SCOPES)[number];
export type RoomConnectionState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'incompatible';

export interface Vec2 {
  x: number;
  z: number;
}

export interface PortalRoute {
  slot: number;
  from: MarketSlug;
  to: MarketSlug;
  x: number;
  z: number;
  yaw: number;
}

export interface WorldGuard {
  worldRadius: number;
  podiumRadius: number;
  maxSprintSpeed: number;
}

/** A stable, collision-free slot shared by the room server and local client. */
export interface SpawnAssignment {
  slot: number;
  market: MarketSlug;
  fromMarket: MarketSlug | null;
  x: number;
  y: number;
  z: number;
  /** Fox/player yaw that faces back toward the active market monument. */
  yaw: number;
}

export interface MoveSnapshot {
  protocolVersion: number;
  sequence: number;
  sentAt: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  verticalSpeed: number;
  grounded: boolean;
  gait: 'idle' | 'walk' | 'run' | 'air' | 'glide';
  /** Optional v2 capability. Legacy servers strip it and new clients infer. */
  movementState?: ReplicatedMovementState;
  /** Normalized 0..1 procedural gait phase. */
  gaitPhase?: number;
  movementBlend?: number;
  runBlend?: number;
  airProgress?: number;
  simulationTick?: number;
  /** Optional v2 motion-detail capability used for exact remote secondary motion. */
  velocityX?: number;
  velocityZ?: number;
  turnLean?: number;
  accelerationLean?: number;
  glideBank?: number;
  /** Monotonic action counters keep sub-100ms poses visible across 10Hz patches. */
  anticipationSequence?: number;
  jumpSequence?: number;
  doubleJumpSequence?: number;
  landSequence?: number;
  skidSequence?: number;
  anticipationTick?: number;
  jumpTick?: number;
  doubleJumpTick?: number;
  landTick?: number;
  skidTick?: number;
  landingTier?: 'soft' | 'heavy';
  stateTransitionSequence?: number;
  stateTransitionTick?: number;
}

export type ReplicatedMovementState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'jump-anticipate'
  | 'jump-rise'
  | 'apex'
  | 'fall'
  | 'double-jump'
  | 'glide'
  | 'land-soft'
  | 'land-heavy'
  | 'skid';

export interface ParkourRespawnMessage {
  protocolVersion: number;
  checkpointId: ParkourCheckpointId;
}

export interface NetPlayerState {
  actorId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  verticalSpeed: number;
  grounded: boolean;
  gait: MoveSnapshot['gait'];
  movementState?: ReplicatedMovementState;
  gaitPhase?: number;
  movementBlend?: number;
  runBlend?: number;
  airProgress?: number;
  simulationTick?: number;
  /** Distinguishes exact motion fields from zero-valued schema defaults sent for legacy clients. */
  motionStateV2?: boolean;
  velocityX?: number;
  velocityZ?: number;
  turnLean?: number;
  accelerationLean?: number;
  glideBank?: number;
  anticipationSequence?: number;
  jumpSequence?: number;
  doubleJumpSequence?: number;
  landSequence?: number;
  skidSequence?: number;
  anticipationTick?: number;
  jumpTick?: number;
  doubleJumpTick?: number;
  landTick?: number;
  skidTick?: number;
  landingTier?: 'soft' | 'heavy';
  stateTransitionSequence?: number;
  stateTransitionTick?: number;
  animal: AnimalKind;
  skin: SkinId;
  username: string | null;
  updatedAt: number;
}

export interface RoomPopulation {
  market: MarketSlug;
  online: number;
  shards: number;
  /** Joinable room instances, presented to players as numbered channels. */
  channels?: readonly RoomChannelPopulation[];
  updatedAt: number;
}

/**
 * Public, short-lived description of one room shard. Room ids are opaque and
 * may disappear when an empty Colyseus room auto-disposes; `channel` is the
 * friendly number shown in the world switcher for that room's lifetime.
 */
export interface RoomChannelPopulation {
  roomId: string;
  channel: number;
  online: number;
  capacity: number;
}

/**
 * Server-authored room timeline. Weather, rain, thunder, cloud drift, and
 * lighting are deterministic functions of this timeline and the canonical
 * world seed, so a room experiences one shared sky rather than a per-browser
 * session clock.
 */
export interface SharedWorldEnvironment {
  /** Seconds since this room's authoritative world timeline began. */
  elapsedSeconds: number;
  /** Server wall-clock timestamp when elapsedSeconds was sampled. */
  updatedAt: number;
  /** Kept in the protocol so clients never silently disagree on cycle length. */
  dayDurationSeconds: number;
}

export interface ChatMessage {
  id: string;
  actorId: string;
  username: string | null;
  animal: AnimalKind;
  text: string;
  sentAt: number;
  /** Defaults to world when omitted by a previous-protocol sender. */
  scope: ChatScope;
}

export type ChatRejectionCode =
  | 'empty'
  | 'too_long'
  | 'rate_limited'
  | 'profanity'
  | 'links'
  | 'wallet_or_contract'
  | 'seed_phrase'
  | 'invisible_spam'
  | 'repeated_spam'
  | 'impersonation'
  | 'disabled'
  | 'muted'
  | 'protocol_mismatch';

export interface ChatRejection {
  code: ChatRejectionCode;
  retryAfterMs?: number;
}

export interface PlayerReport {
  id: string;
  reporterActorId: string;
  targetActorId: string;
  market: MarketSlug;
  reason: ModerationReason;
  note?: string;
  createdAt: number;
}

export type ReportRejectionCode =
  | 'protocol_mismatch'
  | 'invalid_target'
  | 'self_report'
  | 'target_not_found'
  | 'rate_limited'
  | 'persistence_failed';

export interface ReportRejection {
  code: ReportRejectionCode;
  retryAfterMs?: number;
}

export interface IdentityRefreshMessage {
  protocolVersion: number;
  /** Supply exactly one signed identity. Wallet sessions upgrade an anonymous connection. */
  sessionToken?: string;
  /** Re-applying the browser's signed anonymous token removes wallet-only presentation. */
  anonymousToken?: string;
}

export type IdentityRejectionCode =
  | 'protocol_mismatch'
  | 'invalid_identity'
  | 'actor_mismatch'
  | 'moderated'
  | 'disabled';

export interface IdentityRefreshResult {
  actorId: string;
  username: string | null;
  animal: AnimalKind;
  skin: SkinId;
  walletConnected: boolean;
}

export interface IdentityRejection {
  code: IdentityRejectionCode;
}

export interface PurchaseQuote {
  id: string;
  accountId: string;
  sku: EntitlementSku;
  usdCents: number;
  lamports: string;
  reference: string;
  recipient: string;
  cluster: 'devnet' | 'mainnet-beta';
  expiresAt: number;
}

export interface AccountProfile {
  id: string;
  actorId: string;
  username: string | null;
  /** True when a paid username could not be assigned and may be claimed again. */
  usernameCreditAvailable?: boolean;
  selectedAnimal: AnimalKind;
  selectedSkin: SkinId;
  entitlements: readonly EntitlementSku[];
  lastMarket: MarketSlug;
}

export interface CorrectionMessage {
  sequence: number;
  x: number;
  y: number;
  z: number;
  reason: 'invalid' | 'speed' | 'bounds' | 'terrain' | 'parkour';
  hard: boolean;
}

export interface AppearanceMessage {
  protocolVersion: number;
  animal: AnimalKind;
  skin: SkinId;
  /** Free launch identity; servers still normalize, reserve, and de-duplicate it. */
  username?: string | null;
}

export interface ChatSendMessage {
  protocolVersion: number;
  text: string;
  /** Previous protocol clients omit this field and are routed to world chat. */
  scope?: ChatScope;
}

export interface ReportSendMessage {
  protocolVersion: number;
  targetActorId: string;
  reason: ModerationReason;
  note?: string;
}

export interface JoinOptions {
  protocolVersion: number;
  market: MarketSlug;
  /**
   * Explicitly lets this authenticated connection replace an older seat for
   * the same actor. Omission preserves legacy reject-on-duplicate behavior so
   * an older client cannot reclaim a seat after being displaced.
   */
  sessionTakeover?: boolean;
  /** Signed opaque identity from POST /api/anonymous/session. */
  anonymousToken?: string;
  /** Revocable wallet account session. Raw wallet addresses never enter room state. */
  sessionToken?: string;
  /** Legacy v1 fallback; accepted only during the one-version deployment overlap. */
  actorId?: string;
  fromMarket?: MarketSlug;
  animal: AnimalKind;
  skin?: SkinId;
  /** Signed 30-minute invitation. Clients redeem it before joinById and pass it again here. */
  partyToken?: string;
}
