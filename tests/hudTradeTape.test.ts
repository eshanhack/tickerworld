import { describe, expect, it } from 'vitest';
import { HELP_DISCLAIMER, nearbyMarketStatusLabel } from '../src/ui/Hud';

describe('nearby market status', () => {
  it('uses only the concise feed state without provider or tape labels', () => {
    expect(nearbyMarketStatusLabel('live')).toBe('LIVE');
    expect(nearbyMarketStatusLabel('simulated')).toBe('SIMULATED');
    expect(nearbyMarketStatusLabel('connecting')).toBe('CONNECTING');
    expect(nearbyMarketStatusLabel('reconnecting')).toBe('RECONNECTING');
  });

  it('keeps the offline-chart and financial-risk copy without naming a provider', () => {
    expect(HELP_DISCLAIMER).toContain('If the chart goes offline, the chart will pause while we reconnect.');
    expect(HELP_DISCLAIMER).toContain('For ambience, not financial advice.');
    expect(HELP_DISCLAIMER).toContain('not responsible for trading losses');
    expect(HELP_DISCLAIMER).not.toMatch(/Hyperliquid/i);
  });
});
