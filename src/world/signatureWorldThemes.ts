/**
 * Original visual identities for the eleven 24/7 signature-market worlds.
 * These motifs deliberately describe an industry or product idea instead of
 * reproducing company logos, headquarters, ad campaigns, or trade dress.
 */
export const SIGNATURE_WORLD_SYMBOLS = [
  'SKHYNIX',
  'HYPE',
  'XYZ100',
  'SP500',
  'MU',
  'SPACEX',
  'NVDA',
  'GOLD',
  'AAPL',
  'META',
  'GOOGL',
] as const;

export type SignatureMarketSymbol = (typeof SIGNATURE_WORLD_SYMBOLS)[number];

export type SignatureWorldMotif =
  | 'memory-stack'
  | 'hypercore-islands'
  | 'innovation-skyline'
  | 'sector-mosaic'
  | 'memory-canyon'
  | 'launch-coast'
  | 'ai-factory'
  | 'gold-vault'
  | 'idea-orchard'
  | 'connection-loom'
  | 'information-atlas';

export type SignatureParticleStyle = 'data' | 'embers' | 'petals' | 'stars' | 'threads';

export interface SignatureWorldThemeDefinition {
  readonly symbol: SignatureMarketSymbol;
  readonly title: string;
  readonly motif: SignatureWorldMotif;
  readonly primary: number;
  readonly secondary: number;
  readonly accent: number;
  readonly ground: number;
  readonly particle: number;
  readonly particleStyle: SignatureParticleStyle;
  readonly lightColor: number;
}

export const SIGNATURE_WORLD_THEMES: Readonly<Record<SignatureMarketSymbol, SignatureWorldThemeDefinition>> = {
  SKHYNIX: {
    symbol: 'SKHYNIX',
    title: 'STACKED MEMORY GARDEN',
    motif: 'memory-stack',
    primary: 0x6b8fb8,
    secondary: 0xa6c4d8,
    accent: 0xf0aabf,
    ground: 0x718f88,
    particle: 0xccecff,
    particleStyle: 'data',
    lightColor: 0x9edfff,
  },
  HYPE: {
    symbol: 'HYPE',
    title: 'HYPERCORE ARCHIPELAGO',
    motif: 'hypercore-islands',
    primary: 0x49bfa5,
    secondary: 0x9be8c9,
    accent: 0xd5f4bb,
    ground: 0x427d77,
    particle: 0xa4ffe3,
    particleStyle: 'threads',
    lightColor: 0x76ffd6,
  },
  XYZ100: {
    symbol: 'XYZ100',
    title: 'INNOVATION SKYLINE',
    motif: 'innovation-skyline',
    primary: 0x687fd0,
    secondary: 0xaeb9f1,
    accent: 0xf2a8ca,
    ground: 0x606f91,
    particle: 0xcdd7ff,
    particleStyle: 'data',
    lightColor: 0xb8c7ff,
  },
  SP500: {
    symbol: 'SP500',
    title: 'AMERICAN MARKET MOSAIC',
    motif: 'sector-mosaic',
    primary: 0xb17873,
    secondary: 0xe1b583,
    accent: 0x7fb7a2,
    ground: 0x7f8f74,
    particle: 0xffdda8,
    particleStyle: 'petals',
    lightColor: 0xffc77c,
  },
  MU: {
    symbol: 'MU',
    title: 'MEMORY CANYON',
    motif: 'memory-canyon',
    primary: 0x5486a8,
    secondary: 0x9bc7d1,
    accent: 0xe5b17b,
    ground: 0x647c7e,
    particle: 0xbce8ee,
    particleStyle: 'data',
    lightColor: 0x8adff0,
  },
  SPACEX: {
    symbol: 'SPACEX',
    title: 'REUSABLE LAUNCH COAST',
    motif: 'launch-coast',
    primary: 0xaab8c3,
    secondary: 0x6f839a,
    accent: 0xe99376,
    ground: 0x687e7b,
    particle: 0xf0f5ff,
    particleStyle: 'stars',
    lightColor: 0xffd1a3,
  },
  NVDA: {
    symbol: 'NVDA',
    title: 'AI FACTORY GARDEN',
    motif: 'ai-factory',
    primary: 0x72a967,
    secondary: 0xb5d493,
    accent: 0x83d7b1,
    ground: 0x5e7c65,
    particle: 0xc8ffc0,
    particleStyle: 'data',
    lightColor: 0xa9ff90,
  },
  GOLD: {
    symbol: 'GOLD',
    title: 'AURIC VAULT GROTTO',
    motif: 'gold-vault',
    primary: 0xd4a84f,
    secondary: 0xf3d48a,
    accent: 0xffedb1,
    ground: 0x88765d,
    particle: 0xffe8a0,
    particleStyle: 'embers',
    lightColor: 0xffd46b,
  },
  AAPL: {
    symbol: 'AAPL',
    title: 'ORCHARD OF IDEAS',
    motif: 'idea-orchard',
    primary: 0x9da9a8,
    secondary: 0xdce2db,
    accent: 0xe7a28c,
    ground: 0x6f9275,
    particle: 0xffd3c7,
    particleStyle: 'petals',
    lightColor: 0xffc6ac,
  },
  META: {
    symbol: 'META',
    title: 'CONNECTION LOOM',
    motif: 'connection-loom',
    primary: 0x7197d6,
    secondary: 0xaabff0,
    accent: 0xdb9ddb,
    ground: 0x667b91,
    particle: 0xd7c4ff,
    particleStyle: 'threads',
    lightColor: 0xa9bfff,
  },
  GOOGL: {
    symbol: 'GOOGL',
    title: 'INFORMATION ATLAS',
    motif: 'information-atlas',
    primary: 0x79a9d8,
    secondary: 0xe9b96e,
    accent: 0xd98585,
    ground: 0x66867d,
    particle: 0xd5ebff,
    particleStyle: 'data',
    lightColor: 0x9edaff,
  },
};

export function isSignatureMarketSymbol(symbol: string): symbol is SignatureMarketSymbol {
  return (SIGNATURE_WORLD_SYMBOLS as readonly string[]).includes(symbol);
}

