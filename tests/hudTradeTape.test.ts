import { describe, expect, it } from 'vitest';
import { tradeTapeStatusLabel } from '../src/ui/Hud';

describe('nearby trade-tape status', () => {
  it('uses compact, truthful labels for every feed mode', () => {
    expect(tradeTapeStatusLabel('live')).toBe('TAPE LIVE');
    expect(tradeTapeStatusLabel('simulated')).toBe('TAPE SIM');
    expect(tradeTapeStatusLabel('unavailable')).toBe('TAPE OFF');
    expect(tradeTapeStatusLabel('connecting')).toBe('TAPE CONNECTING');
    expect(tradeTapeStatusLabel('reconnecting')).toBe('TAPE RECONNECTING');
  });

  it('hides the badge when the game does not provide a tape state', () => {
    expect(tradeTapeStatusLabel(undefined)).toBeNull();
  });
});
