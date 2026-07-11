import { describe, expect, it } from 'vitest';
import { countFreshNewsAdditions } from '../src/Game';

describe('Game news notification integration', () => {
  it('keeps resumed backfill visual while counting only posts created after the sound cutoff', () => {
    const cutoff = 2_000;

    expect(countFreshNewsAdditions([
      { createdAt: 1_000 },
      { createdAt: 1_999 },
      { createdAt: 2_000 },
      { createdAt: 2_400 },
    ], cutoff)).toBe(2);
  });

  it('ignores invalid timestamps and allows normal pre-resume notifications', () => {
    expect(countFreshNewsAdditions([
      { createdAt: Number.NaN },
      { createdAt: 1_000 },
    ], Number.NEGATIVE_INFINITY)).toBe(1);
  });
});
