import {
  Group,
  Mesh,
  PerspectiveCamera,
  PointLight,
  Points,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'troika-three-text';
import { ASSET_SYMBOLS, type AssetState, type Candle, type TickDirection } from '../src/types';
import {
  MONUMENT_CANDLE_COUNT,
  MONUMENT_SHUNT_DURATION_SECONDS,
  computePriceRange,
  didCandleWindowRoll,
  easePriceRange,
  formatPrice,
  layoutCandles,
  smoothCandles,
  stepCriticallyDampedSpring,
} from '../src/monuments/chartMath';
import { buildMedallion } from '../src/monuments/medallions';
import { MEDALLION_CENTER, PLINTH_BOUNDS } from '../src/monuments/monumentGeometry';
import { Monument } from '../src/monuments/Monument';
import { TickTrailPool } from '../src/monuments/TickTrailPool';
import {
  HORIZON_BADGE_LAYOUT,
  HorizonBadgePanel,
} from '../src/monuments/HorizonBadgePanel';
import { createEmptyHorizonChanges } from '../src/markets';
import {
  MONUMENT_CHART_HEIGHT,
  MONUMENT_CHART_WIDTH,
  MONUMENT_OVERLAY_RENDER_ORDER,
  MONUMENT_PRESENTATION_FORWARD_OFFSET,
} from '../src/monuments/Monument';

function candle(openTime: number, open: number, high: number, low: number, close: number, closed = true): Candle {
  return { openTime, open, high, low, close, closed };
}

function state(
  candles: readonly Candle[],
  presentationTick = 1,
  direction: TickDirection = 'up',
): AssetState {
  const price = candles.at(-1)?.close ?? null;
  return {
    symbol: 'BTC',
    instrument: 'BTC',
    provider: 'hyperliquid',
    candles,
    price,
    previousPrice: price,
    direction,
    mode: 'live',
    updateKind: 'trade',
    updatedAt: Date.now(),
    presentationTick,
    horizonChanges: createEmptyHorizonChanges(),
  };
}

describe('monument chart math', () => {
  it('keeps the latest 30 candles and maps OHLC values without clipping', () => {
    const candles = Array.from({ length: 35 }, (_, index) => (
      candle(index, 100 + index, 103 + index, 98 + index, 102 + index)
    ));
    const range = computePriceRange(candles);
    const layouts = layoutCandles(candles, range, 15, 5);

    expect(layouts).toHaveLength(MONUMENT_CANDLE_COUNT);
    expect(layouts[0]?.candle.openTime).toBe(5);
    expect(layouts.every((layout) => layout.wickHeight >= layout.bodyHeight * 0.01)).toBe(true);
    expect(layouts.every((layout) => layout.wickY >= 0 && layout.wickY <= 5)).toBe(true);
  });

  it('sanitizes malformed candle bounds before layout', () => {
    const layouts = layoutCandles(
      [candle(1, 10, 8, 12, 11)],
      computePriceRange([candle(1, 10, 8, 12, 11)]),
      15,
      5,
    );
    expect(layouts[0]?.wickHeight).toBeGreaterThanOrEqual(layouts[0]?.bodyHeight ?? 0);
  });

  it('expands a range immediately and eases contractions', () => {
    const expanded = easePriceRange({ min: 90, max: 110 }, { min: 80, max: 120 }, 0.016);
    expect(expanded).toEqual({ min: 80, max: 120 });

    const contracted = easePriceRange({ min: 80, max: 120 }, { min: 90, max: 110 }, 0.016);
    expect(contracted.min).toBeGreaterThan(80);
    expect(contracted.min).toBeLessThan(90);
    expect(contracted.max).toBeLessThan(120);
    expect(contracted.max).toBeGreaterThan(110);
  });

  it('detects an ordered minute-window rollover', () => {
    const previous = [candle(1, 10, 11, 9, 10), candle(2, 10, 12, 9, 11, false)];
    const next = [candle(2, 10, 12, 9, 11), candle(3, 11, 11, 11, 11, false)];
    expect(didCandleWindowRoll(previous, next)).toBe(true);
    expect(didCandleWindowRoll(next, next)).toBe(false);
  });

  it('smooths only the live candle while closed history snaps to truth', () => {
    const displayed = [candle(1, 10, 11, 9, 10), candle(2, 10, 10, 10, 10, false)];
    const target = [candle(1, 10, 13, 8, 12), candle(2, 10, 12, 9, 12, false)];
    const smoothed = smoothCandles(displayed, target, 0.016);

    expect(smoothed[0]).toEqual(target[0]);
    expect(smoothed[1]?.close).toBeGreaterThan(10);
    expect(smoothed[1]?.close).toBeLessThan(12);
  });

  it('critically damps live geometry to truth without inventing overshoot', () => {
    let spring = { value: 10, velocity: 0 };
    let previous = spring.value;
    for (let frame = 0; frame < 90; frame += 1) {
      spring = stepCriticallyDampedSpring(spring, 14, 1 / 60, 0.19);
      expect(spring.value).toBeGreaterThanOrEqual(previous);
      expect(spring.value).toBeLessThanOrEqual(14);
      previous = spring.value;
    }
    expect(spring.value).toBeCloseTo(14, 4);
  });

  it('uses the locked shunt timing and adaptive nullable price formatting', () => {
    expect(MONUMENT_SHUNT_DURATION_SECONDS).toBe(0.58);
    expect(formatPrice(null)).toBe('$—');
    expect(formatPrice(64_127.125)).toBe('$64,127.13');
    expect(formatPrice(12.3456)).toBe('$12.346');
    expect(formatPrice(0.1234567)).toBe('$0.123457');
  });

  it('renders candles through four fixed pastel pools and moves the live matrix', () => {
    const monument = new Monument({ symbol: 'BTC' });
    const initial = [
      candle(1, 10, 12, 9, 11),
      candle(2, 11, 12, 9, 10),
      candle(3, 10, 11, 8, 9),
      candle(4, 9, 10, 9, 10, false),
    ];
    monument.setAssetState(state(initial));
    monument.update(0.016, 0);

    expect(monument.greenBodyInstances.material.color.getHex()).toBe(0x8fd8a3);
    expect(monument.greenWickInstances.material.color.getHex()).toBe(0x8fd8a3);
    expect(monument.redBodyInstances.material.color.getHex()).toBe(0xefa09a);
    expect(monument.redWickInstances.material.color.getHex()).toBe(0xefa09a);
    expect(monument.greenBodyInstances.instanceColor).toBeNull();
    expect(monument.redBodyInstances.instanceColor).toBeNull();
    expect(monument.greenBodyInstances.count + monument.redBodyInstances.count).toBe(4);
    expect(monument.greenWickInstances.count + monument.redWickInstances.count).toBe(4);
    expect(monument.root.getObjectByName('BTC-active-candle-highlight')?.visible).toBe(true);

    const before = Array.from(monument.greenBodyInstances.instanceMatrix.array);
    const next = [...initial.slice(0, -1), candle(4, 9, 13, 9, 12.5, false)];
    monument.setAssetState(state(next, 2));
    monument.update(0.08, 0.08);
    expect(Array.from(monument.greenBodyInstances.instanceMatrix.array)).not.toEqual(before);
    monument.dispose();
  });

  it('keeps a true-price guide alive and emits a pooled bead for flat ticks', () => {
    const monument = new Monument({ symbol: 'BTC' });
    const initial = [
      candle(1, 8, 13, 7, 11),
      candle(2, 11, 14, 9, 12),
      candle(3, 12, 13, 10, 11, false),
    ];
    monument.setAssetState(state(initial, 1, 'flat'));
    monument.update(0.016, 0.016);

    expect(monument.livePriceGuide.visible).toBe(true);
    expect(monument.livePriceMarker.visible).toBe(true);
    expect(monument.livePriceGuide.position.y).toBeCloseTo(monument.livePriceMarker.position.y, 8);
    expect(monument.activeTickBeadCount).toBe(1);
    expect(monument.root.getObjectByName('live-market-tick-trail')).toBeDefined();

    const flatMarkerScale = monument.livePriceMarker.scale.x;
    monument.setAssetState(state(initial, 2, 'flat'));
    monument.update(0.016, 0.032);
    expect(monument.activeTickBeadCount).toBe(2);
    expect(monument.livePriceMarker.scale.x).toBeGreaterThanOrEqual(flatMarkerScale);

    const priorGuideY = monument.livePriceGuide.position.y;
    const moved = [...initial.slice(0, -1), candle(3, 12, 13, 10, 12, false)];
    monument.setAssetState(state(moved, 3, 'up'));
    monument.update(0.08, 0.112);
    expect(monument.livePriceGuide.position.y).toBeGreaterThan(priorGuideY);
    expect(monument.livePriceGuide.position.y).toBeCloseTo(monument.livePriceMarker.position.y, 8);
    monument.dispose();
  });

  it('bounds and disposes the tick trail pool exactly once', () => {
    const trail = new TickTrailPool(2);
    const disposeMesh = vi.spyOn(trail.mesh, 'dispose');
    const disposeGeometry = vi.spyOn(trail.mesh.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(trail.mesh.material, 'dispose');
    expect(trail.emit(100, 'up')).toBe(true);
    expect(trail.emit(101, 'down')).toBe(true);
    expect(trail.emit(102, 'flat')).toBe(true);
    trail.update(0.016, { min: 90, max: 110 }, 5, 7);
    expect(trail.activeCount).toBeLessThanOrEqual(2);
    expect(trail.mesh.count).toBe(trail.activeCount);

    trail.dispose();
    trail.dispose();
    expect(trail.mesh.count).toBe(0);
    expect(disposeMesh).toHaveBeenCalledTimes(1);
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
    expect(trail.emit(103, 'up')).toBe(false);
  });

  it('samples transformed plaza tiers and collides with only solid shrine volumes', () => {
    const parent = new Group();
    const monument = new Monument({
      symbol: 'ETH',
      position: { x: 100, y: 7, z: -20 },
      scale: 2,
    });
    monument.mount(parent);
    parent.updateMatrixWorld(true);

    expect(monument.sampleGround(100, -20)).toEqual({ height: 8.68, surface: 'stone' });
    expect(monument.sampleGround(117, -20)?.height).toBeCloseTo(8.18, 6);
    expect(monument.sampleGround(125, -20)).toBeNull();

    const medallionPoint = monument.root.localToWorld(new Vector3(
      MEDALLION_CENTER.x,
      MEDALLION_CENTER.y,
      MEDALLION_CENTER.z,
    ));
    const plinthPoint = monument.root.localToWorld(new Vector3(
      PLINTH_BOUNDS.centerX,
      PLINTH_BOUNDS.centerY,
      PLINTH_BOUNDS.centerZ,
    ));
    const clearPoint = monument.root.localToWorld(new Vector3(0, 3.2, 6));
    expect(monument.collidesCamera(medallionPoint.x, medallionPoint.y, medallionPoint.z)).toBe(true);
    expect(monument.collidesCamera(plinthPoint.x, plinthPoint.y, plinthPoint.z)).toBe(true);
    expect(monument.collidesCamera(clearPoint.x, clearPoint.y, clearPoint.z)).toBe(false);

    const camera = new PerspectiveCamera();
    const pivot = monument.root.localToWorld(new Vector3(
      MEDALLION_CENTER.x,
      MEDALLION_CENTER.y,
      MEDALLION_CENTER.z,
    ));
    camera.position.copy(monument.root.localToWorld(new Vector3(
      MEDALLION_CENTER.x + 20,
      MEDALLION_CENTER.y + 3,
      MEDALLION_CENTER.z,
    )));
    monument.update(1 / 60, 0, camera);
    parent.updateMatrixWorld(true);

    const medallion = monument.root.getObjectByName('eth-grand-medallion') as Group;
    const rotatedSolidPoint = medallion.localToWorld(new Vector3(
      MEDALLION_CENTER.x + 2,
      MEDALLION_CENTER.y,
      MEDALLION_CENTER.z,
    ));
    const staleHeadingPoint = monument.root.localToWorld(new Vector3(
      MEDALLION_CENTER.x + 2,
      MEDALLION_CENTER.y,
      MEDALLION_CENTER.z,
    ));
    expect(camera.position.x).toBeGreaterThan(pivot.x);
    expect(monument.collidesCamera(
      rotatedSolidPoint.x,
      rotatedSolidPoint.y,
      rotatedSolidPoint.z,
    )).toBe(true);
    expect(monument.collidesCamera(
      staleHeadingPoint.x,
      staleHeadingPoint.y,
      staleHeadingPoint.z,
    )).toBe(false);
    expect(monument.collidesCamera(plinthPoint.x, plinthPoint.y, plinthPoint.z)).toBe(true);
    monument.dispose();
  });

  it('builds an identifiable primitive medallion for every symbol and simplifies echoes', () => {
    for (const symbol of ASSET_SYMBOLS) {
      const group = buildMedallion(symbol, 'grand');
      expect(group.name).toBe(`${symbol.toLowerCase()}-grand-medallion`);
      expect(group.children.length).toBeGreaterThan(1);
    }

    const grand = buildMedallion('BTC', 'grand');
    const echo = buildMedallion('BTC', 'echo');
    expect(echo.name).toBe('btc-echo-medallion');
    expect(echo.children.length).toBeLessThan(grand.children.length);
  });

  it('smoothly yaws the crest and market presentation while scenery and plinth stay fixed', () => {
    const world = new Group();
    world.position.set(4, 0, -7);
    world.rotation.y = 0.42;
    world.scale.setScalar(1.2);
    const monument = new Monument({ symbol: 'BTC', position: { x: 3, z: -2 } });
    monument.mount(world);
    world.updateMatrixWorld(true);

    const presentation = monument.root.getObjectByName('BTC-facing-presentation') as Group;
    const chart = monument.root.getObjectByName('BTC-chart');
    const medallion = monument.root.getObjectByName('btc-grand-medallion');
    const plinth = monument.root.getObjectByName('btc-medallion-plinth') as Mesh;
    const symbolLabel = monument.root.getObjectByName('BTC-symbol-label');
    const marketUi = monument.root.getObjectByName('BTC-market-ui');
    expect(chart?.parent).toBe(presentation);
    expect(medallion?.parent).toBe(presentation);
    expect(plinth.parent).toBe(monument.root);
    expect(symbolLabel?.parent).toBe(presentation);
    expect(marketUi?.parent).toBe(presentation);
    expect(monument.root.getObjectByName('market-horizon-panel')?.parent).toBe(marketUi);

    for (const fixedName of [
      'BTC-plaza-tier-1',
      'btc-medallion-plinth',
      'BTC-bench-left',
      'BTC-lamp-pole-1',
      'BTC-lamp-light-1',
      'BTC-planter-1',
    ]) {
      expect(monument.root.getObjectByName(fixedName)?.parent).toBe(monument.root);
    }
    expect(monument.root.getObjectByName('BTC-lamp-aura-1')).toBeUndefined();
    const lampLight = monument.root.getObjectByName('BTC-lamp-light-1') as PointLight;
    expect(lampLight.visible).toBe(false);
    monument.setNightFactor(1);
    expect(lampLight.visible).toBe(true);
    expect(lampLight.intensity).toBeCloseTo(32, 5);
    expect(lampLight.distance).toBe(13);
    expect(lampLight.decay).toBe(2);

    const camera = new PerspectiveCamera();
    const pivot = presentation.getWorldPosition(new Vector3());
    const assertFacesCamera = (): void => {
      world.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const position = presentation.getWorldPosition(new Vector3());
      const forward = presentation
        .localToWorld(new Vector3(0, 0, 1))
        .sub(position)
        .setY(0)
        .normalize();
      const towardCamera = camera.position.clone().sub(position).setY(0).normalize();
      expect(forward.dot(towardCamera)).toBeGreaterThan(0.999);
      expect(presentation.rotation.x).toBe(0);
      expect(presentation.rotation.z).toBe(0);
      expect(marketUi?.rotation.x).toBe(0);
      expect(marketUi?.rotation.y).toBe(0);
      expect(marketUi?.rotation.z).toBe(0);
    };

    camera.position.copy(pivot).add(new Vector3(0, 8, 24));
    monument.update(1 / 60, 0, camera);
    assertFacesCamera();

    for (const offset of [new Vector3(22, 6, 0), new Vector3(-16, 5, -18)]) {
      camera.position.copy(pivot).add(offset);
      const priorYaw = presentation.rotation.y;
      monument.update(1 / 60, 1 / 60, camera);
      expect(presentation.rotation.y).not.toBe(priorYaw);
      for (let frame = 0; frame < 180; frame += 1) {
        monument.update(1 / 60, (frame + 2) / 60, camera);
      }
      assertFacesCamera();
    }

    // At an exact 90-degree side view, the chart and UI still share the
    // presentation heading without moving closer and growing on screen.
    camera.position.copy(monument.root.localToWorld(new Vector3(
      MEDALLION_CENTER.x + 40,
      8,
      MEDALLION_CENTER.z,
    )));
    for (let frame = 0; frame < 180; frame += 1) {
      monument.update(1 / 60, (frame + 200) / 60, camera);
    }
    assertFacesCamera();
    expect(presentation.rotation.y).toBeCloseTo(Math.PI * 0.5, 5);
    const facingPivot = presentation.getWorldPosition(new Vector3());
    const forward = presentation
      .localToWorld(new Vector3(0, 0, 1))
      .sub(facingPivot)
      .setY(0)
      .normalize();
    const chartDepth = (chart?.getWorldPosition(new Vector3()) ?? new Vector3())
      .sub(facingPivot)
      .dot(forward);
    const marketUiDepth = (marketUi?.getWorldPosition(new Vector3()) ?? new Vector3())
      .sub(facingPivot)
      .dot(forward);
    expect(chartDepth).toBeCloseTo(MONUMENT_PRESENTATION_FORWARD_OFFSET * 1.2, 5);
    expect(marketUiDepth).toBeCloseTo(chartDepth, 5);
    expect(MEDALLION_CENTER.z + MONUMENT_PRESENTATION_FORWARD_OFFSET).toBeCloseTo(3.15, 8);

    // Market geometry is an intentional magical overlay: it keeps the old
    // readable depth while no static bench, lamp, or planter can hide it.
    for (const [overlayRoot, minimumOrder] of [
      [chart, MONUMENT_OVERLAY_RENDER_ORDER],
      [marketUi, MONUMENT_OVERLAY_RENDER_ORDER + 1],
    ] as const) {
      let renderableCount = 0;
      overlayRoot?.traverse((object) => {
        if (!(object instanceof Mesh) && !(object instanceof Points)) return;
        renderableCount += 1;
        expect(object.renderOrder).toBeGreaterThanOrEqual(minimumOrder);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          expect(material.depthTest).toBe(false);
          expect(material.depthWrite).toBe(false);
        }
      });
      expect(renderableCount).toBeGreaterThan(0);
    }

    const disposeGeometry = vi.spyOn(plinth.geometry, 'dispose');
    monument.dispose();
    monument.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
  });

  it('uses a taller, forward chart plane and keeps horizon badges grand-only', () => {
    const grand = new Monument({ symbol: 'BTC', kind: 'grand' });
    const echo = new Monument({ symbol: 'BTC', kind: 'echo' });
    const grandChart = grand.root.getObjectByName('BTC-chart');
    const echoChart = echo.root.getObjectByName('BTC-chart');

    expect(MONUMENT_CHART_WIDTH).toBeGreaterThanOrEqual(14);
    expect(MONUMENT_CHART_HEIGHT).toBeGreaterThanOrEqual(5.7);
    expect(grandChart?.scale.y).toBe(1);
    expect(grandChart?.position.z).toBeGreaterThan(3);
    expect(echoChart?.scale.y).toBe(1);
    expect(grand.root.getObjectByName('market-horizon-panel')).toBeDefined();
    expect(echo.root.getObjectByName('market-horizon-panel')).toBeUndefined();
    expect(grand.root.getObjectByName('horizon-badge-1y')).toBeDefined();

    grand.dispose();
    echo.dispose();
  });

  it('updates countdown and seven direction badges, then disposes shared resources once', () => {
    const panel = new HorizonBadgePanel();
    const changes = createEmptyHorizonChanges().map((change, index) => ({
      ...change,
      referenceTime: 1,
      referencePrice: 100,
      changeRatio: index === 0 ? 0.012 : index === 1 ? -0.02 : 0,
      direction: index === 0 ? 'up' as const : index === 1 ? 'down' as const : 'flat' as const,
    }));
    panel.setChanges(changes);
    panel.update(1, 59_000, 'live');

    expect(panel.badgeCount).toBe(7);
    expect(panel.countdownLabel).toBe('NEXT CANDLE  0:01');
    const upCard = panel.root.getObjectByName('horizon-card-1m');
    const downCard = panel.root.getObjectByName('horizon-card-15m');
    const upBadge = panel.root.getObjectByName('horizon-badge-1m') as Group;
    const upClock = panel.root.getObjectByName('horizon-clock-1m') as Mesh;
    const upTimeframe = panel.root.getObjectByName('horizon-timeframe-1m') as Text;
    const upChange = panel.root.getObjectByName('horizon-change-1m') as Text;
    expect(upCard).toBeInstanceOf(Mesh);
    expect(downCard).toBeInstanceOf(Mesh);
    expect((upCard as Mesh).material).not.toBe((downCard as Mesh).material);
    expect(upTimeframe.text).toBe('1m');
    expect(upChange.text).toBe('↑  +1.20%');
    expect(upTimeframe.position.y).toBeGreaterThan(upChange.position.y);
    expect(upClock.position.x).toBe(HORIZON_BADGE_LAYOUT.clockCenterX);
    expect(upTimeframe.anchorX).toBe('left');
    expect(upChange.anchorX).toBe('left');
    expect(upChange.position.x).toBe(HORIZON_BADGE_LAYOUT.textStartX);
    expect(
      HORIZON_BADGE_LAYOUT.clockCenterX + HORIZON_BADGE_LAYOUT.clockOuterRadius,
    ).toBeLessThan(HORIZON_BADGE_LAYOUT.textStartX);
    expect(
      Math.abs(upBadge.position.x) - HORIZON_BADGE_LAYOUT.cardWidth * 0.5,
    ).toBeGreaterThan(MONUMENT_CHART_WIDTH * 0.5);

    const disposeGeometry = vi.spyOn((upCard as Mesh).geometry, 'dispose');
    panel.dispose();
    panel.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(panel.badgeCount).toBe(0);
    expect(panel.root.children).toHaveLength(0);
  });
});
