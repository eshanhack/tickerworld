import { describe, expect, it } from 'vitest';
import {
  parseSharedWorldEnvironment,
  projectSharedWorldElapsed,
} from '../src/net';

describe('shared room environment timeline', () => {
  const environment = {
    elapsedSeconds: 321.25,
    updatedAt: 1_700_000_000_000,
    dayDurationSeconds: 18 * 60,
  } as const;

  it('accepts a bounded authoritative room clock and advances it from receipt time', () => {
    expect(parseSharedWorldEnvironment(environment)).toEqual(environment);
    expect(projectSharedWorldElapsed(environment, 10_000, 10_750)).toBeCloseTo(322, 8);
    // Browser and server wall clocks may differ; only local elapsed time after
    // receiving the state patch influences the projected shared timeline.
    expect(projectSharedWorldElapsed(environment, 10_000, 9_000)).toBe(321.25);
  });

  it('fails closed for malformed or implausible environment data', () => {
    expect(parseSharedWorldEnvironment(null)).toBeNull();
    expect(parseSharedWorldEnvironment({ ...environment, elapsedSeconds: -1 })).toBeNull();
    expect(parseSharedWorldEnvironment({ ...environment, elapsedSeconds: Number.NaN })).toBeNull();
    expect(parseSharedWorldEnvironment({ ...environment, updatedAt: 'now' })).toBeNull();
    expect(parseSharedWorldEnvironment({ ...environment, dayDurationSeconds: 10 })).toBeNull();
    expect(parseSharedWorldEnvironment({ ...environment, dayDurationSeconds: 3_601 })).toBeNull();
  });
});
