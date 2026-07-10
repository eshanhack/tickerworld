import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  describeChunk,
  echoPlacementForMacrocell,
  generateChunkLayout,
} from '../src/world/layout';
import { createRandom, hashSeed, valueNoise2D } from '../src/world/random';
import { TerrainSampler } from '../src/world/terrain';
import type { GrandMonumentCoordinate } from '../src/world/layout';

const monuments: readonly GrandMonumentCoordinate[] = [
  { symbol: 'BTC', x: 0, z: 0 },
  { symbol: 'ETH', x: 190, z: 70 },
];

describe('deterministic world helpers', () => {
  it('repeats random streams and varies distinct seeds', () => {
    const first = createRandom('tickerworld-v1');
    const second = createRandom('tickerworld-v1');
    const other = createRandom('tickerworld-v2');
    const firstValues = Array.from({ length: 12 }, () => first());

    expect(Array.from({ length: 12 }, () => second())).toEqual(firstValues);
    expect(Array.from({ length: 12 }, () => other())).not.toEqual(firstValues);
    expect(hashSeed('tickerworld-v1')).toBe(hashSeed('tickerworld-v1'));
  });

  it('keeps value noise continuous across lattice boundaries', () => {
    const seed = hashSeed('seams');
    const left = valueNoise2D(10 - 0.000001, -3.25, seed);
    const boundary = valueNoise2D(10, -3.25, seed);
    const right = valueNoise2D(10 + 0.000001, -3.25, seed);

    expect(Math.abs(left - boundary)).toBeLessThan(0.00001);
    expect(Math.abs(right - boundary)).toBeLessThan(0.00001);
  });
});

describe('TerrainSampler', () => {
  const terrain = new TerrainSampler({
    seed: 'tickerworld-v1',
    chunkSize: 48,
    monuments,
  });

  it('samples identical heights for both sides of every chunk seam', () => {
    for (let zIndex = 0; zIndex <= 24; zIndex += 1) {
      const z = -24 + zIndex * 2;
      const leftChunkEdge = terrain.heightAt(24, z);
      const rightChunkEdge = terrain.heightAt(48 - 24, z);
      expect(leftChunkEdge).toBe(rightChunkEdge);
    }
  });

  it('marks plazas, their apron, and connecting paths', () => {
    expect(terrain.surfaceAt(0, 0)).toBe('stone');
    expect(terrain.surfaceAt(23, 0)).toBe('sand');
    expect(terrain.surfaceAt(95, 35)).toBe('sand');
    expect(terrain.surfaceAt(60, -45)).toBe('grass');
  });

  it('is deterministic regardless of query order', () => {
    const points = [
      [-120, 40],
      [24, -24],
      [390, 510],
      [-0.25, 0.25],
    ] as const;
    const forward = points.map(([x, z]) => terrain.heightAt(x, z));
    const reverse = [...points].reverse().map(([x, z]) => terrain.heightAt(x, z)).reverse();
    expect(reverse).toEqual(forward);
  });
});

describe('chunk layout and echo placement', () => {
  it('creates one stable echo candidate per far macrocell', () => {
    const first = echoPlacementForMacrocell('tickerworld-v1', 12, -9, 48, monuments);
    const second = echoPlacementForMacrocell('tickerworld-v1', 12, -9, 48, monuments);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    if (!first) {
      return;
    }
    const owner = describeChunk(
      'tickerworld-v1',
      first.chunkX,
      first.chunkZ,
      48,
      monuments,
    );
    expect(owner.descriptor.hasEchoMonument).toBe(true);
    expect(owner.echo?.key).toBe(first.key);
  });

  it('suppresses echo candidates near grand plazas', () => {
    const candidate = echoPlacementForMacrocell(
      'tickerworld-v1',
      0,
      0,
      48,
      [{ x: 130, z: 130 }],
      10_000,
    );
    expect(candidate).toBeNull();
  });

  it('generates repeatable props inside the owning chunk', () => {
    const terrain = new TerrainSampler({ seed: 'tickerworld-v1', chunkSize: 48, monuments });
    const options = {
      seed: 'tickerworld-v1',
      chunkX: 5,
      chunkZ: -4,
      chunkSize: 48,
      terrain,
      monuments,
    } as const;
    const first = generateChunkLayout(options);
    const second = generateChunkLayout(options);

    expect(second).toEqual(first);
    for (const prop of first.props) {
      expect(prop.x).toBeGreaterThanOrEqual(5 * 48 - 24);
      expect(prop.x).toBeLessThanOrEqual(5 * 48 + 24);
      expect(prop.z).toBeGreaterThanOrEqual(-4 * 48 - 24);
      expect(prop.z).toBeLessThanOrEqual(-4 * 48 + 24);
    }
  });
});

describe('WorldSystem streaming lifecycle', () => {
  it('bounds loaded chunks and shared prop draw calls, then restores scene state', async () => {
    vi.stubGlobal('location', { search: '' });
    const { WorldSystem } = await import('../src/world/WorldSystem');
    const scene = new THREE.Scene();
    const originalBackground = new THREE.Color(0x112233);
    const originalFog = new THREE.Fog(0x112233, 5, 50);
    scene.background = originalBackground;
    scene.fog = originalFog;
    const world = new WorldSystem(scene, {
      seed: 'streaming-test',
      loadBudgetPerUpdate: 25,
      unloadBudgetPerUpdate: 25,
    });

    world.update({ x: 0, z: 0 }, 0);
    expect(world.getDebugStats()).toMatchObject({
      loadedChunks: 25,
      desiredChunks: 25,
      queuedLoads: 0,
      terrainDrawCalls: 25,
    });
    expect(world.getDebugStats().sharedPropDrawCalls).toBeLessThanOrEqual(9);

    world.update({ x: 2_000, z: -2_000 }, 300);
    expect(world.getDebugStats().loadedChunks).toBe(25);
    expect(world.getLoadedChunkDescriptors()).toHaveLength(25);

    world.dispose();
    expect(scene.background).toBe(originalBackground);
    expect(scene.fog).toBe(originalFog);
    expect(scene.children).not.toContain(world.root);
    vi.unstubAllGlobals();
  });
});
