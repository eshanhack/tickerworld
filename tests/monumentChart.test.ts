import { Group, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ASSET_SYMBOLS, type AssetState, type Candle } from '../src/types';
import {
  MONUMENT_CANDLE_COUNT,
  MONUMENT_SHUNT_DURATION_SECONDS,
  computePriceRange,
  didCandleWindowRoll,
  easePriceRange,
  formatPrice,
  layoutCandles,
  smoothCandles,
} from '../src/monuments/chartMath';
import { buildMedallion } from '../src/monuments/medallions';
import { MEDALLION_CENTER, PLINTH_BOUNDS } from '../src/monuments/monumentGeometry';
import { Monument } from '../src/monuments/Monument';

function candle(openTime: number, open: number, high: number, low: number, close: number, closed = true): Candle {
  return { openTime, open, high, low, close, closed };
}

function state(candles: readonly Candle[], presentationTick = 1): AssetState {
  const price = candles.at(-1)?.close ?? null;
  return {
    symbol: 'BTC',
    instrument: 'BTC',
    provider: 'hyperliquid',
    candles,
    price,
    previousPrice: price,
    direction: 'up',
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
