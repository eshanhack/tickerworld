import type {
  AccountProfile,
  AnimalKind,
  EntitlementSku,
  MarketSlug,
  PurchaseQuote,
  SkinId,
} from '../../shared/src/index.js';

const SESSION_KEY = 'tickerworld:v2:account-session';

export interface AuthChallenge {
  readonly id: string;
  readonly message: string;
  readonly expiresAt: number;
}

export interface AuthSessionResult {
  readonly sessionToken: string;
  readonly profile: AccountProfile;
  readonly blocks: readonly string[];
}

export interface PurchaseConfirmation {
  readonly status: 'confirmed' | 'pending' | 'credited';
  readonly profile?: AccountProfile;
}

export class EconomyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EconomyApiError';
  }
}

export interface EconomyApiContract {
  readonly sessionToken: string | null;
  setSessionToken(value: string | null): void;
  challenge(publicKey: string, actorId: string): Promise<AuthChallenge>;
  verify(challengeId: string, publicKey: string, signature: string, actorId: string): Promise<AuthSessionResult>;
  logout(): Promise<void>;
  getProfile(): Promise<AccountProfile>;
  updateProfile(animal: AnimalKind, skin: SkinId, lastMarket: MarketSlug): Promise<AccountProfile>;
  updateLastMarket(lastMarket: MarketSlug): Promise<AccountProfile>;
  claimUsername(username: string): Promise<AccountProfile>;
  getBlocks(): Promise<readonly string[]>;
  setBlock(actorId: string, blocked: boolean): Promise<void>;
  createQuote(sku: EntitlementSku, options?: { readonly username?: string }): Promise<PurchaseQuote>;
  confirmPurchase(quoteId: string, signature: string): Promise<PurchaseConfirmation>;
}

export interface EconomyApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly storage?: Storage | null;
  /** Signed anonymous identity binds wallet authentication to the visible actor. */
  readonly anonymousToken?: () => string | null;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice(5)}`;
  return trimmed;
}

function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export class EconomyApi implements EconomyApiContract {
  private readonly baseUrl: string;
  private readonly requestFetch: typeof fetch;
  private readonly storage: Storage | null;
  private readonly anonymousToken: () => string | null;
  private token: string | null;

  constructor(options: EconomyApiOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? import.meta.env.VITE_MULTIPLAYER_URL ?? '');
    // Window.fetch must not be invoked with EconomyApi as its receiver.
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.anonymousToken = options.anonymousToken ?? (() => null);
    try {
      this.token = this.storage?.getItem(SESSION_KEY) ?? null;
    } catch {
      this.token = null;
    }
  }

  get sessionToken(): string | null {
    return this.token;
  }

  setSessionToken(value: string | null): void {
    this.token = value;
    try {
      if (value) this.storage?.setItem(SESSION_KEY, value);
      else this.storage?.removeItem(SESSION_KEY);
    } catch {
      // The in-memory revocable session remains valid for this page.
    }
  }

  async challenge(publicKey: string, actorId: string): Promise<AuthChallenge> {
    const anonymousToken = this.requireAnonymousToken();
    return this.request('/api/auth/challenge', {
      method: 'POST',
      body: { publicKey, actorId, anonymousToken },
      authenticated: false,
    });
  }

  async verify(challengeId: string, publicKey: string, signature: string, actorId: string): Promise<AuthSessionResult> {
    const session = await this.request<AuthSessionResult>('/api/auth/verify', {
      method: 'POST',
      body: {
        challengeId,
        publicKey,
        signature,
        actorId,
        anonymousToken: this.requireAnonymousToken(),
      },
      authenticated: false,
    });
    this.setSessionToken(session.sessionToken);
    return session;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/auth/logout', { method: 'POST' });
    } finally {
      this.setSessionToken(null);
    }
  }

  getProfile(): Promise<AccountProfile> {
    return this.request('/api/account');
  }

  updateProfile(animal: AnimalKind, skin: SkinId, lastMarket: MarketSlug): Promise<AccountProfile> {
    return this.request('/api/account/profile', { method: 'PATCH', body: { animal, skin, lastMarket } });
  }

  updateLastMarket(lastMarket: MarketSlug): Promise<AccountProfile> {
    return this.request('/api/account/profile', { method: 'PATCH', body: { lastMarket } });
  }

  claimUsername(username: string): Promise<AccountProfile> {
    return this.request('/api/account/username', {
      method: 'PUT',
      body: { username },
    });
  }

  getBlocks(): Promise<readonly string[]> {
    return this.request('/api/account/blocks');
  }

  async setBlock(actorId: string, blocked: boolean): Promise<void> {
    await this.request(`/api/account/blocks/${encodeURIComponent(actorId)}`, {
      method: blocked ? 'PUT' : 'DELETE',
    });
  }

  createQuote(sku: EntitlementSku, options: { readonly username?: string } = {}): Promise<PurchaseQuote> {
    return this.request('/api/purchases/quote', { method: 'POST', body: { sku, ...options } });
  }

  confirmPurchase(quoteId: string, signature: string): Promise<PurchaseConfirmation> {
    return this.request('/api/purchases/confirm', { method: 'POST', body: { quoteId, signature } });
  }

  private async request<T = unknown>(
    path: string,
    options: {
      readonly method?: string;
      readonly body?: Readonly<Record<string, unknown>>;
      readonly authenticated?: boolean;
    } = {},
  ): Promise<T> {
    if (!this.baseUrl) throw new Error('Account services are not configured yet.');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.authenticated !== false) {
      if (!this.token) throw new Error('Connect a wallet first.');
      headers.Authorization = `Bearer ${this.token}`;
    }
    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    if (!response.ok) {
      if (response.status === 401) this.setSessionToken(null);
      throw new EconomyApiError(
        response.status,
        payload?.error ?? 'account_request_failed',
        payload?.message ?? payload?.error ?? `Account request failed (${response.status}).`,
      );
    }
    return payload as T;
  }

  private requireAnonymousToken(): string {
    const token = this.anonymousToken();
    if (!token) throw new Error('Anonymous identity is still connecting. Try again in a moment.');
    return token;
  }
}
