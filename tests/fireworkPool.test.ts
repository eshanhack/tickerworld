import { describe, expect, it, vi } from 'vitest';
import { FireworkPool } from '../src/monuments';

describe('FireworkPool', () => {
  it('gives a large move three clearly separated pooled sky blooms', () => {
    const pool = new FireworkPool({ capacity: 96, random: () => 0.25 });

    expect(pool.launch({ x: 2, y: 12, z: -1 }, 'up', 'large')).toBe(true);
    pool.update(0);
    expect(pool.getDebugStats()).toMatchObject({
      emittedBursts: 1,
      pendingBursts: 2,
      activeParticles: 28,
    });
    pool.update(0.1);
    expect(pool.getDebugStats().emittedBursts).toBe(1);
    pool.update(0.1);
    pool.update(0.1);
    expect(pool.getDebugStats().emittedBursts).toBe(2);
    pool.update(0.1);
    pool.update(0.1);
    pool.update(0.1);
    const stats = pool.getDebugStats();
    expect(stats).toMatchObject({ emittedBursts: 3, pendingBursts: 0, emittedParticles: 77 });
    expect(stats.activeParticles).toBeLessThanOrEqual(pool.capacity);
    expect(stats.recentBurstOrigins).toHaveLength(3);
    expect(Math.hypot(
      stats.recentBurstOrigins[1]!.x - stats.recentBurstOrigins[0]!.x,
      stats.recentBurstOrigins[1]!.z - stats.recentBurstOrigins[0]!.z,
    )).toBeGreaterThan(4);

    pool.dispose();
  });

  it('runs an exceptional seven-burst show over one bounded second', () => {
    const pool = new FireworkPool({ capacity: 80, random: () => 0.25 });
    expect(pool.launch({ x: 2, y: 12, z: -1 }, 'up', 'exceptional')).toBe(true);
    expect(pool.getDebugStats()).toMatchObject({ emittedBursts: 1, pendingBursts: 6 });

    for (let index = 0; index < 9; index += 1) pool.update(0.1);
    expect(pool.getDebugStats().emittedBursts).toBeGreaterThanOrEqual(6);
    pool.update(0.1);
    const show = pool.getDebugStats();
    expect(show).toMatchObject({ emittedBursts: 7, pendingBursts: 0, emittedParticles: 195 });
    expect(show.activeParticles).toBeLessThanOrEqual(80);
    expect(new Set(show.recentBurstOrigins.map(({ x, y, z }) => `${x}:${y}:${z}`)).size).toBe(7);
    expect(Math.max(...show.recentBurstOrigins.map(({ y }) => y)))
      .toBeGreaterThan(Math.min(...show.recentBurstOrigins.map(({ y }) => y)) + 4);

    for (let index = 0; index < 40; index += 1) pool.update(0.1);
    expect(pool.getDebugStats()).toMatchObject({ activeParticles: 0, pendingBursts: 0 });

    pool.dispose();
  });

  it('gives rising and falling moves distinct pastel palettes without replacing GPU resources', () => {
    const sample = (direction: 'up' | 'down'): number[] => {
      const pool = new FireworkPool({ random: () => 0.1 });
      const geometry = pool.points.geometry;
      const material = pool.points.material;
      pool.launch({ x: 0, y: 9, z: 0 }, direction, 'large');
      pool.update(0);
      const colors = Array.from(
        (pool.points.geometry.getAttribute('color').array as Float32Array).slice(0, 12),
      );
      expect(pool.points.geometry).toBe(geometry);
      expect(pool.points.material).toBe(material);
      pool.dispose();
      return colors;
    };

    expect(sample('up')).not.toEqual(sample('down'));
  });

  it('reduces an exceptional launch to two small blooms and disposes cleanly', () => {
    const pool = new FireworkPool({ capacity: 32, reducedMotion: true, random: () => 0.5 });
    const geometryDispose = vi.spyOn(pool.points.geometry, 'dispose');
    const materialDispose = vi.spyOn(pool.points.material, 'dispose');

    pool.launch({ x: 0, y: 10, z: 0 }, 'up', 'exceptional');
    pool.update(0);
    expect(pool.getDebugStats()).toMatchObject({
      activeParticles: 5,
      pendingBursts: 1,
      emittedBursts: 1,
      reducedMotion: true,
    });
    for (let index = 0; index < 5; index += 1) pool.update(0.1);
    expect(pool.getDebugStats()).toMatchObject({
      activeParticles: 9,
      pendingBursts: 0,
      emittedBursts: 2,
      emittedParticles: 9,
    });

    pool.dispose();
    expect(pool.points.visible).toBe(false);
    expect(pool.points.geometry.drawRange.count).toBe(0);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('caps overlapping pending shows and recycles only within the fixed pool', () => {
    const pool = new FireworkPool({ capacity: 32, random: () => 0.4 });
    for (let index = 0; index < 5; index += 1) {
      pool.launch({ x: index, y: 10, z: 0 }, 'up', 'exceptional');
    }
    expect(pool.getDebugStats()).toMatchObject({ emittedBursts: 5, pendingBursts: 12 });
    for (let index = 0; index < 12; index += 1) pool.update(0.1);
    expect(pool.getDebugStats().activeParticles).toBeLessThanOrEqual(32);
    expect(pool.getDebugStats().pendingBursts).toBe(0);
    pool.dispose();
  });
});
