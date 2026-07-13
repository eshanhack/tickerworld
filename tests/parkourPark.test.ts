import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { describe, expect, it, vi } from 'vitest';
import { createPortalRoutes } from '../src/portals';
import { ANIMAL_KINDS } from '../shared/src/index.js';
import { ANIMAL_MOTION_PROFILES } from '../src/player/animalProfiles';
import { GRAND_MONUMENTS } from '../src/config';
import {
  PARKOUR_COURSE_IDS,
  PARKOUR_FAIL_DELAY_SECONDS,
  PARKOUR_PARK_BOUNDS,
  ParkourParkSystem,
  TerrainSampler,
  createCanonicalRoadDescriptors,
  createParkourParkLayout,
  generateChunkLayout,
  isInsideParkourPropExclusion,
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
    expect(first.arches).toHaveLength(4);
    expect(first.arches.filter(({ label }) => label)).toHaveLength(4);
    expect(first.hoops).toHaveLength(2);

    const roads = createCanonicalRoadDescriptors();
    const portals = createPortalRoutes('BTC');
    for (const surface of first.surfaces) {
      const radius = descriptorRadius(surface);
      expect(Math.hypot(surface.x, surface.z) + radius).toBeLessThan(80);
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
      expect(parkourEdgeGap(current, next)).toBeLessThanOrEqual(1.35);
      const departure = current.shape === 'ramp' ? current.endElevation : current.elevation;
      expect(next.elevation - departure).toBeLessThanOrEqual(0.300_001);
    }
    expect(Math.max(...first.surfaces.map(({ elevation, endElevation }) => (
      Math.max(elevation, endElevation)
    )))).toBeLessThan(3.5);

    const terrain = new TerrainSampler({ seed: 'tickerworld-v1', monuments: GRAND_MONUMENTS });
    const layouts = [0, 1, 2].flatMap((chunkX) => [-1, 0, 1].map((chunkZ) => generateChunkLayout({
      seed: 'tickerworld-v1',
      chunkX,
      chunkZ,
      chunkSize: 48,
      terrain,
      monuments: GRAND_MONUMENTS,
      echoSuppressionRadius: Number.POSITIVE_INFINITY,
    })));
    expect(layouts.flatMap(({ props }) => props).some(({ x, z }) => (
      isInsideParkourPropExclusion(x, z)
    ))).toBe(false);
  });

  it('keeps every jump link reachable for every character movement profile', () => {
    const { surfaces } = createParkourParkLayout();
    for (const animal of ANIMAL_KINDS) {
      const profile = ANIMAL_MOTION_PROFILES[animal];
      for (let index = 0; index < surfaces.length - 1; index += 1) {
        const current = surfaces[index]!;
        const next = surfaces[index + 1]!;
        const departure = current.shape === 'ramp' ? current.endElevation : current.elevation;
        const rise = Math.max(0, next.elevation - departure);
        const discriminant = profile.jumpImpulse ** 2 - 2 * profile.gravity * rise;
        expect(discriminant, `${animal} vertical link ${current.id} -> ${next.id}`).toBeGreaterThan(0);
        const flightSeconds = (profile.jumpImpulse + Math.sqrt(discriminant)) / profile.gravity;
        const conservativeRange = profile.sprintSpeed * flightSeconds * 0.66;
        expect(
          parkourEdgeGap(current, next),
          `${animal} horizontal link ${current.id} -> ${next.id}`,
        ).toBeLessThanOrEqual(conservativeRange);
        expect(rise).toBeLessThanOrEqual(profile.jumpImpulse ** 2 / (2 * profile.gravity) * 0.7);
      }
    }
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
    expect(park.sampleGround(35.4, 2)?.height).toBeCloseTo(0.72, 5);
    expect(park.sampleGround(60.6, 0.4)?.height).toBeCloseTo(2.62, 5);
    expect(park.sampleGround(20, 20)).toBeNull();

    const blocked = park.resolveHorizontal(58, -1, 60.6, 0.4, 0);
    expect(blocked).not.toEqual({ x: 60.6, z: 0.4 });
    expect(park.resolveHorizontal(58, -1, 60.6, 0.4, 2.2)).toEqual({ x: 60.6, z: 0.4 });
    expect(park.resolveHorizontal(30, 2, 30.7, 2, 0)).toEqual({ x: 30.7, z: 2 });

    expect(park.collidesCamera(60.6, 1, 0.4)).toBe(true);
    expect(park.collidesCamera(60.6, 3.5, 0.4)).toBe(false);
    // The middle of an arch remains a generous pass-through for the bear,
    // while its actual support stays solid.
    const checkpointHeight = park.sampleGround(47, 2.2)!.height;
    expect(park.resolveHorizontal(46.4, 2.2, 47, 2.2, checkpointHeight))
      .toEqual({ x: 47, z: 2.2 });
    expect(park.resolveHorizontal(46.4, 3.6, 47, 3.6, checkpointHeight))
      .not.toEqual({ x: 47, z: 3.6 });
    park.dispose();
  });

  it('retains identical course geometry and collision while adopting the DEX neon palette', () => {
    const park = new ParkourParkSystem({ parent: new THREE.Group(), heightAt: () => 0 });
    const start = park.root.getObjectByName('parkour-start-solid') as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    >;
    const geometry = start.geometry;
    const ordinaryColor = start.material.color.getHex();
    const sample = park.sampleGround(30, 2);
    const blocked = park.resolveHorizontal(58, -1, 60.6, 0.4, 0);

    park.setCyberpunkTheme(true);
    expect(start.geometry).toBe(geometry);
    expect(start.material.color.getHex()).not.toBe(ordinaryColor);
    expect(start.material.emissiveIntensity).toBeGreaterThan(0.2);
    expect(park.sampleGround(30, 2)).toEqual(sample);
    expect(park.resolveHorizontal(58, -1, 60.6, 0.4, 0)).toEqual(blocked);

    park.setCyberpunkTheme(false);
    expect(start.material.color.getHex()).toBe(ordinaryColor);
    expect(start.material.emissiveIntensity).toBeCloseTo(0.055);
    park.dispose();
  });

  it('resets ordinary-ground contact to START before any checkpoint', () => {
    const respawn = vi.fn((_point: ParkourRespawnPoint) => true);
    const events: string[] = [];
    const park = new ParkourParkSystem({
      parent: new THREE.Group(),
      heightAt: () => 0,
      onRespawnRequested: respawn,
      onEvent: ({ type }) => events.push(type),
    });
    park.setPlayerProbe({ x: 30, y: 0.18, z: 2, grounded: true });
    park.update(0.1, 0.1);
    park.setPlayerProbe({ x: 34, y: 0, z: -1, grounded: true });
    park.update(0.1, 0.2);
    park.update(0.1, 0.3);
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(respawn.mock.calls[0]?.[0]).toMatchObject({
      checkpointId: 'parkour-start',
      x: 30,
      z: 2,
    });
    expect(events).toEqual(['start', 'respawn']);
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
    // The final checkpoint cannot be taken out of order.
    park.setPlayerProbe({ x: 66, y: 2.55, z: 2.5, grounded: true });
    park.update(0.1, 0.12);
    park.setPlayerProbe({ x: 72.3, y: 0.18, z: 2.5, grounded: true });
    park.update(0.1, 0.14);
    expect(events).toEqual(['start']);
    park.setPlayerProbe({ x: 72.3, y: 0.18, z: 2.5, grounded: true });
    park.update(0.1, 0.15);
    expect(events).toEqual(['start']);
    park.setPlayerProbe({ x: 47, y: 1.7, z: 2.2, grounded: true });
    park.update(0.1, 0.2);
    expect(events).toEqual(['start', 'checkpoint']);

    park.setPlayerProbe({ x: 50, y: 0, z: -0.5, grounded: true });
    for (let elapsed = 0; elapsed < PARKOUR_FAIL_DELAY_SECONDS + 0.2; elapsed += 0.1) {
      park.update(0.1, 0.3 + elapsed);
    }
    expect(respawn).toHaveBeenCalledTimes(1);
    const respawnPoint = respawn.mock.calls[0]?.[0];
    expect(respawnPoint).toMatchObject({ checkpointId: 'parkour-checkpoint-a', x: 47, z: 2.2 });
    expect(respawnPoint?.y).toBeCloseTo(1.74, 8);
    expect(events).toContain('respawn');

    park.setPlayerProbe({ x: 66, y: 2.55, z: 2.5, grounded: true });
    park.update(0.1, 1.8);
    park.setPlayerProbe({ x: 72.3, y: 0.18, z: 2.5, grounded: true });
    park.update(0.1, 2);
    expect(events.at(-1)).toBe('finish');
    expect(park.getDebugStats()).toMatchObject({
      surfaces: PARKOUR_COURSE_IDS.length,
      arches: 4,
      hoops: 2,
      active: false,
      checkpointId: 'parkour-checkpoint-b',
    });
    for (let frame = 0; frame < 300; frame += 1) park.update(1 / 60, frame / 60);
    expect(park.root.children).toHaveLength(initialChildren);

    park.resetRun();
    expect(park.getDebugStats()).toMatchObject({
      active: false,
      checkpointId: 'parkour-start',
      elapsedSeconds: 0,
    });

    park.setPlayerProbe({ x: 30, y: 0.18, z: 2, grounded: true });
    park.update(0.1, 8);
    const respawnsBeforeQuit = respawn.mock.calls.length;
    expect(park.quitRun()).toBe(true);
    expect(events.at(-1)).toBe('quit');
    park.setPlayerProbe({ x: 30, y: 1.8, z: 2, grounded: false });
    park.update(0.1, 8.1);
    park.setPlayerProbe({ x: 30, y: 0.18, z: 2, grounded: true });
    park.update(0.1, 8.2);
    expect(park.getDebugStats().active).toBe(false);
    park.setPlayerProbe({ x: 40, y: 0, z: -1, grounded: true });
    park.update(0.5, 8.5);
    expect(respawn).toHaveBeenCalledTimes(respawnsBeforeQuit);
    expect(park.quitRun()).toBe(false);

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
