import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { describe, expect, it, vi } from 'vitest';
import { createPortalRoutes } from '../src/portals';
import {
  PARKOUR_COURSE_IDS,
  PARKOUR_FAIL_DELAY_SECONDS,
  PARKOUR_PARK_BOUNDS,
  ParkourParkSystem,
  createCanonicalRoadDescriptors,
  createParkourParkLayout,
  parkourEdgeGap,
  type ParkourRespawnPoint,
  type ParkourSurfaceDescriptor,
} from '../src/world';

function descriptorRadius(surface: ParkourSurfaceDescriptor): number {
  return surface.shape === 'circle'
    ? surface.radius
    : Math.hypot(surface.width, surface.depth) * 0.5;
}

function distanceToRoad(x: number, z: number, roadX: number, roadZ: number): number {
  const lengthSquared = roadX * roadX + roadZ * roadZ;
  const progress = Math.max(0, Math.min(1, (x * roadX + z * roadZ) / lengthSquared));
  return Math.hypot(x - roadX * progress, z - roadZ * progress);
}

describe('nearby parkour park', () => {
  it('uses one deterministic, reachable course in the clear east-side sector', () => {
    const first = createParkourParkLayout();
    const second = createParkourParkLayout();
    expect(second).toEqual(first);
    expect(first.courseIds).toEqual(PARKOUR_COURSE_IDS);
    expect(first.surfaces.map(({ id }) => id)).toEqual(PARKOUR_COURSE_IDS);
    expect(new Set(first.surfaces.map(({ shape }) => shape))).toEqual(
      new Set(['rect', 'circle', 'ramp']),
    );
    expect(first.arches).toHaveLength(3);
    expect(first.arches.filter(({ label }) => label)).toHaveLength(3);

    const roads = createCanonicalRoadDescriptors();
    const portals = createPortalRoutes('BTC');
    for (const surface of first.surfaces) {
      const radius = descriptorRadius(surface);
      expect(Math.hypot(surface.x, surface.z) + radius).toBeLessThan(76);
      expect(Math.hypot(surface.x, surface.z) - radius).toBeGreaterThan(17);
      expect(surface.x - radius).toBeGreaterThanOrEqual(PARKOUR_PARK_BOUNDS.left - 0.9);
      expect(surface.x + radius).toBeLessThanOrEqual(PARKOUR_PARK_BOUNDS.right + 0.9);
      for (const road of roads) {
        expect(distanceToRoad(surface.x, surface.z, road.market.x, road.market.z) - radius)
          .toBeGreaterThan(4.2);
      }
      for (const portal of portals) {
        expect(Math.hypot(surface.x - portal.x, surface.z - portal.z) - radius - 2.05)
          .toBeGreaterThan(3.8);
      }
    }

    for (let index = 0; index < first.surfaces.length - 1; index += 1) {
      const current = first.surfaces[index]!;
      const next = first.surfaces[index + 1]!;
      expect(parkourEdgeGap(current, next)).toBeLessThanOrEqual(1.7);
      const departure = current.shape === 'ramp' ? current.endElevation : current.elevation;
      expect(next.elevation - departure).toBeLessThanOrEqual(0.300_001);
    }
    expect(Math.max(...first.surfaces.map(({ elevation, endElevation }) => (
      Math.max(elevation, endElevation)
    )))).toBeLessThan(3.5);
  });

  it('samples platforms and true ramp slopes while blocking only unearned step-ups', () => {
    const parent = new THREE.Group();
    const park = new ParkourParkSystem({ parent, heightAt: () => 0 });
    expect(parent.children).toContain(park.root);
    expect(park.sampleGround(30, 2)).toMatchObject({
      height: 0.18,
      surface: 'stone',
      surfaceId: 'parkour-start',
      role: 'start',
    });
    expect(park.sampleGround(30.6, 2)?.height).toBeCloseTo(0.18, 5);
    expect(park.sampleGround(35.4, 2)?.height).toBeCloseTo(0.75, 5);
    expect(park.sampleGround(55.5, 3.5)?.height).toBeCloseTo(2.15, 5);
    expect(park.sampleGround(20, 20)).toBeNull();

    const blocked = park.resolveHorizontal(53, 0, 55.5, 3.5, 0);
    expect(blocked).not.toEqual({ x: 55.5, z: 3.5 });
    expect(park.resolveHorizontal(53, 0, 55.5, 3.5, 1.8)).toEqual({ x: 55.5, z: 3.5 });
    expect(park.resolveHorizontal(30, 2, 30.7, 2, 0)).toEqual({ x: 30.7, z: 2 });

    expect(park.collidesCamera(55.5, 1, 3.5)).toBe(true);
    expect(park.collidesCamera(55.5, 3, 3.5)).toBe(false);
    // The middle of an arch remains a generous pass-through for the bear,
    // while its actual support stays solid.
    const checkpointHeight = park.sampleGround(48.5, 2.2)!.height;
    expect(park.resolveHorizontal(47.8, 2.2, 48.5, 2.2, checkpointHeight))
      .toEqual({ x: 48.5, z: 2.2 });
    expect(park.resolveHorizontal(47.8, 3.6, 48.5, 3.6, checkpointHeight))
      .not.toEqual({ x: 48.5, z: 3.6 });
    park.dispose();
  });

  it('tracks start, checkpoint, safe solo respawn, and finish without growing resources', () => {
    const parent = new THREE.Group();
    const events: string[] = [];
    const respawn = vi.fn((_point: ParkourRespawnPoint) => true);
    const park = new ParkourParkSystem({
      parent,
      heightAt: () => 0,
      onEvent: ({ type }) => events.push(type),
      onRespawnRequested: respawn,
    });
    const initialChildren = park.root.children.length;

    park.setPlayerProbe({ x: 30, y: 0.18, z: 2, grounded: true });
    park.update(0.1, 0.1);
    expect(events).toEqual(['start']);
    park.setPlayerProbe({ x: 63, y: 0.18, z: 0.2, grounded: true });
    park.update(0.1, 0.15);
    expect(events).toEqual(['start']);
    park.setPlayerProbe({ x: 48.5, y: 1.85, z: 2.2, grounded: true });
    park.update(0.1, 0.2);
    expect(events).toEqual(['start', 'checkpoint']);

    park.setPlayerProbe({ x: 50, y: 0, z: -0.5, grounded: true });
    for (let elapsed = 0; elapsed < PARKOUR_FAIL_DELAY_SECONDS + 0.2; elapsed += 0.1) {
      park.update(0.1, 0.3 + elapsed);
    }
    expect(respawn).toHaveBeenCalledTimes(1);
    const respawnPoint = respawn.mock.calls[0]?.[0];
    expect(respawnPoint).toMatchObject({ checkpointId: 'parkour-checkpoint', x: 48.5, z: 2.2 });
    expect(respawnPoint?.y).toBeCloseTo(1.89, 8);
    expect(events).toContain('respawn');

    park.setPlayerProbe({ x: 63, y: 0.18, z: 0.2, grounded: true });
    park.update(0.1, 2);
    expect(events.at(-1)).toBe('finish');
    expect(park.getDebugStats()).toMatchObject({
      surfaces: PARKOUR_COURSE_IDS.length,
      arches: 3,
      active: false,
      checkpointId: 'parkour-checkpoint',
    });
    for (let frame = 0; frame < 300; frame += 1) park.update(1 / 60, frame / 60);
    expect(park.root.children).toHaveLength(initialChildren);

    park.resetRun();
    expect(park.getDebugStats()).toMatchObject({
      active: false,
      checkpointId: 'parkour-start',
      elapsedSeconds: 0,
    });

    const solid = park.root.getObjectByName('parkour-start-solid') as THREE.Mesh;
    const label = park.root.getObjectByName('parkour-start-arch-label') as Text;
    const disposeGeometry = vi.spyOn(solid.geometry, 'dispose');
    const disposeText = vi.spyOn(label, 'dispose');
    park.dispose();
    park.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeText).toHaveBeenCalledTimes(1);
    expect(parent.children).not.toContain(park.root);
    expect(park.root.children).toHaveLength(0);
  });
});
