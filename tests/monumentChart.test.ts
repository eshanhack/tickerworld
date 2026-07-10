import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/types';
import {
  MONUMENT_CANDLE_COUNT,
  computePriceRange,
  didCandleWindowRoll,
  easePriceRange,
  layoutCandles,
  smoothCandles,
} from '../src/monuments/chartMath';

function candle(openTime: number, open: number, high: number, low: number, close: number, closed = true): Candle {
  return { openTime, open, high, low, close, closed };
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
});
