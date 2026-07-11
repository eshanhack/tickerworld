import {
  PODIUM_EXCLUSION_RADIUS,
  SPAWN_SLOT_COUNT,
  SPAWN_SLOT_SPACING,
  WORLD_RADIUS,
} from './constants.js';
import type { MarketSlug, SpawnAssignment } from './contracts.js';
import { createPortalRoutes } from './portals.js';
import { sampleBoundedTerrainHeight } from './terrain.js';

const SPAWN_COLUMNS = 10;
const SPAWN_ROWS = 5;
// Five outward rows end at 19.2 units, leaving a clear gap before the
// 24-unit portal trigger rings while remaining outside the 10.6-unit podium.
const INITIAL_BASE_RADIUS = 12;
const PORTAL_BASE_RADIUS = 28.5;

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function arrivalDirection(market: MarketSlug, fromMarket?: MarketSlug): { x: number; z: number } {
  if (fromMarket && fromMarket !== market) {
    const route = createPortalRoutes(market).find(({ to }) => to === fromMarket);
    if (route) {
      const length = Math.hypot(route.x, route.z) || 1;
      return { x: route.x / length, z: route.z / length };
    }
  }
  // Initial joins use the quiet southern plaza approach, away from the podium.
  return { x: 0, z: -1 };
}

/**
 * Builds fifty 1.8-unit-spaced slots in a shallow outward-facing grid. Portal
 * arrivals never extend back into the trigger ring, while initial joins remain
 * between the podium exclusion and the seven portal gates.
 */
export function createSpawnAssignments(
  market: MarketSlug,
  fromMarket?: MarketSlug,
): readonly SpawnAssignment[] {
  const direction = arrivalDirection(market, fromMarket);
  const tangent = { x: -direction.z, z: direction.x };
  const baseRadius = fromMarket && fromMarket !== market
    ? PORTAL_BASE_RADIUS
    : INITIAL_BASE_RADIUS;
  const assignments: SpawnAssignment[] = [];

  for (let row = 0; row < SPAWN_ROWS; row += 1) {
    for (let column = 0; column < SPAWN_COLUMNS; column += 1) {
      const slot = row * SPAWN_COLUMNS + column;
      const tangentOffset = (column - (SPAWN_COLUMNS - 1) / 2) * SPAWN_SLOT_SPACING;
      const radius = baseRadius + row * SPAWN_SLOT_SPACING;
      const x = direction.x * radius + tangent.x * tangentOffset;
      const z = direction.z * radius + tangent.z * tangentOffset;
      const distance = Math.hypot(x, z);
      if (distance < PODIUM_EXCLUSION_RADIUS || distance > WORLD_RADIUS) {
        throw new Error(`Spawn slot ${slot} violates the shared world guard.`);
      }
      assignments.push({
        slot,
        market,
        fromMarket: fromMarket && fromMarket !== market ? fromMarket : null,
        x,
        y: sampleBoundedTerrainHeight(x, z),
        z,
        yaw: Math.atan2(x, z),
      });
    }
  }

  if (assignments.length !== SPAWN_SLOT_COUNT) {
    throw new Error(`Expected ${SPAWN_SLOT_COUNT} spawn slots, received ${assignments.length}.`);
  }
  return assignments;
}

/** Selects an actor-stable preferred slot, then probes deterministically. */
export function allocateSpawnAssignment(
  actorId: string,
  market: MarketSlug,
  fromMarket?: MarketSlug,
  occupiedSlots: ReadonlySet<number> | readonly number[] = [],
): SpawnAssignment {
  const assignments = createSpawnAssignments(market, fromMarket);
  const occupied = occupiedSlots instanceof Set ? occupiedSlots : new Set(occupiedSlots);
  const preferred = stableHash(`${actorId}\u0000${market}\u0000${fromMarket ?? 'initial'}`)
    % SPAWN_SLOT_COUNT;
  for (let offset = 0; offset < SPAWN_SLOT_COUNT; offset += 1) {
    const candidate = assignments[(preferred + offset) % SPAWN_SLOT_COUNT];
    if (candidate && !occupied.has(candidate.slot)) return candidate;
  }
  // The room cap equals the slot count, so this is reachable only if callers
  // retained stale occupancy. Reuse the actor-stable slot instead of throwing.
  return assignments[preferred]!;
}
