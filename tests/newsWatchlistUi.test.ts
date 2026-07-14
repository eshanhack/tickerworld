import { describe, expect, it } from 'vitest';
import {
  NewsInteractionAggregate,
  newsAccountProfileUrl,
  newsWatchlistLayout,
} from '../src/ui';

describe('news source UI coordination', () => {
  it('keeps the shared input lock active until both news surfaces release it', () => {
    const aggregate = new NewsInteractionAggregate();
    expect(aggregate.set('overlay', true)).toBe(true);
    expect(aggregate.active).toBe(true);
    expect(aggregate.set('sources', true)).toBe(false);
    expect(aggregate.set('overlay', false)).toBe(false);
    expect(aggregate.active).toBe(true);
    expect(aggregate.set('sources', false)).toBe(true);
    expect(aggregate.active).toBe(false);
  });

  it('places 320px and 390px portrait rails on the side lane', () => {
    expect(newsWatchlistLayout({ width: 320, height: 568, coarsePointer: true }))
      .toBe('touch-side');
    expect(newsWatchlistLayout({ width: 390, height: 844, coarsePointer: true }))
      .toBe('touch-side');
  });

  it('places an 844px touch landscape rail in the bottom-centre lane', () => {
    expect(newsWatchlistLayout({ width: 844, height: 390, coarsePointer: true }))
      .toBe('touch-landscape-bottom');
    expect(newsWatchlistLayout({ width: 1440, height: 900, coarsePointer: false }))
      .toBe('desktop-side');
  });

  it('creates only origin-bound X profile links', () => {
    expect(newsAccountProfileUrl('DeItaone')).toBe('https://x.com/DeItaone');
    expect(newsAccountProfileUrl('../evil?next=https://example.com')).toBe('https://x.com/');
  });
});
