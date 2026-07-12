import { describe, expect, it } from 'vitest';
import { ASSET_SYMBOLS } from '../src/types';
import {
  DEX_CYBERPUNK_SYMBOLS,
  DEX_CYBERPUNK_THEMES,
  dexCyberpunkGlowAt,
  getDexCyberpunkTheme,
  isDexCyberpunkSymbol,
} from '../src/world/dexCyberpunkTheme';

describe('DEX cyberpunk themes', () => {
  it('applies only to PUMP, ANSEM, and SHFL with distinct palettes and original copy', () => {
    expect(ASSET_SYMBOLS.filter(isDexCyberpunkSymbol)).toEqual(DEX_CYBERPUNK_SYMBOLS);
    expect(getDexCyberpunkTheme('BTC')).toBeNull();
    expect(new Set(DEX_CYBERPUNK_SYMBOLS.map((symbol) => (
      DEX_CYBERPUNK_THEMES[symbol].palette.neonPrimary
    ))).size).toBe(3);
    for (const symbol of DEX_CYBERPUNK_SYMBOLS) {
      expect(DEX_CYBERPUNK_THEMES[symbol].districtName).toContain(symbol);
      expect(DEX_CYBERPUNK_THEMES[symbol].signText).toContain(symbol);
    }
  });

  it('eases every glow channel monotonically from readable day to vivid night', () => {
    const values = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(dexCyberpunkGlowAt);
    for (const channel of ['neon', 'windows', 'streetBounce', 'haze', 'puddleReflection'] as const) {
      for (let index = 1; index < values.length; index += 1) {
        expect(values[index]![channel]).toBeGreaterThanOrEqual(values[index - 1]![channel]);
      }
    }
    expect(dexCyberpunkGlowAt(0).neon).toBe(0.2);
    expect(dexCyberpunkGlowAt(1).neon).toBe(1);
  });
});
