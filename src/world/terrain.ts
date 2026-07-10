import type { SurfaceKind } from '../types';
import { fbm2D, hashCoordinates, hashSeed } from './random';

export interface MonumentCoordinate {
  x: number;
  z: number;
}

export interface PondDescriptor {
  chunkX: number;
  chunkZ: number;
  x: number;
  z: number;
  radius: number;
  waterLevel: number;
}

export interface TerrainSamplerOptions {
  seed: string | number;
  chunkSize?: number;
  monuments?: readonly MonumentCoordinate[];
}

interface SegmentDistance {
  distance: number;
  progress: number;
}

const DEFAULT_CHUNK_SIZE = 48;
const PATH_WIDTH = 3.4;
const PATH_FLATTEN_RADIUS = 8;
const POND_CACHE_LIMIT = 256;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function distanceToSegment(
  x: number,
  z: number,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
): SegmentDistance {
  const segmentX = endX - startX;
  const segmentZ = endZ - startZ;
  const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
  if (lengthSquared < 0.0001) {
    return { distance: Math.hypot(x - startX, z - startZ), progress: 0 };
  }

  const progress = clamp01(
    ((x - startX) * segmentX + (z - startZ) * segmentZ) / lengthSquared,
  );
  const closestX = startX + segmentX * progress;
  const closestZ = startZ + segmentZ * progress;
  return { distance: Math.hypot(x - closestX, z - closestZ), progress };
}

/**
 * Owns all global-coordinate terrain queries. Sampling never depends on chunk
 * load order, which is what guarantees matching borders.
 */
export class TerrainSampler {
  readonly seed: number;
  readonly chunkSize: number;
  readonly monuments: readonly MonumentCoordinate[];
  private readonly pondCache = new Map<string, PondDescriptor | null>();

  constructor(options: TerrainSamplerOptions) {
    this.seed = hashSeed(options.seed);
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.monuments = options.monuments ? [...options.monuments] : [];
  }

  rawHeightAt(x: number, z: number): number {
    const broad = fbm2D(x / 112, z / 112, this.seed, {
      octaves: 4,
      lacunarity: 2.05,
      gain: 0.52,
    });
    const detail = fbm2D(x / 31, z / 31, this.seed ^ 0xa53a9b4d, {
      octaves: 3,
      lacunarity: 2.2,
      gain: 0.43,
    });
    return broad * 7.25 + detail * 1.25;
  }

  private shapedHeightWithoutPonds(x: number, z: number): number {
    let height = this.rawHeightAt(x, z);
    const originHeight = this.rawHeightAt(0, 0);

    for (const monument of this.monuments) {
      const distance = Math.hypot(x - monument.x, z - monument.z);
      const plazaBlend = 1 - smoothstep(17, 34, distance);
      if (plazaBlend > 0) {
        height = lerp(height, this.rawHeightAt(monument.x, monument.z), plazaBlend * 0.96);
      }

      if (Math.abs(monument.x) + Math.abs(monument.z) < 0.001) {
        continue;
      }
      const path = distanceToSegment(x, z, 0, 0, monument.x, monument.z);
      const pathBlend = 1 - smoothstep(3, PATH_FLATTEN_RADIUS, path.distance);
      if (pathBlend > 0) {
        const destinationHeight = this.rawHeightAt(monument.x, monument.z);
        const pathHeight = lerp(originHeight, destinationHeight, path.progress);
        height = lerp(height, pathHeight, pathBlend * 0.7);
      }
    }

    return height;
  }

  private pathDistanceAt(x: number, z: number): number {
    let closest = Number.POSITIVE_INFINITY;
    for (const monument of this.monuments) {
      if (Math.abs(monument.x) + Math.abs(monument.z) < 0.001) {
        continue;
      }
      closest = Math.min(
        closest,
        distanceToSegment(x, z, 0, 0, monument.x, monument.z).distance,
      );
    }
    return closest;
  }

  pondForChunk(chunkX: number, chunkZ: number): PondDescriptor | null {
    const cacheKey = `${chunkX}:${chunkZ}`;
    const cached = this.pondCache.get(cacheKey);
    if (cached !== undefined || this.pondCache.has(cacheKey)) {
      // Refresh insertion order so this remains a small LRU during long roams.
      this.pondCache.delete(cacheKey);
      this.pondCache.set(cacheKey, cached ?? null);
      return cached ?? null;
    }

    let pond: PondDescriptor | null = null;
    if (hashCoordinates(this.seed, chunkX, chunkZ, 4_091) > 0.12) {
      this.cachePond(cacheKey, null);
      return null;
    }

    const half = this.chunkSize * 0.5;
    const x = chunkX * this.chunkSize
      + (hashCoordinates(this.seed, chunkX, chunkZ, 4_093) - 0.5) * (this.chunkSize - 14);
    const z = chunkZ * this.chunkSize
      + (hashCoordinates(this.seed, chunkX, chunkZ, 4_099) - 0.5) * (this.chunkSize - 14);
    const radius = 3.6 + hashCoordinates(this.seed, chunkX, chunkZ, 4_111) * 2.8;

    if (Math.abs(x - chunkX * this.chunkSize) <= half - radius
      && Math.abs(z - chunkZ * this.chunkSize) <= half - radius
      && this.pathDistanceAt(x, z) >= radius + 5
      && !this.monuments.some((monument) => Math.hypot(x - monument.x, z - monument.z) < 42)) {
      pond = {
        chunkX,
        chunkZ,
        x,
        z,
        radius,
        waterLevel: this.shapedHeightWithoutPonds(x, z) - 0.28,
      };
    }

    this.cachePond(cacheKey, pond);
    return pond;
  }

  private cachePond(key: string, pond: PondDescriptor | null): void {
    this.pondCache.set(key, pond);
    if (this.pondCache.size <= POND_CACHE_LIMIT) {
      return;
    }
    const oldest = this.pondCache.keys().next().value;
    if (oldest !== undefined) {
      this.pondCache.delete(oldest);
    }
  }

  clearCache(): void {
    this.pondCache.clear();
  }

  heightAt(x: number, z: number): number {
    let height = this.shapedHeightWithoutPonds(x, z);
    const centerChunkX = Math.floor((x + this.chunkSize * 0.5) / this.chunkSize);
    const centerChunkZ = Math.floor((z + this.chunkSize * 0.5) / this.chunkSize);

    for (let chunkZ = centerChunkZ - 1; chunkZ <= centerChunkZ + 1; chunkZ += 1) {
      for (let chunkX = centerChunkX - 1; chunkX <= centerChunkX + 1; chunkX += 1) {
        const pond = this.pondForChunk(chunkX, chunkZ);
        if (!pond) {
          continue;
        }
        const distance = Math.hypot(x - pond.x, z - pond.z);
        const depression = 1 - smoothstep(pond.radius * 0.72, pond.radius + 1.6, distance);
        if (depression > 0) {
          height = lerp(height, pond.waterLevel - 0.48, depression);
        }
      }
    }

    return height;
  }

  surfaceAt(x: number, z: number): SurfaceKind {
    for (const monument of this.monuments) {
      const distance = Math.hypot(x - monument.x, z - monument.z);
      if (distance < 19) {
        return 'stone';
      }
      if (distance < 27) {
        return 'sand';
      }
    }

    if (this.pathDistanceAt(x, z) <= PATH_WIDTH) {
      return 'sand';
    }

    const centerChunkX = Math.floor((x + this.chunkSize * 0.5) / this.chunkSize);
    const centerChunkZ = Math.floor((z + this.chunkSize * 0.5) / this.chunkSize);
    for (let chunkZ = centerChunkZ - 1; chunkZ <= centerChunkZ + 1; chunkZ += 1) {
      for (let chunkX = centerChunkX - 1; chunkX <= centerChunkX + 1; chunkX += 1) {
        const pond = this.pondForChunk(chunkX, chunkZ);
        if (pond && Math.hypot(x - pond.x, z - pond.z) < pond.radius + 1.2) {
          return 'sand';
        }
      }
    }

    return 'grass';
  }
}
