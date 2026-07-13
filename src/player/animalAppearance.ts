import {
  ANIMAL_KINDS,
  type AnimalKind,
  type PremiumSkinId,
  type SkinId,
} from '../../shared/src/index.js';
import { PALETTE } from '../config';

export interface AnimalAppearancePalette {
  readonly primary: number;
  readonly secondary: number;
  readonly dark: number;
  readonly accent: number;
  readonly highlight: number;
}

export interface AnimalAppearanceProfile {
  readonly animal: AnimalKind;
  readonly skin: SkinId;
  readonly palette: AnimalAppearancePalette;
  readonly premium: boolean;
}

export const BASE_ANIMAL_PALETTES: Readonly<Record<AnimalKind, AnimalAppearancePalette>> = {
  fox: {
    primary: PALETTE.fox,
    secondary: PALETTE.foxCream,
    dark: PALETTE.ink,
    accent: PALETTE.pink,
    highlight: PALETTE.cream,
  },
  penguin: {
    primary: 0x526a78,
    secondary: 0xfff1cf,
    dark: 0x31373d,
    accent: 0xe8a35f,
    highlight: 0xb8dce2,
  },
  frog: {
    primary: 0x79ad79,
    secondary: 0xe7efbd,
    dark: 0x31443a,
    accent: 0xe6a3a8,
    highlight: 0xb9d99b,
  },
  duck: {
    primary: 0xe2b95f,
    secondary: 0xffedb1,
    dark: 0x59483f,
    accent: 0xdb8055,
    highlight: 0xfff1cf,
  },
  bear: {
    primary: 0x9b765e,
    secondary: 0xe9cfa9,
    dark: 0x493d3a,
    accent: 0xc98b80,
    highlight: 0xf0d9b7,
  },
  rabbit: {
    primary: 0xc0a5c8,
    secondary: 0xf5e5ed,
    dark: 0x51465b,
    accent: 0xe7a9bd,
    highlight: 0xeadcf0,
  },
  cat: {
    primary: 0xb88671,
    secondary: 0xf4d7bd,
    dark: 0x493f42,
    accent: 0xe3a5a9,
    highlight: 0xe8bca7,
  },
  axolotl: {
    primary: 0xd99aa8,
    secondary: 0xf5ced5,
    dark: 0x5c4755,
    accent: 0xb36c9c,
    highlight: 0xf0b8c7,
  },
  saylor: {
    primary: 0x283746,
    secondary: 0xd8a17a,
    dark: 0x666b70,
    accent: 0xf29a3f,
    highlight: 0xffdfaa,
  },
};

export const PREMIUM_SKIN_ANIMAL: Readonly<Record<PremiumSkinId, AnimalKind>> = {
  'sunrise-fox': 'fox',
  'amethyst-rabbit': 'rabbit',
  'aurora-axolotl': 'axolotl',
  'tide-cat': 'cat',
  'golden-duck': 'duck',
  'honey-bear': 'bear',
  'bluebell-penguin': 'penguin',
  'alpine-frog': 'frog',
};

/** Legacy palettes remain typed so old room/profile payloads can be decoded. */
const PREMIUM_PALETTES: Readonly<Record<PremiumSkinId, AnimalAppearancePalette>> = {
  'sunrise-fox': {
    primary: 0xe9865f,
    secondary: 0xffe9bd,
    dark: 0x573f48,
    accent: 0xf1a8a1,
    highlight: 0xffd56f,
  },
  'amethyst-rabbit': {
    primary: 0x9c83be,
    secondary: 0xeadff4,
    dark: 0x4d4266,
    accent: 0xd6a6dc,
    highlight: 0xc6b3ef,
  },
  'aurora-axolotl': {
    primary: 0x8ecbc4,
    secondary: 0xe5f0d6,
    dark: 0x455269,
    accent: 0xc58acb,
    highlight: 0xf2c4b7,
  },
  'tide-cat': {
    primary: 0x6d9da8,
    secondary: 0xdce9df,
    dark: 0x3d5260,
    accent: 0x87c3bf,
    highlight: 0xb8dce2,
  },
  'golden-duck': {
    primary: 0xe9be4f,
    secondary: 0xffedaa,
    dark: 0x674f37,
    accent: 0xe4804f,
    highlight: 0xffd86b,
  },
  'honey-bear': {
    primary: 0xb98854,
    secondary: 0xf0d4a3,
    dark: 0x513e32,
    accent: 0xdc9f55,
    highlight: 0xf4c969,
  },
  'bluebell-penguin': {
    primary: 0x647ea4,
    secondary: 0xe7e9f1,
    dark: 0x3f485d,
    accent: 0x8eadd1,
    highlight: 0xa9c8e5,
  },
  'alpine-frog': {
    primary: 0x6fa78b,
    secondary: 0xdcebc4,
    dark: 0x385247,
    accent: 0x8ebba3,
    highlight: 0xc5dbd0,
  },
};

function validAnimal(value: AnimalKind): AnimalKind {
  return ANIMAL_KINDS.includes(value) ? value : 'fox';
}

/** Invalid or cross-species premium combinations degrade to the base skin. */
export function resolveAnimalAppearance(
  requestedAnimal: AnimalKind,
  requestedSkin: SkinId = 'base',
): AnimalAppearanceProfile {
  const animal = validAnimal(requestedAnimal);
  const skin = requestedSkin !== 'base' && PREMIUM_SKIN_ANIMAL[requestedSkin] === animal
    ? requestedSkin
    : 'base';
  return {
    animal,
    skin,
    // Color charms were removed from the playable wardrobe. We still retain
    // and round-trip a valid legacy skin id during protocol-version overlap,
    // but every creature renders in its canonical species palette and never
    // receives the old crest/charm geometry.
    palette: BASE_ANIMAL_PALETTES[animal],
    premium: false,
  };
}

// Keep the legacy table referenced in production builds so protocol skew can
// be diagnosed without reintroducing those looks into the wardrobe.
void PREMIUM_PALETTES;
