import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MARKET_TRADE_CONFIG } from '../src/trades/config';
import { WorldSystem } from '../src/world';

function world(scene: THREE.Scene, reducedMotion = false): WorldSystem {
  return new WorldSystem(scene, {
    seed: 'trade-surge-test',
    dayDurationSeconds: 600,
    loadBudgetPerUpdate: 25,
    unloadBudgetPerUpdate: 25,
    reducedMotion,
  });
}

describe('WorldSystem trade atmosphere surge', () => {
  it('eases toward a subtle direction tint and restores the exact moving day/night baseline', () => {
    const baselineScene = new THREE.Scene();
    const surgedScene = new THREE.Scene();
    const baseline = world(baselineScene);
    const surged = world(surgedScene);
    const player = { x: 0, z: 0 };
    baseline.update(player, 100);
    surged.update(player, 100);

    expect(surged.triggerTradeSurge('buy', 'BTC')).toBe(true);
    baseline.update(player, 100.5);
    surged.update(player, 100.5);
    const halfway = surged.getDebugStats();
    expect(halfway.tradeSurgeDirection).toBe('up');
    expect(halfway.tradeSurgeIntensity).toBeGreaterThan(0);
    expect(halfway.tradeSurgeIntensity).toBeLessThanOrEqual(
      MARKET_TRADE_CONFIG.BTC.surge.tintStrength,
    );
    expect(surged.nightFactor).toBeCloseTo(baseline.nightFactor, 12);
    expect((surgedScene.background as THREE.Color).equals(
      baselineScene.background as THREE.Color,
    )).toBe(false);

    // A contrary repeat cannot restart or flip an active surge. It only adds
    // the bounded hold extension from the shared trade configuration.
    expect(surged.triggerTradeSurge('sell', 'BTC')).toBe(false);
    surged.update(player, 100.5);
    expect(surged.getDebugStats().tradeSurgeDirection).toBe('up');

    baseline.update(player, 101.1);
    surged.update(player, 101.1);
    expect(surged.getDebugStats().tradeSurgeIntensity).toBeCloseTo(
      MARKET_TRADE_CONFIG.BTC.surge.tintStrength,
      10,
    );
    baseline.update(player, 104.5);
    surged.update(player, 104.5);
    expect(surged.getDebugStats().tradeSurgeIntensity).toBeGreaterThan(0);
    expect(surged.getDebugStats().tradeSurgeIntensity).toBeLessThan(
      MARKET_TRADE_CONFIG.BTC.surge.tintStrength,
    );

    baseline.update(player, 107.31);
    surged.update(player, 107.31);
    expect(surged.getDebugStats().tradeSurgeIntensity).toBe(0);
    expect((surgedScene.background as THREE.Color).equals(
      baselineScene.background as THREE.Color,
    )).toBe(true);
    expect((surgedScene.fog as THREE.Fog).color.equals(
      (baselineScene.fog as THREE.Fog).color,
    )).toBe(true);
    const baselineHemisphere = baseline.root.getObjectByName(
      'WorldHemisphereLight',
    ) as THREE.HemisphereLight;
    const surgedHemisphere = surged.root.getObjectByName(
      'WorldHemisphereLight',
    ) as THREE.HemisphereLight;
    const baselineSun = baseline.root.getObjectByName('WorldSun') as THREE.DirectionalLight;
    const surgedSun = surged.root.getObjectByName('WorldSun') as THREE.DirectionalLight;
    expect(surgedHemisphere.color.equals(baselineHemisphere.color)).toBe(true);
    expect(surgedHemisphere.groundColor.equals(baselineHemisphere.groundColor)).toBe(true);
    expect(surgedHemisphere.intensity).toBeCloseTo(baselineHemisphere.intensity, 12);
    expect(surgedSun.color.equals(baselineSun.color)).toBe(true);
    expect(surgedSun.intensity).toBeCloseTo(baselineSun.intensity, 12);
    expect(surged.nightFactor).toBeCloseTo(baseline.nightFactor, 12);

    // A complete second, opposite-colour cycle also restores exactly: no
    // lerp result from the first surge is ever reused as a new baseline.
    baseline.update(player, 110.01);
    surged.update(player, 110.01);
    expect(surged.triggerTradeSurge('sell', 'BTC')).toBe(true);
    baseline.update(player, 118.5);
    surged.update(player, 118.5);
    expect((surgedScene.background as THREE.Color).equals(
      baselineScene.background as THREE.Color,
    )).toBe(true);
    expect(surgedHemisphere.color.equals(baselineHemisphere.color)).toBe(true);
    expect(surgedSun.color.equals(baselineSun.color)).toBe(true);

    baseline.dispose();
    surged.dispose();
  });

  it('enforces the configured cooldown and accepts the opposite direction only afterwards', () => {
    const scene = new THREE.Scene();
    const system = world(scene);
    const player = { x: 0, z: 0 };
    system.update(player, 20);
    expect(system.triggerTradeSurge('up', 'ETH')).toBe(true);
    system.update(player, 28);
    expect(system.triggerTradeSurge('down', 'ETH')).toBe(false);
    system.update(player, 30.01);
    expect(system.triggerTradeSurge('down', 'ETH')).toBe(true);
    system.update(player, 30.51);
    expect(system.getDebugStats().tradeSurgeDirection).toBe('down');
    expect(system.getDebugStats().tradeSurgeIntensity).toBeGreaterThan(0);
    system.dispose();
  });

  it('caps repeat extensions and cannot chain a sustained tape into flashing', () => {
    const system = world(new THREE.Scene());
    const player = { x: 0, z: 0 };
    system.update(player, 10);
    expect(system.triggerTradeSurge('buy', 'BTC')).toBe(true);
    system.update(player, 10.2);
    for (let repeat = 0; repeat < 20; repeat += 1) {
      expect(system.triggerTradeSurge(repeat % 2 === 0 ? 'sell' : 'buy', 'BTC')).toBe(false);
    }
    expect(system.getDebugStats().tradeSurgeDirection).toBe('up');

    const config = MARKET_TRADE_CONFIG.BTC.surge;
    const maximumEnd = 10 + config.attackSeconds + config.maximumHoldSeconds
      + config.releaseSeconds;
    system.update(player, maximumEnd - 0.01);
    expect(system.getDebugStats().tradeSurgeIntensity).toBeGreaterThan(0);
    system.update(player, maximumEnd + 0.01);
    expect(system.getDebugStats().tradeSurgeIntensity).toBe(0);
    // The cooldown is measured from the original start, not from repeats.
    expect(system.triggerTradeSurge('sell', 'BTC')).toBe(false);
    system.update(player, 20.01);
    expect(system.triggerTradeSurge('sell', 'BTC')).toBe(true);
    system.dispose();
  });

  it('caps reduced-motion strength without shortening the slow attack or release', () => {
    const scene = new THREE.Scene();
    const system = world(scene, true);
    const player = { x: 0, z: 0 };
    system.update(player, 50);
    system.triggerTradeSurge('sell', 'BTC');
    system.update(player, 51);
    expect(system.getDebugStats().tradeSurgeIntensity).toBeCloseTo(
      MARKET_TRADE_CONFIG.BTC.surge.tintStrength
        * MARKET_TRADE_CONFIG.BTC.surge.reducedMotionStrengthMultiplier,
      8,
    );
    expect(system.getDebugStats().tradeSurgeIntensity).toBeLessThanOrEqual(0.08);
    expect(system.getDebugStats().tradeSurgeDirection).toBe('down');
    system.dispose();
  });

  it('clears active and cooldown state before a market-world switch', () => {
    const scene = new THREE.Scene();
    const system = world(scene);
    const player = { x: 0, z: 0 };
    system.update(player, 40);
    expect(system.triggerTradeSurge('buy', 'BTC')).toBe(true);
    system.update(player, 40.5);
    expect(system.getDebugStats().tradeSurgeIntensity).toBeGreaterThan(0);

    system.clearTradeSurge();
    expect(system.getDebugStats().tradeSurgeIntensity).toBe(0);
    system.update(player, 40.51);
    expect(system.getDebugStats()).toMatchObject({
      tradeSurgeIntensity: 0,
      tradeSurgeDirection: 'up',
    });
    // Clearing also drops the old world's cooldown, allowing the destination
    // world to establish its own independent mood immediately.
    expect(system.triggerTradeSurge('sell', 'ETH')).toBe(true);
    system.dispose();
  });
});
