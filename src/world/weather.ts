import { hashCoordinates, hashSeed } from './random';

export interface ThunderMoment {
  readonly at: number;
  readonly intensity: number;
}

export interface StormWindow {
  readonly id: string;
  readonly cycle: number;
  readonly start: number;
  readonly end: number;
  readonly peakIntensity: number;
  readonly thunder: readonly ThunderMoment[];
}

export interface RainState {
  readonly active: boolean;
  readonly intensity: number;
  readonly storm: StormWindow | null;
}

const STORM_CADENCE_CYCLES = 3;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function smoothstep01(value: number): number {
  const amount = Math.max(0, Math.min(1, value));
  return amount * amount * (3 - 2 * amount);
}

/**
 * One short storm every three world-days, with its night-time placement,
 * strength, and thunder moments derived only from the canonical world seed.
 */
export function stormWindowForCycle(
  seed: string,
  cycle: number,
  dayDurationSeconds: number,
): StormWindow | null {
  const duration = Math.max(60, dayDurationSeconds);
  const wholeCycle = Math.floor(cycle);
  const numericSeed = hashSeed(seed);
  const phase = numericSeed % STORM_CADENCE_CYCLES;
  if (positiveModulo(wholeCycle, STORM_CADENCE_CYCLES) !== phase) return null;

  // Deep night occupies roughly 0.29–0.71 of the current solar cycle. Keeping
  // storms inside 0.37–0.60 guarantees that rain never spills into daylight.
  const startRatio = 0.37 + hashCoordinates(numericSeed, wholeCycle, 0, 4_103) * 0.075;
  const stormDuration = Math.min(
    duration * 0.115,
    42 + hashCoordinates(numericSeed, wholeCycle, 0, 5_209) * 22,
  );
  const start = wholeCycle * duration + startRatio * duration;
  const end = start + stormDuration;
  const peakIntensity = 0.58 + hashCoordinates(numericSeed, wholeCycle, 0, 6_271) * 0.32;
  const firstThunderRatio = 0.28 + hashCoordinates(numericSeed, wholeCycle, 0, 7_313) * 0.16;
  const thunder: ThunderMoment[] = [{
    at: start + stormDuration * firstThunderRatio,
    intensity: 0.48 + hashCoordinates(numericSeed, wholeCycle, 0, 8_191) * 0.34,
  }];
  if (hashCoordinates(numericSeed, wholeCycle, 0, 9_223) < 0.52) {
    thunder.push({
      at: start + stormDuration * (0.7 + hashCoordinates(numericSeed, wholeCycle, 0, 10_267) * 0.12),
      intensity: 0.4 + hashCoordinates(numericSeed, wholeCycle, 0, 11_329) * 0.28,
    });
  }
  return {
    id: `${numericSeed}:${wholeCycle}`,
    cycle: wholeCycle,
    start,
    end,
    peakIntensity,
    thunder,
  };
}

export function rainStateAt(
  seed: string,
  elapsedSeconds: number,
  dayDurationSeconds: number,
): RainState {
  if (!Number.isFinite(elapsedSeconds)) return { active: false, intensity: 0, storm: null };
  const duration = Math.max(60, dayDurationSeconds);
  const cycle = Math.floor(elapsedSeconds / duration);
  const storm = stormWindowForCycle(seed, cycle, duration);
  if (!storm || elapsedSeconds < storm.start || elapsedSeconds >= storm.end) {
    return { active: false, intensity: 0, storm };
  }
  const fadeSeconds = Math.min(5, (storm.end - storm.start) * 0.2);
  const fadeIn = smoothstep01((elapsedSeconds - storm.start) / fadeSeconds);
  const fadeOut = smoothstep01((storm.end - elapsedSeconds) / fadeSeconds);
  return {
    active: true,
    intensity: storm.peakIntensity * Math.min(fadeIn, fadeOut),
    storm,
  };
}
