const UINT32_MAX_PLUS_ONE = 4_294_967_296;

/** Stable FNV-1a string hash, kept in unsigned 32-bit space. */
export function hashSeed(value: string | number): number {
  if (typeof value === 'number') {
    return mix32(value >>> 0);
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash >>> 0);
}

/** A compact integer avalanche suitable for deterministic procedural layout. */
export function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

export function hashCoordinates(
  seed: number,
  x: number,
  z: number,
  salt = 0,
): number {
  const xHash = Math.imul(x | 0, 0x9e3779b1);
  const zHash = Math.imul(z | 0, 0x85ebca77);
  const saltHash = Math.imul(salt | 0, 0xc2b2ae3d);
  return mix32((seed ^ xHash ^ zHash ^ saltHash) >>> 0) / UINT32_MAX_PLUS_ONE;
}

/** Mulberry32-derived deterministic random stream. */
export function createRandom(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_MAX_PLUS_ONE;
  };
}

function smooth(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** Seamless value noise in [-1, 1] for arbitrary global coordinates. */
export function valueNoise2D(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const top = lerp(
    hashCoordinates(seed, x0, z0),
    hashCoordinates(seed, x0 + 1, z0),
    tx,
  );
  const bottom = lerp(
    hashCoordinates(seed, x0, z0 + 1),
    hashCoordinates(seed, x0 + 1, z0 + 1),
    tx,
  );
  return lerp(top, bottom, tz) * 2 - 1;
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
}

/** Normalized fractal noise in approximately [-1, 1]. */
export function fbm2D(
  x: number,
  z: number,
  seed: number,
  options: FbmOptions = {},
): number {
  const octaves = options.octaves ?? 4;
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;
  let frequency = 1;
  let amplitude = 1;
  let total = 0;
  let amplitudeTotal = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise2D(x * frequency, z * frequency, seed + octave * 1_013) * amplitude;
    amplitudeTotal += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return amplitudeTotal === 0 ? 0 : total / amplitudeTotal;
}
