import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WorldSystem } from '../src/world';

describe('30-minute logical roaming soak', () => {
  it('keeps streamed world resources bounded across a long journey', () => {
    const scene = new THREE.Scene();
    const world = new WorldSystem(scene, { seed: 'tickerworld-soak', loadBudgetPerUpdate: 3 });
    const stepSeconds = 0.1;
    const steps = (30 * 60) / stepSeconds;
    let maxChunks = 0;
    let maxPropDraws = 0;
    let maxInstances = 0;

    for (let step = 0; step < steps; step += 1) {
      const elapsed = step * stepSeconds;
      // A broad curve crosses hundreds of chunk boundaries without revisiting
      // exactly the same strip, approximating a player continuously sprinting.
      const position = {
        x: Math.sin(elapsed / 74) * 190 + elapsed * 1.55,
        z: -elapsed * 6.4 + Math.cos(elapsed / 53) * 120,
      };
      world.update(position, elapsed);
      if (step % 100 === 0 || step === steps - 1) {
        const stats = world.getDebugStats();
        maxChunks = Math.max(maxChunks, stats.loadedChunks);
        maxPropDraws = Math.max(maxPropDraws, stats.sharedPropDrawCalls);
        maxInstances = Math.max(maxInstances, stats.propInstances);
        expect(stats.loadedChunks).toBeLessThanOrEqual(25);
        expect(stats.sharedPropDrawCalls).toBeLessThanOrEqual(9);
        expect(stats.activeEchoes).toBeLessThanOrEqual(4);
      }
    }

    expect(maxChunks).toBe(25);
    expect(maxPropDraws).toBeLessThanOrEqual(9);
    expect(maxInstances).toBeGreaterThan(100);
    world.dispose();
    expect(world.getDebugStats().loadedChunks).toBe(0);
  }, 30_000);
});
