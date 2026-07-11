import { describe, expect, it } from 'vitest';
import { CANONICAL_WORLD_SEED, multiplayerAllowedForSeed } from '../src/config';

describe('world seed multiplayer policy', () => {
  it('keeps only the canonical world eligible for shared rooms', () => {
    expect(multiplayerAllowedForSeed(CANONICAL_WORLD_SEED)).toBe(true);
    expect(multiplayerAllowedForSeed('qa-seed')).toBe(false);
    expect(multiplayerAllowedForSeed('')).toBe(false);
  });
});
