import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  BigOrderHologramSystem,
  MONUMENT_CANDLE_COLORS,
  Monument,
  formatHologramNotional,
  type BigOrderHologramAnchorProvider,
  type BigOrderHologramEvent,
} from '../src/monuments';
import { ThirdPersonCamera } from '../src/player';
import { MARKET_TRADE_CONFIG } from '../src/trades';

const anchor: BigOrderHologramAnchorProvider = {
  getBigOrderHologramAnchor(slot, target = new THREE.Vector3()) {
    return target.set(slot * 3, 5, 2);
  },
};

function order(
  side: 'buy' | 'sell',
  tier: 'big' | 'whale',
  notionalUsd: number,
  symbol: BigOrderHologramEvent['symbol'] = 'BTC',
  simulated = false,
): BigOrderHologramEvent {
  return { symbol, side, tier, notionalUsd, simulated };
}

describe('BigOrderHologramSystem', () => {
  it('formats restrained, readable notional labels', () => {
    expect(formatHologramNotional(125_000)).toBe('$125K');
    expect(formatHologramNotional(1_234_000)).toBe('$1.23M');
    expect(formatHologramNotional(25_500_000)).toBe('$25.5M');
    expect(formatHologramNotional(1_500_000_000)).toBe('$1.50B');
  });

  it('uses three pooled slots, exact candle colours, a whale flourish and a subordinate SIM mark', () => {
    const parent = new THREE.Group();
    const camera = new THREE.PerspectiveCamera();
    const system = new BigOrderHologramSystem({ parent, camera });

    expect(system.show(order('buy', 'big', 180_000), anchor)).toMatchObject({
      materialized: true,
      promotedToWhale: false,
      tier: 'big',
    });
    system.update(0.1, 0.1);
    expect(system.show(order('sell', 'whale', 1_800_000, 'ETH', true), anchor)).toMatchObject({
      materialized: true,
      promotedToWhale: false,
      tier: 'whale',
    });
    system.update(0.1, 0.2);

    const stats = system.getDebugStats();
    expect(stats.capacity).toBe(3);
    expect(stats.visible).toBe(2);
    expect(stats.slots[0]).toMatchObject({
      side: 'buy',
      tier: 'big',
      title: 'BIG BUY',
      amount: '$180K',
      simulated: false,
    });
    expect(stats.slots[1]).toMatchObject({
      side: 'sell',
      tier: 'whale',
      title: 'BIG SELL',
      amount: '$1.80M',
      simulated: true,
    });
    const buyTitle = parent.getObjectByName('big-order-title-1') as unknown as { color: number };
    const sellTitle = parent.getObjectByName('big-order-title-2') as unknown as { color: number };
    expect(buyTitle.color).toBe(MONUMENT_CANDLE_COLORS.up);
    expect(sellTitle.color).toBe(MONUMENT_CANDLE_COLORS.down);
    expect(parent.getObjectByName('whale-order-crown-2')?.visible).toBe(true);
    expect(parent.getObjectByName('big-order-simulated-2')?.visible).toBe(true);
    for (const name of [
      'big-order-backplate-1',
      'big-order-title-1',
      'big-order-amount-1',
      'big-order-projection-beam-1',
      'big-order-scanline-1-1',
      'whale-order-crown-2',
    ]) {
      // Billboard transforms are camera-driven. Their pooled renderables
      // must never disappear from a stale frustum bound during shrine turns.
      expect(parent.getObjectByName(name)?.frustumCulled).toBe(false);
    }

    system.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('coalesces same-side flow, rejects smaller overflow and lets a whale preempt', () => {
    const system = new BigOrderHologramSystem({
      parent: new THREE.Group(),
      camera: new THREE.PerspectiveCamera(),
    });
    expect(system.show(order('buy', 'big', 120_000), anchor)?.materialized).toBe(true);
    system.update(0.2, 0.2);
    // Coalescing changes the existing projection without replaying the
    // materialisation shimmer.
    expect(system.show(order('buy', 'big', 80_000), anchor)).toMatchObject({
      materialized: false,
      promotedToWhale: false,
      tier: 'big',
    });
    expect(system.getDebugStats()).toMatchObject({ coalescedEvents: 1, visible: 1 });
    expect(system.getDebugStats().slots[0]?.amount).toBe('$200K');

    expect(system.show(order('sell', 'big', 220_000), anchor)?.materialized).toBe(true);
    expect(system.show(order('buy', 'big', 240_000, 'ETH'), anchor)?.materialized).toBe(true);
    expect(system.getDebugStats().visible).toBe(3);
    expect(system.show(order('sell', 'big', 90_000, 'SOL'), anchor)).toBeNull();
    expect(system.getDebugStats().droppedEvents).toBe(1);

    expect(system.show(order('sell', 'whale', 2_400_000, 'SOL'), anchor)?.materialized).toBe(true);
    expect(system.getDebugStats()).toMatchObject({ visible: 3, preemptedEvents: 1 });
    expect(system.getDebugStats().slots.some((slot) => slot.tier === 'whale')).toBe(true);
    system.dispose();
  });

  it('promotes accumulated same-side big flow to whale and clears market-scoped state', () => {
    const parent = new THREE.Group();
    const system = new BigOrderHologramSystem({
      parent,
      camera: new THREE.PerspectiveCamera(),
    });
    expect(system.show(order('buy', 'big', 600_000), anchor)?.tier).toBe('big');
    system.update(0.1, 0.1);
    expect(system.show(order('buy', 'big', 450_000), anchor)).toEqual({
      materialized: false,
      promotedToWhale: true,
      tier: 'whale',
    });
    expect(system.getDebugStats().slots[0]).toMatchObject({
      tier: 'whale',
      notionalUsd: 1_050_000,
    });
    expect(parent.getObjectByName('whale-order-crown-1')?.visible).toBe(true);

    system.clear();
    expect(system.getDebugStats()).toMatchObject({
      visible: 0,
      activeDissolveParticles: 0,
    });
    expect(system.getLatestWorldPosition()).toBeNull();
    expect(parent.getObjectByName('big-order-hologram-1')?.visible).toBe(false);
    system.dispose();
  });

  it('dissolves through one bounded particle pool and disposes every shared resource', () => {
    const parent = new THREE.Group();
    const system = new BigOrderHologramSystem({
      parent,
      camera: new THREE.PerspectiveCamera(),
      reducedMotion: true,
    });
    const dissolve = parent.getObjectByName('big-order-hologram-dissolve-pool') as THREE.Points;
    const geometryDispose = vi.spyOn(dissolve.geometry, 'dispose');
    const materialDispose = vi.spyOn(dissolve.material as THREE.Material, 'dispose');
    system.show(order('buy', 'big', 150_000), anchor);
    const config = MARKET_TRADE_CONFIG.BTC.hologram;
    const expiresAt = config.materializeSeconds + config.holdSeconds + config.dissolveSeconds;
    system.update(0.1, expiresAt + 0.04);
    system.update(0.02, expiresAt + 0.06);
    expect(system.getDebugStats().visible).toBe(0);
    expect(system.getDebugStats().activeDissolveParticles).toBeGreaterThan(0);
    expect(system.getDebugStats().activeDissolveParticles).toBeLessThanOrEqual(48);

    system.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('keeps qualifying aggregate projections prominent above the chart overlay', () => {
    const parent = new THREE.Group();
    const system = new BigOrderHologramSystem({
      parent,
      camera: new THREE.PerspectiveCamera(),
    });
    const config = MARKET_TRADE_CONFIG.BTC.hologram;
    system.show(order('sell', 'whale', 1_800_000), anchor);
    system.update(0.3, 0.3);

    const backplate = parent.getObjectByName('big-order-backplate-1') as THREE.Mesh<
      THREE.BoxGeometry,
      THREE.MeshBasicMaterial
    >;
    const title = parent.getObjectByName('big-order-title-1') as THREE.Object3D & {
      material: THREE.Material;
    };
    expect(backplate.visible).toBe(true);
    // Monument chart UI deliberately draws at 40+, so the hologram must sit
    // over it even when a camera-facing chart overlaps in screen space.
    expect(backplate.renderOrder).toBeGreaterThan(40);
    expect(backplate.material.depthTest).toBe(false);
    expect(backplate.material.depthWrite).toBe(false);
    expect(backplate.material.opacity).toBeGreaterThan(0.2);
    expect(title.renderOrder).toBeGreaterThan(backplate.renderOrder);

    system.update(0.1, config.materializeSeconds + config.holdSeconds - 0.05);
    expect(system.getDebugStats().visible).toBe(1);
    system.update(0.1, config.materializeSeconds + config.holdSeconds + config.dissolveSeconds + 0.05);
    expect(system.getDebugStats().visible).toBe(0);
    system.dispose();
  });

  it('provides a primary chart-front anchor plus two in-frame shoulder anchors', () => {
    const parent = new THREE.Group();
    const monument = new Monument({ symbol: 'BTC', position: { x: 4, y: 1, z: -3 } }).mount(parent);
    const points = [0, 1, 2].map((slot) => monument.getBigOrderHologramAnchor(slot));
    expect(points.every((point) => (
      Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
    ))).toBe(true);
    expect(new Set(points.map((point) => point.toArray().join(','))).size).toBe(3);
    // The default primary callout is intentionally centred in front of the
    // chart's upper lane. Concurrent overflow remains in a safe shoulder
    // gutter within the chart's frame so camera-facing rotation cannot push a
    // real alert offscreen.
    expect(points[0]!.x).toBeCloseTo(4);
    expect(Math.abs(points[1]!.x - 4)).toBeGreaterThan(4.8);
    expect(Math.abs(points[1]!.x - 4)).toBeLessThan(5.3);
    expect(Math.abs(points[2]!.x - 4)).toBeGreaterThan(4.8);
    expect(Math.abs(points[2]!.x - 4)).toBeLessThan(5.3);
    monument.dispose();
  });

  it('keeps all three projection cards inside the chart frame, separated, and in view', () => {
    const parent = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.08, 360);
    const rig = new ThirdPersonCamera({ camera, yaw: 0, pitch: 0.28, distance: 9 });
    rig.resize(1280, 720);
    rig.update(0, new THREE.Vector3(0, 0, 21), () => 0);
    const monument = new Monument({ symbol: 'BTC' }).mount(parent);
    monument.update(1 / 60, 1, camera);
    const holograms = new BigOrderHologramSystem({ parent, camera });
    holograms.show(order('buy', 'whale', 2_000_000), monument);
    holograms.show(order('sell', 'whale', 2_200_000, 'ETH'), monument);
    holograms.show(order('buy', 'whale', 800_000, 'SOL'), monument);
    holograms.update(0.4, 0.4);
    parent.updateMatrixWorld(true);

    const chartBounds = monument.getChartOcclusionBounds(camera, {
      left: 0,
      top: 0,
      width: 1280,
      height: 720,
    });
    expect(chartBounds).not.toBeNull();
    const projectedCentres: THREE.Vector2[] = [];
    const projectedBackplateWidths: number[] = [];
    for (let slot = 0; slot < 3; slot += 1) {
      const title = parent.getObjectByName(`big-order-title-${slot + 1}`);
      const amount = parent.getObjectByName(`big-order-amount-${slot + 1}`);
      const crown = parent.getObjectByName(`whale-order-crown-${slot + 1}`);
      const backplate = parent.getObjectByName(`big-order-backplate-${slot + 1}`) as THREE.Mesh;
      expect(title).toBeDefined();
      expect(amount).toBeDefined();
      expect(crown).toBeDefined();
      expect(backplate).toBeDefined();
      const titleWorld = title!.getWorldPosition(new THREE.Vector3());
      const amountWorld = amount!.getWorldPosition(new THREE.Vector3());
      const crownWorld = crown!.getWorldPosition(new THREE.Vector3());
      const titleProjected = titleWorld.clone().project(camera);
      const amountProjected = amountWorld.clone().project(camera);
      const crownProjected = crownWorld.clone().project(camera);
      const backplateWorld = backplate.getWorldPosition(new THREE.Vector3());
      const backplateProjected = backplateWorld.clone().project(camera);
      projectedCentres.push(new THREE.Vector2(titleProjected.x, titleProjected.y));
      projectedBackplateWidths.push(backplate.getWorldScale(new THREE.Vector3()).x * 4.25);
      // Every readable component remains above even the largest animal rig.
      expect(titleWorld.y).toBeGreaterThan(2);
      expect(amountWorld.y).toBeGreaterThan(2);
      expect(crownWorld.y).toBeGreaterThan(2);
      for (const projected of [titleProjected, amountProjected, crownProjected]) {
        expect(projected.x).toBeGreaterThan(-1);
        expect(projected.x).toBeLessThan(1);
        expect(projected.y).toBeGreaterThan(-1);
        expect(projected.y).toBeLessThan(1);
        expect(projected.z).toBeGreaterThan(-1);
        expect(projected.z).toBeLessThan(1);
        const screenX = (projected.x * 0.5 + 0.5) * 1280;
        const screenY = (-projected.y * 0.5 + 0.5) * 720;
        if (slot === 0) {
          // The first alert is deliberately front-and-centre for the default
          // spawn camera, not relegated to a peripheral shoulder.
          expect(screenX).toBeGreaterThan(chartBounds!.left + 72);
          expect(screenX).toBeLessThan(chartBounds!.right - 72);
        } else {
          // Overflow remains in the chart frame with enough horizontal
          // breathing room to avoid the live-price rail, rather than relying
          // on an off-frame shoulder that can clip on a real camera view.
          expect(screenX).toBeGreaterThan(chartBounds!.left + 24);
          expect(screenX).toBeLessThan(chartBounds!.right - 24);
        }
        expect(backplateProjected.x).toBeGreaterThan(-1);
        expect(backplateProjected.x).toBeLessThan(1);
        expect(screenY).toBeGreaterThanOrEqual(0);
        expect(screenY).toBeLessThanOrEqual(720);
      }
    }
    // Both overflow cards use the same subordinate scale. This is the guard
    // that prevents a single full-size shoulder card from escaping the view.
    expect(projectedBackplateWidths[1]).toBeCloseTo(projectedBackplateWidths[2]!);
    expect(projectedBackplateWidths[1]).toBeLessThan(projectedBackplateWidths[0]!);
    for (let left = 0; left < projectedCentres.length; left += 1) {
      for (let right = left + 1; right < projectedCentres.length; right += 1) {
        expect(projectedCentres[left]!.distanceTo(projectedCentres[right]!)).toBeGreaterThan(0.1);
      }
    }
    holograms.dispose();
    rig.dispose();
    monument.dispose();
  });
});
