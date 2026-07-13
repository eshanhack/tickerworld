import { describe, expect, it } from 'vitest';
import {
  PARKOUR_RESULTS_VISIBLE_MS,
  formatParkourTime,
  createParkourRunResult,
  parkourDisplayName,
  rankParkourResults,
  scheduleParkourResultDismissal,
  type ParkourResultDismissScheduler,
  type ParkourRunResult,
} from '../src/ui';

describe('parkour session HUD', () => {
  it('formats a stable tenths timer without rolling seconds incorrectly', () => {
    expect(formatParkourTime(0)).toBe('0:00.0');
    expect(formatParkourTime(9.99)).toBe('0:09.9');
    expect(formatParkourTime(65.27)).toBe('1:05.2');
    expect(formatParkourTime(Number.NaN)).toBe('0:00.0');
  });

  it('uses a claimed username or a deterministic friendly anonymous name', () => {
    expect(parkourDisplayName('  Magic_Fox  ', 'fox', 'actor-1')).toBe('Magic_Fox');
    const anonymous = parkourDisplayName(null, 'rabbit', 'actor-123');
    expect(anonymous).toMatch(/^[A-Z][a-z]+ Rabbit$/);
    expect(parkourDisplayName(null, 'rabbit', 'actor-123')).toBe(anonymous);
    expect(parkourDisplayName(null, 'rabbit', 'actor-124')).not.toBe('');
    expect(createParkourRunResult({
      username: 'Magic_Fox',
      animal: 'fox',
      actorId: 'actor-1',
      elapsedSeconds: 21.4,
      market: 'BTC',
      completedAt: 123,
    })).toEqual({
      displayName: 'Magic_Fox',
      elapsedSeconds: 21.4,
      market: 'BTC',
      completedAt: 123,
    });
  });

  it('keeps a bounded, fastest-first session log and never mutates its input', () => {
    const input: ParkourRunResult[] = [
      { displayName: 'Slow Bear', elapsedSeconds: 42.4, market: 'BTC', completedAt: 3 },
      { displayName: 'Quick Frog', elapsedSeconds: 18.2, market: 'TEST', completedAt: 2 },
      { displayName: '  Cat  ', elapsedSeconds: 18.2, market: 'ETH', completedAt: 1 },
      { displayName: '', elapsedSeconds: 1, market: 'SOL', completedAt: 4 },
      { displayName: 'Broken', elapsedSeconds: Number.NaN, market: 'WTI', completedAt: 5 },
    ];
    const before = structuredClone(input);
    const ranked = rankParkourResults(input, 2);
    expect(ranked).toEqual([
      { displayName: 'Cat', elapsedSeconds: 18.2, market: 'ETH', completedAt: 1 },
      { displayName: 'Quick Frog', elapsedSeconds: 18.2, market: 'TEST', completedAt: 2 },
    ]);
    expect(input).toEqual(before);
  });

  it('dismisses the finished-times tile after ten seconds and supports early cancellation', () => {
    let pending: (() => void) | undefined;
    let scheduledDelay = 0;
    let clearCount = 0;
    const timer = 42 as unknown as ReturnType<typeof globalThis.setTimeout>;
    const scheduler: ParkourResultDismissScheduler = {
      setTimeout: (callback, delayMs) => {
        pending = callback;
        scheduledDelay = delayMs;
        return timer;
      },
      clearTimeout: (value) => {
        expect(value).toBe(timer);
        clearCount += 1;
        pending = undefined;
      },
    };
    let dismissed = false;
    const cancel = scheduleParkourResultDismissal(() => { dismissed = true; }, scheduler);

    expect(PARKOUR_RESULTS_VISIBLE_MS).toBe(10_000);
    expect(scheduledDelay).toBe(10_000);
    expect(dismissed).toBe(false);
    cancel();
    cancel();
    expect(clearCount).toBe(1);
    expect(pending).toBeUndefined();
    expect(dismissed).toBe(false);

    scheduleParkourResultDismissal(() => { dismissed = true; }, scheduler);
    pending?.();
    expect(dismissed).toBe(true);
  });
});
