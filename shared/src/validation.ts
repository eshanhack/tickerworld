import {
  ACCEPTED_PROTOCOL_VERSIONS,
  ACTOR_ID_MAX_LENGTH,
  ANIMAL_KINDS,
  ASSET_SYMBOLS,
  ENTITLEMENT_SKUS,
  MARKET_SLUGS,
  MODERATION_REASONS,
  PREMIUM_SKINS,
} from './constants.js';
import type {
  AnimalKind,
  AssetSymbol,
  EntitlementSku,
  MarketSlug,
  ModerationReason,
  SkinId,
} from './contracts.js';
import { assetSymbolForMarket, marketSlugForAsset } from './markets.js';

const ANONYMOUS_ACTOR_PATTERN = /^anon_[a-f0-9]{32}$/;
const PLAYER_ACTOR_PATTERN = /^player_[A-Za-z0-9]{16,57}$/;

export function isMarketSlug(value: unknown): value is MarketSlug {
  return typeof value === 'string' && (MARKET_SLUGS as readonly string[]).includes(value);
}

export function isAssetSymbol(value: unknown): value is AssetSymbol {
  return typeof value === 'string' && (ASSET_SYMBOLS as readonly string[]).includes(value);
}

export function isAnimalKind(value: unknown): value is AnimalKind {
  return typeof value === 'string' && (ANIMAL_KINDS as readonly string[]).includes(value);
}

export function isSkinId(value: unknown): value is SkinId {
  return value === 'base'
    || (typeof value === 'string' && (PREMIUM_SKINS as readonly string[]).includes(value));
}

export function isModerationReason(value: unknown): value is ModerationReason {
  return typeof value === 'string'
    && (MODERATION_REASONS as readonly string[]).includes(value);
}

export function isEntitlementSku(value: unknown): value is EntitlementSku {
  return typeof value === 'string'
    && (ENTITLEMENT_SKUS as readonly string[]).includes(value);
}

export function isProtocolVersionAccepted(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && (ACCEPTED_PROTOCOL_VERSIONS as readonly number[]).includes(value);
}

export function isActorId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= ACTOR_ID_MAX_LENGTH
    && (ANONYMOUS_ACTOR_PATTERN.test(value) || PLAYER_ACTOR_PATTERN.test(value));
}

/** Canonicalizes arbitrary finite client yaw without changing its direction. */
export function normalizeYaw(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const fullTurn = Math.PI * 2;
  const wrapped = (value + Math.PI) % fullTurn;
  return (wrapped < 0 ? wrapped + fullTurn : wrapped) - Math.PI;
}

export function normalizeUsername(value: string): string | null {
  const normalized = value.normalize('NFKC').trim();
  return /^[A-Za-z0-9_]{3,16}$/.test(normalized) ? normalized : null;
}

export function canonicalUsername(value: string): string | null {
  return normalizeUsername(value)?.toLocaleLowerCase('en-US') ?? null;
}

export function symbolForMarket(market: MarketSlug): AssetSymbol {
  return assetSymbolForMarket(market);
}

export function marketForSymbol(symbol: AssetSymbol): MarketSlug {
  return marketSlugForAsset(symbol);
}
