import type { AssetSymbol } from '../types';

export const DEX_CYBERPUNK_SYMBOLS = ['PUMP', 'ANSEM', 'SHFL'] as const;
export type DexCyberpunkSymbol = (typeof DEX_CYBERPUNK_SYMBOLS)[number];

export interface DexCyberpunkPalette {
  readonly skyTop: number;
  readonly skyHorizon: number;
  readonly fog: number;
  readonly ground: number;
  readonly street: number;
  readonly facade: number;
  readonly facadeAlt: number;
  readonly neonPrimary: number;
  readonly neonSecondary: number;
  readonly neonAccent: number;
  readonly window: number;
}

export interface DexCyberpunkTheme {
  readonly symbol: DexCyberpunkSymbol;
  readonly districtName: string;
  readonly palette: DexCyberpunkPalette;
  /** Original, fictional copy—no real Shinjuku venues, brands, or logos. */
  readonly signText: readonly string[];
}

export const DEX_CYBERPUNK_THEMES: Readonly<Record<DexCyberpunkSymbol, DexCyberpunkTheme>> = {
  PUMP: {
    symbol: 'PUMP',
    districtName: 'PUMP ELECTRIC WARD',
    palette: {
      skyTop: 0x241f4f, skyHorizon: 0x6a376a, fog: 0x493458,
      ground: 0x3a3855, street: 0x2d3048, facade: 0x504b73, facadeAlt: 0x666183,
      neonPrimary: 0xff70bd, neonSecondary: 0x65e9ff, neonAccent: 0xffd06b,
      window: 0xffbce1,
    },
    signText: ['PUMP', 'LIQUIDITY ARCADE', 'MOON LINE', 'OPEN 24H', 'NEON BLOCK', 'WICK ALLEY'],
  },
  ANSEM: {
    symbol: 'ANSEM',
    districtName: 'ANSEM SIGNAL CITY',
    palette: {
      skyTop: 0x171c3e, skyHorizon: 0x4a4268, fog: 0x33334d,
      ground: 0x333747, street: 0x292f40, facade: 0x475064, facadeAlt: 0x5d6575,
      neonPrimary: 0xb8ff72, neonSecondary: 0xffa45f, neonAccent: 0x9d8cff,
      window: 0xe9ffbd,
    },
    signText: ['ANSEM', 'SIGNAL TERMINAL', 'NARRATIVE FM', 'NIGHT MARKET', 'ALPHA LANE', 'BLOCK RADIO'],
  },
  SHFL: {
    symbol: 'SHFL',
    districtName: 'SHFL NIGHT DISTRICT',
    palette: {
      skyTop: 0x162c53, skyHorizon: 0x315e77, fog: 0x29475d,
      ground: 0x304653, street: 0x263947, facade: 0x416276, facadeAlt: 0x527b91,
      neonPrimary: 0x62cfff, neonSecondary: 0xff7975, neonAccent: 0xffdc78,
      window: 0xbcecff,
    },
    signText: ['SHFL', 'SHUFFLE CLUB', 'LUCKY BLOCK', 'BLUE HOUR', 'PRISM ALLEY', 'ORDER LANE'],
  },
};

export interface DexCyberpunkGlowState {
  readonly neon: number;
  readonly windows: number;
  readonly streetBounce: number;
  readonly haze: number;
  readonly puddleReflection: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const progress = clamp01((value - edge0) / (edge1 - edge0));
  return progress * progress * (3 - 2 * progress);
}

export function isDexCyberpunkSymbol(symbol: AssetSymbol | string): symbol is DexCyberpunkSymbol {
  return DEX_CYBERPUNK_SYMBOLS.some((candidate) => candidate === symbol);
}

export function getDexCyberpunkTheme(symbol: AssetSymbol | string): DexCyberpunkTheme | null {
  return isDexCyberpunkSymbol(symbol) ? DEX_CYBERPUNK_THEMES[symbol] : null;
}

/** Smooth dusk response: readable by day, vivid at night, never a hard pop. */
export function dexCyberpunkGlowAt(nightFactor: number): DexCyberpunkGlowState {
  const dusk = smoothstep(0.16, 0.84, clamp01(nightFactor));
  return {
    neon: 0.2 + dusk * 0.8,
    windows: 0.12 + dusk * 0.74,
    streetBounce: 0.04 + dusk * 0.34,
    haze: 0.025 + dusk * 0.09,
    puddleReflection: 0.14 + dusk * 0.78,
  };
}
