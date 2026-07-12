import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WorldSystem } from '../src/world';

function terrainColors(world: WorldSystem): number[] {
  const colors: number[] = [];
  world.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const attribute = object.geometry.getAttribute('color');
    if (!attribute || attribute.count < 20) return;
    colors.push(...Array.from((attribute.array as Float32Array).slice(0, 24)));
  });
  return colors;
}

describe('DEX cyberpunk world presentation', () => {
  it('switches to a stone neon district presentation and restores the normal park exactly', () => {
    const scene = new THREE.Scene();
    const world = new WorldSystem(scene, {
      seed: 'dex-theme-switch',
      activeMarket: 'BTC',
      activeRadius: 1,
      loadBudgetPerUpdate: 9,
      unloadBudgetPerUpdate: 9,
    });

    world.update({ x: 0, z: 0 }, 0);
    const parkStats = world.getDebugStats();
    const parkColors = terrainColors(world);
    let grassPoint: { x: number; z: number } | null = null;
    for (let x = -90; x <= 90 && !grassPoint; x += 9) {
      for (let z = -90; z <= 90; z += 9) {
        if (world.surfaceAt(x, z) === 'grass') {
          grassPoint = { x, z };
          break;
        }
      }
    }
    expect(parkStats.propInstances).toBeGreaterThan(0);
    expect(parkStats.grassInstances).toBeGreaterThan(0);
    expect(grassPoint).not.toBeNull();

    world.setActiveMarket('PUMP');
    const dexStats = world.getDebugStats();
    const dexColors = terrainColors(world);
    expect(dexStats).toMatchObject({
      loadedChunks: parkStats.loadedChunks,
      propInstances: 0,
      grassInstances: 0,
      shrubInstances: 0,
      ambientFireflies: 0,
      ambientPetals: 0,
      ambientBirds: 0,
    });
    expect(world.surfaceAt(grassPoint!.x, grassPoint!.z)).toBe('stone');
    expect(dexColors).not.toEqual(parkColors);

    world.setActiveMarket('BTC');
    expect(world.getDebugStats()).toMatchObject({
      loadedChunks: parkStats.loadedChunks,
      propInstances: parkStats.propInstances,
      grassInstances: parkStats.grassInstances,
      shrubInstances: parkStats.shrubInstances,
    });
    expect(world.surfaceAt(grassPoint!.x, grassPoint!.z)).toBe('grass');
    expect(terrainColors(world)).toEqual(parkColors);

    world.dispose();
  });

  it('starts directly in a DEX world without briefly constructing park props', () => {
    const world = new WorldSystem(new THREE.Scene(), {
      seed: 'direct-dex-theme',
      activeMarket: 'SHFL',
      activeRadius: 1,
      loadBudgetPerUpdate: 9,
    });
    world.update({ x: 0, z: 0 }, 0);

    expect(world.getDebugStats()).toMatchObject({
      loadedChunks: 9,
      propInstances: 0,
      grassInstances: 0,
      shrubInstances: 0,
    });
    expect(world.surfaceAt(80, 80)).toBe('stone');
    world.dispose();
  });
});
