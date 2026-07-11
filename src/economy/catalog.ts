import type { AnimalKind, PremiumSkinId } from '../../shared/src/index.js';

export interface PremiumSkinDefinition {
  readonly id: PremiumSkinId;
  readonly name: string;
  readonly animal: AnimalKind;
  readonly usdCents: 600;
  readonly colors: readonly [number, number, number];
}

export const PREMIUM_SKIN_CATALOG: readonly PremiumSkinDefinition[] = [
  { id: 'sunrise-fox', name: 'Sunrise Fox', animal: 'fox', usdCents: 600, colors: [0xdc8065, 0xffd99f, 0xf5b971] },
  { id: 'amethyst-rabbit', name: 'Amethyst Rabbit', animal: 'rabbit', usdCents: 600, colors: [0x9f82b8, 0xe0c7ea, 0xf4dcf0] },
  { id: 'aurora-axolotl', name: 'Aurora Axolotl', animal: 'axolotl', usdCents: 600, colors: [0x75b9b1, 0xe1a5c5, 0xb4d7d0] },
  { id: 'tide-cat', name: 'Tide Cat', animal: 'cat', usdCents: 600, colors: [0x548a9d, 0xc4dfe0, 0x82b5bd] },
  { id: 'golden-duck', name: 'Golden Duck', animal: 'duck', usdCents: 600, colors: [0xd7a83e, 0xffe9a8, 0xeecb62] },
  { id: 'honey-bear', name: 'Honey Bear', animal: 'bear', usdCents: 600, colors: [0xb17a45, 0xefd08e, 0xce9c5f] },
  { id: 'bluebell-penguin', name: 'Bluebell Penguin', animal: 'penguin', usdCents: 600, colors: [0x647caa, 0xd6dff0, 0x93a9cc] },
  { id: 'alpine-frog', name: 'Alpine Frog', animal: 'frog', usdCents: 600, colors: [0x668f72, 0xdbe3b4, 0x93b58b] },
] as const;

export const USERNAME_CLAIM_USD_CENTS = 300;
