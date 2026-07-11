import { describe, expect, it } from 'vitest';
import { accountBlockMerge } from '../src/social';

describe('account block merging', () => {
  it('keeps the union and identifies local-only blocks for upload', () => {
    const result = accountBlockMerge(new Set(['local', 'both']), ['server', 'both']);
    expect([...result.union].sort()).toEqual(['both', 'local', 'server']);
    expect(result.localOnly).toEqual(['local']);
  });
});
