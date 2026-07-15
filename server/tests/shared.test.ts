import {
  ACCEPTED_PROTOCOL_VERSIONS,
  CHAT_SCOPES,
  DEX_FIELD_PORTAL_RADIUS,
  MARKET_SLUGS,
  MAX_SPRINT_SPEED,
  PODIUM_EXCLUSION_RADIUS,
  PORTAL_RADIUS,
  SIGNATURE_WORLD_PORTAL_RADIUS,
  SPAWN_SLOT_COUNT,
  SPAWN_SLOT_SPACING,
  SERVER_MESSAGES,
  WORLD_RADIUS,
  allocateSpawnAssignment,
  createSpawnAssignments,
  createPortalRoutes,
  isActorId,
  isAnimalKind,
  isAllowedWorldXZ,
  normalizeUsername,
  maximumHorizontalTravel,
  resolveWorldXZ,
  sampleBoundedTerrainHeight,
} from '@tickerworld/shared';
import { describe, expect, it } from 'vitest';

describe('shared multiplayer contracts', () => {
  it('accepts only current and previous protocol versions', () => {
    expect(ACCEPTED_PROTOCOL_VERSIONS).toEqual([2, 1]);
  });

  it('keeps the additive scoped-chat contract on protocol v2', () => {
    expect(CHAT_SCOPES).toEqual(['world', 'proximity']);
  });

  it('accepts the free Saylor fan-tribute character without widening arbitrary values', () => {
    expect(isAnimalKind('saylor')).toBe(true);
    expect(isAnimalKind('strategy')).toBe(false);
  });

  it('normalizes safe usernames without broadening the character set', () => {
    expect(normalizeUsername('  Magic_Fox  ')).toBe('Magic_Fox');
    expect(normalizeUsername('Ａdmin')).toBe('Admin');
    expect(normalizeUsername('two words')).toBeNull();
    expect(normalizeUsername('ab')).toBeNull();
  });

  it('accepts only bounded server-minted actor identifiers', () => {
    expect(isActorId(`anon_${'a'.repeat(32)}`)).toBe(true);
    expect(isActorId(`player_${'a'.repeat(57)}`)).toBe(true);
    expect(isActorId(`player_${'a'.repeat(58)}`)).toBe(false);
    expect(isActorId('anon_client_controlled')).toBe(false);
  });

  it('resolves both the world edge and podium exclusion deterministically', () => {
    const outer = resolveWorldXZ({ x: 20, z: 0 }, { x: 200, z: 0 });
    expect(Math.hypot(outer.x, outer.z)).toBeCloseTo(WORLD_RADIUS);
    expect(outer.bounded).toBe(true);
    const inner = resolveWorldXZ({ x: 0, z: 14 }, { x: 0, z: 0 });
    expect(Math.hypot(inner.x, inner.z)).toBeCloseTo(PODIUM_EXCLUSION_RADIUS);
    expect(inner.excluded).toBe(true);
    expect(isAllowedWorldXZ(inner.x, inner.z)).toBe(true);
  });

  it('uses the lightweight-species ceiling for authoritative travel tolerance', () => {
    expect(MAX_SPRINT_SPEED).toBe(8.4);
    expect(maximumHorizontalTravel(100)).toBeCloseTo(MAX_SPRINT_SPEED * 0.28);
  });

  it('maps each market to every other unique portal destination', () => {
    const canonicalSlots = createPortalRoutes('btc');
    const dexSlots = new Set(['pump', 'ansem', 'shfl']);
    const signatureSlots = new Set([
      'skhynix', 'hype', 'xyz100', 'sp500', 'micron', 'spacex',
      'nvidia', 'gold', 'apple', 'meta', 'google',
    ]);
    for (const market of MARKET_SLUGS) {
      const routes = createPortalRoutes(market);
      expect(routes).toHaveLength(MARKET_SLUGS.length - 1);
      expect(new Set(routes.map((route) => route.to)).size).toBe(MARKET_SLUGS.length - 1);
      expect(routes.every((route) => {
        const canonical = canonicalSlots[route.slot];
        if (!canonical) return false;
        const expectedRadius = signatureSlots.has(canonical.to)
          ? SIGNATURE_WORLD_PORTAL_RADIUS
          : dexSlots.has(canonical.to)
            ? DEX_FIELD_PORTAL_RADIUS
            : PORTAL_RADIUS;
        return Math.abs(route.x - canonical.x) < 0.000001
          && Math.abs(route.z - canonical.z) < 0.000001
          && Math.abs(Math.hypot(route.x, route.z) - expectedRadius) < 0.000001;
      })).toBe(true);
    }
  });

  it('provides finite deterministic server terrain samples', () => {
    const first = sampleBoundedTerrainHeight(23.5, -41.25);
    expect(first).toBe(sampleBoundedTerrainHeight(23.5, -41.25));
    expect(Number.isFinite(first)).toBe(true);
  });

  it('allocates fifty deterministic collision-free spawn slots outside the podium', () => {
    const initial = createSpawnAssignments('btc');
    const arrival = createSpawnAssignments('eth', 'btc');
    expect(initial).toHaveLength(SPAWN_SLOT_COUNT);
    expect(arrival).toHaveLength(SPAWN_SLOT_COUNT);
    for (const layout of [initial, arrival]) {
      for (let index = 0; index < layout.length; index += 1) {
        const slot = layout[index]!;
        expect(Math.hypot(slot.x, slot.z)).toBeGreaterThanOrEqual(PODIUM_EXCLUSION_RADIUS);
        expect(Math.hypot(slot.x, slot.z)).toBeLessThanOrEqual(WORLD_RADIUS);
        for (let other = index + 1; other < layout.length; other += 1) {
          const peer = layout[other]!;
          expect(Math.hypot(slot.x - peer.x, slot.z - peer.z)).toBeGreaterThanOrEqual(
            SPAWN_SLOT_SPACING - 1e-8,
          );
        }
      }
    }
    for (const slot of initial) {
      for (const portal of createPortalRoutes('btc')) {
        expect(Math.hypot(slot.x - portal.x, slot.z - portal.z)).toBeGreaterThan(3.2);
      }
    }

    for (const market of MARKET_SLUGS) {
      for (const fromMarket of MARKET_SLUGS) {
        if (fromMarket === market) continue;
        const routes = createPortalRoutes(market);
        for (const slot of createSpawnAssignments(market, fromMarket)) {
          // Portal travel now lands on the same near-chart approach as a
          // direct join, safely inside the portal ring.
          expect(Math.hypot(slot.x, slot.z)).toBeLessThan(PORTAL_RADIUS - 3.2);
          for (const portal of routes) {
            expect(Math.hypot(slot.x - portal.x, slot.z - portal.z)).toBeGreaterThan(3.2);
          }
        }
      }
    }

    const first = allocateSpawnAssignment('actor-a', 'eth', 'btc');
    const occupied = new Set([first.slot]);
    const second = allocateSpawnAssignment('actor-a', 'eth', 'btc', occupied);
    expect(second.slot).not.toBe(first.slot);
    expect(allocateSpawnAssignment('actor-a', 'eth', 'btc')).toEqual(first);
  });
});
