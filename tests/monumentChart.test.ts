import { Group, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
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
    updatedAt: Date.now(),
    presentationTick,
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
});
