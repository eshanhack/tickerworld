const UINT32_RANGE = 4_294_967_296;
const WORLD_SEED = 'tickerworld-v1';
const ROAD_TARGETS = [
  [190, 70],
  [-240, 150],
  [100, -310],
  [380, 220],
  [-420, -240],
  [-80, 520],
  [510, -400],
] as const;

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash >>> 0);
}

function hashCoordinate(seed: number, x: number, z: number): number {
  return mix32((seed ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(z | 0, 0x85ebca77)) >>> 0)
    / UINT32_RANGE;
}

function smooth(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  return lerp(
    lerp(hashCoordinate(seed, x0, z0), hashCoordinate(seed, x0 + 1, z0), tx),
    lerp(hashCoordinate(seed, x0, z0 + 1), hashCoordinate(seed, x0 + 1, z0 + 1), tx),
    tz,
  ) * 2 - 1;
}

function fbm(x: number, z: number, seed: number, octaves: number, lacunarity: number, gain: number): number {
  let frequency = 1;
  let amplitude = 1;
  let total = 0;
  let amplitudeTotal = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(x * frequency, z * frequency, seed + octave * 1_013) * amplitude;
    amplitudeTotal += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return total / amplitudeTotal;
}

function rawHeight(x: number, z: number): number {
  const seed = hashSeed(WORLD_SEED);
  return fbm(x / 112, z / 112, seed, 4, 2.05, 0.52) * 7.25
    + fbm(x / 31, z / 31, seed ^ 0xa53a9b4d, 3, 2.2, 0.43) * 1.25;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}

function distanceToRoad(x: number, z: number, endX: number, endZ: number): { distance: number; progress: number } {
  const lengthSquared = endX * endX + endZ * endZ;
  const progress = Math.max(0, Math.min(1, (x * endX + z * endZ) / lengthSquared));
  return {
    distance: Math.hypot(x - endX * progress, z - endZ * progress),
    progress,
  };
}

/**
 * Server-compatible height for the bounded district. It exactly matches the
 * seeded broad/detail noise and road/plaza shaping; pond depressions are
 * intentionally covered by the grounded-move tolerance.
 */
export function sampleBoundedTerrainHeight(x: number, z: number): number {
  let height = rawHeight(x, z);
  const originHeight = rawHeight(0, 0);
  const plazaBlend = 1 - smoothstep(17, 34, Math.hypot(x, z));
  height = lerp(height, originHeight, plazaBlend * 0.96);
  for (const [roadX, roadZ] of ROAD_TARGETS) {
    const road = distanceToRoad(x, z, roadX, roadZ);
    const pathBlend = 1 - smoothstep(3, 8, road.distance);
    if (pathBlend > 0) {
      height = lerp(height, lerp(originHeight, rawHeight(roadX, roadZ), road.progress), pathBlend * 0.7);
    }
  }
  return height;
}
