import { describe, expect, it } from 'vitest';
import {
  clampNewsOverlayPosition,
  createNewsConnectorPath,
  safeXPostUrl,
} from '../src/ui/NewsOverlayView';

describe('draggable news overlay geometry', () => {
  it('clamps a dragged card fully inside the current viewport', () => {
    const bounds = {
      viewportWidth: 800,
      viewportHeight: 500,
      cardWidth: 360,
      cardHeight: 240,
      padding: 12,
    };

    expect(clampNewsOverlayPosition({ x: -200, y: -10 }, bounds)).toEqual({ x: 12, y: 12 });
    expect(clampNewsOverlayPosition({ x: 900, y: 700 }, bounds)).toEqual({ x: 428, y: 248 });
    expect(clampNewsOverlayPosition({ x: 120, y: 90 }, bounds)).toEqual({ x: 120, y: 90 });
  });

  it('honours asymmetric landscape safe-area insets', () => {
    const bounds = {
      viewportWidth: 844,
      viewportHeight: 390,
      cardWidth: 320,
      cardHeight: 180,
      insets: { top: 12, right: 47, bottom: 21, left: 47 },
    };
    expect(clampNewsOverlayPosition({ x: -100, y: -100 }, bounds)).toEqual({ x: 47, y: 12 });
    expect(clampNewsOverlayPosition({ x: 900, y: 900 }, bounds)).toEqual({ x: 477, y: 189 });
  });

  it('keeps dragged cards above the reserved footer and touch-control zone', () => {
    expect(clampNewsOverlayPosition({ x: 900, y: 900 }, {
      viewportWidth: 1_280,
      viewportHeight: 720,
      cardWidth: 360,
      cardHeight: 250,
      insets: { top: 12, right: 12, bottom: 88, left: 12 },
    })).toEqual({ x: 900, y: 382 });

    expect(clampNewsOverlayPosition({ x: 900, y: 900 }, {
      viewportWidth: 390,
      viewportHeight: 844,
      cardWidth: 320,
      cardHeight: 250,
      insets: { top: 12, right: 12, bottom: 200, left: 12 },
    })).toEqual({ x: 58, y: 394 });
  });

  it('connects the candle to the nearest card edge with a finite SVG curve', () => {
    const path = createNewsConnectorPath(
      { x: 100, y: 220 },
      { left: 500, top: 120, width: 260, height: 220 },
    );

    expect(path).toMatch(/^M 500\.0 220\.0 C /);
    expect(path).toContain('100.0 220.0');
    expect(path).not.toContain('NaN');
  });

  it('chooses the closest edge when the candle projects behind the card', () => {
    const path = createNewsConnectorPath(
      { x: 540, y: 135 },
      { left: 500, top: 120, width: 260, height: 220 },
    );
    expect(path).toMatch(/^M 540\.0 120\.0 C /);
  });

  it('only labels genuine HTTPS X hosts as post permalinks', () => {
    expect(safeXPostUrl('https://x.com/DeItaone/status/123')).toContain('x.com/DeItaone');
    expect(safeXPostUrl('https://t.co/abc')).toBe('https://t.co/abc');
    expect(safeXPostUrl('http://x.com/DeItaone/status/123')).toBeNull();
    expect(safeXPostUrl('https://example.com/fake-x-post')).toBeNull();
    expect(safeXPostUrl('https://x.com.evil.example/status/123')).toBeNull();
  });
});
