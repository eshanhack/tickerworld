import type { SurfaceKind } from '../types';

export interface StoneGroundSample {
  readonly height: number;
  readonly surface: Extract<SurfaceKind, 'stone'>;
}

export interface PlazaLayer {
  readonly radius: number;
  readonly height: number;
  readonly centerY: number;
  readonly top: number;
}

export interface PlazaStep {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly top: number;
}

export const PLAZA_LAYERS: readonly PlazaLayer[] = [
  { radius: 10, height: 0.42, centerY: 0.1, top: 0.31 },
  { radius: 9.15, height: 0.32, centerY: 0.43, top: 0.59 },
  { radius: 8.2, height: 0.26, centerY: 0.71, top: 0.84 },
] as const;

export const PLAZA_STEPS: readonly PlazaStep[] = [
  { width: 3.5, height: 0.17, depth: 1.1, x: 0, y: 0.28, z: 9.1, top: 0.365 },
  { width: 4.1, height: 0.17, depth: 1.1, x: 0, y: 0.2, z: 9.78, top: 0.285 },
  { width: 4.7, height: 0.17, depth: 1.1, x: 0, y: 0.12, z: 10.46, top: 0.205 },
] as const;

export const MEDALLION_CENTER = { x: 0, y: 4.48, z: -1.55 } as const;
export const MEDALLION_RADIUS = 3.05;
export const MEDALLION_DEPTH = 0.86;

export const PLINTH_BOUNDS = {
  centerX: 0,
  centerY: 1.46,
  centerZ: -1.55,
  halfX: 3.65,
  halfY: 0.62,
  halfZ: 1.16,
} as const;

/** Exact walkable height for the meshes built by Monument.buildPlaza. */
export function sampleLocalStoneGround(localX: number, localZ: number): StoneGroundSample | null {
  let height = Number.NEGATIVE_INFINITY;
  const radiusSquared = localX * localX + localZ * localZ;

  for (const layer of PLAZA_LAYERS) {
    if (radiusSquared <= layer.radius * layer.radius) {
      height = Math.max(height, layer.top);
    }
  }

  for (const step of PLAZA_STEPS) {
    if (
      Math.abs(localX - step.x) <= step.width * 0.5
      && Math.abs(localZ - step.z) <= step.depth * 0.5
    ) {
      height = Math.max(height, step.top);
    }
  }

  if (!Number.isFinite(height)) {
    return null;
  }
  return { height, surface: 'stone' };
}

function pointInBox(
  x: number,
  y: number,
  z: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  halfX: number,
  halfY: number,
  halfZ: number,
): boolean {
  return Math.abs(x - centerX) <= halfX
    && Math.abs(y - centerY) <= halfY
    && Math.abs(z - centerZ) <= halfZ;
}

/** Static point collision in monument-local space, padded for a small camera probe. */
export function collidesLocalStaticCamera(localX: number, localY: number, localZ: number): boolean {
  const padding = 0.24;

  for (const layer of PLAZA_LAYERS) {
    const radialLimit = layer.radius + padding;
    if (
      localX * localX + localZ * localZ <= radialLimit * radialLimit
      && localY >= layer.centerY - layer.height * 0.5 - padding
      && localY <= layer.top + padding
    ) {
      return true;
    }
  }

  for (const step of PLAZA_STEPS) {
    if (pointInBox(
      localX,
      localY,
      localZ,
      step.x,
      step.y,
      step.z,
      step.width * 0.5 + padding,
      step.height * 0.5 + padding,
      step.depth * 0.5 + padding,
    )) {
      return true;
    }
  }

  if (pointInBox(
    localX,
    localY,
    localZ,
    PLINTH_BOUNDS.centerX,
    PLINTH_BOUNDS.centerY,
    PLINTH_BOUNDS.centerZ,
    PLINTH_BOUNDS.halfX + padding,
    PLINTH_BOUNDS.halfY + padding,
    PLINTH_BOUNDS.halfZ + padding,
  )) {
    return true;
  }

  return false;
}

/** Medallion collision in the local space used by buildMedallion. */
export function collidesLocalMedallionCamera(
  localX: number,
  localY: number,
  localZ: number,
): boolean {
  const padding = 0.24;

  const dx = localX - MEDALLION_CENTER.x;
  const dy = localY - MEDALLION_CENTER.y;
  return dx * dx + dy * dy <= (MEDALLION_RADIUS + padding) ** 2
    && Math.abs(localZ - MEDALLION_CENTER.z) <= MEDALLION_DEPTH * 0.5 + padding;
}

/** Legacy combined helper for callers whose medallion has not been rotated. */
export function collidesLocalCamera(localX: number, localY: number, localZ: number): boolean {
  return collidesLocalStaticCamera(localX, localY, localZ)
    || collidesLocalMedallionCamera(localX, localY, localZ);
}
