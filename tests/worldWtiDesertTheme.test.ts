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

describe('WTI desert world presentation', () => {
  it('switches park to desert to DEX and restores the original park exactly', () => {
    const world = new WorldSystem(new THREE.Scene(), {
      seed: 'wti-desert-switch',
      activeMarket: 'BTC',
      activeRadius: 1,
      loadBudgetPerUpdate: 9,
      unloadBudgetPerUpdate: 9,
    });
    world.update({ x: 0, z: 0 }, 0);
    const parkStats = world.getDebugStats();
    const parkColors = terrainColors(world);
    const rootChildren = world.root.children.length;
    let grassPoint: { x: number; z: number } | null = null;
    for (let x = -90; x <= 90 && !grassPoint; x += 9) {
      for (let z = -90; z <= 90; z += 9) {
        if (world.surfaceAt(x, z) === 'grass') {
          grassPoint = { x, z };
          break;
        }
      }
    }
    expect(grassPoint).not.toBeNull();
    expect(parkStats.propInstances).toBeGreaterThan(0);

    world.setActiveMarket('WTI');
    const desertStats = world.getDebugStats();
    const desertColors = terrainColors(world);
    expect(desertStats).toMatchObject({
      loadedChunks: parkStats.loadedChunks,
      propInstances: 0,
      grassInstances: 0,
      shrubInstances: 0,
      ambientFireflies: 0,
      ambientPetals: 0,
      ambientBirds: 0,
    });
    expect(world.surfaceAt(grassPoint!.x, grassPoint!.z)).toBe('sand');
    expect(world.sampleVegetation(grassPoint!.x, grassPoint!.z)).toBeNull();
    expect(desertColors).not.toEqual(parkColors);

    world.setActiveMarket('PUMP');
    expect(world.surfaceAt(grassPoint!.x, grassPoint!.z)).toBe('stone');
    expect(terrainColors(world)).not.toEqual(desertColors);

    world.setActiveMarket('BTC');
    expect(world.getDebugStats()).toMatchObject({
      loadedChunks: parkStats.loadedChunks,
      propInstances: parkStats.propInstances,
      grassInstances: parkStats.grassInstances,
      shrubInstances: parkStats.shrubInstances,
    });
    expect(world.surfaceAt(grassPoint!.x, grassPoint!.z)).toBe('grass');
    expect(terrainColors(world)).toEqual(parkColors);
    expect(world.root.children).toHaveLength(rootChildren);

    for (let index = 0; index < 4; index += 1) {
      world.setActiveMarket('WTI');
      world.setActiveMarket('BTC');
      expect(world.root.children).toHaveLength(rootChildren);
    }
    world.dispose();
  });

  it('constructs directly as desert without a one-frame park prop population', () => {
    const world = new WorldSystem(new THREE.Scene(), {
      seed: 'direct-wti-desert',
      activeMarket: 'WTI',
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
    expect(world.surfaceAt(70, 70)).toBe('sand');
    world.dispose();
  });
});
