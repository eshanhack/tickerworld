import type { AssetSymbol } from '../types';
import type { AssetAudioProfile } from './types';

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

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Compresses market moves into a calm, bounded audio intensity. */
export function normaliseMoveIntensity(moveRatio: number): number {
  if (!Number.isFinite(moveRatio)) return 0;
  return Math.sqrt(Math.min(Math.abs(moveRatio), 0.02) / 0.02);
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
