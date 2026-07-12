import { ANIMAL_KINDS, type AnimalKind } from '../../shared/src/index.js';

const ACTOR_KEY = 'tickerworld:v2:actor';
const ANIMAL_KEY = 'tickerworld:v2:animal';
const SIGNED_IDENTITY_KEY = 'tickerworld:v2:signed-anonymous';

export interface GuestIdentity {
  readonly actorId: string;
  readonly animal: AnimalKind;
}

export interface SignedGuestIdentity extends GuestIdentity {
  readonly token: string;
  readonly expiresAt: number;
}

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `guest-${Date.now().toString(36)}-${random}`;
}

function randomAnimal(): AnimalKind {
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(values);
  else values[0] = Math.floor(Math.random() * 0xffff_ffff);
  return ANIMAL_KINDS[values[0]! % ANIMAL_KINDS.length]!;
}

export function readGuestIdentity(storage: Storage | null = safeSessionStorage()): GuestIdentity {
  let actorId = '';
  let animal: AnimalKind | undefined;
  try {
    actorId = storage?.getItem(ACTOR_KEY) ?? '';
    const savedAnimal = storage?.getItem(ANIMAL_KEY);
    animal = ANIMAL_KINDS.find((candidate) => candidate === savedAnimal);
  } catch {
    // Private browsing may deny storage; the in-memory identity still works.
  }
  if (!actorId) actorId = randomId();
  animal ??= randomAnimal();
  try {
    storage?.setItem(ACTOR_KEY, actorId);
    storage?.setItem(ANIMAL_KEY, animal);
  } catch {
    // Persistence is optional.
  }
  return { actorId, animal };
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
    storage?.setItem(ANIMAL_KEY, identity.animal);
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

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
