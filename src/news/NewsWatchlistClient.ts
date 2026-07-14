import {
  ASSET_SYMBOLS,
  NEWS_CLIENT_ACCOUNT_MAX,
  type AssetSymbol,
} from '../../shared/src/index.js';
import {
  multiplayerHttpOrigin,
  resolveMultiplayerEndpoint,
} from '../net/RuntimeCapabilitiesClient.js';
import { parseTrackedNewsAccount } from './newsMath.js';
import type { NewsItem, TrackedNewsAccount } from './types.js';

const STORAGE_KEY = 'tickerworld:v2:news-watchlists';
const ACCOUNT_TOUCH_REFRESH_MS = 12 * 60 * 60 * 1_000;
const ACCOUNT_TOUCH_RETRY_MS = 5 * 60 * 1_000;
const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;
const ACCOUNT_ADD_RETRY_MS = 1_250;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NewsWatchlistSnapshot {
  readonly market: AssetSymbol;
  readonly accounts: readonly TrackedNewsAccount[];
  readonly catalog: readonly TrackedNewsAccount[];
  readonly selectedHandles: readonly string[];
  readonly maxAccounts: number;
  readonly adding: boolean;
  readonly error: string | null;
}

export type NewsWatchlistListener = (snapshot: NewsWatchlistSnapshot) => void;

export type NewsAccountAddResult =
  | { readonly ok: true; readonly account: TrackedNewsAccount }
  | { readonly ok: false; readonly error: string };

export interface NewsWatchlistClientOptions {
  readonly activeMarket: AssetSymbol;
  readonly storage?: Storage | null;
  readonly fetcher?: Fetcher;
  readonly baseUrl?: string | null;
  readonly anonymousToken?: () => string | null;
  readonly requestTimeoutMs?: number;
}

interface StoredNewsAccountSelection {
  /** Immutable X account id. Null exists only while migrating a legacy handle. */
  readonly id: string | null;
  /** Last verified handle, retained for display and rolling-server compatibility. */
  readonly handle: string;
}

type StoredWatchlists = Partial<Record<AssetSymbol, StoredNewsAccountSelection[]>>;

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function normalizeNewsHandle(value: string): string | null {
  const handle = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function handleKey(value: string): string {
  return value.toLowerCase();
}

function normalizeNewsAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[^\s\u0000-\u001f\u007f]{1,128}$/.test(id) ? id : null;
}

function selectionKey(selection: StoredNewsAccountSelection): string {
  return selection.id
    ? `id:${selection.id}`
    : `legacy-handle:${handleKey(selection.handle)}`;
}

function dedupeSelections(
  values: readonly StoredNewsAccountSelection[],
  limit: number,
): StoredNewsAccountSelection[] {
  const result: StoredNewsAccountSelection[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const handle = normalizeNewsHandle(value.handle);
    const id = value.id === null ? null : normalizeNewsAccountId(value.id);
    if (!handle || (value.id !== null && !id)) continue;
    const selection = { id, handle };
    const key = selectionKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selection);
    if (result.length >= limit) break;
  }
  return result;
}

function parseStoredSelection(value: unknown): StoredNewsAccountSelection | null {
  if (typeof value === 'string') {
    const handle = normalizeNewsHandle(value);
    return handle ? { id: null, handle } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const handle = typeof candidate.handle === 'string'
    ? normalizeNewsHandle(candidate.handle)
    : null;
  if (!handle) return null;
  if (candidate.id === undefined || candidate.id === null) return { id: null, handle };
  const id = normalizeNewsAccountId(candidate.id);
  return id ? { id, handle } : null;
}

function readStoredWatchlists(storage: Storage | null): StoredWatchlists {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const source = value as Record<string, unknown>;
    const result: StoredWatchlists = {};
    for (const market of ASSET_SYMBOLS) {
      if (!Array.isArray(source[market])) continue;
      result[market] = dedupeSelections(
        source[market]
          .map(parseStoredSelection)
          .filter((selection): selection is StoredNewsAccountSelection => selection !== null),
        NEWS_CLIENT_ACCOUNT_MAX,
      );
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredWatchlists(storage: Storage | null, value: StoredWatchlists): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Local selection is a convenience; live news remains available without storage.
  }
}

function defaultServiceOrigin(): string | null {
  return multiplayerHttpOrigin(resolveMultiplayerEndpoint());
}

function normalizeServiceOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || url.search
      || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Owns one browser's per-world display choices. The server only resolves and
 * deduplicates acquisition; removing a source never changes another player's world.
 */
export class NewsWatchlistClient {
  private readonly storage: Storage | null;
  private readonly fetcher: Fetcher;
  private readonly baseUrl: string | null;
  private readonly anonymousToken: () => string | null;
  private readonly requestTimeoutMs: number;
  private readonly listeners = new Set<NewsWatchlistListener>();
  private readonly touchControllers = new Map<string, AbortController>();
  private readonly touchAttemptedAt = new Map<string, number>();
  private readonly touchSucceededAt = new Map<string, number>();
  private readonly touchFailures = new Set<string>();
  private readonly stored: StoredWatchlists;
  private market: AssetSymbol;
  private catalog: TrackedNewsAccount[] = [];
  private selectedAccounts: StoredNewsAccountSelection[] = [];
  private maxAccounts = NEWS_CLIENT_ACCOUNT_MAX;
  private addController: AbortController | null = null;
  private addGeneration = 0;
  private addingMarket: AssetSymbol | null = null;
  private lastAddAttemptKey: string | null = null;
  private lastAddAttemptAt = Number.NEGATIVE_INFINITY;
  private error: string | null = null;
  private disposed = false;

  constructor(options: NewsWatchlistClientOptions) {
    this.market = options.activeMarket;
    this.storage = options.storage === undefined ? safeLocalStorage() : options.storage;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.baseUrl = normalizeServiceOrigin(
      options.baseUrl === undefined ? defaultServiceOrigin() : options.baseUrl,
    );
    this.anonymousToken = options.anonymousToken ?? (() => null);
    this.requestTimeoutMs = Math.max(1, Math.floor(
      options.requestTimeoutMs ?? ACCOUNT_REQUEST_TIMEOUT_MS,
    ));
    this.stored = readStoredWatchlists(this.storage);
    this.selectedAccounts = (this.stored[this.market] ?? []).map((selection) => ({ ...selection }));
  }

  get snapshot(): NewsWatchlistSnapshot {
    const byId = new Map(this.catalog.map((account) => [account.id, account]));
    const byHandle = new Map(this.catalog.map((account) => [handleKey(account.handle), account]));
    const accounts = this.selectedAccounts.map((selection): TrackedNewsAccount => {
      const key = handleKey(selection.handle);
      const touchFailed = this.touchFailures.has(this.touchKey(this.market, selection));
      const account = selection.id
        ? byId.get(selection.id)
        : byHandle.get(key);
      if (account) return touchFailed && !account.isDefault
        ? { ...account, status: 'unavailable' }
        : account;
      return {
        id: selection.id ?? `pending:${key}`,
        handle: selection.handle,
        name: `@${selection.handle}`,
        avatarUrl: null,
        isDefault: false,
        status: touchFailed ? 'unavailable' : 'reconnecting',
        lastPostAt: null,
      };
    });
    return {
      market: this.market,
      accounts,
      catalog: [...this.catalog],
      selectedHandles: this.selectedAccounts.map((selection) => selection.handle),
      maxAccounts: this.maxAccounts,
      adding: this.addingMarket === this.market,
      error: this.error,
    };
  }

  setActiveMarket(market: AssetSymbol): void {
    if (this.disposed || this.market === market) return;
    this.cancelAddRequest('The world changed before the account was added.');
    this.abortTouchRequests('The world changed before the account was refreshed.');
    this.market = market;
    this.catalog = [];
    this.maxAccounts = NEWS_CLIENT_ACCOUNT_MAX;
    this.selectedAccounts = (this.stored[market] ?? []).map((selection) => ({ ...selection }));
    this.error = null;
    this.emit();
  }

  setCatalog(accounts: readonly TrackedNewsAccount[], maximum = NEWS_CLIENT_ACCOUNT_MAX): void {
    if (this.disposed) return;
    const byId = new Map<string, TrackedNewsAccount>();
    for (const account of accounts) {
      if (!byId.has(account.id)) byId.set(account.id, account);
    }
    this.catalog = [...byId.values()];
    this.maxAccounts = Math.min(
      NEWS_CLIENT_ACCOUNT_MAX,
      Math.max(1, Math.floor(maximum)),
    );
    if (this.stored[this.market] === undefined && this.catalog.length > 0) {
      this.selectedAccounts = this.catalog
        .filter((account) => account.isDefault)
        .slice(0, this.maxAccounts)
        .map((account) => ({ id: account.id, handle: account.handle }));
      this.persist();
    } else {
      const catalogById = new Map(this.catalog.map((account) => [account.id, account]));
      const catalogByHandle = new Map(
        this.catalog.map((account) => [handleKey(account.handle), account]),
      );
      this.selectedAccounts = dedupeSelections(
        this.selectedAccounts.map((selection) => {
          const account = selection.id
            ? catalogById.get(selection.id)
            : catalogByHandle.get(handleKey(selection.handle));
          return account
            ? { id: account.id, handle: account.handle }
            : selection;
        }),
        this.maxAccounts,
      );
      for (const selection of this.selectedAccounts) {
        if (selection.id && catalogById.has(selection.id)) {
          this.touchFailures.delete(this.touchKey(this.market, selection));
        }
      }
      if (this.stored[this.market] !== undefined) this.persist();
    }
    this.emit();
    this.touchSelectedAccounts();
  }

  subscribe(listener: NewsWatchlistListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  /** Retries saved custom sources once the signed anonymous identity is ready. */
  refreshAssociations(): void {
    if (this.disposed || this.catalog.length === 0) return;
    this.touchSelectedAccounts();
  }

  filterItems(items: readonly NewsItem[]): NewsItem[] {
    // During a compatible server rollout, preserve posts only for visitors who
    // have never made a source choice. An explicit empty/selected watchlist is
    // authoritative even when the catalog request temporarily disappears.
    if (this.catalog.length === 0 && this.stored[this.market] === undefined) return [...items];
    return items.filter((item) => (
      item.source === 'simulation'
      || this.selectedAccounts.some((selection) => this.itemMatchesSelection(item, selection))
    ));
  }

  latestItemFor(items: readonly NewsItem[], handle: string): NewsItem | null {
    const key = handleKey(handle);
    const selected = this.selectedAccounts.find((candidate) => (
      handleKey(candidate.handle) === key
    ));
    const catalogAccount = this.catalog.find((candidate) => handleKey(candidate.handle) === key);
    const selection = selected
      ?? (catalogAccount
        ? { id: catalogAccount.id, handle: catalogAccount.handle }
        : { id: null, handle });
    return items.find((item) => (
      item.source === 'x' && this.itemMatchesSelection(item, selection)
    )) ?? null;
  }

  async add(rawHandle: string): Promise<NewsAccountAddResult> {
    if (this.disposed || this.addingMarket !== null) {
      return { ok: false, error: 'Please wait a moment.' };
    }
    const handle = normalizeNewsHandle(rawHandle);
    if (!handle) return this.fail('Enter a valid X handle, without the profile URL.');
    const selected = this.selectedAccounts.find((selection) => (
      handleKey(selection.handle) === handleKey(handle)
    ));
    if (selected) {
      const account = selected.id
        ? this.catalog.find((candidate) => candidate.id === selected.id)
        : this.catalog.find((candidate) => handleKey(candidate.handle) === handleKey(handle));
      return account ? { ok: true, account } : this.fail(`@${handle} is already selected.`);
    }
    if (this.selectedAccounts.length >= this.maxAccounts) {
      return this.fail(`Remove an account before adding another (maximum ${this.maxAccounts}).`);
    }

    const anonymousToken = this.anonymousToken();
    if (!this.baseUrl || !anonymousToken) {
      return this.fail('Account controls are still connecting. Try again in a moment.');
    }
    const requestedMarket = this.market;
    const attemptKey = `${requestedMarket}:${handleKey(handle)}`;
    const now = Date.now();
    if (this.lastAddAttemptKey === attemptKey
      && now - this.lastAddAttemptAt < ACCOUNT_ADD_RETRY_MS) {
      return this.fail('Please wait a moment before retrying that account.');
    }
    this.lastAddAttemptKey = attemptKey;
    this.lastAddAttemptAt = now;
    const generation = ++this.addGeneration;
    const controller = new AbortController();
    this.addController = controller;
    this.addingMarket = requestedMarket;
    this.error = null;
    this.emit();
    try {
      const response = await this.postAccount(
        requestedMarket,
        handle,
        anonymousToken,
        controller,
      );
      if (this.disposed || generation !== this.addGeneration || this.market !== requestedMarket) {
        return { ok: false, error: 'Account request was cancelled when the world changed.' };
      }
      const payload = await response.json().catch(() => null) as {
        account?: unknown;
        error?: unknown;
        message?: unknown;
      } | null;
      if (this.disposed || generation !== this.addGeneration || this.market !== requestedMarket) {
        return { ok: false, error: 'Account request was cancelled when the world changed.' };
      }
      if (!response.ok) {
        const message = typeof payload?.message === 'string'
          ? payload.message
          : response.status === 429
            ? 'Too many account changes. Try again later.'
            : 'That X account could not be added.';
        return this.fail(message);
      }
      const account = parseTrackedNewsAccount(payload?.account);
      if (!account) return this.fail('The news service returned an invalid account.');
      this.markTouchSuccess(requestedMarket, account);
      this.catalog = [
        account,
        ...this.catalog.filter((candidate) => (
          candidate.id !== account.id
          && handleKey(candidate.handle) !== handleKey(account.handle)
        )),
      ];
      this.select(account);
      return { ok: true, account };
    } catch {
      if (this.disposed || generation !== this.addGeneration
        || this.abortReasonName(controller) === 'AbortError') {
        return { ok: false, error: 'Account request was cancelled when the world changed.' };
      }
      if (this.abortReasonName(controller) === 'TimeoutError') {
        return this.fail('The news service took too long to respond. Try again.');
      }
      return this.fail('The news service is unavailable. Try again shortly.');
    } finally {
      if (generation === this.addGeneration) {
        this.addController = null;
        this.addingMarket = null;
        if (!this.disposed) this.emit();
      }
    }
  }

  remove(handle: string): boolean {
    if (this.disposed) return false;
    const key = handleKey(handle);
    const removed = this.selectedAccounts.find((candidate) => handleKey(candidate.handle) === key);
    if (!removed) return false;
    this.selectedAccounts = this.selectedAccounts.filter((candidate) => candidate !== removed);
    this.touchFailures.delete(this.touchKey(this.market, removed));
    this.error = null;
    this.persist();
    this.emit();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAddRequest('The news controls were closed.');
    this.abortTouchRequests('The news controls were closed.');
    this.listeners.clear();
  }

  private select(account: TrackedNewsAccount): void {
    this.selectedAccounts = dedupeSelections(
      [...this.selectedAccounts, { id: account.id, handle: account.handle }],
      this.maxAccounts,
    );
    this.error = null;
    this.persist();
    this.emit();
    if (!account.isDefault) {
      void this.touchAccount(this.market, { id: account.id, handle: account.handle });
    }
  }

  private persist(): void {
    this.stored[this.market] = this.selectedAccounts.map((selection) => ({ ...selection }));
    writeStoredWatchlists(this.storage, this.stored);
  }

  private itemMatchesSelection(
    item: NewsItem,
    selection: StoredNewsAccountSelection,
  ): boolean {
    if (item.authorId !== undefined) {
      return selection.id !== null && item.authorId === selection.id;
    }
    if (handleKey(item.authorHandle) !== handleKey(selection.handle)) return false;
    if (!selection.id) return true;
    // A rolling old endpoint lacks authorId. Handle fallback is safe only when
    // the current catalog does not prove that this handle belongs to another id.
    const currentHandleOwner = this.catalog.find((account) => (
      handleKey(account.handle) === handleKey(item.authorHandle)
    ));
    return !currentHandleOwner || currentHandleOwner.id === selection.id;
  }

  private fail(error: string): NewsAccountAddResult {
    this.error = error;
    this.emit();
    return { ok: false, error };
  }

  private emit(): void {
    const snapshot = this.snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private touchSelectedAccounts(): void {
    const market = this.market;
    const catalogById = new Map(this.catalog.map((account) => [account.id, account]));
    const catalogByHandle = new Map(
      this.catalog.map((account) => [handleKey(account.handle), account]),
    );
    for (const selection of this.selectedAccounts) {
      const account = selection.id
        ? catalogById.get(selection.id)
        : catalogByHandle.get(handleKey(selection.handle));
      if (account?.isDefault) continue;
      void this.touchAccount(market, { ...selection });
    }
  }

  private async touchAccount(
    market: AssetSymbol,
    selection: StoredNewsAccountSelection,
  ): Promise<void> {
    const anonymousToken = this.anonymousToken();
    if (this.disposed || !this.baseUrl || !anonymousToken) return;
    const key = this.touchKey(market, selection);
    const now = Date.now();
    const succeededAt = this.touchSucceededAt.get(key) ?? Number.NEGATIVE_INFINITY;
    const attemptedAt = this.touchAttemptedAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (this.touchControllers.has(key)
      || now - succeededAt < ACCOUNT_TOUCH_REFRESH_MS
      || now - attemptedAt < ACCOUNT_TOUCH_RETRY_MS) return;
    const controller = new AbortController();
    this.touchControllers.set(key, controller);
    this.touchAttemptedAt.set(key, now);
    try {
      const response = await this.postAccount(
        market,
        selection.handle,
        anonymousToken,
        controller,
        selection.id,
      );
      const payload = await response.json().catch(() => null) as { account?: unknown } | null;
      const account = response.ok ? parseTrackedNewsAccount(payload?.account) : undefined;
      if (!account) throw new Error('account_touch_failed');
      if (selection.id && account.id !== selection.id) {
        throw new Error('account_identity_mismatch');
      }
      if (!selection.id && handleKey(account.handle) !== handleKey(selection.handle)) {
        throw new Error('account_handle_mismatch');
      }
      this.markTouchSuccess(market, account, key);
      if (this.market === market) {
        const selectedIndex = this.selectedAccounts.findIndex((candidate) => (
          selection.id
            ? candidate.id === selection.id
            : candidate.id === null
              && handleKey(candidate.handle) === handleKey(selection.handle)
        ));
        if (selectedIndex < 0) return;
        this.selectedAccounts[selectedIndex] = { id: account.id, handle: account.handle };
        this.selectedAccounts = dedupeSelections(this.selectedAccounts, this.maxAccounts);
        this.catalog = [
          account,
          ...this.catalog.filter((candidate) => (
            candidate.id !== account.id
            && handleKey(candidate.handle) !== handleKey(account.handle)
          )),
        ];
        this.persist();
      }
    } catch {
      if (this.abortReasonName(controller) === 'AbortError') {
        this.touchAttemptedAt.delete(key);
      } else {
        this.touchFailures.add(key);
      }
    } finally {
      if (this.touchControllers.get(key) === controller) this.touchControllers.delete(key);
      if (!this.disposed && this.market === market) this.emit();
    }
  }

  private async postAccount(
    market: AssetSymbol,
    handle: string,
    anonymousToken: string,
    controller: AbortController,
    accountId?: string | null,
  ): Promise<Response> {
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason);
      }, { once: true });
    });
    const timeout = globalThis.setTimeout(() => {
      const reason = new DOMException('The news account request timed out.', 'TimeoutError');
      controller.abort(reason);
    }, this.requestTimeoutMs);
    try {
      return await Promise.race([
        this.fetcher(`${this.baseUrl}/api/news/accounts`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: market,
            handle,
            anonymousToken,
            ...(accountId ? { accountId } : {}),
          }),
          signal: controller.signal,
        }),
        aborted,
      ]);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private cancelAddRequest(message: string): void {
    if (!this.addController) return;
    ++this.addGeneration;
    this.addController.abort(new DOMException(message, 'AbortError'));
    this.addController = null;
    this.addingMarket = null;
  }

  private abortTouchRequests(message: string): void {
    for (const controller of this.touchControllers.values()) {
      controller.abort(new DOMException(message, 'AbortError'));
    }
    this.touchControllers.clear();
  }

  private abortReasonName(controller: AbortController): string | null {
    if (!controller.signal.aborted) return null;
    const reason = controller.signal.reason;
    return reason instanceof Error ? reason.name : 'AbortError';
  }

  private markTouchSuccess(
    market: AssetSymbol,
    account: Pick<TrackedNewsAccount, 'id' | 'handle'>,
    previousKey?: string,
  ): void {
    const key = this.touchKey(market, { id: account.id, handle: account.handle });
    this.touchSucceededAt.set(key, Date.now());
    this.touchFailures.delete(key);
    if (previousKey) {
      this.touchSucceededAt.set(previousKey, Date.now());
      this.touchFailures.delete(previousKey);
    }
  }

  private touchKey(market: AssetSymbol, selection: StoredNewsAccountSelection): string {
    return `${market}:${selectionKey(selection)}`;
  }
}
