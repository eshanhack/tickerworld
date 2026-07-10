import type { AssetSymbol } from './types';

export const WORLD_SEED = new URLSearchParams(location.search).get('seed') ?? 'tickerworld-v1';
export const FORCE_SIMULATION = new URLSearchParams(location.search).get('data') === 'sim';
export const DEBUG_MODE = new URLSearchParams(location.search).get('debug') === '1';

export const CHUNK_SIZE = 48;
export const CHUNK_SEGMENTS = 24;
export const ACTIVE_CHUNK_RADIUS = 2;

export const GRAND_MONUMENTS: ReadonlyArray<{
  symbol: AssetSymbol;
  x: number;
  z: number;
  scale: number;
}> = [
  { symbol: 'BTC', x: 0, z: 0, scale: 1.25 },
  { symbol: 'ETH', x: 190, z: 70, scale: 1 },
  { symbol: 'SOL', x: -240, z: 150, scale: 1 },
  { symbol: 'XRP', x: 100, z: -310, scale: 0.95 },
  { symbol: 'DOGE', x: 380, z: 220, scale: 0.95 },
  { symbol: 'BNB', x: -420, z: -240, scale: 1 },
  { symbol: 'LINK', x: -80, z: 520, scale: 0.95 },
  { symbol: 'AVAX', x: 510, z: -400, scale: 1 },
];

export const PALETTE = {
  skyDay: 0xa9d6ce,
  skyNight: 0x26344f,
  grass: 0x8fb78c,
  grassAlt: 0x9ac497,
  sand: 0xd7bd8a,
  cream: 0xfff1cf,
  stone: 0xb8aea0,
  stoneDark: 0x81796f,
  terracotta: 0xc9795c,
  teal: 0x5f9b91,
  pink: 0xe6a3a8,
  green: 0x70b883,
  red: 0xc96c63,
  fox: 0xc9744f,
  foxCream: 0xffe7c0,
  ink: 0x31373d,
} as const;
