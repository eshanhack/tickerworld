import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_DAY_DURATION_SECONDS,
  stormWindowForCycle,
  WorldSystem,
} from '../src/world';

describe('WorldSystem lamp ambience', () => {
  it('uses a relaxed eighteen-minute session clock by default', () => {
    expect(DEFAULT_DAY_DURATION_SECONDS).toBe(18 * 60);
    const scene = new THREE.Scene();
    const world = new WorldSystem(scene, { activeRadius: 0, loadBudgetPerUpdate: 1 });
    world.update({ x: 0, z: 0 }, 0);
    expect(world.minutesSinceMidnight).toBe(12 * 60);
    world.update({ x: 0, z: 0 }, DEFAULT_DAY_DURATION_SECONDS / 2);
    expect(world.minutesSinceMidnight).toBe(0);
    expect(world.nightFactor).toBeGreaterThan(0.99);
    world.update({ x: 0, z: 0 }, DEFAULT_DAY_DURATION_SECONDS);
    expect(world.minutesSinceMidnight).toBe(12 * 60);
    expect(world.nightFactor).toBe(0);
    world.dispose();
  });

  it('pools dense grass and shrubs, bends only nearby instances, and reports traversal', () => {
    const scene = new THREE.Scene();
    const onVegetationInteraction = vi.fn();
    const world = new WorldSystem(scene, {
      seed: 'interactive-foliage-test',
      loadBudgetPerUpdate: 25,
      unloadBudgetPerUpdate: 25,
      onVegetationInteraction,
    });
    world.update({ x: 0, z: 0 }, 0);
    const stats = world.getDebugStats();
    expect(stats.grassInstances).toBeGreaterThan(750);
    expect(stats.grassInstances).toBeLessThanOrEqual(25 * 160);
    expect(stats.shrubInstances).toBeGreaterThan(20);
    expect(stats.sharedPropDrawCalls).toBeLessThanOrEqual(9);

    const internal = world as unknown as {
      vegetationGrid: Map<string, Array<{
        kind: 'grass' | 'shrub';
        poolName: 'flowers' | 'bushes';
        index: number;
        x: number;
        z: number;
      }>>;
      pools: Record<'flowers' | 'bushes', { mesh: THREE.InstancedMesh }>;
    };
    const instance = [...internal.vegetationGrid.values()].flat()[0];
    expect(instance).toBeDefined();
    if (!instance) return;
    const pool = internal.pools[instance.poolName].mesh;
    const before = new THREE.Matrix4();
    const after = new THREE.Matrix4();
    pool.getMatrixAt(instance.index, before);

    world.update({ x: instance.x + 2.8, z: instance.z }, 1);
    onVegetationInteraction.mockClear();
    world.update({ x: instance.x, z: instance.z }, 1.1);
    pool.getMatrixAt(instance.index, after);
    expect(after.equals(before)).toBe(false);
    expect(world.getDebugStats().bendingVegetation).toBeGreaterThan(0);
    expect(world.sampleVegetation(instance.x, instance.z)).toMatchObject({
      kind: instance.kind,
      intensity: 1,
    });
    expect(onVegetationInteraction).toHaveBeenCalledTimes(1);
    expect(onVegetationInteraction.mock.calls[0]?.[0]).toMatchObject({
      kind: instance.kind,
      x: instance.x,
      z: instance.z,
    });
    world.dispose();
  });

  it('keeps a deterministic one-draw cloud field bounded, animated, and disposable', () => {
    const scene = new THREE.Scene();
    const world = new WorldSystem(scene, {
      seed: 'cloud-atmosphere-test',
      loadBudgetPerUpdate: 25,
      unloadBudgetPerUpdate: 25,
    });
    world.update({ x: 0, z: 0 }, 0);
    const clouds = world.root.getObjectByName('AtmosphereClouds') as THREE.InstancedMesh;
    expect(clouds).toBeDefined();
    expect(world.getDebugStats()).toMatchObject({
      cloudPuffs: 42,
      cloudDrawCalls: 1,
    });
    expect(clouds.count).toBe(42);
    const cloudMaterial = clouds.material as THREE.MeshLambertMaterial;
    expect(cloudMaterial.transparent).toBe(false);
    expect(cloudMaterial.alphaHash).toBe(false);
    expect(cloudMaterial.depthWrite).toBe(true);

    const before = new THREE.Matrix4();
    const after = new THREE.Matrix4();
    const position = new THREE.Vector3();
    clouds.getMatrixAt(0, before);
    for (let index = 0; index < clouds.count; index += 1) {
      clouds.getMatrixAt(index, after);
      position.setFromMatrixPosition(after);
      expect(Math.abs(position.x)).toBeLessThanOrEqual(108);
      expect(Math.abs(position.z)).toBeLessThanOrEqual(112);
      expect(position.y).toBeGreaterThanOrEqual(27);
      expect(position.y).toBeLessThanOrEqual(39.5);
    }
    const dayColor = cloudMaterial.color.clone();
    world.update({ x: 0, z: 0 }, 90);
    clouds.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(false);

    world.update({ x: 0, z: 0 }, DEFAULT_DAY_DURATION_SECONDS / 2);
    const nightColor = cloudMaterial.color.clone();
    expect(nightColor.equals(dayColor)).toBe(false);

    const geometryDispose = vi.spyOn(clouds.geometry, 'dispose');
    const materialDispose = vi.spyOn(clouds.material as THREE.Material, 'dispose');
    world.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(scene.children).not.toContain(world.root);
  });

  it('uses only bounded real lights and motes without additive ground planes', () => {
    const scene = new THREE.Scene();
    const world = new WorldSystem(scene, {
      seed: 'lamp-ambience-test',
      dayDurationSeconds: 600,
      loadBudgetPerUpdate: 25,
      unloadBudgetPerUpdate: 25,
    });
    const motes = world.root.getObjectByName('LampFireflyMotes') as THREE.Points;
    expect(world.root.getObjectByName('LampGroundAuras')).toBeUndefined();
    expect(motes).toBeDefined();

    world.update({ x: 0, z: 0 }, 0);
    expect(motes.geometry.drawRange.count).toBe(0);
    expect(motes.visible).toBe(false);

    world.update({ x: 0, z: 0 }, 300);
    const stats = world.getDebugStats();
    expect(stats.activeLampLights).toBeGreaterThan(0);
    expect(stats.activeLampLights).toBeLessThanOrEqual(4);
    expect(stats.activeLampMotes).toBe(stats.activeLampLights * 6);
    expect(stats.activeLampMotes).toBeLessThanOrEqual(24);
    expect(motes.visible).toBe(true);
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
    expect(pooledLights.filter((light) => light.visible)).toHaveLength(stats.activeLampLights);
    expect(pooledLights.filter((light) => light.visible).every((light) => (
      light.intensity > 20 && light.distance === 18 && light.decay === 2
    ))).toBe(true);

    const moteGeometryDispose = vi.spyOn(motes.geometry, 'dispose');
    world.dispose();
    expect(moteGeometryDispose).toHaveBeenCalledOnce();
    expect(scene.children).not.toContain(world.root);
  });

  it('composes a bounded drop flash after day/night and returns to the identical baseline', () => {
    const baselineScene = new THREE.Scene();
    const flashedScene = new THREE.Scene();
    const risenScene = new THREE.Scene();
    const options = {
      seed: 'drop-flash-test',
      dayDurationSeconds: 600,
      loadBudgetPerUpdate: 25,
      unloadBudgetPerUpdate: 25,
    } as const;
    const baseline = new WorldSystem(baselineScene, options);
    const flashed = new WorldSystem(flashedScene, options);
    const risen = new WorldSystem(risenScene, options);
    const player = { x: 0, z: 0 };

    baseline.update(player, 120);
    flashed.update(player, 120);
    risen.update(player, 120);
    flashed.triggerDropFlash('large');
    risen.triggerRiseFlash('large');
    baseline.update(player, 120.055);
    flashed.update(player, 120.055);
    risen.update(player, 120.055);

    expect(flashed.getDebugStats().dropFlashIntensity).toBeCloseTo(0.45, 2);
    expect(flashed.nightFactor).toBeCloseTo(baseline.nightFactor, 10);
    expect(risen.getDebugStats().riseFlashIntensity).toBeCloseTo(0.45, 2);
    expect(risen.getDebugStats().dropFlashIntensity).toBe(0);
    expect(risen.nightFactor).toBeCloseTo(baseline.nightFactor, 10);
    expect((flashedScene.background as THREE.Color).equals(
      baselineScene.background as THREE.Color,
    )).toBe(false);
    expect((risenScene.background as THREE.Color).equals(
      baselineScene.background as THREE.Color,
    )).toBe(false);
    expect((risenScene.background as THREE.Color).equals(
      flashedScene.background as THREE.Color,
    )).toBe(false);
    const baselineSun = baseline.root.getObjectByName('WorldSun') as THREE.DirectionalLight;
    const flashedSun = flashed.root.getObjectByName('WorldSun') as THREE.DirectionalLight;
    const risenSun = risen.root.getObjectByName('WorldSun') as THREE.DirectionalLight;
    expect(flashedSun.color.equals(baselineSun.color)).toBe(false);
    expect(risenSun.color.equals(baselineSun.color)).toBe(false);

    const beforeUpgrade = flashed.getDebugStats().dropFlashIntensity;
    flashed.triggerDropFlash('exceptional');
    flashed.update(player, 120.055);
    expect(flashed.getDebugStats().dropFlashIntensity).toBeCloseTo(beforeUpgrade, 8);

    baseline.update(player, 121.3);
    flashed.update(player, 121.3);
    risen.update(player, 121.3);
    expect(flashed.getDebugStats().dropFlashIntensity).toBe(0);
    expect((flashedScene.background as THREE.Color).equals(
      baselineScene.background as THREE.Color,
    )).toBe(true);
    expect((flashedScene.fog as THREE.Fog).color.equals(
      (baselineScene.fog as THREE.Fog).color,
    )).toBe(true);
    expect(flashedSun.color.equals(baselineSun.color)).toBe(true);
    expect(risenSun.color.equals(baselineSun.color)).toBe(true);
    expect(risen.getDebugStats().riseFlashIntensity).toBe(0);
    expect(flashed.nightFactor).toBeCloseTo(baseline.nightFactor, 10);

    flashed.setReducedMotion(true);
    flashed.triggerDropFlash('exceptional');
    flashed.update(player, 121.42);
    const reducedPeak = flashed.getDebugStats().dropFlashIntensity;
    expect(reducedPeak).toBeGreaterThan(0);
    expect(reducedPeak).toBeLessThanOrEqual(0.22);
    flashed.triggerDropFlash('large');
    flashed.update(player, 121.43);
    expect(flashed.getDebugStats().dropFlashIntensity).toBeGreaterThan(reducedPeak * 0.95);

    baseline.dispose();
    flashed.dispose();
    risen.dispose();
  });

  it('renders deterministic, infrequent rain only at night and emits bounded thunder cues', () => {
    const scene = new THREE.Scene();
    const onThunder = vi.fn();
    const world = new WorldSystem(scene, {
      seed: 'tickerworld-v1',
      dayDurationSeconds: 600,
      loadBudgetPerUpdate: 25,
      unloadBudgetPerUpdate: 25,
      onThunder,
    });
    const storm = stormWindowForCycle('tickerworld-v1', 0, 600);
    expect(storm).not.toBeNull();
    expect(stormWindowForCycle('tickerworld-v1', 1, 600)).toBeNull();
    expect(stormWindowForCycle('tickerworld-v1', 2, 600)).toBeNull();
    const rain = world.root.getObjectByName('NightRain') as THREE.LineSegments;
    expect(rain).toBeDefined();

    world.update({ x: 0, z: 0 }, storm!.start - 0.1);
    world.update({ x: 0, z: 0 }, storm!.start + 1);
    expect(world.nightFactor).toBeGreaterThan(0.72);
    expect(world.raining).toBe(true);
    expect(world.getDebugStats().activeRainDrops).toBeGreaterThan(0);
    expect(world.getDebugStats().activeRainDrops).toBeLessThanOrEqual(144);
    expect(rain.visible).toBe(true);

    const thunder = storm!.thunder[0]!;
    world.update({ x: 0, z: 0 }, thunder.at - 0.01);
    world.update({ x: 0, z: 0 }, thunder.at + 0.01);
    expect(onThunder).toHaveBeenCalledTimes(1);
    expect(onThunder.mock.calls[0]?.[0]).toBeGreaterThan(0.4);

    world.update({ x: 0, z: 0 }, 600);
    expect(world.nightFactor).toBe(0);
    expect(world.raining).toBe(false);
    expect(world.getDebugStats().activeRainDrops).toBe(0);
    expect(rain.visible).toBe(false);
    world.dispose();
  });
});
