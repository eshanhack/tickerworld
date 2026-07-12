import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { OilWorldEffects } from '../src/world';

describe('WTI world effects', () => {
  it('plays one prompt first-visit flyby, then keeps return and repeat flybys sparse', () => {
    const parent = new THREE.Group();
    const jet = vi.fn();
    const explosion = vi.fn();
    const effects = new OilWorldEffects({
      parent,
      heightAt: () => 1.25,
      onJetFlyby: jet,
      onExplosion: explosion,
    });

    expect(parent.children).toContain(effects.root);
    effects.update(0.1, 20, new THREE.Vector3());
    expect(effects.getDebugStats()).toEqual({ active: false, jets: 0, blasts: 0 });

    effects.setActiveMarket('WTI');
    for (let frame = 0; frame < 8; frame += 1) {
      effects.update(0.1, frame * 0.1, new THREE.Vector3());
    }
    expect(effects.getDebugStats().jets).toBe(0);
    effects.update(0.1, 0.8, new THREE.Vector3());
    expect(effects.getDebugStats().jets).toBe(1);

    for (let frame = 0; frame < 120; frame += 1) {
      effects.update(0.1, 0.9 + frame * 0.1, new THREE.Vector3());
    }
    expect(effects.getDebugStats().active).toBe(true);
    expect(jet).toHaveBeenCalledTimes(1);
    expect(explosion).toHaveBeenCalledTimes(1);
    expect(effects.getDebugStats().jets).toBeLessThanOrEqual(2);
    expect(effects.getDebugStats().blasts).toBeLessThanOrEqual(4);

    effects.setActiveMarket('BTC');
    expect(effects.getDebugStats()).toEqual({ active: false, jets: 0, blasts: 0 });
    effects.setActiveMarket('WTI');
    for (let frame = 0; frame < 170; frame += 1) {
      effects.update(0.1, 20 + frame * 0.1, new THREE.Vector3());
    }
    expect(effects.getDebugStats().jets).toBe(0);
    expect(jet).toHaveBeenCalledTimes(1);

    effects.dispose();
    effects.dispose();
    expect(parent.children).not.toContain(effects.root);
  });
});
