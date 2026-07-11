import type { AssetSymbol } from '../types';
import type { AssetAudioProfile, MarketMoveClass } from './types';

export const ASSET_AUDIO_PROFILES: Readonly<Record<AssetSymbol, AssetAudioProfile>> = {
  BTC: { frequency: 220, accent: 0 },
  ETH: { frequency: 246.94, accent: -4 },
  SOL: { frequency: 277.18, accent: 3 },
  XRP: { frequency: 293.66, accent: -7 },
  DOGE: { frequency: 329.63, accent: 6 },
  BNB: { frequency: 369.99, accent: -2 },
  LINK: { frequency: 440, accent: 4 },
  AVAX: { frequency: 493.88, accent: -5 },
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
  return clampUnit(Math.log1p(magnitude / 0.000025) / Math.log1p(0.003 / 0.000025));
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
  switch (classifyMarketMove(moveRatio)) {
    case 'exceptional':
      return 0.12 + severity * 0.04;
    case 'large':
      return 0.085 + severity * 0.035;
    case 'medium':
      return 0.036 + severity * 0.024;
    case 'small':
      return 0.016 + severity * 0.022;
  }
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
