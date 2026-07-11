import {
  ENTITLEMENT_SKUS,
  canonicalUsername,
  normalizeUsername,
  type EntitlementSku,
  type PurchaseQuote,
} from '@tickerworld/shared';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/types.js';
import type { ServerConfig } from '../config.js';
import { createId, randomSolanaReference } from './crypto.js';
import {
  ConflictError,
  InputError,
  ServiceUnavailableError,
} from './errors.js';

const SKU_USD_CENTS: Readonly<Record<EntitlementSku, number>> = {
  'username-claim': 300,
  'sunrise-fox': 600,
  'amethyst-rabbit': 600,
  'aurora-axolotl': 600,
  'tide-cat': 600,
  'golden-duck': 600,
  'honey-bear': 600,
  'bluebell-penguin': 600,
  'alpine-frog': 600,
};

const PAYMENT_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === '23505'
    || candidate?.code?.startsWith('SQLITE_CONSTRAINT') === true
    || /unique constraint/i.test(candidate?.message ?? '');
}

export interface QuoteAuthority {
  readonly available: boolean;
  initialize?(): Promise<boolean>;
  lamportsForUsdCents(usdCents: number): Promise<bigint>;
}

export class HttpSolUsdQuoteAuthority implements QuoteAuthority {
  private lastCheckedAt = 0;
  private lastSuccessAt = 0;

  constructor(
    private readonly priceUrl: string | null,
    private readonly requestFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get available(): boolean {
    return Boolean(this.priceUrl)
      && this.lastSuccessAt > 0
      && this.now() - this.lastSuccessAt <= 120_000;
  }

  async initialize(): Promise<boolean> {
    if (this.lastCheckedAt > 0 && this.now() - this.lastCheckedAt < 30_000) return this.available;
    this.lastCheckedAt = this.now();
    try {
      await this.fetchPrice();
      this.lastSuccessAt = this.now();
    } catch {
      this.lastSuccessAt = 0;
    }
    return this.available;
  }

  async lamportsForUsdCents(usdCents: number): Promise<bigint> {
    this.lastCheckedAt = this.now();
    try {
      const price = await this.fetchPrice();
      this.lastSuccessAt = this.now();
      return BigInt(Math.ceil(usdCents / 100 / price * 1_000_000_000));
    } catch (error) {
      this.lastSuccessAt = 0;
      throw error;
    }
  }

  private async fetchPrice(): Promise<number> {
    if (!this.priceUrl) {
      throw new ServiceUnavailableError('quote_authority_unavailable', 'SOL/USD authority is not configured');
    }
    let response: Response;
    try {
      response = await this.requestFetch(this.priceUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ServiceUnavailableError('quote_authority_unavailable', 'SOL/USD authority did not respond');
    }
    if (!response.ok) {
      throw new ServiceUnavailableError('quote_authority_unavailable', 'SOL/USD authority rejected the request');
    }
    const payload = await response.json().catch(() => null) as any;
    const price = Number(payload?.solana?.usd ?? payload?.usd ?? payload?.price ?? payload?.data?.solana?.usd);
    if (!Number.isFinite(price) || price <= 0) {
      throw new ServiceUnavailableError('quote_authority_invalid', 'SOL/USD authority returned an invalid price');
    }
    return price;
  }
}

export class UnavailableQuoteAuthority implements QuoteAuthority {
  readonly available = false;
  async lamportsForUsdCents(): Promise<bigint> {
    throw new ServiceUnavailableError('quote_authority_unavailable', 'Purchase quotes are unavailable');
  }
}

export class DevelopmentQuoteAuthority implements QuoteAuthority {
  readonly available = true;
  constructor(private readonly solUsdPrice: number) {}
  async lamportsForUsdCents(usdCents: number): Promise<bigint> {
    return BigInt(Math.ceil(usdCents / 100 / this.solUsdPrice * 1_000_000_000));
  }
}

export interface VerifiedPayment {
  signature: string;
  payer: string;
  recipient: string;
  reference: string;
  lamports: bigint;
  cluster: 'devnet' | 'mainnet-beta';
  confirmationStatus: 'confirmed' | 'finalized';
  /** Authoritative chain block time, converted to milliseconds. */
  blockTimeMs: number;
}

export type PaymentVerificationResult =
  | { readonly state: 'pending' }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'confirmed'; readonly payment: VerifiedPayment };

export interface ChainPaymentVerifier {
  readonly available: boolean;
  initialize?(): Promise<boolean>;
  verify(
    signature: string,
    expected?: PaymentExpectation,
  ): Promise<PaymentVerificationResult>;
}

export interface PaymentExpectation {
  payer: string;
  recipient: string;
  reference: string;
  lamports: bigint;
  cluster: 'devnet' | 'mainnet-beta';
}

export class UnavailableChainPaymentVerifier implements ChainPaymentVerifier {
  readonly available = false;
  async verify(): Promise<PaymentVerificationResult> {
    return { state: 'pending' };
  }
}

export class SolanaRpcPaymentVerifier implements ChainPaymentVerifier {
  private requestId = 0;
  private genesisVerified = false;
  private lastGenesisCheckAt = 0;

  constructor(
    private readonly rpcUrl: string | null,
    private readonly cluster: 'devnet' | 'mainnet-beta',
    private readonly requestFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
  }

  get available(): boolean {
    return Boolean(this.rpcUrl)
      && this.genesisVerified
      && this.lastGenesisCheckAt > 0
      && this.now() - this.lastGenesisCheckAt <= 120_000;
  }

  async initialize(): Promise<boolean> {
    if (!this.rpcUrl) return false;
    if (this.lastGenesisCheckAt > 0 && this.now() - this.lastGenesisCheckAt < 30_000) return this.available;
    this.lastGenesisCheckAt = this.now();
    const expectedGenesis = this.cluster === 'mainnet-beta'
      ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    const actualGenesis = await this.rpc('getGenesisHash', []);
    this.genesisVerified = actualGenesis === expectedGenesis;
    return this.genesisVerified;
  }

  async verify(signature: string, expected?: PaymentExpectation): Promise<PaymentVerificationResult> {
    if ((!this.available && !await this.initialize())
      || !this.rpcUrl || !expected || expected.cluster !== this.cluster) {
      return { state: 'invalid', reason: 'verifier_unavailable' };
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature)) {
      return { state: 'invalid', reason: 'invalid_signature' };
    }
    const [statusResponse, transactionResponse] = await Promise.all([
      this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]),
      this.rpc('getTransaction', [signature, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }]),
    ]);
    const status = (statusResponse as any)?.value?.[0];
    const transaction = transactionResponse as any;
    const confirmationStatus = status?.confirmationStatus;
    if (!status) return { state: 'pending' };
    if (status.err !== null) return { state: 'invalid', reason: 'transaction_failed' };
    if (confirmationStatus !== 'confirmed' && confirmationStatus !== 'finalized') {
      return { state: 'pending' };
    }
    if (!transaction) return { state: 'pending' };
    if (transaction.meta?.err !== null
      || !transaction.transaction?.signatures?.includes(signature)) {
      return { state: 'invalid', reason: 'invalid_transaction' };
    }
    if (!Number.isFinite(transaction.blockTime)) return { state: 'pending' };

    const message = transaction.transaction?.message;
    const accountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
    const key = (entry: any): string | null => typeof entry === 'string'
      ? entry
      : typeof entry?.pubkey === 'string'
        ? entry.pubkey
        : null;
    const payerKey = accountKeys.find((entry: any) => key(entry) === expected.payer);
    const referenceKey = accountKeys.find((entry: any) => key(entry) === expected.reference);
    if (!payerKey || typeof payerKey !== 'object' || payerKey.signer !== true
      || !referenceKey || typeof referenceKey !== 'object'
      || referenceKey.signer === true || referenceKey.writable === true) {
      return { state: 'invalid', reason: 'payer_or_reference_mismatch' };
    }

    const lamportsMatch = (value: unknown): boolean => {
      try {
        return BigInt(String(value)) === expected.lamports;
      } catch {
        return false;
      }
    };
    const transfers = (Array.isArray(message?.instructions) ? message.instructions : [])
      .filter((instruction: any) => instruction?.program === 'system'
        && instruction?.parsed?.type === 'transfer')
      .map((instruction: any) => instruction.parsed?.info)
      .filter((info: any) => info
        && info.source === expected.payer
        && info.destination === expected.recipient
        && lamportsMatch(info.lamports));
    if (transfers.length !== 1) return { state: 'invalid', reason: 'transfer_mismatch' };
    return {
      state: 'confirmed',
      payment: {
        signature,
        payer: expected.payer,
        recipient: expected.recipient,
        reference: expected.reference,
        lamports: expected.lamports,
        cluster: this.cluster,
        confirmationStatus,
        blockTimeMs: Math.floor(transaction.blockTime * 1_000),
      },
    };
  }

  private async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    if (!this.rpcUrl) return null;
    let response: Response;
    try {
      response = await this.requestFetch(this.rpcUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as any;
    return body?.error ? null : body?.result ?? null;
  }
}

export type PaymentConfirmationState = 'pending' | 'confirmed' | 'credited';

export interface PaymentConfirmationResult {
  state: PaymentConfirmationState;
  entitlement: EntitlementSku;
  idempotent: boolean;
}

export class EconomyService {
  /**
   * Prevents duplicate verifier work inside this process while allowing a
   * persisted processing claim to resume after a crash or a pending chain
   * response. The database claim remains the cross-process authority.
   */
  private readonly activePaymentVerifications = new Set<string>();

  constructor(
    private readonly db: Kysely<DatabaseSchema>,
    private readonly config: ServerConfig,
    private readonly quoteAuthority: QuoteAuthority,
    private readonly paymentVerifier: ChainPaymentVerifier,
    private readonly isReservedUsername: (canonical: string) => boolean = () => false,
  ) {}

  get ready(): boolean {
    return this.quoteAuthority.available
      && this.paymentVerifier.available
      && this.config.treasuryAddress !== null;
  }

  async refreshReadiness(): Promise<boolean> {
    if (this.quoteAuthority.initialize) await this.quoteAuthority.initialize().catch(() => false);
    if (this.paymentVerifier.initialize) await this.paymentVerifier.initialize().catch(() => false);
    return this.ready;
  }

  async createQuote(
    accountId: string,
    sku: string,
    options: { username?: string } = {},
    now = Date.now(),
  ): Promise<PurchaseQuote> {
    if (!(ENTITLEMENT_SKUS as readonly string[]).includes(sku)) {
      throw new InputError('invalid_sku', 'Unknown entitlement');
    }
    if (!this.quoteAuthority.available && this.quoteAuthority.initialize) {
      await this.quoteAuthority.initialize().catch(() => false);
    }
    if (!this.quoteAuthority.available || !this.config.treasuryAddress) {
      throw new ServiceUnavailableError('quote_authority_unavailable', 'Purchases are not configured');
    }
    const entitlementSku = sku as EntitlementSku;
    let requestedUsername: string | null = null;
    let requestedUsernameNormalized: string | null = null;
    if (entitlementSku === 'username-claim') {
      requestedUsername = options.username ? normalizeUsername(options.username) : null;
      requestedUsernameNormalized = options.username ? canonicalUsername(options.username) : null;
      if (!requestedUsername
        || !requestedUsernameNormalized
        || this.isReservedUsername(requestedUsernameNormalized)) {
        throw new InputError('invalid_username', 'Use an available 3–16 character username');
      }
      const account = await this.db.selectFrom('accounts')
        .select('username_normalized')
        .where('id', '=', accountId)
        .executeTakeFirst();
      if (!account) throw new InputError('account_not_found', 'Account was not found');
      if (account.username_normalized) {
        throw new ConflictError('username_immutable', 'Claimed usernames cannot be changed');
      }
      const usernameOwner = await this.db.selectFrom('accounts')
        .select('id')
        .where('username_normalized', '=', requestedUsernameNormalized)
        .executeTakeFirst();
      if (usernameOwner && usernameOwner.id !== accountId) {
        throw new ConflictError('username_taken', 'That username is already claimed');
      }
    }
    const existing = await this.db.selectFrom('entitlements')
      .select('id')
      .where('account_id', '=', accountId)
      .where('sku', '=', entitlementSku)
      .executeTakeFirst();
    if (existing) throw new ConflictError('already_owned', 'Entitlement is already owned');

    const usdCents = SKU_USD_CENTS[entitlementSku];
    const lamports = await this.quoteAuthority.lamportsForUsdCents(usdCents);
    const quote: PurchaseQuote = {
      id: createId('quote'),
      accountId,
      sku: entitlementSku,
      usdCents,
      lamports: lamports.toString(),
      reference: randomSolanaReference(),
      recipient: this.config.treasuryAddress,
      cluster: this.config.solanaCluster,
      expiresAt: now + 2 * 60_000,
    };
    try {
      await this.db.transaction().execute(async (transaction) => {
        if (requestedUsernameNormalized) {
          await transaction.deleteFrom('username_reservations')
            .where('expires_at', '<=', now)
            .execute();
          const reservation = await transaction.selectFrom('username_reservations')
            .select(['account_id', 'expires_at'])
            .where('username_normalized', '=', requestedUsernameNormalized)
            .executeTakeFirst();
          if (reservation && reservation.expires_at > now) {
            throw new ConflictError('username_reserved', 'That username is reserved by an active quote');
          }
        }
        await transaction.insertInto('purchase_quotes').values({
          id: quote.id,
          account_id: accountId,
          sku: quote.sku,
          usd_cents: quote.usdCents,
          lamports: quote.lamports,
          reference: quote.reference,
          recipient: quote.recipient,
          cluster: quote.cluster,
          status: 'open',
          claim_signature: null,
          claimed_at: null,
          requested_username: requestedUsername,
          requested_username_normalized: requestedUsernameNormalized,
          expires_at: quote.expiresAt,
          created_at: now,
        }).execute();
        if (requestedUsername && requestedUsernameNormalized) {
          await transaction.insertInto('username_reservations').values({
            username: requestedUsername,
            username_normalized: requestedUsernameNormalized,
            account_id: accountId,
            quote_id: quote.id,
            expires_at: quote.expiresAt,
            created_at: now,
          }).execute();
        }
      });
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      if (requestedUsernameNormalized && isUniqueConstraintError(error)) {
        throw new ConflictError('username_reserved', 'That username is reserved by an active quote');
      }
      throw error;
    }
    return quote;
  }

  async confirmPayment(
    accountId: string,
    quoteId: string,
    signature: string,
    now = Date.now(),
  ): Promise<PaymentConfirmationResult> {
    let quote = await this.db.selectFrom('purchase_quotes')
      .selectAll()
      .where('id', '=', quoteId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (!quote) throw new InputError('quote_not_found', 'Purchase quote was not found');
    const prior = await this.db.selectFrom('payments')
      .selectAll()
      .where('quote_id', '=', quoteId)
      .executeTakeFirst();
    if (prior) {
      if (prior.signature !== signature) throw new ConflictError('quote_consumed', 'Quote is already used');
      const availableCredit = quote.sku === 'username-claim'
        ? await this.db.selectFrom('username_credits')
          .select('id')
          .where('source_payment_id', '=', prior.id)
          .where('status', '=', 'available')
          .executeTakeFirst()
        : null;
      return {
        state: availableCredit ? 'credited' : 'confirmed',
        entitlement: quote.sku as EntitlementSku,
        idempotent: true,
      };
    }
    if (quote.status === 'open' && quote.expires_at + PAYMENT_RECOVERY_WINDOW_MS <= now) {
      await this.db.updateTable('purchase_quotes')
        .set({ status: 'expired', claim_signature: null, claimed_at: null })
        .where('id', '=', quote.id)
        .where('status', '=', 'open')
        .execute();
      throw new ConflictError('quote_expired', 'Purchase quote expired');
    }
    if (quote.status === 'processing') {
      if (quote.claim_signature !== signature) {
        throw new ConflictError('quote_processing', 'Payment confirmation is already in progress');
      }
      if (this.activePaymentVerifications.has(quote.id)) {
        throw new ConflictError('quote_processing', 'Payment confirmation is already in progress');
      }
    }
    if (quote.status !== 'open' && quote.status !== 'processing') {
      throw new ConflictError('quote_consumed', 'Quote is already used');
    }
    if (!this.paymentVerifier.available && this.paymentVerifier.initialize) {
      await this.paymentVerifier.initialize().catch(() => false);
    }
    if (!this.paymentVerifier.available) {
      throw new ServiceUnavailableError('payment_verifier_unavailable', 'Payment confirmation is unavailable');
    }
    if (quote.status === 'open') {
      const claimed = await this.db.updateTable('purchase_quotes')
        .set({ status: 'processing', claim_signature: signature, claimed_at: now })
        .where('id', '=', quote.id)
        .where('account_id', '=', accountId)
        .where('status', '=', 'open')
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) !== 1) {
        throw new ConflictError('quote_processing', 'Payment confirmation is already in progress');
      }
    }

    this.activePaymentVerifications.add(quote.id);
    try {
      const account = await this.db.selectFrom('accounts')
        .select('wallet_address')
        .where('id', '=', accountId)
        .executeTakeFirst();
      if (!account) throw new InputError('account_not_found', 'Account was not found');
      const verification = await this.paymentVerifier.verify(signature, {
        payer: account.wallet_address,
        recipient: quote.recipient,
        reference: quote.reference,
        lamports: BigInt(quote.lamports),
        cluster: quote.cluster as 'devnet' | 'mainnet-beta',
      });
      if (verification.state === 'pending') {
        return {
          state: 'pending',
          entitlement: quote.sku as EntitlementSku,
          idempotent: false,
        };
      }
      if (verification.state === 'invalid') {
        await this.rejectPaymentClaim(quote.id, signature);
        throw new InputError('payment_invalid', 'Payment was rejected by the chain verifier');
      }
      const payment = verification.payment;
      if (payment.signature !== signature
        || payment.payer !== account.wallet_address
        || payment.recipient !== quote.recipient
        || payment.reference !== quote.reference
        || payment.lamports.toString() !== quote.lamports
        || payment.cluster !== quote.cluster
        || (payment.confirmationStatus !== 'confirmed' && payment.confirmationStatus !== 'finalized')
        || !Number.isFinite(payment.blockTimeMs)
        || payment.blockTimeMs > quote.expires_at) {
        await this.rejectPaymentClaim(quote.id, signature);
        throw new InputError('payment_invalid', 'Payment does not match the quote or is not confirmed');
      }

      return await this.db.transaction().execute(async (transaction) => {
      const claimedQuote = await transaction.selectFrom('purchase_quotes')
        .select(['status', 'claim_signature'])
        .where('id', '=', quote.id)
        .executeTakeFirstOrThrow();
      if (claimedQuote.status !== 'processing' || claimedQuote.claim_signature !== signature) {
        throw new ConflictError('quote_consumed', 'Quote claim is no longer active');
      }
      const existingSignature = await transaction.selectFrom('payments')
        .selectAll()
        .where('signature', '=', payment.signature)
        .executeTakeFirst();
      if (existingSignature) {
        if (existingSignature.quote_id !== quote.id) {
          throw new ConflictError('signature_reused', 'Payment signature was already used');
        }
        return {
          state: 'confirmed' as const,
          entitlement: quote.sku as EntitlementSku,
          idempotent: true,
        };
      }
      const paymentId = createId('payment');
      await transaction.insertInto('payments').values({
        id: paymentId,
        quote_id: quote.id,
        account_id: accountId,
        signature: payment.signature,
        payer: payment.payer,
        recipient: payment.recipient,
        reference: payment.reference,
        lamports: payment.lamports.toString(),
        cluster: payment.cluster,
        confirmed_at: now,
      }).execute();
      await transaction.insertInto('entitlements').values({
        id: createId('entitlement'),
        account_id: accountId,
        sku: quote.sku,
        source_payment_id: paymentId,
        granted_at: now,
      }).onConflict((conflict) => conflict.columns(['account_id', 'sku']).doNothing()).execute();
      let grantState: PaymentConfirmationState = 'confirmed';
      if (quote.sku === 'username-claim') {
        if (!quote.requested_username || !quote.requested_username_normalized) {
          throw new ConflictError('username_missing', 'Quote does not contain a username claim');
        }
        const creditId = createId('username_credit');
        await transaction.insertInto('username_credits').values({
          id: creditId,
          account_id: accountId,
          source_payment_id: paymentId,
          status: 'available',
          consumed_username_normalized: null,
          consumed_at: null,
          created_at: now,
        }).execute();
        grantState = 'credited';
        const reservation = await transaction.selectFrom('username_reservations')
          .select(['quote_id', 'expires_at'])
          .where('username_normalized', '=', quote.requested_username_normalized)
          .executeTakeFirst();
        const usernameOwner = await transaction.selectFrom('accounts')
          .select(['id', 'username_normalized'])
          .where('username_normalized', '=', quote.requested_username_normalized)
          .executeTakeFirst();
        if (reservation?.quote_id === quote.id
          && reservation.expires_at > now
          && (!usernameOwner || usernameOwner.id === accountId)) {
          const assigned = await transaction.updateTable('accounts').set({
            username: quote.requested_username,
            username_normalized: quote.requested_username_normalized,
            updated_at: now,
          })
            .where('id', '=', accountId)
            .where('username_normalized', 'is', null)
            .executeTakeFirst();
          if (Number(assigned.numUpdatedRows) === 1) {
            await transaction.updateTable('username_credits').set({
              status: 'consumed',
              consumed_username_normalized: quote.requested_username_normalized,
              consumed_at: now,
            }).where('id', '=', creditId).execute();
            grantState = 'confirmed';
          }
        }
        await transaction.deleteFrom('username_reservations')
          .where('quote_id', '=', quote.id)
          .execute();
      }
      const confirmed = await transaction.updateTable('purchase_quotes')
        .set({ status: 'confirmed' })
        .where('id', '=', quote.id)
        .where('status', '=', 'processing')
        .where('claim_signature', '=', signature)
        .executeTakeFirst();
      if (Number(confirmed.numUpdatedRows) !== 1) {
        throw new ConflictError('quote_consumed', 'Quote claim is no longer active');
      }
      return {
        state: grantState,
        entitlement: quote.sku as EntitlementSku,
        idempotent: false,
      };
      });
    } finally {
      this.activePaymentVerifications.delete(quote.id);
    }
  }

  private async rejectPaymentClaim(quoteId: string, signature: string): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction.updateTable('purchase_quotes')
        .set({ status: 'expired' })
        .where('id', '=', quoteId)
        .where('status', '=', 'processing')
        .where('claim_signature', '=', signature)
        .execute();
      await transaction.deleteFrom('username_reservations')
        .where('quote_id', '=', quoteId)
        .execute();
    });
  }
}
