import type {
  ANIMAL_KINDS,
  ASSET_SYMBOLS,
  ENTITLEMENT_SKUS,
  MARKET_SLUGS,
  MODERATION_REASONS,
  PREMIUM_SKINS,
} from './constants.js';

export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];
export type MarketSlug = (typeof MARKET_SLUGS)[number];
export type AnimalKind = (typeof ANIMAL_KINDS)[number];
export type PremiumSkinId = (typeof PREMIUM_SKINS)[number];
export type SkinId = 'base' | PremiumSkinId;
export type ModerationReason = (typeof MODERATION_REASONS)[number];
export type EntitlementSku = (typeof ENTITLEMENT_SKUS)[number];
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
  animal: AnimalKind;
  skin: SkinId;
  username: string | null;
  updatedAt: number;
}

export interface RoomPopulation {
  market: MarketSlug;
  online: number;
  shards: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  actorId: string;
  username: string | null;
  animal: AnimalKind;
  text: string;
  sentAt: number;
}

export type ChatRejectionCode =
  | 'empty'
  | 'too_long'
  | 'rate_limited'
  | 'profanity'
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
  | 'moderated';

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
  reason: 'invalid' | 'speed' | 'bounds' | 'terrain';
  hard: boolean;
}

export interface AppearanceMessage {
  protocolVersion: number;
  animal: AnimalKind;
  skin: SkinId;
}

export interface ChatSendMessage {
  protocolVersion: number;
  text: string;
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
  /** Signed opaque identity from POST /api/anonymous/session. */
  anonymousToken?: string;
  /** Revocable wallet account session. Raw wallet addresses never enter room state. */
  sessionToken?: string;
  /** Legacy v1 fallback; accepted only during the one-version deployment overlap. */
  actorId?: string;
  fromMarket?: MarketSlug;
  animal: AnimalKind;
  skin?: SkinId;
}
