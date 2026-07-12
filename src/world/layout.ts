import { ASSET_SYMBOLS } from '../types';
import type { AssetSymbol, ChunkDescriptor } from '../types';
import { createRandom, hashSeed } from './random';
import { createRoadSignExclusionPoints } from './RoadSignLayout';
import type { MonumentCoordinate, PondDescriptor } from './terrain';
import { TerrainSampler } from './terrain';

export const ECHO_MACROCELL_CHUNKS = 6;
export const ECHO_SCALE = 0.6;
export const ECHO_GRAND_SUPPRESSION_RADIUS = 132;

export interface GrandMonumentCoordinate extends MonumentCoordinate {
  symbol: AssetSymbol;
}

export interface EchoPlacementDescriptor {
  key: string;
  macroX: number;
  macroZ: number;
  chunkX: number;
  chunkZ: number;
  x: number;
  z: number;
  symbol: AssetSymbol;
  scale: number;
}

export type PropKind = 'tree' | 'bush' | 'rock' | 'flower' | 'grass' | 'lamp' | 'bench';

export interface PropPlacement {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  colorVariant: number;
}

export interface ChunkLayout {
  descriptor: ChunkDescriptor;
  echo: EchoPlacementDescriptor | null;
  props: readonly PropPlacement[];
  ponds: readonly PondDescriptor[];
}

export interface ChunkLayoutOptions {
  seed: string | number;
  chunkX: number;
  chunkZ: number;
  chunkSize: number;
  terrain: TerrainSampler;
  monuments: readonly GrandMonumentCoordinate[];
  echoSuppressionRadius?: number;
}

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX}:${chunkZ}`;
}

function tooCloseTo(
  x: number,
  z: number,
  points: readonly MonumentCoordinate[],
  radius: number,
): boolean {
  return points.some((point) => Math.hypot(x - point.x, z - point.z) < radius);
}

export function macrocellForChunk(chunkX: number, chunkZ: number): { x: number; z: number } {
  return {
    x: Math.floor(chunkX / ECHO_MACROCELL_CHUNKS),
    z: Math.floor(chunkZ / ECHO_MACROCELL_CHUNKS),
  };
}

/** Returns the macrocell's sole echo candidate, or null near a grand plaza. */
export function echoPlacementForMacrocell(
  seed: string | number,
  macroX: number,
  macroZ: number,
  chunkSize: number,
  monuments: readonly MonumentCoordinate[],
  suppressionRadius = ECHO_GRAND_SUPPRESSION_RADIUS,
): EchoPlacementDescriptor | null {
  const random = createRandom(`${seed}:echo:${macroX}:${macroZ}`);
  const localChunkX = Math.min(
    ECHO_MACROCELL_CHUNKS - 1,
    Math.floor(random() * ECHO_MACROCELL_CHUNKS),
  );
  const localChunkZ = Math.min(
    ECHO_MACROCELL_CHUNKS - 1,
    Math.floor(random() * ECHO_MACROCELL_CHUNKS),
  );
  const chunkX = macroX * ECHO_MACROCELL_CHUNKS + localChunkX;
  const chunkZ = macroZ * ECHO_MACROCELL_CHUNKS + localChunkZ;
  const x = chunkX * chunkSize + (random() - 0.5) * chunkSize * 0.42;
  const z = chunkZ * chunkSize + (random() - 0.5) * chunkSize * 0.42;

  if (tooCloseTo(x, z, monuments, suppressionRadius)) {
    return null;
  }

  const symbolIndex = Math.min(ASSET_SYMBOLS.length - 1, Math.floor(random() * ASSET_SYMBOLS.length));
  const symbol = ASSET_SYMBOLS[symbolIndex];
  if (!symbol) {
    return null;
  }

  return {
    key: `echo:${macroX}:${macroZ}`,
    macroX,
    macroZ,
    chunkX,
    chunkZ,
    x,
    z,
    symbol,
    scale: ECHO_SCALE,
  };
}

export function describeChunk(
  seed: string | number,
  chunkX: number,
  chunkZ: number,
  chunkSize: number,
  monuments: readonly GrandMonumentCoordinate[],
  echoSuppressionRadius = ECHO_GRAND_SUPPRESSION_RADIUS,
): { descriptor: ChunkDescriptor; echo: EchoPlacementDescriptor | null } {
  const macrocell = macrocellForChunk(chunkX, chunkZ);
  const macroEcho = echoPlacementForMacrocell(
    seed,
    macrocell.x,
    macrocell.z,
    chunkSize,
    monuments,
    echoSuppressionRadius,
  );
  const echo = macroEcho?.chunkX === chunkX && macroEcho.chunkZ === chunkZ ? macroEcho : null;

  return {
    descriptor: {
      chunkX,
      chunkZ,
      seed: hashSeed(`${seed}:chunk:${chunkX}:${chunkZ}`),
      hasEchoMonument: echo !== null,
      ...(echo ? { echoSymbol: echo.symbol } : {}),
    },
    echo,
  };
}

export function generateChunkLayout(options: ChunkLayoutOptions): ChunkLayout {
  const {
    seed,
    chunkX,
    chunkZ,
    chunkSize,
    terrain,
    monuments,
    echoSuppressionRadius = ECHO_GRAND_SUPPRESSION_RADIUS,
  } = options;
  const random = createRandom(`${seed}:props:${chunkX}:${chunkZ}`);
  const props: PropPlacement[] = [];
  const pond = terrain.pondForChunk(chunkX, chunkZ);
  const ponds = pond ? [pond] : [];
  const { descriptor, echo } = describeChunk(
    seed,
    chunkX,
    chunkZ,
    chunkSize,
    monuments,
    echoSuppressionRadius,
  );
  const half = chunkSize * 0.5;
  const roadSignExclusions = createRoadSignExclusionPoints(monuments);

  const candidateIsClear = (x: number, z: number, spacing: number): boolean => {
    if (echo && Math.hypot(x - echo.x, z - echo.z) < 22) {
      return false;
    }
    if (pond && Math.hypot(x - pond.x, z - pond.z) < pond.radius + 2.5) {
      return false;
    }
    return !props.some((prop) => Math.hypot(x - prop.x, z - prop.z) < spacing);
  };

  const addNaturalProps = (kind: PropKind, wanted: number, spacing: number): void => {
    let placed = 0;
    const maxAttempts = wanted * 12;
    for (let attempt = 0; attempt < maxAttempts && placed < wanted; attempt += 1) {
      const x = chunkX * chunkSize + (random() - 0.5) * (chunkSize - 6);
      const z = chunkZ * chunkSize + (random() - 0.5) * (chunkSize - 6);
      if (terrain.surfaceAt(x, z) !== 'grass' || !candidateIsClear(x, z, spacing)) {
        continue;
      }
      const baseScale = 0.72 + random() * 0.62;
      props.push({
        kind,
        x,
        y: terrain.heightAt(x, z),
        z,
        rotationY: random() * Math.PI * 2,
        scaleX: baseScale * (0.84 + random() * 0.32),
        scaleY: baseScale * (0.84 + random() * 0.4),
        scaleZ: baseScale * (0.84 + random() * 0.32),
        colorVariant: random(),
      });
      placed += 1;
    }
  };

  addNaturalProps('tree', 4 + Math.floor(random() * 5), 4.6);
  addNaturalProps('bush', 3 + Math.floor(random() * 5), 2.4);
  addNaturalProps('rock', 2 + Math.floor(random() * 4), 2.2);
  addNaturalProps('flower', 7 + Math.floor(random() * 8), 0.75);
  // Ground foliage shares one instanced draw with the flower clusters. A
  // generous count makes the bounded worlds feel planted without adding
  // individual meshes, materials, or frame-time-dependent randomness.
  addNaturalProps('grass', 20 + Math.floor(random() * 14), 0.48);

  const addPathProp = (kind: 'lamp' | 'bench', wanted: number): void => {
    let placed = 0;
    for (let attempt = 0; attempt < wanted * 70 && placed < wanted; attempt += 1) {
      const x = chunkX * chunkSize + (random() - 0.5) * (chunkSize - 5);
      const z = chunkZ * chunkSize + (random() - 0.5) * (chunkSize - 5);
      const surface = terrain.surfaceAt(x, z);
      if (surface === 'grass'
        || tooCloseTo(x, z, monuments, 11)
        || roadSignExclusions.some((point) => Math.hypot(x - point.x, z - point.z) < point.radius)
        || !candidateIsClear(x, z, kind === 'lamp' ? 7 : 5)) {
        continue;
      }
      const baseScale = 0.88 + random() * 0.22;
      props.push({
        kind,
        x,
        y: terrain.heightAt(x, z),
        z,
        rotationY: random() * Math.PI * 2,
        scaleX: baseScale,
        scaleY: baseScale,
        scaleZ: baseScale,
        colorVariant: random(),
      });
      placed += 1;
    }
  };

  if (random() < 0.58) {
    addPathProp('lamp', 1 + Math.floor(random() * 2));
  }
  if (random() < 0.36) {
    addPathProp('bench', 1);
  }

  // Keep the generated coordinates inside their owning centered chunk.
  for (const prop of props) {
    prop.x = Math.max(chunkX * chunkSize - half, Math.min(chunkX * chunkSize + half, prop.x));
    prop.z = Math.max(chunkZ * chunkSize - half, Math.min(chunkZ * chunkSize + half, prop.z));
  }

  return { descriptor, echo, props, ponds };
}

export function keyForChunk(chunkX: number, chunkZ: number): string {
  return chunkKey(chunkX, chunkZ);
}
