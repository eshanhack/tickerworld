import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldSystem } from '../src/world';

describe('WorldSystem lamp ambience', () => {
  it('adds only bounded nearby night auras and motes while retaining four real lights', () => {
    const scene = new THREE.Scene();
    const world = new WorldSystem(scene, {
      seed: 'lamp-ambience-test',
      dayDurationSeconds: 600,
      loadBudgetPerUpdate: 25,
      unloadBudgetPerUpdate: 25,
    });
    const aura = world.root.getObjectByName('LampGroundAuras') as THREE.InstancedMesh;
    const motes = world.root.getObjectByName('LampFireflyMotes') as THREE.Points;
    expect(aura).toBeDefined();
    expect(motes).toBeDefined();

    world.update({ x: 0, z: 0 }, 0);
    expect(aura.count).toBe(0);
    expect(motes.geometry.drawRange.count).toBe(0);
    expect(aura.visible).toBe(false);
    expect(motes.visible).toBe(false);

    world.update({ x: 0, z: 0 }, 300);
    const stats = world.getDebugStats();
    expect(stats.activeLampAuras).toBeGreaterThan(0);
    expect(stats.activeLampAuras).toBeLessThanOrEqual(4);
    expect(stats.activeLampMotes).toBe(stats.activeLampAuras * 6);
    expect(stats.activeLampMotes).toBeLessThanOrEqual(24);
    expect(aura.visible).toBe(true);
    expect(motes.visible).toBe(true);
    expect((aura.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0);
    expect((motes.material as THREE.PointsMaterial).opacity).toBeGreaterThan(0);
    const motePositions = motes.geometry.getAttribute('position').array as Float32Array;
    expect(Array.from(motePositions.slice(0, stats.activeLampMotes * 3)).every(Number.isFinite)).toBe(true);

    const pooledLights: THREE.PointLight[] = [];
    world.root.traverse((object) => {
      if (object instanceof THREE.PointLight && object.name.startsWith('PooledLampLight')) {
        pooledLights.push(object);
      }
    });
    expect(pooledLights).toHaveLength(4);
    expect(pooledLights.filter((light) => light.visible)).toHaveLength(stats.activeLampAuras);

    const auraGeometryDispose = vi.spyOn(aura.geometry, 'dispose');
    const moteGeometryDispose = vi.spyOn(motes.geometry, 'dispose');
    world.dispose();
    expect(auraGeometryDispose).toHaveBeenCalledOnce();
    expect(moteGeometryDispose).toHaveBeenCalledOnce();
    expect(scene.children).not.toContain(world.root);
  });
});
