import type { AssetSymbol } from '../types';
import type { AssetAudioProfile } from './types';

export const ASSET_AUDIO_PROFILES: Readonly<Record<AssetSymbol, AssetAudioProfile>> = {
  BTC: { frequency: 523.25, accent: 0 },
  ETH: { frequency: 587.33, accent: -4 },
  SOL: { frequency: 659.25, accent: 3 },
  XRP: { frequency: 698.46, accent: -7 },
  DOGE: { frequency: 783.99, accent: 6 },
  BNB: { frequency: 880, accent: -2 },
  LINK: { frequency: 987.77, accent: 4 },
  AVAX: { frequency: 1046.5, accent: -5 },
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
