import {
  ANIMAL_KINDS,
  isSkinId,
  normalizeUsername,
  type AnimalKind,
  type SkinId,
} from '../../shared/src/index.js';

const ACTOR_KEY = 'tickerworld:v2:actor';
const APPEARANCE_KEY = 'tickerworld:v2:guest-appearance';
const LEGACY_WARDROBE_ANIMAL_KEY = 'tickerworld:v2:wardrobe-animal';
const SIGNED_IDENTITY_KEY = 'tickerworld:v2:signed-anonymous';
export const DEFAULT_ANONYMOUS_ANIMAL: AnimalKind = 'fox';

const SKIN_ANIMAL: Readonly<Record<Exclude<SkinId, 'base'>, AnimalKind>> = {
  'sunrise-fox': 'fox',
  'amethyst-rabbit': 'rabbit',
  'aurora-axolotl': 'axolotl',
  'tide-cat': 'cat',
  'golden-duck': 'duck',
  'honey-bear': 'bear',
  'bluebell-penguin': 'penguin',
  'alpine-frog': 'frog',
};

export interface GuestIdentity {
  readonly actorId: string;
  readonly animal: AnimalKind;
  /** Present for authoritative account/room presentation updates. */
  readonly skin?: SkinId;
  /** Present for authoritative account/room presentation updates. */
  readonly username?: string | null;
}

export interface SignedGuestIdentity extends GuestIdentity {
  readonly token: string;
  readonly expiresAt: number;
}

export interface GuestAppearance {
  readonly animal: AnimalKind;
  readonly skin: SkinId;
  readonly username: string | null;
}

export const DEFAULT_GUEST_APPEARANCE: GuestAppearance = {
  animal: DEFAULT_ANONYMOUS_ANIMAL,
  skin: 'base',
  username: null,
};

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `guest-${Date.now().toString(36)}-${random}`;
}

export function readGuestIdentity(
  storage: Storage | null = safeSessionStorage(),
  appearanceStorage: Storage | null = safeLocalStorage(),
): GuestIdentity {
  let actorId = '';
  try {
    actorId = storage?.getItem(ACTOR_KEY) ?? '';
  } catch {
    // Private browsing may deny storage; the in-memory identity still works.
  }
  if (!actorId) actorId = randomId();
  try {
    storage?.setItem(ACTOR_KEY, actorId);
  } catch {
    // Persistence is optional.
  }
  return { actorId, animal: readGuestAppearance(appearanceStorage).animal };
}

export function readGuestAppearance(storage: Storage | null = safeLocalStorage()): GuestAppearance {
  try {
    const raw = storage?.getItem(APPEARANCE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<GuestAppearance> : null;
    const legacyAnimal = storage?.getItem(LEGACY_WARDROBE_ANIMAL_KEY);
    const animal = ANIMAL_KINDS.find((candidate) => candidate === parsed?.animal)
      ?? ANIMAL_KINDS.find((candidate) => candidate === legacyAnimal)
      ?? DEFAULT_ANONYMOUS_ANIMAL;
    const requestedSkin = isSkinId(parsed?.skin) ? parsed.skin : 'base';
    const skin = requestedSkin === 'base' || SKIN_ANIMAL[requestedSkin] === animal
      ? requestedSkin
      : 'base';
    const username = typeof parsed?.username === 'string'
      ? normalizeUsername(parsed.username)
      : null;
    return { animal, skin, username };
  } catch {
    return DEFAULT_GUEST_APPEARANCE;
  }
}

export function writeGuestAppearance(
  appearance: GuestAppearance,
  storage: Storage | null = safeLocalStorage(),
): GuestAppearance {
  const animal = ANIMAL_KINDS.includes(appearance.animal)
    ? appearance.animal
    : DEFAULT_ANONYMOUS_ANIMAL;
  const requestedSkin = isSkinId(appearance.skin) ? appearance.skin : 'base';
  const skin = requestedSkin === 'base' || SKIN_ANIMAL[requestedSkin] === animal
    ? requestedSkin
    : 'base';
  const username = appearance.username === null ? null : normalizeUsername(appearance.username);
  const safeAppearance = { animal, skin, username } satisfies GuestAppearance;
  try {
    storage?.setItem(APPEARANCE_KEY, JSON.stringify(safeAppearance));
    storage?.removeItem(LEGACY_WARDROBE_ANIMAL_KEY);
  } catch {
    // Persistence is optional; the live player still keeps the choice.
  }
  return safeAppearance;
}

export function readSignedGuestIdentity(
  storage: Storage | null = safeSessionStorage(),
  now = Date.now(),
): SignedGuestIdentity | null {
  try {
    const parsed = JSON.parse(storage?.getItem(SIGNED_IDENTITY_KEY) ?? 'null') as Partial<SignedGuestIdentity> | null;
    if (!parsed
      || typeof parsed.actorId !== 'string'
      || typeof parsed.animal !== 'string'
      || !ANIMAL_KINDS.includes(parsed.animal as AnimalKind)
      || typeof parsed.token !== 'string'
      || parsed.token.length < 24
      || typeof parsed.expiresAt !== 'number'
      || parsed.expiresAt <= now + 5_000) {
      return null;
    }
    return {
      actorId: parsed.actorId,
      animal: parsed.animal as AnimalKind,
      token: parsed.token,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function writeSignedGuestIdentity(
  identity: SignedGuestIdentity,
  storage: Storage | null = safeSessionStorage(),
): void {
  try {
    storage?.setItem(SIGNED_IDENTITY_KEY, JSON.stringify(identity));
    storage?.setItem(ACTOR_KEY, identity.actorId);
  } catch {
    // The room can still use the identity for this page without persistence.
  }
}

export function clearSignedGuestIdentity(storage: Storage | null = safeSessionStorage()): void {
  try {
    storage?.removeItem(SIGNED_IDENTITY_KEY);
  } catch {
    // A failed cleanup still allows the in-memory refresh to proceed.
  }
}

/**
 * Anonymous room credentials belong to one browser tab. Appearance and
 * settings remain browser-wide in localStorage, but sharing an actor token
 * across tabs makes the room's one-seat safety rule lock out the newer tab.
 * sessionStorage survives reloads and portal travel without creating that
 * cross-tab collision.
 */
function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
