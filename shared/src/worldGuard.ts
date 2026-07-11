import {
  MAX_SPRINT_SPEED,
  PODIUM_EXCLUSION_RADIUS,
  WORLD_RADIUS,
} from './constants.js';
import type { Vec2, WorldGuard } from './contracts.js';

export const DEFAULT_WORLD_GUARD: Readonly<WorldGuard> = Object.freeze({
  worldRadius: WORLD_RADIUS,
  podiumRadius: PODIUM_EXCLUSION_RADIUS,
  maxSprintSpeed: MAX_SPRINT_SPEED,
});

export interface WorldResolution {
  x: number;
  z: number;
  bounded: boolean;
  excluded: boolean;
}

export function isFinitePosition(position: { x: number; y?: number; z: number }): boolean {
  return Number.isFinite(position.x)
    && Number.isFinite(position.z)
    && (position.y === undefined || Number.isFinite(position.y));
}

export function isAllowedWorldXZ(
  x: number,
  z: number,
  guard: WorldGuard = DEFAULT_WORLD_GUARD,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const radius = Math.hypot(x, z);
  return radius <= guard.worldRadius && radius >= guard.podiumRadius;
}

/**
 * Applies the same bounded-world and sacred-podium rule on the client and server.
 * A stable fallback direction prevents NaN/teleport behavior at the exact origin.
 */
export function resolveWorldXZ(
  current: Vec2,
  desired: Vec2,
  guard: WorldGuard = DEFAULT_WORLD_GUARD,
): WorldResolution {
  if (!isFinitePosition(desired)) {
    return { x: current.x, z: current.z, bounded: true, excluded: true };
  }

  let x = desired.x;
  let z = desired.z;
  let bounded = false;
  let excluded = false;
  let radius = Math.hypot(x, z);

  if (radius > guard.worldRadius) {
    const scale = guard.worldRadius / radius;
    x *= scale;
    z *= scale;
    radius = guard.worldRadius;
    bounded = true;
  }

  if (radius < guard.podiumRadius) {
    let directionX = x;
    let directionZ = z;
    let directionLength = radius;
    if (directionLength < 0.0001) {
      directionX = current.x;
      directionZ = current.z;
      directionLength = Math.hypot(directionX, directionZ);
    }
    if (directionLength < 0.0001) {
      directionX = 0;
      directionZ = 1;
      directionLength = 1;
    }
    x = directionX / directionLength * guard.podiumRadius;
    z = directionZ / directionLength * guard.podiumRadius;
    excluded = true;
  }

  return { x, z, bounded, excluded };
}

export function horizontalDistance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function maximumHorizontalTravel(
  elapsedMs: number,
  maxSpeed = MAX_SPRINT_SPEED,
  latencyToleranceSeconds = 0.18,
): number {
  const elapsedSeconds = Math.max(0, Math.min(elapsedMs / 1_000, 1));
  return maxSpeed * (elapsedSeconds + latencyToleranceSeconds);
}
