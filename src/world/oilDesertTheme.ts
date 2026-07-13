import type { AssetSymbol } from '../types';

export type WorldEnvironmentTheme = 'park' | 'cyberpunk' | 'desert';

export const OIL_DESERT_PALETTE = Object.freeze({
  sand: 0xd7aa68,
  sandLight: 0xf0cf8c,
  road: 0xc89154,
  sandstone: 0xb96f47,
  sandstoneLight: 0xd9915c,
  oasis: 0x66a79c,
  palm: 0x527b52,
  scrub: 0x899363,
  oilDark: 0x31383a,
  oilSteel: 0x718181,
  oilAccent: 0xe2a05d,
  skyDay: 0x8ec5cf,
  skyNight: 0x26364e,
  horizon: 0xf0b77b,
  fog: 0xdca66e,
  cloud: 0xf5d6aa,
} as const);

export function worldEnvironmentTheme(symbol: AssetSymbol | string): WorldEnvironmentTheme {
  if (symbol === 'WTI') return 'desert';
  if (symbol === 'PUMP' || symbol === 'ANSEM' || symbol === 'SHFL') return 'cyberpunk';
  return 'park';
}

export function isOilDesertSymbol(symbol: AssetSymbol | string): symbol is 'WTI' {
  return symbol === 'WTI';
}
