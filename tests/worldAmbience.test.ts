import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { stormWindowForCycle, WorldSystem } from '../src/world';

describe('WorldSystem lamp ambience', () => {
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
