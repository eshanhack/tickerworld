import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  CyberpunkDexDistrict,
  createCyberpunkDexLayout,
  isDexCyberpunkMarket,
  isDexDistrictProtectedPoint,
} from '../src/world/CyberpunkDexDistrict';
import { PARKOUR_PARK_BOUNDS } from '../src/world/ParkourParkSystem';

const heightAt = (x: number, z: number): number => Math.sin(x * 0.04) * 0.2
  + Math.cos(z * 0.03) * 0.14;

describe('CyberpunkDexDistrict', () => {
  it('generates a deterministic bounded layout outside every protected gameplay route', () => {
    const first = createCyberpunkDexLayout('tickerworld-v1', heightAt);
    const mirror = createCyberpunkDexLayout('tickerworld-v1', heightAt);
    const alternate = createCyberpunkDexLayout('tickerworld-v2', heightAt);
    expect(mirror).toEqual(first);
    expect(alternate.buildings).not.toEqual(first.buildings);
    expect(first.buildings).toHaveLength(18);
    expect(first.signs).toHaveLength(6);
    expect(first.vents).toHaveLength(7);
    expect(first.lanterns).toHaveLength(14);

    for (const building of first.buildings) {
      const footprintRadius = Math.hypot(building.width, building.depth) * 0.5;
      expect(Math.hypot(building.x, building.z) + footprintRadius).toBeLessThanOrEqual(82);
      expect(isDexDistrictProtectedPoint(building.x, building.z, footprintRadius + 1.2)).toBe(false);
      expect(
        building.x >= PARKOUR_PARK_BOUNDS.left - footprintRadius
          && building.x <= PARKOUR_PARK_BOUNDS.right + footprintRadius
          && building.z >= PARKOUR_PARK_BOUNDS.bottom - footprintRadius
          && building.z <= PARKOUR_PARK_BOUNDS.top + footprintRadius,
      ).toBe(false);
    }
    for (const lantern of first.lanterns) {
      expect(isDexDistrictProtectedPoint(lantern.x, lantern.z, 1.15)).toBe(false);
    }
  });

  it('activates only the three DEX themes and keeps its pooled resources bounded', () => {
    const parent = new THREE.Group();
    const district = new CyberpunkDexDistrict({ parent, heightAt, activeMarket: 'BTC' });
    expect(parent.children).toContain(district.root);
    expect(district.root.visible).toBe(false);
    expect(district.getDebugStats().active).toBe(false);
    expect(isDexCyberpunkMarket('PUMP')).toBe(true);
    expect(isDexCyberpunkMarket('BTC')).toBe(false);

    district.setActiveMarket('ANSEM');
    district.update(1 / 60, 12, {
      nightFactor: 1,
      rainIntensity: 0.8,
      playerPosition: { x: 42, y: 1, z: 20 },
    });
    const stats = district.getDebugStats();
    expect(stats).toMatchObject({
      active: true,
      market: 'ANSEM',
      buildings: 18,
      signs: 6,
      vents: 7,
      lanterns: 14,
      steamParticles: 28,
    });
    expect(stats.activePointLights).toBeLessThanOrEqual(4);
    expect(stats.pooledDrawCalls).toBeLessThanOrEqual(20);
    const childCount = district.root.children.length;
    for (let index = 0; index < 2_000; index += 1) {
      district.update(1 / 60, 12 + index / 60, {
        nightFactor: index % 2,
        rainIntensity: 0.4,
        playerPosition: { x: 42, y: 1, z: 20 },
      });
    }
    expect(district.root.children).toHaveLength(childCount);
    expect(district.getDebugStats().activePointLights).toBeLessThanOrEqual(4);

    district.setActiveMarket('SHFL');
    expect(district.getDebugStats().market).toBe('SHFL');
    district.setActiveMarket('ETH');
    expect(district.root.visible).toBe(false);
    expect(district.getDebugStats().steamParticles).toBe(0);
    district.dispose();
  });

  it('blocks building footprints, supports facade sliding, and leaves routes unobstructed', () => {
    const district = new CyberpunkDexDistrict({
      parent: new THREE.Group(),
      seed: 'collider-test',
      heightAt,
      activeMarket: 'PUMP',
    });
    const building = district.layout.buildings[0];
    expect(building).toBeDefined();
    if (!building) throw new Error('Expected a building');
    expect(district.collidesPlayer(building.x, building.z)).toBe(true);
    expect(district.collidesCamera(
      building.x,
      building.y + building.height * 0.5,
      building.z,
    )).toBe(true);
    expect(district.collidesCamera(building.x, building.y + building.height + 4, building.z)).toBe(false);
    expect(district.collidesPlayer(0, 0)).toBe(false);

    const previousX = building.x - building.width - 2;
    const previousZ = building.z;
    const resolved = district.resolveHorizontal(
      building.x,
      building.z + building.depth,
      0.7,
      previousX,
      previousZ,
    );
    expect(district.collidesPlayer(resolved.x, resolved.z, 0.7)).toBe(false);
    district.dispose();
  });

  it('reduces steam motion and disposes every shared resource exactly once', () => {
    const parent = new THREE.Group();
    const district = new CyberpunkDexDistrict({ parent, heightAt, activeMarket: 'PUMP' });
    const steam = district.root.getObjectByName('dex-rooftop-steam') as THREE.Points;
    const wet = district.root.getObjectByName('dex-wet-sidewalks') as THREE.InstancedMesh;
    const disposeGeometry = vi.spyOn(steam.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(wet.material as THREE.Material, 'dispose');
    district.update(1, 0, { nightFactor: 1 });
    const initial = (steam.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
    district.update(1, 4, { nightFactor: 1 });
    const normal = (steam.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
    district.setReducedMotion(true);
    district.update(1, 0, { nightFactor: 1 });
    const reducedStart = (steam.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
    district.update(1, 4, { nightFactor: 1 });
    const reduced = (steam.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
    expect(normal).not.toEqual(initial);
    expect(reduced).not.toEqual(reducedStart);
    const travel = (from: ArrayLike<number>, to: ArrayLike<number>): number => {
      let total = 0;
      for (let index = 0; index < from.length; index += 1) {
        total += Math.abs((to[index] ?? 0) - (from[index] ?? 0));
      }
      return total;
    };
    expect(travel(reducedStart, reduced)).toBeLessThan(travel(initial, normal) * 0.5);

    district.dispose();
    district.dispose();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(parent.children).not.toContain(district.root);
  });
});
