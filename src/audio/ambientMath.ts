import { clampUnit } from './audioMath';

export const AMBIENT_KEY_DELAY_RANGE_SECONDS = [9, 17] as const;
export const AMBIENT_PAD_DELAY_RANGE_SECONDS = [18, 28] as const;

/** D major pentatonic, kept in a soft piano-like register. */
export const D_MAJOR_PENTATONIC_HZ = [
  146.83, 164.81, 185, 220, 246.94,
  293.66, 329.63, 369.99, 440, 493.88,
] as const;

/** Open add2/add6 voicings. Adjacent entries deliberately avoid a functional song progression. */
export const AMBIENT_PAD_VOICINGS = [
  [73.42, 82.41, 92.5, 110],
  [98, 123.47, 146.83, 164.81],
  [110, 123.47, 138.59, 164.81],
  [82.41, 98, 123.47, 138.59],
  [61.74, 69.3, 73.42, 92.5],
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
