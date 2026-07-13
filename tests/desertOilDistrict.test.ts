import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  DesertOilDistrict,
  WTI_SPAWN_PROTECTION_POINTS,
  createDesertOilLayout,
  isDesertOilProtectedPoint,
} from '../src/world/DesertOilDistrict';

const heightAt = (x: number, z: number): number => Math.sin(x * 0.035) * 0.22
  + Math.cos(z * 0.04) * 0.16;

describe('DesertOilDistrict', () => {
  it('generates deterministic bounded scenery outside every route and WTI spawn assignment', () => {
    const first = createDesertOilLayout('tickerworld-v1', heightAt);
    const mirror = createDesertOilLayout('tickerworld-v1', heightAt);
    const alternate = createDesertOilLayout('tickerworld-v2', heightAt);
    expect(mirror).toEqual(first);
    expect(alternate.formations).not.toEqual(first.formations);
    expect(first.dunes).toHaveLength(12);
    expect(first.formations).toHaveLength(10);
    expect(first.palms).toHaveLength(16);
    expect(first.scrub).toHaveLength(32);
    expect(first.oases).toHaveLength(2);
    expect(first.pumpjacks).toHaveLength(2);
    expect(first.lanterns).toHaveLength(12);

    for (const spawn of WTI_SPAWN_PROTECTION_POINTS) {
      expect(isDesertOilProtectedPoint(spawn.x, spawn.z)).toBe(true);
    }
    for (const formation of first.formations) {
      expect(Math.hypot(formation.x, formation.z) + formation.radius).toBeLessThanOrEqual(82);
      expect(isDesertOilProtectedPoint(
        formation.x,
        formation.z,
        formation.radius + 1.05,
      )).toBe(false);
    }
    for (const pumpjack of first.pumpjacks) {
      expect(isDesertOilProtectedPoint(
        pumpjack.x,
        pumpjack.z,
        pumpjack.radius + 1.35,
      )).toBe(false);
    }
    for (const oasis of first.oases) {
      expect(isDesertOilProtectedPoint(
        oasis.x,
        oasis.z,
        Math.max(oasis.radiusX, oasis.radiusZ) + 2.15,
      )).toBe(false);
    }
    for (const palm of first.palms) {
      expect(isDesertOilProtectedPoint(palm.x, palm.z, 1.15)).toBe(false);
    }
    for (const item of first.scrub) {
      expect(isDesertOilProtectedPoint(item.x, item.z, item.scale + 0.3)).toBe(false);
    }
    for (const dune of first.dunes) {
      expect(isDesertOilProtectedPoint(
        dune.x,
        dune.z,
        Math.max(dune.radiusX, dune.radiusZ) + 0.34,
      )).toBe(false);
    }
    for (const lantern of first.lanterns) {
      expect(isDesertOilProtectedPoint(lantern.x, lantern.z, 0.7)).toBe(false);
    }
  });

  it('activates only for WTI and keeps pooled runtime resources bounded', () => {
    const parent = new THREE.Group();
    const district = new DesertOilDistrict({ parent, heightAt, activeMarket: 'BTC' });
    expect(parent.children).toContain(district.root);
    expect(district.root.visible).toBe(false);
    expect(district.getDebugStats().active).toBe(false);

    district.setActiveMarket('WTI');
    district.update(1 / 60, 12, {
      nightFactor: 1,
      playerPosition: { x: 42, y: 1, z: 18 },
    });
    const stats = district.getDebugStats();
    expect(stats).toMatchObject({
      active: true,
      dunes: 12,
      formations: 10,
      palms: 16,
      scrub: 32,
      oases: 2,
      pumpjacks: 2,
      lanterns: 12,
      dustParticles: 30,
    });
    expect(stats.activePointLights).toBeLessThanOrEqual(4);
    expect(stats.pooledDrawCalls).toBeLessThanOrEqual(12);
    const childCount = district.root.children.length;
    for (let index = 0; index < 2_000; index += 1) {
      district.update(1 / 60, 12 + index / 60, {
        nightFactor: index % 2,
        playerPosition: { x: 42, y: 1, z: 18 },
      });
    }
    expect(district.root.children).toHaveLength(childCount);
    expect(district.getDebugStats().activePointLights).toBeLessThanOrEqual(4);

    district.setActiveMarket('PUMP');
    expect(district.root.visible).toBe(false);
    expect(district.getDebugStats().dustParticles).toBe(0);
    district.dispose();
  });

  it('blocks only solid formations and oil machinery and preserves collision sliding', () => {
    const district = new DesertOilDistrict({
      parent: new THREE.Group(),
      seed: 'desert-collision-test',
      heightAt,
      activeMarket: 'WTI',
    });
    const formation = district.layout.formations[0];
    const pumpjack = district.layout.pumpjacks[0];
    if (!formation || !pumpjack) throw new Error('Expected WTI solids');
    expect(district.collidesPlayer(formation.x, formation.z)).toBe(true);
    expect(district.collidesCamera(
      formation.x,
      formation.y + formation.height * 0.5,
      formation.z,
    )).toBe(true);
    expect(district.collidesCamera(
      formation.x,
      formation.y + formation.height + 4,
      formation.z,
    )).toBe(false);
    expect(district.collidesPlayer(pumpjack.x, pumpjack.z)).toBe(true);
    expect(district.collidesPlayer(0, -18)).toBe(false);

    const previousX = formation.x - formation.radius - 2;
    const previousZ = formation.z;
    const resolved = district.resolveHorizontal(
      formation.x,
      formation.z + formation.radius + 1.2,
      0.7,
      previousX,
      previousZ,
    );
    expect(district.collidesPlayer(resolved.x, resolved.z, 0.7)).toBe(false);
    district.dispose();
  });

  it('animates bounded dust and machinery, respects reduced motion, and disposes once', () => {
    const parent = new THREE.Group();
    const district = new DesertOilDistrict({ parent, heightAt, activeMarket: 'WTI' });
    const dust = district.root.getObjectByName('wti-desert-dust') as THREE.Points;
    const frames = district.root.getObjectByName('wti-pumpjack-frames') as THREE.InstancedMesh;
    const disposeGeometry = vi.spyOn(dust.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(frames.material as THREE.Material, 'dispose');
    district.update(1, 0, { nightFactor: 0, playerPosition: { x: 2, y: 0, z: 3 } });
    const firstDust = (dust.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
    const firstFrames = frames.instanceMatrix.array.slice();
    district.update(1, 4, { nightFactor: 0, playerPosition: { x: 2, y: 0, z: 3 } });
    expect((dust.geometry.getAttribute('position') as THREE.BufferAttribute).array).not.toEqual(firstDust);
    expect(frames.instanceMatrix.array).not.toEqual(firstFrames);
    district.setReducedMotion(true);
    district.update(1, 8, { nightFactor: 0, playerPosition: { x: 2, y: 0, z: 3 } });
    expect((dust.material as THREE.PointsMaterial).opacity).toBeLessThan(0.1);

    district.dispose();
    district.dispose();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(parent.children).not.toContain(district.root);
  });
});
