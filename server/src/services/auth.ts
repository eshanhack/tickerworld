import {
  canonicalUsername,
  isActorId,
  isAnimalKind,
  isMarketSlug,
  isSkinId,
  normalizeUsername,
  type AccountProfile,
  type AnimalKind,
  type EntitlementSku,
  type MarketSlug,
  type SkinId,
} from '@tickerworld/shared';
import { createPublicKey, verify } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/types.js';
import { createId, randomToken, sha256 } from './crypto.js';
import {
  ConflictError,
  InputError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
} from './errors.js';

const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHALLENGE_LIFETIME_MS = 5 * 60_000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;

export interface SignatureVerificationRequest {
  walletAddress: string;
  message: string;
  signature: string;
}

export interface WalletSignatureVerifier {
  readonly available: boolean;
  verify(request: SignatureVerificationRequest): Promise<boolean>;
}

export class UnavailableWalletSignatureVerifier implements WalletSignatureVerifier {
  readonly available = false;
  async verify(): Promise<boolean> {
    return false;
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(value: string): Buffer | null {
  let numeric = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    numeric = numeric * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (numeric > 0n) {
    bytes.push(Number(numeric & 255n));
    numeric >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

/** Verifies Wallet Standard signMessage output locally; no RPC or secret is required. */
export class Ed25519WalletSignatureVerifier implements WalletSignatureVerifier {
  readonly available = true;

  async verify(request: SignatureVerificationRequest): Promise<boolean> {
    const publicKeyBytes = decodeBase58(request.walletAddress);
    const base58Signature = decodeBase58(request.signature);
    let signature = base58Signature;
    if (signature?.length !== 64) {
      try {
        signature = Buffer.from(request.signature, 'base64');
      } catch {
        return false;
      }
    }
    if (publicKeyBytes?.length !== 32 || !signature || signature.length !== 64) return false;
    try {
      const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
      const key = createPublicKey({
        key: Buffer.concat([spkiPrefix, publicKeyBytes]),
        format: 'der',
        type: 'spki',
      });
      return verify(null, Buffer.from(request.message, 'utf8'), key, signature);
    } catch {
      return false;
    }
  }
}

export interface AuthenticatedAccount {
  accountId: string;
  actorId: string;
  walletAddress: string;
  username: string | null;
  selectedAnimal: AnimalKind;
  selectedSkin: SkinId;
}

export class AuthService {
  constructor(
    private readonly db: Kysely<DatabaseSchema>,
    private readonly verifier: WalletSignatureVerifier,
  ) {}

  get ready(): boolean {
    return this.verifier.available;
  }

  async issueChallenge(
    walletAddress: string,
    actorId: string,
    actorAnimal: AnimalKind,
    ipHash: string,
    now = Date.now(),
  ): Promise<{
    id: string;
    message: string;
    expiresAt: number;
  }> {
    if (!WALLET_PATTERN.test(walletAddress)) {
      throw new InputError('invalid_wallet', 'A valid Solana wallet address is required');
    }
    if (!isActorId(actorId)) {
      throw new InputError('invalid_actor', 'A signed Tickerworld actor identity is required');
    }
    const [recentByIp, recentByWallet] = await Promise.all([
      this.db.selectFrom('auth_challenges')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('ip_hash', '=', ipHash)
        .where('created_at', '>', now - 60_000)
        .executeTakeFirst(),
      this.db.selectFrom('auth_challenges')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('wallet_address', '=', walletAddress)
        .where('created_at', '>', now - 60_000)
        .executeTakeFirst(),
    ]);
    if (Number(recentByIp?.count ?? 0) >= 5 || Number(recentByWallet?.count ?? 0) >= 5) {
      throw new RateLimitError('challenge_rate_limited', 'Try again in a minute', 60_000);
    }

    const challengeId = createId('challenge');
    const nonce = randomToken(24);
    const expiresAt = now + CHALLENGE_LIFETIME_MS;
    const message = [
      'tickerworld.io wants you to sign in with your Solana account:',
      walletAddress,
      '',
      'This request will not trigger a blockchain transaction or cost any fees.',
      `Challenge: ${challengeId}`,
      `Actor ID: ${actorId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(now).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join('\n');
    await this.db.insertInto('auth_challenges').values({
      id: challengeId,
      wallet_address: walletAddress,
      actor_id: actorId,
      actor_animal: actorAnimal,
      nonce_hash: sha256(nonce),
      message,
      ip_hash: ipHash,
      expires_at: expiresAt,
      consumed_at: null,
      created_at: now,
    }).execute();
    return { id: challengeId, message, expiresAt };
  }

  async verifyChallenge(input: {
    challengeId: string;
    walletAddress: string;
    actorId: string;
    signature: string;
  }, now = Date.now()): Promise<{ token: string; profile: AccountProfile }> {
    if (!this.verifier.available) {
      throw new ServiceUnavailableError(
        'wallet_verifier_unavailable',
        'Wallet authentication is not configured on this server',
      );
    }
    const challenge = await this.db.selectFrom('auth_challenges')
      .selectAll()
      .where('id', '=', input.challengeId)
      .executeTakeFirst();
    if (!challenge
      || challenge.wallet_address !== input.walletAddress
      || challenge.actor_id !== input.actorId
      || challenge.consumed_at !== null
      || challenge.expires_at <= now) {
      throw new UnauthorizedError('Challenge is invalid, expired, or already used');
    }
    if (!await this.verifier.verify({
      walletAddress: input.walletAddress,
      message: challenge.message,
      signature: input.signature,
    })) {
      throw new UnauthorizedError('Wallet signature is invalid');
    }

    const token = randomToken(32);
    const sessionId = createId('session');
    const account = await this.db.transaction().execute(async (transaction) => {
      const consumed = await transaction.updateTable('auth_challenges')
        .set({ consumed_at: now })
        .where('id', '=', challenge.id)
        .where('consumed_at', 'is', null)
        .executeTakeFirst();
      if (Number(consumed.numUpdatedRows) !== 1) {
        throw new ConflictError('challenge_consumed', 'Challenge was already used');
      }
      let row = await transaction.selectFrom('accounts')
        .selectAll()
        .where('wallet_address', '=', input.walletAddress)
        .executeTakeFirst();
      if (!row) {
        const actorOwner = await transaction.selectFrom('accounts')
          .select('wallet_address')
          .where('actor_id', '=', challenge.actor_id)
          .executeTakeFirst();
        if (actorOwner && actorOwner.wallet_address !== input.walletAddress) {
          throw new ConflictError('actor_already_linked', 'Actor identity is linked to another account');
        }
        row = {
          id: createId('account'),
          wallet_address: input.walletAddress,
          actor_id: challenge.actor_id,
          username: null,
          username_normalized: null,
          selected_animal: challenge.actor_animal,
          selected_skin: 'base',
          last_market: 'btc',
          created_at: now,
          updated_at: now,
        };
        await transaction.insertInto('accounts').values(row).execute();
      }
      await transaction.insertInto('auth_sessions').values({
        id: sessionId,
        account_id: row.id,
        token_hash: sha256(token),
        expires_at: now + SESSION_LIFETIME_MS,
        revoked_at: null,
        created_at: now,
      }).execute();
      return row;
    });
    return { token, profile: await this.profileForAccount(account.id) };
  }

  async authenticate(token: string | undefined, now = Date.now()): Promise<AuthenticatedAccount> {
    if (!token) throw new UnauthorizedError();
    const row = await this.db.selectFrom('auth_sessions')
      .innerJoin('accounts', 'accounts.id', 'auth_sessions.account_id')
      .select([
        'accounts.id as account_id',
        'accounts.actor_id',
        'accounts.wallet_address',
        'accounts.username',
        'accounts.selected_animal',
        'accounts.selected_skin',
        'auth_sessions.expires_at',
        'auth_sessions.revoked_at',
      ])
      .where('auth_sessions.token_hash', '=', sha256(token))
      .executeTakeFirst();
    if (!row || row.revoked_at !== null || row.expires_at <= now) throw new UnauthorizedError();
    return {
      accountId: row.account_id,
      actorId: row.actor_id,
      walletAddress: row.wallet_address,
      username: row.username,
      selectedAnimal: row.selected_animal as AnimalKind,
      selectedSkin: row.selected_skin as SkinId,
    };
  }

  async revoke(token: string | undefined, now = Date.now()): Promise<void> {
    if (!token) return;
    await this.db.updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('token_hash', '=', sha256(token))
      .where('revoked_at', 'is', null)
      .execute();
  }

  async profileForAccount(accountId: string): Promise<AccountProfile> {
    const account = await this.db.selectFrom('accounts')
      .selectAll()
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    const entitlements = await this.db.selectFrom('entitlements')
      .select('sku')
      .where('account_id', '=', accountId)
      .execute();
    const usernameCredit = account.username
      ? null
      : await this.db.selectFrom('username_credits')
        .select('id')
        .where('account_id', '=', accountId)
        .where('status', '=', 'available')
        .executeTakeFirst();
    return {
      id: account.id,
      actorId: account.actor_id,
      username: account.username,
      usernameCreditAvailable: Boolean(usernameCredit),
      selectedAnimal: account.selected_animal as AnimalKind,
      selectedSkin: account.selected_skin as SkinId,
      entitlements: entitlements.map((row) => row.sku as EntitlementSku),
      lastMarket: account.last_market as MarketSlug,
    };
  }

  async setLastMarket(accountId: string, market: MarketSlug, now = Date.now()): Promise<void> {
    await this.db.updateTable('accounts')
      .set({ last_market: market, updated_at: now })
      .where('id', '=', accountId)
      .execute();
  }

  async claimUsername(
    accountId: string,
    requested: string,
    isReserved: (canonical: string) => boolean,
    now = Date.now(),
  ): Promise<AccountProfile> {
    const username = normalizeUsername(requested);
    const canonical = canonicalUsername(requested);
    if (!username || !canonical || isReserved(canonical)) {
      throw new InputError('invalid_username', 'Use 3–16 letters, numbers, or underscores');
    }
    await this.db.transaction().execute(async (transaction) => {
      const account = await transaction.selectFrom('accounts')
        .select(['username', 'username_normalized'])
        .where('id', '=', accountId)
        .executeTakeFirstOrThrow();
      if (account.username_normalized) {
        if (account.username_normalized === canonical) return;
        throw new ConflictError('username_immutable', 'Claimed usernames cannot be changed');
      }
      await transaction.deleteFrom('username_reservations')
        .where('expires_at', '<=', now)
        .execute();
      const reservation = await transaction.selectFrom('username_reservations')
        .select(['account_id', 'expires_at'])
        .where('username_normalized', '=', canonical)
        .executeTakeFirst();
      if (reservation && reservation.account_id !== accountId && reservation.expires_at > now) {
        throw new ConflictError('username_reserved', 'That username is reserved by an active purchase');
      }
      const owner = await transaction.selectFrom('accounts')
        .select('id')
        .where('username_normalized', '=', canonical)
        .executeTakeFirst();
      if (owner && owner.id !== accountId) {
        throw new ConflictError('username_taken', 'That username is already claimed');
      }
      const credit = await transaction.selectFrom('username_credits')
        .select('id')
        .where('account_id', '=', accountId)
        .where('status', '=', 'available')
        .orderBy('created_at', 'asc')
        .executeTakeFirst();
      if (!credit) {
        // Compatibility for entitlements granted before username credits existed.
        const entitlement = await transaction.selectFrom('entitlements')
          .select('id')
          .where('account_id', '=', accountId)
          .where('sku', '=', 'username-claim')
          .executeTakeFirst();
        if (!entitlement) throw new UnauthorizedError('Username credit is required');
      }
      const updated = await transaction.updateTable('accounts')
        .set({ username, username_normalized: canonical, updated_at: now })
        .where('id', '=', accountId)
        .where('username_normalized', 'is', null)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new ConflictError('username_immutable', 'Claimed usernames cannot be changed');
      }
      if (credit) {
        await transaction.updateTable('username_credits')
          .set({
            status: 'consumed',
            consumed_username_normalized: canonical,
            consumed_at: now,
          })
          .where('id', '=', credit.id)
          .where('status', '=', 'available')
          .execute();
      }
    });
    return this.profileForAccount(accountId);
  }

  async updateProfile(accountId: string, input: {
    animal?: unknown;
    skin?: unknown;
    lastMarket?: unknown;
  }, now = Date.now()): Promise<AccountProfile> {
    const updates: { selected_animal?: string; selected_skin?: string; last_market?: string; updated_at: number } = {
      updated_at: now,
    };
    if (input.animal !== undefined) {
      if (!isAnimalKind(input.animal)) throw new InputError('invalid_animal', 'Unknown animal');
      updates.selected_animal = input.animal;
    }
    if (input.lastMarket !== undefined) {
      if (!isMarketSlug(input.lastMarket)) throw new InputError('invalid_market', 'Unknown market');
      updates.last_market = input.lastMarket;
    }
    if (input.skin !== undefined) {
      if (!isSkinId(input.skin)) throw new InputError('invalid_skin', 'Unknown skin');
      if (input.skin !== 'base') {
        const owned = await this.db.selectFrom('entitlements')
          .select('id')
          .where('account_id', '=', accountId)
          .where('sku', '=', input.skin)
          .executeTakeFirst();
        if (!owned) throw new UnauthorizedError('Skin entitlement is required');
      }
      updates.selected_skin = input.skin;
    }
    await this.db.updateTable('accounts').set(updates).where('id', '=', accountId).execute();
    return this.profileForAccount(accountId);
  }

  async listBlocks(accountId: string): Promise<readonly string[]> {
    const rows = await this.db.selectFrom('account_blocks')
      .select('blocked_actor_id')
      .where('account_id', '=', accountId)
      .execute();
    return rows.map((row) => row.blocked_actor_id);
  }

  async addBlock(accountId: string, actorId: string, now = Date.now()): Promise<void> {
    if (!isActorId(actorId)) {
      throw new InputError('invalid_actor', 'Invalid player identifier');
    }
    await this.db.insertInto('account_blocks').values({
      account_id: accountId,
      blocked_actor_id: actorId,
      created_at: now,
    }).onConflict((conflict) => conflict.columns(['account_id', 'blocked_actor_id']).doNothing()).execute();
  }

  async removeBlock(accountId: string, actorId: string): Promise<void> {
    await this.db.deleteFrom('account_blocks')
      .where('account_id', '=', accountId)
      .where('blocked_actor_id', '=', actorId)
      .execute();
  }
}
