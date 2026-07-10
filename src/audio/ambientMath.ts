import { clampUnit } from './audioMath';

export const AMBIENT_KEY_DELAY_RANGE_SECONDS = [5, 10] as const;
export const AMBIENT_PAD_DELAY_RANGE_SECONDS = [24, 38] as const;

/** D major pentatonic in a bright, bell-piano register. */
export const D_MAJOR_PENTATONIC_HZ = [
  293.66, 329.63, 369.99, 440, 493.88,
  587.33, 659.25, 739.99, 880, 987.77,
] as const;

/** Airy add2/add6/sus voicings; no bass notes or functional song progression. */
export const AMBIENT_PAD_VOICINGS = [
  [146.83, 220, 329.63, 493.88],
  [164.81, 246.94, 369.99, 587.33],
  [185, 220, 293.66, 440],
  [220, 329.63, 369.99, 493.88],
  [246.94, 369.99, 440, 659.25],
] as const;

export interface ColoredNoiseState {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly b3: number;
  readonly b4: number;
  readonly b5: number;
  readonly b6: number;
  readonly brown: number;
}

export interface ColoredNoiseStep {
  readonly sample: number;
  readonly state: ColoredNoiseState;
}

export const EMPTY_COLORED_NOISE_STATE: ColoredNoiseState = {
  b0: 0,
  b1: 0,
  b2: 0,
  b3: 0,
  b4: 0,
  b5: 0,
  b6: 0,
  brown: 0,
};

export function delayInRange(
  randomValue: number,
  range: readonly [number, number],
): number {
  const random = clampUnit(randomValue);
  return range[0] + random * (range[1] - range[0]);
}

/** Uniformly chooses any entry except the previous one. */
export function pickNonRepeatingIndex(
  randomValue: number,
  previousIndex: number,
  count: number,
): number {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount <= 1) return 0;
  if (previousIndex < 0 || previousIndex >= safeCount) {
    return Math.min(safeCount - 1, Math.floor(clampUnit(randomValue) * safeCount));
  }
  const slot = Math.min(safeCount - 2, Math.floor(clampUnit(randomValue) * (safeCount - 1)));
  return slot >= previousIndex ? slot + 1 : slot;
}

/** Picks a nearby pentatonic answer note without repeating the call note. */
export function pickAmbientResponseIndex(
  primaryIndex: number,
  randomValue: number,
  count = D_MAJOR_PENTATONIC_HZ.length,
): number {
  const safeCount = Math.max(2, Math.floor(count));
  const primary = Math.min(safeCount - 1, Math.max(0, Math.floor(primaryIndex)));
  const step = clampUnit(randomValue) < 0.5 ? 2 : 3;
  return primary + step < safeCount
    ? primary + step
    : Math.max(0, primary - step);
}

/** One deterministic step of a blended pink/brown atmosphere generator. */
export function nextColoredNoiseSample(
  whiteInput: number,
  previous: ColoredNoiseState,
): ColoredNoiseStep {
  const white = Math.min(1, Math.max(-1, Number.isFinite(whiteInput) ? whiteInput : 0));
  const b0 = 0.99886 * previous.b0 + white * 0.0555179;
  const b1 = 0.99332 * previous.b1 + white * 0.0750759;
  const b2 = 0.969 * previous.b2 + white * 0.153852;
  const b3 = 0.8665 * previous.b3 + white * 0.3104856;
  const b4 = 0.55 * previous.b4 + white * 0.5329522;
  const b5 = -0.7616 * previous.b5 - white * 0.016898;
  const b6 = white * 0.115926;
  const brown = previous.brown * 0.985 + white * 0.015;
  const pink = b0 + b1 + b2 + b3 + b4 + b5 + previous.b6 + white * 0.5362;
  const sample = Math.min(1, Math.max(-1, pink * 0.105 + brown * 0.42));
  return {
    sample,
    state: { b0, b1, b2, b3, b4, b5, b6, brown },
  };
}
