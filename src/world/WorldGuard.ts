import {
  MAX_SPRINT_SPEED,
  PODIUM_EXCLUSION_RADIUS as SHARED_PODIUM_RADIUS,
  WORLD_RADIUS,
  isAllowedWorldXZ,
  resolveWorldXZ as resolveSharedWorldXZ,
  type WorldGuard as SharedWorldGuard,
} from '../../shared/src/index.js';

export const WORLD_BOUNDARY_RADIUS = WORLD_RADIUS;
export const PODIUM_EXCLUSION_RADIUS = SHARED_PODIUM_RADIUS;

export interface WorldXZ {
  readonly x: number;
  readonly z: number;
}

export interface WorldGuardOptions {
  readonly centerX?: number;
  readonly centerZ?: number;
  readonly boundaryRadius?: number;
  readonly podiumRadius?: number;
}

export interface WorldGuardResolution extends WorldXZ {
  readonly boundaryAdjusted: boolean;
  readonly podiumAdjusted: boolean;
}

interface NormalizedWorldGuardOptions {
  readonly centerX: number;
  readonly centerZ: number;
  readonly boundaryRadius: number;
  readonly podiumRadius: number;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeOptions(options: WorldGuardOptions = {}): NormalizedWorldGuardOptions {
  const boundaryRadius = Math.max(0, finite(options.boundaryRadius ?? WORLD_BOUNDARY_RADIUS, WORLD_BOUNDARY_RADIUS));
  const podiumRadius = Math.min(
    boundaryRadius,
    Math.max(0, finite(options.podiumRadius ?? PODIUM_EXCLUSION_RADIUS, PODIUM_EXCLUSION_RADIUS)),
  );
  return {
    centerX: finite(options.centerX ?? 0, 0),
    centerZ: finite(options.centerZ ?? 0, 0),
    boundaryRadius,
    podiumRadius,
  };
}

function sharedGuard(options: NormalizedWorldGuardOptions): SharedWorldGuard {
  return {
    worldRadius: options.boundaryRadius,
    podiumRadius: options.podiumRadius,
    maxSprintSpeed: MAX_SPRINT_SPEED,
  };
}

/** Shared predicate for player validation and camera collision. */
export function isForbiddenWorldXZ(
  x: number,
  z: number,
  options: WorldGuardOptions = {},
): boolean {
  const normalized = normalizeOptions(options);
  return !isAllowedWorldXZ(
    x - normalized.centerX,
    z - normalized.centerZ,
    sharedGuard(normalized),
  );
}

/**
 * Projects a proposed point into the playable annulus through the exact shared
 * client/server rule. Coordinates are translated only to support testable
 * non-origin guards; the production world is centred at the origin.
 */
export function resolveWorldXZ(
  previousX: number,
  previousZ: number,
  proposedX: number,
  proposedZ: number,
  options: WorldGuardOptions = {},
): WorldGuardResolution {
  const normalized = normalizeOptions(options);
  const current = {
    x: finite(previousX, normalized.centerX + normalized.podiumRadius) - normalized.centerX,
    z: finite(previousZ, normalized.centerZ) - normalized.centerZ,
  };
  const desired = {
    x: proposedX - normalized.centerX,
    z: proposedZ - normalized.centerZ,
  };
  const result = resolveSharedWorldXZ(current, desired, sharedGuard(normalized));
  return {
    x: result.x + normalized.centerX,
    z: result.z + normalized.centerZ,
    boundaryAdjusted: result.bounded,
    podiumAdjusted: result.excluded,
  };
}

/** Stateful convenience wrapper with a FoxPlayer-compatible resolver. */
export class WorldGuard {
  public readonly centerX: number;
  public readonly centerZ: number;
  public readonly boundaryRadius: number;
  public readonly podiumRadius: number;

  public constructor(options: WorldGuardOptions = {}) {
    const normalized = normalizeOptions(options);
    this.centerX = normalized.centerX;
    this.centerZ = normalized.centerZ;
    this.boundaryRadius = normalized.boundaryRadius;
    this.podiumRadius = normalized.podiumRadius;
  }

  public readonly resolveHorizontal = (
    previousX: number,
    previousZ: number,
    proposedX: number,
    proposedZ: number,
  ): WorldXZ => this.resolve(previousX, previousZ, proposedX, proposedZ);

  public resolve(
    previousX: number,
    previousZ: number,
    proposedX: number,
    proposedZ: number,
  ): WorldGuardResolution {
    return resolveWorldXZ(previousX, previousZ, proposedX, proposedZ, this);
  }

  public collides(x: number, z: number): boolean {
    return isForbiddenWorldXZ(x, z, this);
  }

  public contains(x: number, z: number): boolean {
    return !this.collides(x, z);
  }
}
