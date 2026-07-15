import type { AssetSymbol } from '../types';
import type { AssetAudioProfile, MarketMoveClass } from './types';

/** Market cues are intentionally local to the plaza the fox is visiting. */
export const MARKET_AUDIO_FULL_RADIUS = 12;
export const MARKET_AUDIO_MAX_RADIUS = 34;

/**
 * Player-proximity trim for positional market audio. Camera position remains
 * responsible only for HRTF orientation, so orbiting away from the fox cannot
 * make a distant market louder. The squared smoothstep gives the fade a short,
 * soft tail before reaching a true zero at the outer radius.
 */
export function marketSourceProximityGain(distance: number): number {
  if (!Number.isFinite(distance) || distance >= MARKET_AUDIO_MAX_RADIUS) return 0;
  if (distance <= MARKET_AUDIO_FULL_RADIUS) return 1;
  const progress = (
    (distance - MARKET_AUDIO_FULL_RADIUS)
    / (MARKET_AUDIO_MAX_RADIUS - MARKET_AUDIO_FULL_RADIUS)
  );
  const smooth = progress * progress * (3 - 2 * progress);
  const remainder = 1 - smooth;
  return remainder * remainder;
}

export const ASSET_AUDIO_PROFILES: Readonly<Record<AssetSymbol, AssetAudioProfile>> = {
  BTC: { frequency: 220, accent: 0 },
  WTI: { frequency: 233.08, accent: -8 },
  ETH: { frequency: 246.94, accent: -4 },
  SOL: { frequency: 277.18, accent: 3 },
  XRP: { frequency: 293.66, accent: -7 },
  DOGE: { frequency: 329.63, accent: 6 },
  BNB: { frequency: 369.99, accent: -2 },
  LINK: { frequency: 440, accent: 4 },
  AVAX: { frequency: 493.88, accent: -5 },
  TEST: { frequency: 523.25, accent: 9 },
  PUMP: { frequency: 587.33, accent: 5 },
  ANSEM: { frequency: 261.63, accent: -9 },
  SHFL: { frequency: 415.3, accent: 7 },
  SKHYNIX: { frequency: 311.13, accent: -6 },
  HYPE: { frequency: 554.37, accent: 10 },
  XYZ100: { frequency: 349.23, accent: 1 },
  SP500: { frequency: 392, accent: -1 },
  MU: { frequency: 466.16, accent: -6 },
  SPACEX: { frequency: 568, accent: 12 },
  NVDA: { frequency: 269.29, accent: 8 },
  GOLD: { frequency: 427.47, accent: 2 },
  AAPL: { frequency: 301.99, accent: 5 },
  META: { frequency: 339.29, accent: -3 },
  GOOGL: { frequency: 452.89, accent: 7 },
};

/**
 * Fixed one-minute return thresholds, expressed as ratios rather than percents.
 * For example, 0.0001 is 0.01%. These deliberately sit well below daily-chart
 * alert levels: a live one-minute candle should reach medium regularly, large
 * during an energetic minute, and exceptional only on a genuinely sharp move.
 */
export const MARKET_MOVE_THRESHOLDS = Object.freeze({
  medium: 0.0001,
  large: 0.00035,
  exceptional: 0.001,
} as const);

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Compresses market moves into a calm, bounded audio intensity. */
export function normaliseMoveIntensity(moveRatio: number): number {
  if (!Number.isFinite(moveRatio)) return 0;
  return Math.sqrt(Math.min(Math.abs(moveRatio), 0.02) / 0.02);
}

/**
 * A perceptual market-move curve. Tiny trade-to-trade changes stay delicate,
 * while unusual one-minute moves quickly become expressive without reaching
 * unbounded gain values.
 */
export function marketMoveSeverity(moveRatio: number): number {
  if (!Number.isFinite(moveRatio)) return 0;
  const magnitude = Math.abs(moveRatio);
  return clampUnit(
    Math.log1p(magnitude / 0.000025)
    / Math.log1p(MARKET_MOVE_THRESHOLDS.exceptional / 0.000025),
  );
}

/** Classifies an absolute or signed current one-minute return. */
export function classifyMarketMove(moveRatio: number): MarketMoveClass {
  const magnitude = Number.isFinite(moveRatio) ? Math.abs(moveRatio) : 0;
  if (magnitude >= MARKET_MOVE_THRESHOLDS.exceptional) return 'exceptional';
  if (magnitude >= MARKET_MOVE_THRESHOLDS.large) return 'large';
  if (magnitude >= MARKET_MOVE_THRESHOLDS.medium) return 'medium';
  return 'small';
}

/**
 * Peak gain for one voice in the market gesture. Tier steps are intentionally
 * pronounced so a large move reads as an event even after positional rolloff.
 */
export function marketMovePeakGain(moveRatio: number): number {
  const severity = marketMoveSeverity(moveRatio);
  return Math.min(0.12, 0.035 + severity * 0.085);
}

/** A larger move adds a lower, weightier chart heartbeat without harsh sub-bass. */
export function marketBassFrequency(moveRatio: number): number {
  return 180 - marketMoveSeverity(moveRatio) * 85;
}

/** Keeps both notes of a market gesture inside the calm midrange. */
export function marketGestureFrequencies(
  baseFrequency: number,
  direction: 'up' | 'down',
): readonly [number, number] {
  const base = Math.min(523.25, Math.max(220, baseFrequency));
  if (direction === 'up') return [base, Math.min(587.33, base * 1.12246)];
  return [Math.min(587.33, base * 1.05946), Math.max(220, base * 0.8909)];
}
