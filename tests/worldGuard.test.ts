import { describe, expect, it } from 'vitest';
import {
  PODIUM_EXCLUSION_RADIUS,
  WORLD_BOUNDARY_RADIUS,
  WorldGuard,
  isForbiddenWorldXZ,
  resolveWorldXZ,
} from '../src/world';

describe('bounded-world guard', () => {
  it('uses the locked 84-unit boundary and 10.6-unit podium exclusion', () => {
    expect(WORLD_BOUNDARY_RADIUS).toBe(84);
    expect(PODIUM_EXCLUSION_RADIUS).toBe(10.6);
    expect(isForbiddenWorldXZ(0, 21)).toBe(false);
    expect(isForbiddenWorldXZ(0, 9)).toBe(true);
    expect(isForbiddenWorldXZ(85, 0)).toBe(true);
  });

  it('projects movement onto either edge of the playable annulus', () => {
    const outer = resolveWorldXZ(80, 0, 100, 0);
    expect(Math.hypot(outer.x, outer.z)).toBeCloseTo(84, 8);
    expect(outer).toMatchObject({ boundaryAdjusted: true, podiumAdjusted: false });

    const inner = resolveWorldXZ(0, 21, 0, 2);
    expect(Math.hypot(inner.x, inner.z)).toBeCloseTo(10.6, 8);
    expect(inner).toMatchObject({ boundaryAdjusted: false, podiumAdjusted: true });
  });

  it('uses the previous direction for exact-centre and invalid proposals', () => {
    const centre = resolveWorldXZ(-20, 0, 0, 0);
    expect(centre.x).toBeCloseTo(-10.6, 8);
    expect(centre.z).toBeCloseTo(0, 8);
    const invalid = resolveWorldXZ(0, 21, Number.NaN, Number.POSITIVE_INFINITY);
    expect(invalid.x).toBe(0);
    expect(invalid.z).toBe(21);
  });

  it('exposes the same rules as player resolver and camera collision', () => {
    const guard = new WorldGuard();
    const player = guard.resolveHorizontal(0, 21, 90, 0);
    expect(Math.hypot(player.x, player.z)).toBeCloseTo(84, 8);
    expect(guard.collides(0, 5)).toBe(true);
    expect(guard.contains(player.x, player.z)).toBe(true);
  });
});
