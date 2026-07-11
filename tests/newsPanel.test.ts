import { describe, expect, it } from 'vitest';
import type { NewsItem } from '../src/news';
import { activeNewsItems, findNewsCandleLayout, newsMinute } from '../src/monuments/NewsPanel';
import type { CandleLayout } from '../src/monuments/chartMath';

function item(id: string, createdAt: number, expiresAt = createdAt + 600_000): NewsItem {
  return {
    id,
    source: 'simulation',
    text: `Fictional demo ${id}`,
    links: [],
    createdAt,
    expiresAt,
    authorName: 'Tickerwire Demo',
    authorHandle: 'demo',
    authorAvatarUrl: null,
    permalink: null,
    demo: true,
  };
}

function layout(openTime: number, x: number): CandleLayout {
  return {
    candle: {
      openTime,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      closed: true,
    },
    index: 0,
    x,
    openY: 2,
    closeY: 2.2,
    bodyY: 2.1,
    bodyHeight: 0.2,
    wickY: 2,
    wickHeight: 0.6,
    isUp: true,
  };
}

describe('news chart presentation helpers', () => {
  it('maps a post to the candle for the minute in which it was created', () => {
    const minute = Date.UTC(2026, 6, 11, 4, 20);
    const layouts = [layout(minute - 60_000, -1), layout(minute, 1)];

    expect(newsMinute(minute + 43_210)).toBe(minute);
    expect(findNewsCandleLayout(item('headline', minute + 43_210), layouts)?.x).toBe(1);
  });

  it('keeps only unexpired ten-minute posts, newest first', () => {
    const now = Date.UTC(2026, 6, 11, 4, 30);
    const active = activeNewsItems([
      item('older-active', now - 9 * 60_000),
      item('expired', now - 10 * 60_000),
      item('newest', now - 1_000),
      item('future', now + 1_000),
    ], now);

    expect(active.map(({ id }) => id)).toEqual(['newest', 'older-active']);
  });

  it('honours an earlier server expiry and a bounded visual pool', () => {
    const now = 1_000_000;
    const items = Array.from({ length: 20 }, (_, index) => item(
      `item-${index}`,
      now - index * 1_000,
      index === 3 ? now - 1 : now + 600_000,
    ));

    const active = activeNewsItems(items, now, 5);
    expect(active).toHaveLength(5);
    expect(active.map(({ id }) => id)).toEqual(['item-0', 'item-1', 'item-2', 'item-4', 'item-5']);
  });
});
