import { describe, expect, it, vi } from 'vitest';
import { UiInteractionLock } from '../src/ui';

describe('UiInteractionLock', () => {
  it('tracks overlapping owners without duplicate transitions', () => {
    const lock = new UiInteractionLock();
    const listener = vi.fn();
    lock.subscribe(listener);

    lock.set('chat', true);
    lock.set('chat', true);
    lock.set('news', true);
    lock.set('chat', false);

    expect(lock.locked).toBe(true);
    expect(lock.has('news')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(4);
    expect([...listener.mock.calls.at(-1)![1]]).toEqual(['news']);

    lock.clear();
    expect(lock.locked).toBe(false);
  });

  it('does not let a stale lease release a newer operation for the same owner', () => {
    const lock = new UiInteractionLock();
    const releaseFirst = lock.acquire('portal');
    const releaseSecond = lock.acquire('portal');

    releaseFirst();
    expect(lock.has('portal')).toBe(true);
    expect(lock.locked).toBe(true);

    releaseSecond();
    expect(lock.has('portal')).toBe(false);
    expect(lock.locked).toBe(false);
  });
});
