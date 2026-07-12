import { describe, expect, it, vi } from 'vitest';
import { FireworkPool } from '../src/monuments';

describe('FireworkPool', () => {
  it('uses exactly one pooled bloom for both large and exceptional moves', () => {
    const pool = new FireworkPool({ capacity: 96, random: () => 0.25 });

    expect(pool.launch({ x: 2, y: 12, z: -1 }, 'up', 'large')).toBe(true);
    pool.update(0);
    expect(pool.getDebugStats()).toMatchObject({
      emittedBursts: 1,
      pendingBursts: 0,
      activeParticles: 23,
    });

    expect(pool.launch({ x: 2, y: 12, z: -1 }, 'down', 'exceptional')).toBe(true);
    expect(pool.getDebugStats()).toMatchObject({ emittedBursts: 2, pendingBursts: 0 });
    for (let index = 0; index < 5; index += 1) pool.update(0.1);
    expect(pool.getDebugStats()).toMatchObject({ emittedBursts: 2, pendingBursts: 0 });
    expect(pool.getDebugStats().activeParticles).toBeLessThanOrEqual(pool.capacity);

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

  it('reduces an exceptional launch to one small bloom and disposes cleanly', () => {
    const pool = new FireworkPool({ capacity: 32, reducedMotion: true, random: () => 0.5 });
    const geometryDispose = vi.spyOn(pool.points.geometry, 'dispose');
    const materialDispose = vi.spyOn(pool.points.material, 'dispose');

    pool.launch({ x: 0, y: 10, z: 0 }, 'up', 'exceptional');
    pool.update(0);
    expect(pool.getDebugStats()).toMatchObject({
      activeParticles: 8,
      pendingBursts: 0,
      emittedBursts: 1,
      reducedMotion: true,
    });

    pool.dispose();
    expect(pool.points.visible).toBe(false);
    expect(pool.points.geometry.drawRange.count).toBe(0);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});
