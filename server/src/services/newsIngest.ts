import {
  ASSET_SYMBOLS,
  NEWS_CATALOG_ACCOUNT_MAX,
  NEWS_CLIENT_ACCOUNT_MAX,
  NEWS_WORLD_ACCOUNT_MAX,
  type AssetSymbol,
  type NewsAccountStatus,
  type NewsScope,
  type NewsTrackedAccount,
} from '@tickerworld/shared';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { DatabaseSchema, XNewsSourceRow } from '../db/types.js';
import { ConflictError, InputError, ServiceUnavailableError } from './errors.js';
import type { RuntimeSwitchboard } from './runtimeSwitches.js';

const X_ORIGIN = 'https://api.x.com';
const HEALTH_PROVIDER = 'x-news';
const NEWS_TTL_MS = 10 * 60_000;
const PROFILE_TTL_MS = 24 * 60 * 60_000;
// Explicit user acquisition re-checks mutable handle ownership much sooner
// than the background profile/avatar refresh. X account ids remain canonical.
const HANDLE_OWNERSHIP_TTL_MS = 5 * 60_000;
const PROFILE_REFRESH_BATCH_MAX = 1;
const CUSTOM_WORLD_TTL_MS = 24 * 60 * 60_000;
const RULE_NAMESPACE = 'tickerworld:account:';
const STREAM_PATH = '/2/tweets/search/stream';
const RULES_PATH = '/2/tweets/search/stream/rules';
const REQUEST_TIMEOUT_MS = 8_000;
// X may wait up to 20 seconds before the first idle keep-alive. Leave enough
// room for that documented heartbeat plus normal network scheduling latency.
export const X_STREAM_HANDSHAKE_TIMEOUT_MS = 30_000;
const STREAM_HEARTBEAT_DEADLINE_MS = 45_000;
const LEASE_TTL_MS = 45_000;
const LEASE_RENEW_MS = 15_000;
const CATALOG_MAINTENANCE_MS = 5 * 60_000;
const SHARED_CACHE_REFRESH_MS = 5_000;
const SHARED_HEALTH_STALE_MS = 60_000;
const ACTIVE_ASSOCIATION_MS = 13 * 60 * 60_000;
const DYNAMIC_GAP_BACKFILL_MS = 30_000;

interface XUser {
  id: string;
  name: string;
  username: string;
  profileImageUrl: string | null;
}

interface SourceRecord extends XUser {
  status: 'active' | 'unavailable';
  sinceId: string | null;
  rulePendingAt: number | null;
  rulePendingSinceId: string | null;
  ruleReadyAt: number | null;
  lastProfileAt: number | null;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastPostAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type SourceProgressState = Pick<
  SourceRecord,
  | 'status'
  | 'sinceId'
  | 'rulePendingAt'
  | 'rulePendingSinceId'
  | 'ruleReadyAt'
  | 'lastPollAt'
  | 'lastSuccessAt'
  | 'lastPostAt'
  | 'updatedAt'
>;

interface OpenXStream {
  response: Response;
  controller: AbortController;
  leadershipGeneration: number;
}

export interface CachedNewsItem {
  id: string;
  /** Immutable X user id; watchlists must not key filtering to mutable handles. */
  authorId: string;
  source: 'x';
  text: string;
  links: readonly CachedNewsLink[];
  createdAt: number;
  expiresAt: number;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string | null;
  permalink: string;
  demo: false;
  scope: NewsScope;
}

export interface CachedNewsLink {
  kind: 'url' | 'mention' | 'hashtag' | 'cashtag';
  start: number;
  end: number;
  label: string;
  href: string;
}

export interface NewsCacheSnapshot {
  mode: 'live' | 'unavailable' | 'unconfigured';
  items: readonly CachedNewsItem[];
  checkedAt: number;
  accounts: readonly NewsTrackedAccount[];
  maxAccounts: number;
}

export interface XStreamRule {
  id?: string;
  value: string;
  tag?: string;
}

export interface XRulePlan {
  add: readonly { value: string; tag: string }[];
  deleteIds: readonly string[];
}

export interface ParsedXStreamPost {
  id: string;
  authorId: string;
  text: string;
  entities: unknown;
  createdAt: number;
  author: XUser | null;
}

class XProviderError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAt: number,
  ) {
    super(`x_${status}`);
  }
}

class XSourceUnavailableError extends Error {
  constructor(public readonly user: XUser) {
    super('invalid_or_nonpublic_x_user');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entityRange(value: Record<string, unknown>): { start: number; end: number } | null {
  return Number.isInteger(value.start) && Number.isInteger(value.end)
    && (value.start as number) >= 0 && (value.end as number) > (value.start as number)
    ? { start: value.start as number, end: value.end as number }
    : null;
}

function xSearchLink(query: string, source: 'hashtag_click' | 'cashtag_click'): string {
  const url = new URL('/search', 'https://x.com');
  url.searchParams.set('q', query);
  url.searchParams.set('src', source);
  return url.toString();
}

function normalizeEntityLinks(entities: unknown): CachedNewsLink[] {
  if (!isRecord(entities)) return [];
  const links: CachedNewsLink[] = [];
  const append = (
    values: unknown,
    convert: (value: Record<string, unknown>, range: { start: number; end: number }) => CachedNewsLink | null,
  ) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (!isRecord(value)) continue;
      const range = entityRange(value);
      const link = range ? convert(value, range) : null;
      if (link) links.push(link);
    }
  };
  append(entities.urls, (value, range) => {
    if (typeof value.url !== 'string' || typeof value.display_url !== 'string') return null;
    try {
      const original = new URL(value.url);
      if (original.protocol !== 'https:' || original.hostname !== 't.co') return null;
    } catch { return null; }
    return { kind: 'url', ...range, label: value.display_url, href: value.url };
  });
  append(entities.mentions, (value, range) => (
    typeof value.username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value.username)
      ? {
          kind: 'mention', ...range, label: `@${value.username}`,
          href: `https://x.com/${encodeURIComponent(value.username)}`,
        }
      : null
  ));
  append(entities.hashtags, (value, range) => (
    typeof value.tag === 'string' && value.tag.trim()
      ? {
          kind: 'hashtag', ...range, label: `#${value.tag}`,
          href: xSearchLink(`#${value.tag}`, 'hashtag_click'),
        }
      : null
  ));
  append(entities.cashtags, (value, range) => (
    typeof value.tag === 'string' && value.tag.trim()
      ? {
          kind: 'cashtag', ...range, label: `$${value.tag}`,
          href: xSearchLink(`$${value.tag}`, 'cashtag_click'),
        }
      : null
  ));
  return [...new Map(links.map((link) => [
    `${link.kind}:${link.start}:${link.end}:${link.href}`,
    link,
  ])).values()].sort((left, right) => left.start - right.start || left.end - right.end);
}

function parseStoredLinks(value: string): CachedNewsLink[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((link): link is CachedNewsLink => isRecord(link)
    && (link.kind === 'url' || link.kind === 'mention' || link.kind === 'hashtag' || link.kind === 'cashtag')
    && Number.isInteger(link.start) && Number.isInteger(link.end)
    && typeof link.label === 'string' && typeof link.href === 'string');
}

function postContent(value: Record<string, unknown>): { text: string; entities: unknown } | null {
  const note = isRecord(value.note_tweet) ? value.note_tweet : null;
  if (note && typeof note.text === 'string' && note.text.trim()) {
    return { text: note.text, entities: note.entities ?? note.entity_set ?? value.entities };
  }
  return typeof value.text === 'string' && value.text.trim()
    ? { text: value.text, entities: value.entities }
    : null;
}

function parseXUserIdentity(value: unknown): XUser | null {
  if (!isRecord(value)
    || typeof value.id !== 'string' || !/^\d+$/.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(value.username)) return null;
  return {
    id: value.id,
    name: value.name,
    username: value.username,
    profileImageUrl: typeof value.profile_image_url === 'string' ? value.profile_image_url : null,
  };
}

function parseXUser(value: unknown): XUser | null {
  if (!isRecord(value) || value.protected === true || value.withheld !== undefined) return null;
  return parseXUserIdentity(value);
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function newerSnowflake(left: string | null, right: string): string {
  if (!left) return right;
  try { return BigInt(right) > BigInt(left) ? right : left; } catch { return right > left ? right : left; }
}

function sourceFromRow(row: Selectable<XNewsSourceRow>): SourceRecord {
  return {
    id: row.id,
    name: row.name,
    username: row.handle,
    profileImageUrl: row.avatar_url,
    status: row.status,
    sinceId: row.since_id,
    rulePendingAt: row.rule_pending_at,
    rulePendingSinceId: row.rule_pending_since_id,
    ruleReadyAt: row.rule_ready_at,
    lastProfileAt: row.last_profile_at,
    lastPollAt: row.last_poll_at,
    lastSuccessAt: row.last_success_at,
    lastPostAt: row.last_post_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function xRuleTag(sourceId: string): string {
  return `${RULE_NAMESPACE}${sourceId}`;
}

export function xRuleValue(handle: string): string {
  // Replies are authored posts too, and people explicitly tracking an account
  // expect them to appear. Keep reposts out so a busy account cannot flood a
  // world's news rail with content it did not write.
  return `from:${handle} -is:retweet`;
}

/** Reconciles only Tickerworld-owned rules and leaves every foreign app rule untouched. */
export function planXRuleReconciliation(
  existing: readonly XStreamRule[],
  sources: readonly Pick<XUser, 'id' | 'username'>[],
): XRulePlan {
  const desired = new Map(sources.map((source) => [
    xRuleTag(source.id),
    { tag: xRuleTag(source.id), value: xRuleValue(source.username) },
  ]));
  const satisfied = new Set<string>();
  const deleteIds: string[] = [];
  for (const rule of existing) {
    if (!rule.tag?.startsWith(RULE_NAMESPACE)) continue;
    const wanted = desired.get(rule.tag);
    if (wanted && wanted.value === rule.value && !satisfied.has(rule.tag)) {
      satisfied.add(rule.tag);
      continue;
    }
    if (rule.id) deleteIds.push(rule.id);
  }
  return {
    add: [...desired.values()].filter((rule) => !satisfied.has(rule.tag)),
    deleteIds,
  };
}

function parseXRules(payload: unknown): XStreamRule[] | null {
  if (!isRecord(payload)) return null;
  // X omits `data` when no rules exist. A present non-array `data` field is a
  // malformed response and must never be mistaken for an empty rule set.
  if (payload.data === undefined) return [];
  if (!Array.isArray(payload.data)) return null;
  const rules: XStreamRule[] = [];
  for (const value of payload.data) {
    if (!isRecord(value) || typeof value.value !== 'string' || !value.value.trim()) return null;
    if (value.id !== undefined && typeof value.id !== 'string') return null;
    if (value.tag !== undefined && typeof value.tag !== 'string') return null;
    rules.push({
      id: typeof value.id === 'string' ? value.id : undefined,
      value: value.value,
      tag: typeof value.tag === 'string' ? value.tag : undefined,
    });
  }
  return rules;
}

export function parseXStreamEvent(value: unknown): ParsedXStreamPost | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const data = value.data;
  const content = postContent(data);
  const createdAt = typeof data.created_at === 'string' ? Date.parse(data.created_at) : Number.NaN;
  if (!content || typeof data.id !== 'string' || !/^\d+$/.test(data.id)
    || typeof data.author_id !== 'string' || !/^\d+$/.test(data.author_id)
    || !Number.isFinite(createdAt)) return null;
  const includedUsers = isRecord(value.includes) && Array.isArray(value.includes.users)
    ? value.includes.users
    : [];
  const author = includedUsers
    .map(parseXUser)
    .find((candidate): candidate is XUser => candidate?.id === data.author_id) ?? null;
  return {
    id: data.id,
    authorId: data.author_id,
    text: content.text,
    entities: content.entities,
    createdAt,
    author,
  };
}

/** Official guidance uses short linear network recovery and slower exponential HTTP recovery. */
export function xReconnectDelayMs(failureCount: number, status = 0, now = Date.now(), retryAt = 0): number {
  const attempt = Math.max(1, Math.floor(failureCount));
  if (status === 420 || status === 429) {
    return Math.max(60_000, retryAt - now, Math.min(15 * 60_000, 60_000 * 2 ** Math.min(4, attempt - 1)));
  }
  if (status >= 400) return Math.min(320_000, 5_000 * 2 ** Math.min(6, attempt - 1));
  return Math.min(16_000, 250 * attempt);
}

export interface NewsRequestBudget {
  consume(dayUtc: string, limit: number, now: number): Promise<boolean>;
}

export interface NewsIngestLease {
  acquire(ownerId: string, now: number, ttlMs: number): Promise<boolean>;
  release(ownerId: string): Promise<void>;
  /**
   * Holds the durable lease row lock for the whole operation. This turns lease
   * expiry into a quiesced handoff: a successor cannot acquire while an old
   * owner is inside a provider or database mutation.
   */
  runFenced?<T>(
    ownerId: string,
    now: number,
    operation: (transaction: Transaction<DatabaseSchema>) => Promise<T>,
  ): Promise<T>;
}

export class MemoryNewsIngestLease implements NewsIngestLease {
  async acquire(): Promise<boolean> { return true; }
  async release(): Promise<void> {}
}

/** Prevents rolling deployments or accidental scale-out from opening two X streams. */
export class DatabaseNewsIngestLease implements NewsIngestLease {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async acquire(ownerId: string, now: number, ttlMs: number): Promise<boolean> {
    const row = await this.db.insertInto('provider_leases').values({
      provider: 'x-news-stream', owner_id: ownerId, expires_at: now + ttlMs, updated_at: now,
    }).onConflict((conflict) => conflict.column('provider').doUpdateSet({
      owner_id: ownerId,
      expires_at: now + ttlMs,
      updated_at: now,
    }).where(sql<boolean>`provider_leases.owner_id = ${ownerId} or provider_leases.expires_at <= ${now}`))
      .returning('owner_id')
      .executeTakeFirst();
    return row?.owner_id === ownerId;
  }

  async release(ownerId: string): Promise<void> {
    await this.db.deleteFrom('provider_leases')
      .where('provider', '=', 'x-news-stream')
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async runFenced<T>(
    ownerId: string,
    now: number,
    operation: (transaction: Transaction<DatabaseSchema>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (transaction) => {
      // A no-op UPDATE takes a row/write lock in both Postgres and SQLite and
      // keeps acquisition blocked until the guarded operation commits or the
      // connection dies. Checking expiry inside that lock rejects a resumed,
      // stale process before it can touch X or shared state.
      const held = await transaction.updateTable('provider_leases')
        .set({ updated_at: sql<number>`updated_at` })
        .where('provider', '=', 'x-news-stream')
        .where('owner_id', '=', ownerId)
        .where('expires_at', '>', now)
        .returning('owner_id')
        .executeTakeFirst();
      if (!held) throw new XProviderError(503, 0);
      return operation(transaction);
    });
  }
}

export class MemoryNewsRequestBudget implements NewsRequestBudget {
  private readonly counts = new Map<string, number>();
  async consume(dayUtc: string, limit: number): Promise<boolean> {
    const count = this.counts.get(dayUtc) ?? 0;
    if (count >= limit) return false;
    this.counts.set(dayUtc, count + 1);
    return true;
  }
}

/** Persists the paid-provider kill with one atomic upsert on SQLite and Postgres. */
export class DatabaseNewsRequestBudget implements NewsRequestBudget {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async consume(dayUtc: string, limit: number, now: number): Promise<boolean> {
    const result = await this.db.insertInto('provider_budgets').values({
      provider: 'x', day_utc: dayUtc, request_count: 1, updated_at: now,
    }).onConflict((conflict) => conflict.columns(['provider', 'day_utc']).doUpdateSet({
      request_count: sql<number>`provider_budgets.request_count + 1`,
      updated_at: now,
    }).where('provider_budgets.request_count', '<', limit))
      .returning('request_count')
      .executeTakeFirst();
    return result !== undefined && result.request_count <= limit;
  }
}

/** One centralized X Filtered Stream plus bounded timeline gap reconciliation. */
export class NewsIngestService {
  private readonly items = new Map<string, CachedNewsItem>();
  private readonly itemSourceIds = new Map<string, string>();
  private readonly sources = new Map<string, SourceRecord>();
  private readonly sourceIdByHandle = new Map<string, string>();
  private readonly scopesBySource = new Map<string, Set<AssetSymbol>>();
  private readonly defaultScopesBySource = new Map<string, Set<AssetSymbol>>();
  private readonly requestedAtBySourceScope = new Map<string, number>();
  private readonly profileCache = new Map<string, { value: XUser; expiresAt: number }>();
  private readonly profileRetryAt = new Map<string, number>();
  private readonly hydratedSourceIds = new Set<string>();
  private readonly ownerId = `news_${randomUUID()}`;
  private readonly gapBackfillTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly gapBackfillOperations = new Set<Promise<void>>();
  private readonly sourceMutationQueues = new Map<string, Promise<void>>();
  private initialized = false;
  private initializationInFlight: Promise<void> | null = null;
  private disposalInFlight: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  private streamConnected = false;
  private sharedProviderConnected = false;
  private streamController: AbortController | null = null;
  private readonly providerControllers = new Set<AbortController>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionInFlight: Promise<void> | null = null;
  private maintenanceInFlight: Promise<void> | null = null;
  private rulesInFlight: Promise<void> | null = null;
  private rulesGeneration = 1;
  private rulesAppliedGeneration = 0;
  private readonly ruleReadySourceIds = new Set<string>();
  private catalogMutation: Promise<void> = Promise.resolve();
  private catalogMaintenanceInFlight: Promise<void> | null = null;
  private leaderActive = false;
  private leadershipInFlight: Promise<boolean> | null = null;
  private leadershipGeneration = 0;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private catalogTimer: ReturnType<typeof setInterval> | null = null;
  private sharedCacheTimer: ReturnType<typeof setInterval> | null = null;
  private connectionNextAttemptAt = 0;
  private restRetryAt = 0;
  private checkedAt = 0;
  private lastSuccessAt = 0;
  private failureCount = 0;
  private requestDay = '';
  private requestCount = 0;
  private healthWriteQueue: Promise<void> = Promise.resolve();
  private lastHealthWriteAt = 0;
  private lastHealthConnected = false;

  constructor(
    private readonly token: string | null,
    private readonly handles: readonly string[],
    private readonly dailyRequestLimit: number,
    private readonly switches: RuntimeSwitchboard,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 60_000,
    private readonly budget: NewsRequestBudget = new MemoryNewsRequestBudget(),
    private readonly db: Kysely<DatabaseSchema> | null = null,
    private readonly lease: NewsIngestLease = new MemoryNewsIngestLease(),
  ) {}

  /** Loads durable catalog state and acquires configured defaults before rooms start. */
  async initialize(now = this.now()): Promise<void> {
    if (this.initialized || this.disposed) return;
    if (this.initializationInFlight) return this.initializationInFlight;
    this.initializationInFlight = (async () => {
      await this.reloadSharedStateLocked(now);
      this.initialized = true;
    })().finally(() => { this.initializationInFlight = null; });
    return this.initializationInFlight;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // Shared-cache maintenance is useful even when this process has no X
    // credential: it keeps the ten-minute durable window pruned and lets an
    // API-only replica observe the elected ingestor's health.
    this.startIndependentMaintenance();
    if (this.token) this.scheduleConnection(0);
  }

  leaderStatus(): 'disabled' | 'leader' | 'standby' {
    if (!this.token || !this.switches.enabled('newsIngest')) return 'disabled';
    return this.leaderActive ? 'leader' : 'standby';
  }

  available(now = this.now()): boolean {
    const recentlySuccessful = this.lastSuccessAt > 0
      && now - this.lastSuccessAt <= 5 * 60_000;
    if (!this.configured() || !recentlySuccessful) return false;
    // Explicit refresh() remains useful as a deterministic REST-only operational
    // probe. Once start() owns a live service, however, stale cached success must
    // not disguise a disconnected filtered stream as LIVE.
    return !this.started || Boolean(
      (this.streamConnected || this.sharedProviderConnected)
      && this.checkedAt > 0
      && now - this.checkedAt <= SHARED_HEALTH_STALE_MS
    );
  }

  snapshot(scope?: AssetSymbol, now = this.now()): NewsCacheSnapshot {
    this.prune(now);
    const mode: NewsCacheSnapshot['mode'] = !this.configured()
      ? 'unconfigured'
      : this.available(now) ? 'live' : 'unavailable';
    const items = [...this.items.values()]
      .filter((item) => scope === undefined || item.scope === scope)
      .sort((left, right) => right.createdAt - left.createdAt);
    return {
      mode,
      items,
      checkedAt: this.checkedAt || now,
      accounts: scope ? this.accounts(scope, now) : [],
      maxAccounts: NEWS_CLIENT_ACCOUNT_MAX,
    };
  }

  accounts(scope: AssetSymbol, now = this.now()): NewsTrackedAccount[] {
    const result: NewsTrackedAccount[] = [];
    for (const [sourceId, scopes] of this.scopesBySource) {
      if (!scopes.has(scope)) continue;
      const source = this.sources.get(sourceId);
      if (!source) continue;
      const defaults = this.defaultScopesBySource.get(sourceId);
      result.push({
        id: source.id,
        handle: source.username,
        name: source.name,
        avatarUrl: source.profileImageUrl,
        isDefault: defaults?.has(scope) ?? false,
        status: this.accountStatus(source, now),
        lastPostAt: source.lastPostAt,
      });
    }
    return result.sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
      || left.handle.localeCompare(right.handle));
  }

  isAccountAssociated(scope: AssetSymbol, rawHandle: string): boolean {
    const handle = rawHandle.replace(/^@/, '').trim().toLowerCase();
    const sourceId = this.sourceIdByHandle.get(handle);
    return sourceId ? this.scopesBySource.get(sourceId)?.has(scope) ?? false : false;
  }

  isAccountIdAssociated(scope: AssetSymbol, sourceId: string): boolean {
    return this.sources.has(sourceId) && (this.scopesBySource.get(sourceId)?.has(scope) ?? false);
  }

  /**
   * Refreshes a saved association by immutable X id. This is deliberately
   * separate from handle acquisition: a selected account may have renamed and
   * left its former handle vacant or transferred to another user.
   */
  async touchAccount(
    scope: AssetSymbol,
    sourceId: string,
    now = this.now(),
  ): Promise<NewsTrackedAccount> {
    if (!this.initialized) await this.initialize(now);
    if (!await this.ensureLeadership(now)) {
      throw new ServiceUnavailableError(
        'news_ingestor_standby',
        'The live X news catalog is moving between servers; please retry shortly',
      );
    }
    const leadershipGeneration = this.leadershipGeneration;
    return this.enqueueCatalogMutation(async () => {
      this.assertLeadership(leadershipGeneration);
      let source = this.sources.get(sourceId);
      if (!source || !(this.scopesBySource.get(sourceId)?.has(scope) ?? false)) {
        throw new InputError('x_account_not_tracked', 'That saved X account is no longer tracked here');
      }
      let profileChanged = false;
      // Retention touches are high-volume and keyed by an already canonical id;
      // they do not need five-minute mutable-handle verification. The bounded
      // daily profile sweep owns rename discovery for these saved selections.
      if (source.lastProfileAt === null || now - source.lastProfileAt >= PROFILE_TTL_MS) {
        try {
          const profile = await this.resolveUserById(source.id, now);
          await this.reconcileCanonicalHandleOwner(profile, now, leadershipGeneration);
          source = await this.upsertSource(profile, now);
          profileChanged = true;
        } catch (error) {
          if (error instanceof XSourceUnavailableError) {
            await this.reconcileCanonicalHandleOwner(error.user, now, leadershipGeneration);
            source = await this.upsertSource(error.user, now);
            await this.markSourceUnavailable(source, now);
            this.markRulesDirty();
          } else if (error instanceof XProviderError && error.status === 404) {
            await this.markSourceUnavailable(source, now);
            this.markRulesDirty();
          }
          // Shared provider/token failures must not let a transient outage
          // expire an otherwise valid saved association.
        }
      }
      await this.associateSource(source.id, scope, false, now);
      this.assertLeadership(leadershipGeneration);
      if (profileChanged || source.status === 'unavailable') {
        await this.reconcileRules(now).catch(() => undefined);
      }
      const account = this.accounts(scope, now).find((candidate) => candidate.id === source!.id);
      if (!account) throw new InputError('x_account_not_tracked', 'That saved X account is no longer tracked here');
      return account;
    });
  }

  /** Resolves a canonical public profile, persists shared acquisition, and hot-adds its rule. */
  async addAccount(scope: AssetSymbol, rawHandle: string, now = this.now()): Promise<NewsTrackedAccount> {
    if (!this.initialized) await this.initialize(now);
    if (!await this.ensureLeadership(now)) {
      throw new ServiceUnavailableError(
        'news_ingestor_standby',
        'The live X news catalog is moving between servers; please retry shortly',
      );
    }
    const leadershipGeneration = this.leadershipGeneration;
    return this.enqueueCatalogMutation(() => {
      this.assertLeadership(leadershipGeneration);
      return this.addAccountLocked(scope, rawHandle, now, leadershipGeneration);
    });
  }

  /**
   * Reacquires a persisted watchlist selection after its world association was
   * pruned. The immutable id is resolved first, so a rename or reclaimed old
   * handle can never redirect the selection to a different account.
   */
  async addAccountById(
    scope: AssetSymbol,
    sourceId: string,
    now = this.now(),
  ): Promise<NewsTrackedAccount> {
    if (!/^\d{1,32}$/.test(sourceId)) {
      throw new InputError('invalid_x_account_id', 'That saved X account identity is invalid');
    }
    if (!this.initialized) await this.initialize(now);
    if (!await this.ensureLeadership(now)) {
      throw new ServiceUnavailableError(
        'news_ingestor_standby',
        'The live X news catalog is moving between servers; please retry shortly',
      );
    }
    const leadershipGeneration = this.leadershipGeneration;
    return this.enqueueCatalogMutation(async () => {
      this.assertLeadership(leadershipGeneration);
      let profile: XUser;
      try {
        profile = await this.resolveUserById(sourceId, now);
        await this.reconcileCanonicalHandleOwner(profile, now, leadershipGeneration);
      } catch (error) {
        if (error instanceof XProviderError && error.status === 404) {
          throw new InputError('x_account_not_found', 'That saved X account no longer exists');
        }
        if (error instanceof XSourceUnavailableError) {
          throw new InputError('x_account_not_public', 'That saved X account is unavailable or not public');
        }
        throw new ServiceUnavailableError('news_provider_unavailable', 'X could not verify that account right now');
      }
      const alreadyKnown = this.sources.has(profile.id);
      if (!alreadyKnown && this.sources.size >= NEWS_CATALOG_ACCOUNT_MAX) {
        throw new ConflictError('news_catalog_full', 'Tickerworld already has the maximum shared news sources');
      }
      await this.upsertSource(profile, now);
      this.assertLeadership(leadershipGeneration);
      try {
        const account = await this.addAccountLocked(scope, profile.username, now, leadershipGeneration);
        if (account.id !== sourceId) throw new XProviderError(409, 0);
        return account;
      } catch (error) {
        if (!alreadyKnown && !(this.scopesBySource.get(sourceId)?.size ?? 0)) {
          await this.deleteUnusedSource(sourceId, leadershipGeneration);
        }
        throw error;
      }
    });
  }

  private enqueueCatalogMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.catalogMutation.then(operation);
    this.catalogMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async addAccountLocked(
    scope: AssetSymbol,
    rawHandle: string,
    now: number,
    leadershipGeneration: number,
  ): Promise<NewsTrackedAccount> {
    if (!this.token || !this.switches.enabled('newsIngest')) {
      throw new ServiceUnavailableError('news_provider_unavailable', 'Live X news is not configured');
    }
    const handle = rawHandle.replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      throw new InputError('invalid_x_handle', 'Enter a valid public X account handle');
    }
    const normalized = handle.toLowerCase();
    const knownSourceId = this.sourceIdByHandle.get(normalized);
    const knownAssociation = knownSourceId
      ? this.scopesBySource.get(knownSourceId)?.has(scope) ?? false
      : false;
    let source = this.sourceIdByHandle.has(normalized)
      ? this.sources.get(this.sourceIdByHandle.get(normalized)!) ?? null
      : null;
    const ownershipFresh = source?.status === 'active'
      && source.lastProfileAt !== null
      && now - source.lastProfileAt < HANDLE_OWNERSHIP_TTL_MS;
    if (knownAssociation && source && ownershipFresh) {
      await this.associateSource(source.id, scope, false, now);
      this.assertLeadership(leadershipGeneration);
      return this.accounts(scope, now).find((account) => account.id === source!.id)!;
    }
    let resolvedProfile: XUser | null = null;
    if (!ownershipFresh) {
      try {
        // The handle can have moved to a different immutable X user id since
        // our last lookup. Bypass the long-lived avatar/profile cache here.
        resolvedProfile = await this.resolveUser(handle, now, true);
        this.assertLeadership(leadershipGeneration);
        await this.reconcileCanonicalHandleOwner(resolvedProfile, now, leadershipGeneration);
        this.assertLeadership(leadershipGeneration);
      } catch (error) {
        if (error instanceof XProviderError && error.status === 404) {
          throw new InputError('x_account_not_found', 'That public X account could not be found');
        }
        if (error instanceof Error && error.message === 'invalid_or_nonpublic_x_user') {
          throw new InputError('x_account_not_public', 'That X account is unavailable or not public');
        }
        throw new ServiceUnavailableError('news_provider_unavailable', 'X could not verify that account right now');
      }
      source = this.sources.get(resolvedProfile.id) ?? null;
    }

    // Profile validation happens before any LRU eviction, so a typo, suspended
    // account, or provider outage can never destructively remove a valid source.
    await this.pruneInactiveWorldsLocked(now, leadershipGeneration);
    if (source && !this.sources.has(source.id)) {
      resolvedProfile ??= {
        id: source.id,
        name: source.name,
        username: source.username,
        profileImageUrl: source.profileImageUrl,
      };
      source = null;
    }
    const sourceAlreadyKnown = source !== null;
    const scopeSourceCount = [...this.scopesBySource.values()].filter((scopes) => scopes.has(scope)).length;
    let replacementCandidate: { sourceId: string; requestedAt: number } | null = null;
    if (scopeSourceCount >= NEWS_WORLD_ACCOUNT_MAX) {
      const mustReleaseCatalogSlot = !sourceAlreadyKnown && this.sources.size >= NEWS_CATALOG_ACCOUNT_MAX;
      replacementCandidate = this.findInactiveAssociationCandidate(scope, now, mustReleaseCatalogSlot);
      if (!replacementCandidate) {
        throw new ConflictError('news_world_catalog_full', 'This world already has the maximum shared news sources');
      }
    }
    const needsTemporaryCatalogSlot = !sourceAlreadyKnown
      && this.sources.size >= NEWS_CATALOG_ACCOUNT_MAX
      && replacementCandidate !== null;
    if (!sourceAlreadyKnown && this.sources.size >= NEWS_CATALOG_ACCOUNT_MAX && !needsTemporaryCatalogSlot) {
      throw new ConflictError('news_catalog_full', 'Tickerworld already has the maximum shared news sources');
    }
    if (resolvedProfile) {
      source = await this.upsertSource(resolvedProfile, now, needsTemporaryCatalogSlot);
      this.assertLeadership(leadershipGeneration);
    }
    if (!source) throw new ServiceUnavailableError('news_provider_unavailable', 'X could not verify that account right now');
    const gapCursor = source.sinceId;
    if (replacementCandidate) {
      let replaced = false;
      try {
        replaced = await this.replaceInactiveAssociation(
          replacementCandidate,
          source.id,
          scope,
          now,
          leadershipGeneration,
        );
      } catch (error) {
        if (!sourceAlreadyKnown) await this.deleteUnusedSource(source.id, leadershipGeneration);
        throw error;
      }
      if (!replaced) {
        if (!sourceAlreadyKnown) await this.deleteUnusedSource(source.id, leadershipGeneration);
        throw new ConflictError('news_world_catalog_full', 'This world already has the maximum shared news sources');
      }
    } else {
      await this.associateSource(source.id, scope, false, now);
    }
    this.assertLeadership(leadershipGeneration);
    let rulesReady = false;
    await this.reconcileRules(now).then(() => { rulesReady = true; }, () => undefined);
    try {
      await this.backfillSource(source, now, gapCursor);
      if (rulesReady && source.rulePendingAt !== null) {
        this.scheduleGapBackfill(source.id, source.rulePendingSinceId, source.rulePendingAt);
      }
    } catch (error) {
      if (error instanceof XProviderError && error.status === 404) {
        await this.markSourceUnavailable(source, now);
        this.markRulesDirty();
        await this.reconcileRules(now).catch(() => undefined);
      } else {
        // A 403 is commonly app/token/plan-wide. Without a source-specific X
        // error code it must not disable this account or remove its rule.
        throw new ServiceUnavailableError('news_provider_unavailable', 'X could not load that account right now');
      }
    }
    return this.accounts(scope, now).find((account) => account.id === source!.id)!;
  }

  /** Deterministic maintenance hook retained for tests and operational gap repair. */
  refresh(
    now = this.now(),
    cursorSnapshot?: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    if (this.maintenanceInFlight) return this.maintenanceInFlight;
    this.maintenanceInFlight = (async () => {
      if (!this.initialized) await this.initialize(now);
      if (!this.configured() || !await this.ensureLeadership(now)) return;
      await this.maintainCatalog(now);
      await this.reconcileRules(now);
      if (now < this.restRetryAt) return;
      await this.backfillSources([...this.sources.values()], now, cursorSnapshot);
      if (this.rulesAppliedGeneration < this.rulesGeneration) await this.reconcileRules(now);
      this.prune(now);
      await this.healthWriteQueue;
    })().finally(() => { this.maintenanceInFlight = null; });
    return this.maintenanceInFlight;
  }

  private async backfillSources(
    sources: readonly SourceRecord[],
    now: number,
    cursorSnapshot?: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    const leadershipGeneration = this.leadershipGeneration;
    for (const source of sources) {
      this.assertLeadership(leadershipGeneration);
      try {
        const requestedCursor = cursorSnapshot?.has(source.id)
          ? cursorSnapshot.get(source.id)
          : source.rulePendingAt !== null ? source.rulePendingSinceId : undefined;
        await this.backfillSource(source, now, requestedCursor);
      } catch (error) {
        if (error instanceof XProviderError && error.status === 404) {
          await this.markSourceUnavailable(source, now);
          this.markRulesDirty();
          continue;
        }
        throw error;
      }
    }
  }

  private async repairSharedGaps(now: number): Promise<void> {
    if (now < this.restRetryAt || !this.leaderActive) return;
    const sources = [...this.sources.values()].filter((source) => (
      source.status === 'active'
      && (!this.hydratedSourceIds.has(source.id) || source.rulePendingAt !== null)
    ));
    if (sources.length === 0) return;
    await this.backfillSources(sources, now);
    await this.healthWriteQueue;
  }

  async pruneInactiveWorlds(now = this.now()): Promise<number> {
    if (!this.providerEnabled() || !await this.ensureLeadership(now)) return 0;
    const leadershipGeneration = this.leadershipGeneration;
    return this.enqueueCatalogMutation(() => this.pruneInactiveWorldsLocked(now, leadershipGeneration));
  }

  private async pruneInactiveWorldsLocked(now: number, leadershipGeneration: number): Promise<number> {
    this.assertLeadership(leadershipGeneration);
    if (!this.db) return 0;
    const cutoff = now - CUSTOM_WORLD_TTL_MS;
    const stale = await this.withLeadershipFence(leadershipGeneration, async (database) => (
      database!.deleteFrom('x_news_worlds')
        .where('is_default', '=', 0)
        .where('last_requested_at', '<', cutoff)
        .returning(['source_id', 'scope'])
        .execute()
    ));
    this.assertLeadership(leadershipGeneration);
    for (const row of stale) {
      if (!(ASSET_SYMBOLS as readonly string[]).includes(row.scope)) continue;
      this.forgetAssociation(row.source_id, row.scope as AssetSymbol);
    }
    for (const [sourceId, scopes] of this.scopesBySource) {
      if (scopes.size === 0) {
        this.scopesBySource.delete(sourceId);
        await this.deleteUnusedSource(sourceId, leadershipGeneration);
        this.assertLeadership(leadershipGeneration);
      }
    }
    for (const sourceId of [...this.sources.keys()]) {
      if (!this.scopesBySource.has(sourceId)) {
        await this.deleteUnusedSource(sourceId, leadershipGeneration);
        this.assertLeadership(leadershipGeneration);
      }
    }
    return stale.length;
  }

  /**
   * Swaps a stale world slot without ever exposing a committed state where the
   * old association is gone and the requested one is absent. The source row is
   * staged first (it is harmless and swept if this fails), while the world-row
   * delete/insert is one fenced database transaction.
   */
  private async replaceInactiveAssociation(
    candidate: { sourceId: string; requestedAt: number },
    replacementSourceId: string,
    scope: AssetSymbol,
    now: number,
    leadershipGeneration: number,
  ): Promise<boolean> {
    this.assertLeadership(leadershipGeneration);
    const replacement = this.sources.get(replacementSourceId);
    if (!replacement || candidate.sourceId === replacementSourceId) return false;
    if (this.db) {
      const replaced = await this.withLeadershipFence(leadershipGeneration, async (database) => {
        const deleted = await database!.deleteFrom('x_news_worlds')
          .where('source_id', '=', candidate.sourceId)
          .where('scope', '=', scope)
          .where('is_default', '=', 0)
          .where('last_requested_at', '=', candidate.requestedAt)
          .where('last_requested_at', '<', now - ACTIVE_ASSOCIATION_MS)
          .returning('source_id')
          .executeTakeFirst();
        if (!deleted) return false;
        await database!.insertInto('x_news_worlds').values({
          source_id: replacementSourceId,
          scope,
          is_default: 0,
          last_requested_at: now,
          created_at: now,
        }).execute();
        return true;
      });
      this.assertLeadership(leadershipGeneration);
      if (!replaced) return false;
    }
    const hadRuleDemand = (this.scopesBySource.get(replacementSourceId)?.size ?? 0) > 0;
    this.forgetAssociation(candidate.sourceId, scope);
    this.rememberAssociation(replacementSourceId, scope, false, now);
    if (!hadRuleDemand) await this.markSourceRulePending(replacement, now);
    this.markRulesDirty();
    await this.deleteUnusedSource(candidate.sourceId, leadershipGeneration);
    this.assertLeadership(leadershipGeneration);
    return true;
  }

  private findInactiveAssociationCandidate(
    scope: AssetSymbol,
    now: number,
    mustReleaseCatalogSlot: boolean,
  ): { sourceId: string; requestedAt: number } | null {
    const cutoff = now - ACTIVE_ASSOCIATION_MS;
    const candidates = [...this.scopesBySource.entries()]
      .filter(([sourceId, scopes]) => scopes.has(scope)
        && !(this.defaultScopesBySource.get(sourceId)?.has(scope) ?? false)
        && (!mustReleaseCatalogSlot || scopes.size === 1))
      .map(([sourceId]) => ({
        sourceId,
        requestedAt: this.requestedAtBySourceScope.get(`${sourceId}:${scope}`) ?? 0,
      }))
      .filter((candidate) => candidate.requestedAt < cutoff)
      .sort((left, right) => left.requestedAt - right.requestedAt
        || left.sourceId.localeCompare(right.sourceId));
    return candidates[0] ?? null;
  }

  private forgetAssociation(sourceId: string, scope: AssetSymbol): void {
    const scopes = this.scopesBySource.get(sourceId);
    scopes?.delete(scope);
    if (scopes?.size === 0) this.scopesBySource.delete(sourceId);
    const defaults = this.defaultScopesBySource.get(sourceId);
    defaults?.delete(scope);
    if (defaults?.size === 0) this.defaultScopesBySource.delete(sourceId);
    this.requestedAtBySourceScope.delete(`${sourceId}:${scope}`);
    for (const [itemKey, item] of this.items) {
      if (item.scope !== scope || this.itemSourceIds.get(itemKey) !== sourceId) continue;
      this.items.delete(itemKey);
      this.itemSourceIds.delete(itemKey);
    }
  }

  dispose(): Promise<void> {
    if (this.disposalInFlight) return this.disposalInFlight;
    this.disposalInFlight = this.disposeLocked();
    return this.disposalInFlight;
  }

  private async disposeLocked(): Promise<void> {
    this.disposed = true;
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const timer of this.gapBackfillTimers.values()) clearTimeout(timer);
    this.gapBackfillTimers.clear();
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    if (this.sharedCacheTimer) clearInterval(this.sharedCacheTimer);
    this.leaseTimer = null;
    this.catalogTimer = null;
    this.sharedCacheTimer = null;
    this.loseLeadership();
    const pending: Promise<unknown>[] = [];
    for (const operation of [
      this.initializationInFlight,
      this.leadershipInFlight,
      this.connectionInFlight,
      this.maintenanceInFlight,
      this.catalogMaintenanceInFlight,
      this.rulesInFlight,
      this.catalogMutation,
      this.healthWriteQueue,
    ]) {
      if (operation) pending.push(operation);
    }
    pending.push(...this.gapBackfillOperations);
    pending.push(...this.sourceMutationQueues.values());
    await Promise.allSettled(pending);
    await this.healthWriteQueue.catch(() => undefined);
    await this.lease.release(this.ownerId).catch(() => undefined);
    this.streamController = null;
    this.streamConnected = false;
    this.sharedProviderConnected = false;
    this.items.clear();
    this.itemSourceIds.clear();
    this.profileCache.clear();
    this.profileRetryAt.clear();
    this.hydratedSourceIds.clear();
  }

  private configured(): boolean {
    return Boolean(this.providerEnabled()
      && (this.sources.size > 0 || this.handles.length > 0));
  }

  private providerEnabled(): boolean {
    return Boolean(this.token && this.switches.enabled('newsIngest'));
  }

  private accountStatus(source: SourceRecord, now: number): NewsAccountStatus {
    if (!this.token || !this.switches.enabled('newsIngest') || source.status === 'unavailable') {
      return 'unavailable';
    }
    if (source.ruleReadyAt === null) return 'reconnecting';
    return this.available(now) ? 'live' : 'reconnecting';
  }

  /** Deterministic hook used by standby instances and operational smoke tests. */
  async refreshSharedCache(now = this.now()): Promise<void> {
    await this.enqueueCatalogMutation(() => this.reloadSharedStateLocked(now));
  }

  private async reloadSharedStateLocked(now: number): Promise<void> {
    if (!this.db) return;
    const state = await this.db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom('x_news_posts').where('expires_at', '<=', now).execute();
      const [sourceRows, worldRows, postRows, health] = await Promise.all([
        transaction.selectFrom('x_news_sources').selectAll().execute(),
        transaction.selectFrom('x_news_worlds').selectAll().execute(),
        transaction.selectFrom('x_news_posts').selectAll()
          .where('expires_at', '>', now)
          .orderBy('created_at', 'desc')
          .execute(),
        transaction.selectFrom('provider_health').selectAll()
          .where('provider', '=', HEALTH_PROVIDER)
          .executeTakeFirst(),
      ]);
      return { sourceRows, worldRows, postRows, health };
    });

    this.sources.clear();
    this.sourceIdByHandle.clear();
    this.scopesBySource.clear();
    this.defaultScopesBySource.clear();
    this.requestedAtBySourceScope.clear();
    this.ruleReadySourceIds.clear();
    this.items.clear();
    this.itemSourceIds.clear();
    this.hydratedSourceIds.clear();

    let sourceSuccessAt = 0;
    let sourceCheckedAt = 0;
    for (const row of state.sourceRows) {
      const source = sourceFromRow(row);
      this.rememberSource(source);
      sourceSuccessAt = Math.max(sourceSuccessAt, row.last_success_at ?? 0);
      sourceCheckedAt = Math.max(sourceCheckedAt, row.last_poll_at ?? row.last_success_at ?? 0);
      if (source.ruleReadyAt !== null && source.rulePendingAt === null) {
        this.ruleReadySourceIds.add(source.id);
      }
      if (state.health) this.hydratedSourceIds.add(source.id);
    }
    for (const row of state.worldRows) {
      if (!(ASSET_SYMBOLS as readonly string[]).includes(row.scope)
        || !this.sources.has(row.source_id)) continue;
      this.rememberAssociation(
        row.source_id,
        row.scope as AssetSymbol,
        row.is_default === 1,
        row.last_requested_at,
      );
    }
    for (const row of state.postRows) {
      const scopes = this.scopesBySource.get(row.source_id);
      if (!scopes) continue;
      for (const scope of scopes) {
        const item: CachedNewsItem = {
          id: row.id,
          authorId: row.source_id,
          source: 'x',
          text: row.text,
          links: parseStoredLinks(row.links_json),
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          authorName: row.author_name,
          authorHandle: row.author_handle,
          authorAvatarUrl: row.author_avatar_url,
          permalink: row.permalink,
          demo: false,
          scope,
        };
        const itemKey = `${item.id}:${scope}`;
        this.items.set(itemKey, item);
        this.itemSourceIds.set(itemKey, row.source_id);
      }
    }
    this.lastSuccessAt = Math.max(state.health?.last_success_at ?? 0, sourceSuccessAt);
    this.checkedAt = Math.max(state.health?.checked_at ?? 0, sourceCheckedAt) || now;
    this.sharedProviderConnected = state.health?.connected === 1;
  }

  private async ensureDefaultSources(now: number): Promise<void> {
    if (!this.token || !this.switches.enabled('newsIngest')) return;
    const leadershipGeneration = this.leadershipGeneration;
    for (const configuredHandle of this.handles) {
      this.assertLeadership(leadershipGeneration);
      const handle = configuredHandle.replace(/^@/, '').trim();
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue;
      try {
        const existingId = this.sourceIdByHandle.get(handle.toLowerCase());
        let source = existingId ? this.sources.get(existingId) ?? null : null;
        if (!source || source.status !== 'active'
          || !source.lastProfileAt || now - source.lastProfileAt >= PROFILE_TTL_MS) {
          const profile = await this.resolveUser(handle, now);
          this.assertLeadership(leadershipGeneration);
          await this.reconcileCanonicalHandleOwner(profile, now, leadershipGeneration);
          source = await this.upsertSource(profile, now);
          this.assertLeadership(leadershipGeneration);
        }
        for (const scope of ASSET_SYMBOLS) {
          const alreadyAssociated = this.scopesBySource.get(source.id)?.has(scope) ?? false;
          const sourceCount = [...this.scopesBySource.values()].filter((scopes) => scopes.has(scope)).length;
          if (!alreadyAssociated && sourceCount >= NEWS_WORLD_ACCOUNT_MAX) {
            const candidate = this.findInactiveAssociationCandidate(scope, now, false);
            if (!candidate || !await this.replaceInactiveAssociation(
              candidate,
              source.id,
              scope,
              now,
              leadershipGeneration,
            )) continue;
          }
          await this.associateSource(source.id, scope, true, now);
          this.assertLeadership(leadershipGeneration);
        }
      } catch (error) {
        if (!this.leaderActive || this.leadershipGeneration !== leadershipGeneration) throw error;
        // A stale/suspended default must not prevent the process from booting or other sources loading.
      }
    }
  }

  private async reconcileDefaultFlags(leadershipGeneration: number): Promise<void> {
    this.assertLeadership(leadershipGeneration);
    const configuredHandles = new Set(this.handles.map((handle) => handle.replace(/^@/, '').trim().toLowerCase()));
    for (const [sourceId, scopes] of this.defaultScopesBySource) {
      const source = this.sources.get(sourceId);
      if (source && configuredHandles.has(source.username.toLowerCase())) continue;
      for (const scope of [...scopes]) {
        if (this.db) {
          await this.withLeadershipFence(leadershipGeneration, async (database) => {
            await database!.updateTable('x_news_worlds').set({ is_default: 0 })
              .where('source_id', '=', sourceId)
              .where('scope', '=', scope)
              .execute();
          });
          this.assertLeadership(leadershipGeneration);
        }
        scopes.delete(scope);
      }
      if (scopes.size === 0) this.defaultScopesBySource.delete(sourceId);
    }
  }

  private rememberSource(source: SourceRecord): SourceRecord {
    const previous = this.sources.get(source.id);
    if (previous && previous.username.toLowerCase() !== source.username.toLowerCase()) {
      this.sourceIdByHandle.delete(previous.username.toLowerCase());
    }
    const remembered = previous ? Object.assign(previous, source) : source;
    this.sources.set(remembered.id, remembered);
    this.sourceIdByHandle.set(remembered.username.toLowerCase(), remembered.id);
    return remembered;
  }

  private rememberAssociation(sourceId: string, scope: AssetSymbol, isDefault: boolean, requestedAt: number): void {
    const scopes = this.scopesBySource.get(sourceId) ?? new Set<AssetSymbol>();
    scopes.add(scope);
    this.scopesBySource.set(sourceId, scopes);
    if (isDefault) {
      const defaults = this.defaultScopesBySource.get(sourceId) ?? new Set<AssetSymbol>();
      defaults.add(scope);
      this.defaultScopesBySource.set(sourceId, defaults);
    }
    this.requestedAtBySourceScope.set(`${sourceId}:${scope}`, requestedAt);
  }

  private upsertSource(
    user: XUser,
    now: number,
    allowTemporaryCatalogOverflow = false,
  ): Promise<SourceRecord> {
    return this.enqueueSourceMutation(user.id, (leadershipGeneration) => (
      this.upsertSourceLocked(user, now, leadershipGeneration, allowTemporaryCatalogOverflow)
    ));
  }

  private async upsertSourceLocked(
    user: XUser,
    now: number,
    leadershipGeneration: number,
    allowTemporaryCatalogOverflow = false,
  ): Promise<SourceRecord> {
    const previous = this.sources.get(user.id);
    const ruleChanged = !previous
      || previous.username.toLowerCase() !== user.username.toLowerCase()
      || previous.status !== 'active';
    if (!previous && this.sources.size >= NEWS_CATALOG_ACCOUNT_MAX && !allowTemporaryCatalogOverflow) {
      throw new ConflictError('news_catalog_full', 'Tickerworld already has the maximum shared news sources');
    }
    const source: SourceRecord = {
      ...user,
      status: 'active',
      sinceId: previous?.sinceId ?? null,
      rulePendingAt: ruleChanged ? previous?.rulePendingAt ?? now : previous?.rulePendingAt ?? null,
      rulePendingSinceId: ruleChanged
        ? previous?.rulePendingSinceId ?? previous?.sinceId ?? null
        : previous?.rulePendingSinceId ?? null,
      ruleReadyAt: ruleChanged ? null : previous?.ruleReadyAt ?? null,
      lastProfileAt: now,
      lastPollAt: previous?.lastPollAt ?? null,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastPostAt: previous?.lastPostAt ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (this.db) {
      await this.withLeadershipFence(leadershipGeneration, async (database) => {
        await database!.insertInto('x_news_sources').values({
          id: source.id,
          handle: source.username,
          handle_normalized: source.username.toLowerCase(),
          name: source.name,
          avatar_url: source.profileImageUrl,
          status: source.status,
          since_id: source.sinceId,
          rule_pending_at: source.rulePendingAt,
          rule_pending_since_id: source.rulePendingSinceId,
          rule_ready_at: source.ruleReadyAt,
          last_profile_at: source.lastProfileAt,
          last_poll_at: source.lastPollAt,
          last_success_at: source.lastSuccessAt,
          last_post_at: source.lastPostAt,
          created_at: source.createdAt,
          updated_at: source.updatedAt,
        }).onConflict((conflict) => conflict.column('id').doUpdateSet({
          handle: source.username,
          handle_normalized: source.username.toLowerCase(),
          name: source.name,
          avatar_url: source.profileImageUrl,
          status: source.status,
          rule_pending_at: source.rulePendingAt,
          rule_pending_since_id: source.rulePendingSinceId,
          rule_ready_at: source.ruleReadyAt,
          last_profile_at: now,
          updated_at: now,
        })).execute();
      });
    }
    const remembered = this.rememberSource(source);
    if (ruleChanged) this.markRulesDirty();
    this.profileCache.set(remembered.username.toLowerCase(), { value: user, expiresAt: now + PROFILE_TTL_MS });
    return remembered;
  }

  private async associateSource(
    sourceId: string,
    scope: AssetSymbol,
    isDefault: boolean,
    now: number,
  ): Promise<void> {
    const hadRuleDemand = (this.scopesBySource.get(sourceId)?.size ?? 0) > 0;
    const wasAssociated = this.scopesBySource.get(sourceId)?.has(scope) ?? false;
    const existingDefault = this.defaultScopesBySource.get(sourceId)?.has(scope) ?? false;
    const defaultValue = isDefault || existingDefault ? 1 : 0;
    if (this.db) {
      const leadershipGeneration = this.leadershipGeneration;
      await this.withLeadershipFence(leadershipGeneration, async (database) => {
        await database!.insertInto('x_news_worlds').values({
          source_id: sourceId,
          scope,
          is_default: defaultValue,
          last_requested_at: now,
          created_at: now,
        }).onConflict((conflict) => conflict.columns(['source_id', 'scope']).doUpdateSet({
          is_default: defaultValue,
          last_requested_at: now,
        })).execute();
      });
    }
    this.rememberAssociation(sourceId, scope, defaultValue === 1, now);
    const source = this.sources.get(sourceId);
    if (!hadRuleDemand && source) await this.markSourceRulePending(source, now);
    if (!wasAssociated) this.markRulesDirty();
    if (!wasAssociated) {
      if (source) {
        for (const [itemKey, item] of [...this.items]) {
          if (this.itemSourceIds.get(itemKey) !== source.id || item.scope === scope) continue;
          const nextKey = `${item.id}:${scope}`;
          this.items.set(nextKey, { ...item, scope });
          this.itemSourceIds.set(nextKey, source.id);
        }
      }
    }
  }

  private markSourceRulePending(source: SourceRecord, now: number): Promise<void> {
    return this.enqueueSourceMutation(source.id, async (leadershipGeneration) => {
      const current = this.sources.get(source.id) ?? source;
      const progress = this.sourceProgressState(current, {
        rulePendingAt: current.rulePendingAt ?? now,
        rulePendingSinceId: current.rulePendingAt === null
          ? current.sinceId
          : current.rulePendingSinceId,
        ruleReadyAt: null,
        updatedAt: Math.max(current.updatedAt, now),
      });
      await this.persistSourceProgressValuesLocked(current, progress, leadershipGeneration);
      Object.assign(current, progress);
      this.ruleReadySourceIds.delete(current.id);
    });
  }

  private markSourceRuleReady(source: SourceRecord, now: number): Promise<SourceRecord> {
    return this.enqueueSourceMutation(source.id, async (leadershipGeneration) => {
      const current = this.sources.get(source.id) ?? source;
      if (current.ruleReadyAt === null) {
        const progress = this.sourceProgressState(current, {
          ruleReadyAt: now,
          updatedAt: Math.max(current.updatedAt, now),
        });
        await this.persistSourceProgressValuesLocked(current, progress, leadershipGeneration);
        Object.assign(current, progress);
      }
      this.ruleReadySourceIds.add(current.id);
      return current;
    });
  }

  private markSourceUnavailable(source: SourceRecord, now: number): Promise<void> {
    return this.enqueueSourceMutation(source.id, async (leadershipGeneration) => {
      const current = this.sources.get(source.id) ?? source;
      const progress = this.sourceProgressState(current, {
        status: 'unavailable',
        ruleReadyAt: null,
        updatedAt: Math.max(current.updatedAt, now),
      });
      await this.persistSourceProgressValuesLocked(current, progress, leadershipGeneration);
      Object.assign(current, progress);
      this.ruleReadySourceIds.delete(current.id);
    });
  }

  private clearSourceRulePending(source: SourceRecord, pendingAt: number): Promise<boolean> {
    return this.enqueueSourceMutation(source.id, async (leadershipGeneration) => {
      const current = this.sources.get(source.id) ?? source;
      if (current.rulePendingAt !== pendingAt) return false;
      const progress = this.sourceProgressState(current, {
        rulePendingAt: null,
        rulePendingSinceId: null,
        updatedAt: Math.max(current.updatedAt, this.now()),
      });
      await this.persistSourceProgressValuesLocked(current, progress, leadershipGeneration);
      Object.assign(current, progress);
      return true;
    });
  }

  private async deleteUnusedSource(sourceId: string, leadershipGeneration: number): Promise<void> {
    this.assertLeadership(leadershipGeneration);
    if (this.scopesBySource.get(sourceId)?.size) return;
    const source = this.sources.get(sourceId);
    if (this.db) {
      const result = await this.withLeadershipFence(leadershipGeneration, async (database) => {
        const deleted = await database!.deleteFrom('x_news_sources')
          .where('id', '=', sourceId)
          .where(sql<boolean>`not exists (
            select 1 from x_news_worlds where x_news_worlds.source_id = x_news_sources.id
          )`)
          .returning('id')
          .executeTakeFirst();
        const rows = deleted ? [] : await database!.selectFrom('x_news_worlds').selectAll()
          .where('source_id', '=', sourceId)
          .execute();
        return { deleted, rows };
      });
      if (!result.deleted && result.rows.length > 0) {
        for (const row of result.rows) {
          if ((ASSET_SYMBOLS as readonly string[]).includes(row.scope)) {
            this.rememberAssociation(
              sourceId,
              row.scope as AssetSymbol,
              row.is_default === 1,
              row.last_requested_at,
            );
          }
        }
        return;
      }
    }
    if (source) this.sourceIdByHandle.delete(source.username.toLowerCase());
    this.sources.delete(sourceId);
    this.defaultScopesBySource.delete(sourceId);
    this.hydratedSourceIds.delete(sourceId);
    this.ruleReadySourceIds.delete(sourceId);
    this.markRulesDirty();
  }

  /**
   * Moves a stale canonical handle mapping out of the way before inserting its
   * current owner. The displaced account is refreshed by immutable id, so its
   * existing world associations follow that account to its new handle.
   */
  private async reconcileCanonicalHandleOwner(
    user: XUser,
    now: number,
    leadershipGeneration: number,
    visited = new Set<string>(),
  ): Promise<void> {
    this.assertLeadership(leadershipGeneration);
    const normalized = user.username.toLowerCase();
    const displacedId = this.sourceIdByHandle.get(normalized);
    if (!displacedId || displacedId === user.id) return;
    if (visited.has(displacedId)) throw new XProviderError(409, 0);
    visited.add(displacedId);
    let displaced: XUser;
    try {
      displaced = await this.resolveUserById(displacedId, now);
    } catch (error) {
      if (error instanceof XProviderError && error.status === 404) {
        await this.removeCanonicalSource(displacedId);
        this.assertLeadership(leadershipGeneration);
        return;
      }
      if (error instanceof XSourceUnavailableError) {
        await this.reconcileCanonicalHandleOwner(error.user, now, leadershipGeneration, visited);
        const unavailable = await this.upsertSource(error.user, now);
        await this.markSourceUnavailable(unavailable, now);
        this.markRulesDirty();
        this.assertLeadership(leadershipGeneration);
        return;
      }
      throw error;
    }
    this.assertLeadership(leadershipGeneration);
    if (displaced.username.toLowerCase() === normalized) {
      // Username and id lookups disagree during X's rename propagation. Keep
      // the durable catalog untouched and retry after normal provider backoff.
      throw new XProviderError(409, 0);
    }
    await this.reconcileCanonicalHandleOwner(displaced, now, leadershipGeneration, visited);
    await this.upsertSource(displaced, now);
    this.assertLeadership(leadershipGeneration);
    const remainingOwner = this.sourceIdByHandle.get(normalized);
    if (remainingOwner && remainingOwner !== user.id) throw new XProviderError(409, 0);
  }

  private removeCanonicalSource(sourceId: string): Promise<void> {
    return this.enqueueSourceMutation(sourceId, async (leadershipGeneration) => {
      const source = this.sources.get(sourceId);
      if (!source) return;
      if (this.db) {
        await this.withLeadershipFence(leadershipGeneration, async (database) => {
          await database!.deleteFrom('x_news_sources').where('id', '=', sourceId).execute();
        });
      }
      for (const scope of [...(this.scopesBySource.get(sourceId) ?? [])]) {
        this.forgetAssociation(sourceId, scope);
      }
      if (this.sourceIdByHandle.get(source.username.toLowerCase()) === sourceId) {
        this.sourceIdByHandle.delete(source.username.toLowerCase());
      }
      this.sources.delete(sourceId);
      this.defaultScopesBySource.delete(sourceId);
      this.hydratedSourceIds.delete(sourceId);
      this.ruleReadySourceIds.delete(sourceId);
      this.markRulesDirty();
    });
  }

  private async resolveUserById(userId: string, now: number): Promise<XUser> {
    const retryKey = `id:${userId}`;
    const retryAt = this.profileRetryAt.get(retryKey) ?? 0;
    if (retryAt > now) throw new XProviderError(503, retryAt);
    const url = new URL(`/2/users/${encodeURIComponent(userId)}`, X_ORIGIN);
    url.searchParams.set('user.fields', 'name,username,profile_image_url,protected,withheld');
    try {
      const payload = await this.getJson(url, now);
      const rawUser = isRecord(payload) ? payload.data : null;
      const identity = parseXUserIdentity(rawUser);
      if (!identity || identity.id !== userId) throw new XProviderError(502, 0);
      if (isRecord(rawUser) && (rawUser.protected === true || rawUser.withheld !== undefined)) {
        this.profileRetryAt.delete(retryKey);
        throw new XSourceUnavailableError(identity);
      }
      this.profileRetryAt.delete(retryKey);
      this.profileCache.set(identity.username.toLowerCase(), {
        value: identity,
        expiresAt: now + PROFILE_TTL_MS,
      });
      return identity;
    } catch (error) {
      if (error instanceof XSourceUnavailableError) throw error;
      const providerRetryAt = error instanceof XProviderError ? error.retryAt : 0;
      this.profileRetryAt.set(retryKey, Math.max(now + 60_000, providerRetryAt));
      throw error;
    }
  }

  /**
   * Quiet accounts do not produce stream expansions that reveal a rename.
   * Refresh each canonical id at most daily so stale handles are eventually
   * released without multiplying paid requests on every five-minute sweep.
   */
  private async refreshStaleSourceProfiles(
    now: number,
    leadershipGeneration: number,
  ): Promise<void> {
    const stale = [...this.sources.values()]
      .filter((source) => source.status === 'active'
        && (source.lastProfileAt === null || now - source.lastProfileAt >= PROFILE_TTL_MS))
      .sort((left, right) => (left.lastProfileAt ?? 0) - (right.lastProfileAt ?? 0)
        || left.id.localeCompare(right.id))
      // Never let a profile sweep delay the live stream by more than one
      // bounded provider request; subsequent five-minute passes drain the rest.
      .slice(0, PROFILE_REFRESH_BATCH_MAX);
    for (const source of stale) {
      this.assertLeadership(leadershipGeneration);
      try {
        const profile = await this.resolveUserById(source.id, now);
        await this.reconcileCanonicalHandleOwner(profile, now, leadershipGeneration);
        await this.upsertSource(profile, now);
      } catch (error) {
        if (error instanceof XSourceUnavailableError) {
          await this.reconcileCanonicalHandleOwner(error.user, now, leadershipGeneration);
          const unavailable = await this.upsertSource(error.user, now);
          await this.markSourceUnavailable(unavailable, now);
          this.markRulesDirty();
          continue;
        }
        if (error instanceof XProviderError && error.status === 404) {
          await this.markSourceUnavailable(source, now);
          this.markRulesDirty();
          continue;
        }
        // Provider/token/plan failures are shared failures. Preserve every
        // source and let the next bounded maintenance pass retry.
        return;
      }
    }
  }

  private async resolveUser(handle: string, now: number, force = false): Promise<XUser> {
    const normalizedHandle = handle.toLowerCase();
    const cached = this.profileCache.get(normalizedHandle);
    if (!force && cached && cached.expiresAt > now) return cached.value;
    if ((this.profileRetryAt.get(normalizedHandle) ?? 0) > now) {
      throw new XProviderError(503, this.profileRetryAt.get(normalizedHandle)!);
    }
    const url = new URL(`/2/users/by/username/${encodeURIComponent(handle)}`, X_ORIGIN);
    url.searchParams.set('user.fields', 'name,username,profile_image_url,protected,withheld');
    let payload: unknown;
    try {
      payload = await this.getJson(url, now);
    } catch (error) {
      this.profileRetryAt.set(normalizedHandle, now + 60_000);
      throw error;
    }
    const user = isRecord(payload) ? parseXUser(payload.data) : null;
    if (!user) throw new Error('invalid_or_nonpublic_x_user');
    this.profileRetryAt.delete(normalizedHandle);
    this.profileCache.set(handle.toLowerCase(), { value: user, expiresAt: now + PROFILE_TTL_MS });
    this.profileCache.set(user.username.toLowerCase(), { value: user, expiresAt: now + PROFILE_TTL_MS });
    return user;
  }

  private reconcileRules(now = this.now()): Promise<void> {
    if (this.rulesInFlight) return this.rulesInFlight;
    this.rulesInFlight = (async () => {
      do {
        const generation = this.rulesGeneration;
        await this.performRuleReconciliation(now);
        this.rulesAppliedGeneration = generation;
      } while (this.rulesAppliedGeneration < this.rulesGeneration);
    })().finally(() => { this.rulesInFlight = null; });
    return this.rulesInFlight;
  }

  private markRulesDirty(): void {
    this.rulesGeneration += 1;
  }

  private startIndependentMaintenance(): void {
    if (!this.leaseTimer) {
      this.leaseTimer = setInterval(() => {
        void this.ensureLeadership(this.now()).catch(() => {
          this.loseLeadership();
        });
      }, LEASE_RENEW_MS);
      this.leaseTimer.unref?.();
    }
    if (!this.catalogTimer) {
      this.catalogTimer = setInterval(() => void this.runCatalogMaintenance(), CATALOG_MAINTENANCE_MS);
      this.catalogTimer.unref?.();
    }
    if (!this.sharedCacheTimer) {
      this.sharedCacheTimer = setInterval(() => {
        if (!this.leaderActive) void this.refreshSharedCache().catch(() => undefined);
      }, SHARED_CACHE_REFRESH_MS);
      this.sharedCacheTimer.unref?.();
    }
  }

  private ensureLeadership(now: number): Promise<boolean> {
    if (this.leadershipInFlight) return this.leadershipInFlight;
    this.leadershipInFlight = (async () => {
      if (this.disposed || !this.providerEnabled()) {
        this.loseLeadership();
        return false;
      }
      const wasLeader = this.leaderActive;
      const acquired = await this.lease.acquire(this.ownerId, now, LEASE_TTL_MS);
      if (this.disposed || !this.providerEnabled()) {
        if (acquired) await this.lease.release(this.ownerId).catch(() => undefined);
        this.loseLeadership();
        return false;
      }
      if (!acquired) {
        this.loseLeadership();
        return false;
      }
      this.leaderActive = true;
      if (!wasLeader) {
        this.leadershipGeneration += 1;
        try {
          await this.enqueueCatalogMutation(() => this.reloadSharedStateLocked(now));
          // Promotion reload may queue behind disk work. Renew/re-check after it
          // completes so a process paused past the TTL cannot return as leader
          // after a successor has already acquired the durable lease.
          if (!await this.lease.acquire(this.ownerId, this.now(), LEASE_TTL_MS)) {
            throw new XProviderError(503, 0);
          }
          this.assertLeadership(this.leadershipGeneration);
          this.sharedProviderConnected = false;
          this.markRulesDirty();
        } catch (error) {
          this.loseLeadership();
          await this.lease.release(this.ownerId).catch(() => undefined);
          throw error;
        }
      }
      return true;
    })().finally(() => { this.leadershipInFlight = null; });
    return this.leadershipInFlight;
  }

  private loseLeadership(): void {
    if (this.leaderActive) this.queueHealthPersist(this.now(), false, true);
    if (this.leaderActive) this.leadershipGeneration += 1;
    this.leaderActive = false;
    this.sharedProviderConnected = false;
    this.streamController?.abort();
    for (const controller of this.providerControllers) controller.abort();
  }

  private assertLeadership(generation: number): void {
    if (this.disposed || !this.providerEnabled() || !this.leaderActive
      || generation !== this.leadershipGeneration) {
      throw new XProviderError(503, 0);
    }
  }

  private async withLeadershipFence<T>(
    generation: number,
    operation: (
      database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema> | null,
    ) => Promise<T>,
  ): Promise<T> {
    this.assertLeadership(generation);
    const guarded = async (
      database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema> | null,
    ) => {
      this.assertLeadership(generation);
      const result = await operation(database);
      this.assertLeadership(generation);
      return result;
    };
    const result = this.lease.runFenced
      ? await this.lease.runFenced(this.ownerId, this.now(), guarded)
      : this.db
        ? await this.db.transaction().execute((transaction) => guarded(transaction))
        : await guarded(null);
    this.assertLeadership(generation);
    return result;
  }

  private enqueueSourceMutation<T>(
    sourceId: string,
    operation: (leadershipGeneration: number) => Promise<T>,
  ): Promise<T> {
    const leadershipGeneration = this.leadershipGeneration;
    const previous = this.sourceMutationQueues.get(sourceId) ?? Promise.resolve();
    const result = previous.then(() => {
      this.assertLeadership(leadershipGeneration);
      return operation(leadershipGeneration);
    });
    const tail = result.then(() => undefined, () => undefined);
    this.sourceMutationQueues.set(sourceId, tail);
    void tail.finally(() => {
      if (this.sourceMutationQueues.get(sourceId) === tail) this.sourceMutationQueues.delete(sourceId);
    });
    return result;
  }

  private runCatalogMaintenance(): Promise<void> {
    if (this.catalogMaintenanceInFlight) return this.catalogMaintenanceInFlight;
    this.catalogMaintenanceInFlight = (async () => {
      const now = this.now();
      if (!await this.ensureLeadership(now)) return;
      await this.maintainCatalog(now);
      await this.reconcileRules(now);
      await this.repairSharedGaps(now);
    })().catch(() => undefined).finally(() => { this.catalogMaintenanceInFlight = null; });
    return this.catalogMaintenanceInFlight;
  }

  private maintainCatalog(now: number): Promise<void> {
    const leadershipGeneration = this.leadershipGeneration;
    return this.enqueueCatalogMutation(async () => {
      this.assertLeadership(leadershipGeneration);
      await this.reconcileDefaultFlags(leadershipGeneration);
      this.assertLeadership(leadershipGeneration);
      await this.pruneInactiveWorldsLocked(now, leadershipGeneration);
      this.assertLeadership(leadershipGeneration);
      await this.ensureDefaultSources(now);
      this.assertLeadership(leadershipGeneration);
      await this.refreshStaleSourceProfiles(now, leadershipGeneration);
      this.assertLeadership(leadershipGeneration);
      if (this.db) {
        await this.withLeadershipFence(leadershipGeneration, async (database) => {
          await database!.deleteFrom('x_news_posts').where('expires_at', '<=', now).execute();
        });
        this.assertLeadership(leadershipGeneration);
      }
    });
  }

  private async performRuleReconciliation(now: number): Promise<void> {
    if (!this.providerEnabled() || !this.leaderActive) return;
    const leadershipGeneration = this.leadershipGeneration;
    const getUrl = new URL(RULES_PATH, X_ORIGIN);
    let existing = parseXRules(await this.getJson(getUrl, now));
    if (!existing) throw new XProviderError(502, 0);
    this.assertLeadership(leadershipGeneration);
    const activeSources = [...this.sources.values()].filter((source) => (
      source.status === 'active' && (this.scopesBySource.get(source.id)?.size ?? 0) > 0
    ));
    const plan = planXRuleReconciliation(existing, activeSources);
    const exactTags = new Set(existing.map((rule) => `${rule.tag ?? ''}\n${rule.value}`));
    for (const source of activeSources) {
      if (!exactTags.has(`${xRuleTag(source.id)}\n${xRuleValue(source.username)}`)) {
        await this.markSourceRulePending(source, now);
        this.assertLeadership(leadershipGeneration);
      }
    }
    let mutationError: unknown = null;
    try {
      if (plan.deleteIds.length > 0) {
        await this.reserveProviderRequest(now, true);
        await this.withLeadershipFence(leadershipGeneration, async () => {
          await this.getJson(new URL(RULES_PATH, X_ORIGIN), now, {
            method: 'POST',
            body: JSON.stringify({ delete: { ids: plan.deleteIds } }),
            headers: { 'Content-Type': 'application/json' },
          }, true);
        });
        this.assertLeadership(leadershipGeneration);
      }
      if (plan.add.length > 0) {
        await this.reserveProviderRequest(now, true);
        await this.withLeadershipFence(leadershipGeneration, async () => {
          await this.getJson(new URL(RULES_PATH, X_ORIGIN), now, {
            method: 'POST',
            body: JSON.stringify({ add: plan.add }),
            headers: { 'Content-Type': 'application/json' },
          }, true);
        });
        this.assertLeadership(leadershipGeneration);
      }
    } catch (error) {
      mutationError = error;
    }
    if (plan.deleteIds.length > 0 || plan.add.length > 0) {
      // A mutation response is only an acknowledgement. Read the provider's rule set
      // back and grant readiness independently to each source whose exact rule exists.
      existing = parseXRules(await this.getJson(getUrl, now));
      if (!existing) throw new XProviderError(502, 0);
      this.assertLeadership(leadershipGeneration);
    }
    const verifiedExactTags = new Set(existing.map((rule) => `${rule.tag ?? ''}\n${rule.value}`));
    this.ruleReadySourceIds.clear();
    for (const source of activeSources) {
      const exact = verifiedExactTags.has(`${xRuleTag(source.id)}\n${xRuleValue(source.username)}`);
      if (!exact) {
        if (source.rulePendingAt === null || source.ruleReadyAt !== null) {
          await this.markSourceRulePending(source, now);
          this.assertLeadership(leadershipGeneration);
        }
        continue;
      }
      const readySource = await this.markSourceRuleReady(source, now);
      this.assertLeadership(leadershipGeneration);
      if (readySource.rulePendingAt !== null) {
        this.scheduleGapBackfill(
          readySource.id,
          readySource.rulePendingSinceId,
          readySource.rulePendingAt,
        );
      }
    }
    if (mutationError) throw mutationError;
    const verification = planXRuleReconciliation(existing, activeSources);
    if (verification.deleteIds.length > 0 || verification.add.length > 0) {
      throw new XProviderError(502, 0);
    }
  }

  private scheduleConnection(delayMs: number): void {
    if (this.disposed || !this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const operation = this.runConnection();
      this.connectionInFlight = operation;
      void operation.finally(() => {
        if (this.connectionInFlight === operation) this.connectionInFlight = null;
      }).catch(() => undefined);
    }, Math.max(0, delayMs));
    this.reconnectTimer.unref?.();
  }

  private async runConnection(): Promise<void> {
    if (this.disposed || !this.started) return;
    const now = this.now();
    if (!this.initialized) await this.initialize(now);
    if (!this.providerEnabled()) {
      this.scheduleConnection(Math.max(5_000, this.intervalMs));
      return;
    }
    let streamHandshakeSucceeded = false;
    try {
      if (!await this.ensureLeadership(now)) {
        this.scheduleConnection(LEASE_RENEW_MS);
        return;
      }
    } catch {
      this.leaderActive = false;
      this.scheduleConnection(LEASE_RENEW_MS);
      return;
    }
    if (now < this.connectionNextAttemptAt) {
      this.scheduleConnection(this.connectionNextAttemptAt - now);
      return;
    }
    try {
      await this.maintainCatalog(now);
      if (this.sources.size === 0) {
        await this.reconcileRules(now).catch(() => undefined);
        this.scheduleConnection(Math.max(5 * 60_000, this.intervalMs));
        return;
      }
      const cursorSnapshot = new Map([...this.sources].map(([sourceId, source]) => [
        sourceId,
        source.rulePendingAt !== null ? source.rulePendingSinceId : source.sinceId,
      ]));
      // A brand-new account has no provider rule yet. Opening the filtered
      // stream first can yield an immediate provider rejection and strand the
      // account until the reconnect backoff expires, so activate/verify cold
      // rules before the first stream handshake. Previously verified sources
      // retain stream-first recovery during a REST-only outage.
      const needsColdRuleActivation = [...this.sources.values()].some((source) => (
        source.status === 'active'
        && (this.scopesBySource.get(source.id)?.size ?? 0) > 0
        && !this.ruleReadySourceIds.has(source.id)
      ));
      if (needsColdRuleActivation) await this.reconcileRules(now);
      const opened = await this.openStream();
      streamHandshakeSucceeded = true;
      const streamOutcome = this.consumeStream(opened).then(
        () => ({ error: null as unknown }),
        (error: unknown) => ({ error }),
      );
      // The stream remains authoritative even when REST/rules are degraded. Repair runs
      // concurrently and retries independently without tearing down a healthy connection.
      await this.reconcileRules(now).catch(() => undefined);
      await this.backfillSources([...this.sources.values()], now, cursorSnapshot)
        .catch(() => undefined);
      if (this.rulesAppliedGeneration < this.rulesGeneration) {
        await this.reconcileRules(now).catch(() => undefined);
      }
      await this.healthWriteQueue;
      const outcome = await streamOutcome;
      if (outcome.error) throw outcome.error;
      throw new XProviderError(0, 0);
    } catch (error) {
      if (this.disposed) return;
      const status = error instanceof XProviderError ? error.status : 0;
      if (!streamHandshakeSucceeded && (status === 400 || status === 409 || status === 422)) {
        // X rejects a filtered-stream handshake when its durable app rules were
        // removed out-of-band. Invalidate only in-memory readiness; the next
        // bounded reconnect verifies/repairs rules before trying the stream.
        for (const source of this.sources.values()) {
          if (source.status === 'active' && (this.scopesBySource.get(source.id)?.size ?? 0) > 0) {
            this.ruleReadySourceIds.delete(source.id);
          }
        }
        this.markRulesDirty();
      }
      this.streamConnected = false;
      this.failureCount += 1;
      const retryAt = error instanceof XProviderError ? error.retryAt : 0;
      const delay = xReconnectDelayMs(this.failureCount, status, this.now(), retryAt);
      this.connectionNextAttemptAt = Math.max(
        this.connectionNextAttemptAt,
        this.now() + delay,
        retryAt,
      );
      this.scheduleConnection(this.connectionNextAttemptAt - this.now());
    }
  }

  private async openStream(): Promise<OpenXStream> {
    const leadershipGeneration = this.leadershipGeneration;
    this.assertLeadership(leadershipGeneration);
    const url = new URL(STREAM_PATH, X_ORIGIN);
    url.searchParams.set('tweet.fields', 'author_id,created_at,note_tweet,entities');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'id,name,username,profile_image_url,protected,withheld');
    const controller = new AbortController();
    this.streamController = controller;
    try {
      const response = await this.providerFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }, this.now(), X_STREAM_HANDSHAKE_TIMEOUT_MS, false);
      this.assertLeadership(leadershipGeneration);
      if (!response.body) throw new XProviderError(0, 0);
      this.streamConnected = true;
      this.sharedProviderConnected = true;
      this.failureCount = 0;
      this.noteSuccess(this.now(), 'stream');
      return { response, controller, leadershipGeneration };
    } catch (error) {
      controller.abort();
      if (this.streamController === controller) this.streamController = null;
      throw error;
    }
  }

  private async consumeStream({ response, controller, leadershipGeneration }: OpenXStream): Promise<void> {
    if (!response.body) throw new XProviderError(0, 0);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    const armHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => controller.abort(), STREAM_HEARTBEAT_DEADLINE_MS);
      heartbeatTimer.unref?.();
    };
    armHeartbeat();
    try {
      while (!this.disposed && this.switches.enabled('newsIngest')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        armHeartbeat();
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            let payload: unknown;
            try { payload = JSON.parse(line) as unknown; } catch { payload = null; }
            if (payload !== null) {
              await this.acceptStreamPayload(payload, this.now(), leadershipGeneration);
            }
          } else {
            this.noteSuccess(this.now(), 'stream');
          }
          newline = buffer.indexOf('\n');
        }
      }
    } finally {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      try { await reader.cancel(); } catch { /* the provider already closed */ }
      reader.releaseLock();
      controller.abort();
      if (this.streamController === controller) this.streamController = null;
      this.streamConnected = false;
      this.sharedProviderConnected = false;
      this.queueHealthPersist(this.now(), false, true);
    }
  }

  private async acceptStreamPayload(
    payload: unknown,
    now: number,
    leadershipGeneration: number,
  ): Promise<void> {
    this.assertLeadership(leadershipGeneration);
    const parsed = parseXStreamEvent(payload);
    if (!parsed) return;
    let source = this.sources.get(parsed.authorId);
    if (!source) return;
    if (parsed.author) source = await this.upsertSource(parsed.author, now);
    this.assertLeadership(leadershipGeneration);
    await this.acceptPost(source, parsed, now);
    this.assertLeadership(leadershipGeneration);
    this.noteSuccess(now, 'stream');
  }

  private async backfillSource(
    source: SourceRecord,
    now: number,
    requestSinceOverride?: string | null,
  ): Promise<void> {
    if (!this.token || source.status !== 'active') return;
    const leadershipGeneration = this.leadershipGeneration;
    this.assertLeadership(leadershipGeneration);
    let paginationToken: string | null = null;
    let page = 0;
    // Durable cursors prevent gaps, but the ten-minute cards themselves are intentionally
    // ephemeral. The first read after a process boot therefore rehydrates the visible window.
    const requestSinceId = this.hydratedSourceIds.has(source.id)
      ? requestSinceOverride === undefined ? source.sinceId : requestSinceOverride
      : null;
    let newestSinceId = source.sinceId;
    let newestPostAt = source.lastPostAt;
    do {
      const url = new URL(`/2/users/${encodeURIComponent(source.id)}/tweets`, X_ORIGIN);
      url.searchParams.set('max_results', '100');
      // Match the filtered-stream rule: include authored replies while keeping
      // reposts out of the world feed.
      url.searchParams.set('exclude', 'retweets');
      url.searchParams.set('tweet.fields', 'created_at,author_id,note_tweet,entities');
      if (requestSinceId) url.searchParams.set('since_id', requestSinceId);
      else url.searchParams.set('start_time', new Date(now - NEWS_TTL_MS - 60_000).toISOString());
      if (paginationToken) url.searchParams.set('pagination_token', paginationToken);
      const payload = await this.getJson(url, now);
      this.assertLeadership(leadershipGeneration);
      if (!isRecord(payload)
        || (payload.data !== undefined && !Array.isArray(payload.data))
        || (isRecord(payload.meta)
          && payload.meta.next_token !== undefined
          && typeof payload.meta.next_token !== 'string')) {
        throw new XProviderError(502, 0);
      }
      if (Array.isArray(payload.data)) {
        for (const value of payload.data) {
          if (!isRecord(value)) continue;
          const content = postContent(value);
          const createdAt = typeof value.created_at === 'string' ? Date.parse(value.created_at) : Number.NaN;
          if (!content || typeof value.id !== 'string' || !/^\d+$/.test(value.id)
            || !Number.isFinite(createdAt) || createdAt > now + 60_000) continue;
          newestSinceId = newerSnowflake(newestSinceId, value.id);
          newestPostAt = Math.max(newestPostAt ?? 0, createdAt);
          await this.acceptPost(source, {
            id: value.id,
            authorId: source.id,
            text: content.text,
            entities: content.entities,
            createdAt,
            author: null,
          }, now, false);
        }
      }
      paginationToken = isRecord(payload.meta) && typeof payload.meta.next_token === 'string'
        ? payload.meta.next_token
        : null;
      page += 1;
    } while (paginationToken && page < 5);
    await this.commitBackfillProgress(source, newestSinceId, newestPostAt, now);
    this.assertLeadership(leadershipGeneration);
    this.hydratedSourceIds.add(source.id);
    this.noteSuccess(now, 'rest');
  }

  /**
   * X rule changes are not guaranteed to become active at the instant the rules API returns.
   * Re-reading from the pre-rule cursor closes that short activation gap without duplicating posts.
   */
  private scheduleGapBackfill(
    sourceId: string,
    cursor: string | null,
    pendingAt: number,
    attempt = 0,
  ): void {
    if (this.disposed || this.gapBackfillTimers.has(sourceId)) return;
    const timer = setTimeout(() => {
      this.gapBackfillTimers.delete(sourceId);
      const operation = (async () => {
        const source = this.sources.get(sourceId);
        if (this.disposed || !this.leaderActive || !source
          || source.status !== 'active' || !this.ruleReadySourceIds.has(sourceId)) return;
        if (source.rulePendingAt !== pendingAt) {
          if (source.rulePendingAt !== null) {
            this.scheduleGapBackfill(
              sourceId,
              source.rulePendingSinceId,
              source.rulePendingAt,
            );
          }
          return;
        }
        const leadershipGeneration = this.leadershipGeneration;
        try {
          this.assertLeadership(leadershipGeneration);
          await this.backfillSource(source, this.now(), cursor);
          this.assertLeadership(leadershipGeneration);
          const cleared = await this.clearSourceRulePending(source, pendingAt);
          this.assertLeadership(leadershipGeneration);
          if (!cleared) {
            const current = this.sources.get(sourceId);
            if (current?.rulePendingAt !== null && current?.rulePendingAt !== undefined) {
              this.scheduleGapBackfill(
                current.id,
                current.rulePendingSinceId,
                current.rulePendingAt,
              );
            }
          }
        } catch (error) {
          if (error instanceof XProviderError && error.status === 404) {
            await this.markSourceUnavailable(source, this.now());
            this.markRulesDirty();
            await this.reconcileRules(this.now()).catch(() => undefined);
            return;
          }
          if (attempt < 2) this.scheduleGapBackfill(sourceId, cursor, pendingAt, attempt + 1);
        }
      })();
      this.gapBackfillOperations.add(operation);
      void operation.finally(() => this.gapBackfillOperations.delete(operation)).catch(() => undefined);
    }, DYNAMIC_GAP_BACKFILL_MS * (attempt + 1));
    timer.unref?.();
    this.gapBackfillTimers.set(sourceId, timer);
  }

  private async acceptPost(
    source: SourceRecord,
    post: ParsedXStreamPost,
    now: number,
    persist = true,
  ): Promise<void> {
    if (post.createdAt > now + 60_000) return;
    const visible = post.createdAt + NEWS_TTL_MS > now;
    const links = visible ? normalizeEntityLinks(post.entities) : [];
    const permalink = `https://x.com/${encodeURIComponent(source.username)}/status/${encodeURIComponent(post.id)}`;
    if (persist) {
      await this.commitStreamPost(
        source,
        visible ? { post, links, permalink, now } : null,
        post,
        now,
      );
    } else if (visible) {
      await this.persistSharedPost(source, post, links, permalink, now);
    }
    if (visible) {
      for (const scope of this.scopesBySource.get(source.id) ?? []) {
        const item: CachedNewsItem = {
          id: post.id,
          authorId: source.id,
          source: 'x',
          text: post.text,
          links,
          createdAt: post.createdAt,
          expiresAt: post.createdAt + NEWS_TTL_MS,
          authorName: source.name,
          authorHandle: source.username,
          authorAvatarUrl: source.profileImageUrl,
          permalink,
          demo: false,
          scope,
        };
        const itemKey = `${item.id}:${scope}`;
        this.items.set(itemKey, item);
        this.itemSourceIds.set(itemKey, source.id);
      }
    }
  }

  private commitStreamPost(
    source: SourceRecord,
    visible: {
      post: ParsedXStreamPost;
      links: readonly CachedNewsLink[];
      permalink: string;
      now: number;
    } | null,
    post: ParsedXStreamPost,
    now: number,
  ): Promise<void> {
    return this.enqueueSourceMutation(source.id, (leadershipGeneration) => (
      this.commitStreamPostLocked(source, visible, post, now, leadershipGeneration)
    ));
  }

  private async commitStreamPostLocked(
    source: SourceRecord,
    visible: {
      post: ParsedXStreamPost;
      links: readonly CachedNewsLink[];
      permalink: string;
      now: number;
    } | null,
    post: ParsedXStreamPost,
    now: number,
    leadershipGeneration: number,
  ): Promise<void> {
    const current = this.sources.get(source.id) ?? source;
    const progress = this.sourceProgressState(current, {
      sinceId: newerSnowflake(current.sinceId, post.id),
      lastSuccessAt: Math.max(current.lastSuccessAt ?? 0, now),
      lastPostAt: Math.max(current.lastPostAt ?? 0, post.createdAt),
      updatedAt: Math.max(current.updatedAt, now),
    });
    if (this.db) {
      await this.withLeadershipFence(leadershipGeneration, async (database) => {
        if (visible) {
          await database!.insertInto('x_news_posts').values({
            id: visible.post.id,
            source_id: current.id,
            text: visible.post.text,
            links_json: JSON.stringify(visible.links),
            created_at: visible.post.createdAt,
            expires_at: visible.post.createdAt + NEWS_TTL_MS,
            author_name: current.name,
            author_handle: current.username,
            author_avatar_url: current.profileImageUrl,
            permalink: visible.permalink,
            updated_at: visible.now,
          }).onConflict((conflict) => conflict.column('id').doUpdateSet({
            text: visible.post.text,
            links_json: JSON.stringify(visible.links),
            author_name: current.name,
            author_handle: current.username,
            author_avatar_url: current.profileImageUrl,
            permalink: visible.permalink,
            updated_at: visible.now,
          })).execute();
        }
        await this.writeSourceProgress(database!, current.id, progress);
      });
    }
    Object.assign(current, progress);
  }

  private commitBackfillProgress(
    source: SourceRecord,
    newestSinceId: string | null,
    newestPostAt: number | null,
    now: number,
  ): Promise<void> {
    return this.enqueueSourceMutation(source.id, async (leadershipGeneration) => {
      const current = this.sources.get(source.id) ?? source;
      const progress = this.sourceProgressState(current, {
        sinceId: newestSinceId ? newerSnowflake(current.sinceId, newestSinceId) : current.sinceId,
        lastPollAt: Math.max(current.lastPollAt ?? 0, now),
        lastSuccessAt: Math.max(current.lastSuccessAt ?? 0, now),
        lastPostAt: Math.max(current.lastPostAt ?? 0, newestPostAt ?? 0) || null,
        updatedAt: Math.max(current.updatedAt, now),
      });
      if (this.db) {
        await this.withLeadershipFence(leadershipGeneration, async (database) => {
          await this.writeSourceProgress(database!, current.id, progress);
        });
      }
      Object.assign(current, progress);
    });
  }

  private sourceProgressState(
    source: SourceRecord,
    patch: Partial<SourceProgressState> = {},
  ): SourceProgressState {
    return {
      status: source.status,
      sinceId: source.sinceId,
      rulePendingAt: source.rulePendingAt,
      rulePendingSinceId: source.rulePendingSinceId,
      ruleReadyAt: source.ruleReadyAt,
      lastPollAt: source.lastPollAt,
      lastSuccessAt: source.lastSuccessAt,
      lastPostAt: source.lastPostAt,
      updatedAt: source.updatedAt,
      ...patch,
    };
  }

  private async persistSharedPost(
    source: SourceRecord,
    post: ParsedXStreamPost,
    links: readonly CachedNewsLink[],
    permalink: string,
    now: number,
  ): Promise<void> {
    if (!this.db || !this.leaderActive) return;
    const leadershipGeneration = this.leadershipGeneration;
    await this.withLeadershipFence(leadershipGeneration, async (database) => {
        await database!.insertInto('x_news_posts').values({
          id: post.id,
          source_id: source.id,
          text: post.text,
          links_json: JSON.stringify(links),
          created_at: post.createdAt,
          expires_at: post.createdAt + NEWS_TTL_MS,
          author_name: source.name,
          author_handle: source.username,
          author_avatar_url: source.profileImageUrl,
          permalink,
          updated_at: now,
        }).onConflict((conflict) => conflict.column('id').doUpdateSet({
          text: post.text,
          links_json: JSON.stringify(links),
          author_name: source.name,
          author_handle: source.username,
          author_avatar_url: source.profileImageUrl,
          permalink,
          updated_at: now,
        })).execute();
    });
  }

  private async persistSourceProgressValuesLocked(
    source: SourceRecord,
    progress: SourceProgressState,
    leadershipGeneration: number,
  ): Promise<void> {
    if (!this.db) return;
    await this.withLeadershipFence(leadershipGeneration, async (database) => {
      await this.writeSourceProgress(database!, source.id, progress);
    });
  }

  private async writeSourceProgress(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    sourceId: string,
    progress: SourceProgressState,
  ): Promise<void> {
    await database.updateTable('x_news_sources').set({
      since_id: progress.sinceId,
      status: progress.status,
      rule_pending_at: progress.rulePendingAt,
      rule_pending_since_id: progress.rulePendingSinceId,
      rule_ready_at: progress.ruleReadyAt,
      last_poll_at: progress.lastPollAt,
      last_success_at: progress.lastSuccessAt,
      last_post_at: progress.lastPostAt,
      updated_at: progress.updatedAt,
    }).where('id', '=', sourceId).execute();
  }

  private noteSuccess(now: number, channel: 'stream' | 'rest'): void {
    this.checkedAt = Math.max(this.checkedAt, now);
    this.lastSuccessAt = Math.max(this.lastSuccessAt, now);
    if (channel === 'stream') {
      this.failureCount = 0;
      this.connectionNextAttemptAt = 0;
    }
    this.queueHealthPersist(now, this.streamConnected);
  }

  private queueHealthPersist(now: number, connected: boolean, force = false): void {
    if (!this.db || (!this.leaderActive && !force)) return;
    if (!force && connected === this.lastHealthConnected
      && now - this.lastHealthWriteAt < SHARED_CACHE_REFRESH_MS) return;
    this.lastHealthWriteAt = now;
    this.lastHealthConnected = connected;
    const lastSuccessAt = this.lastSuccessAt;
    const checkedAt = this.checkedAt || now;
    this.healthWriteQueue = this.healthWriteQueue.then(async () => {
      if (!this.db) return;
      const write = async (database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>) => {
        await database.insertInto('provider_health').values({
          provider: HEALTH_PROVIDER,
          owner_id: this.ownerId,
          connected: connected ? 1 : 0,
          last_success_at: lastSuccessAt,
          checked_at: checkedAt,
          updated_at: now,
        }).onConflict((conflict) => conflict.column('provider').doUpdateSet({
          owner_id: this.ownerId,
          connected: connected ? 1 : 0,
          last_success_at: sql<number>`case
            when provider_health.last_success_at > ${lastSuccessAt}
            then provider_health.last_success_at else ${lastSuccessAt} end`,
          checked_at: sql<number>`case
            when provider_health.checked_at > ${checkedAt}
            then provider_health.checked_at else ${checkedAt} end`,
          updated_at: now,
        }).where('provider_health.updated_at', '<=', now)).execute();
      };
      if (this.lease.runFenced) {
        await this.lease.runFenced(this.ownerId, now, write);
        return;
      }
      const lease = await this.db.selectFrom('provider_leases')
        .select(['owner_id', 'expires_at'])
        .where('provider', '=', 'x-news-stream')
        .executeTakeFirst();
      if (lease?.owner_id === this.ownerId && lease.expires_at > now) await write(this.db);
    }).catch(() => undefined);
  }

  private ensureRequestDay(now: number): void {
    const day = utcDay(now);
    if (this.requestDay === day) return;
    this.requestDay = day;
    this.requestCount = 0;
  }

  private async reserveProviderRequest(now: number, respectRestCooldown: boolean): Promise<void> {
    if (!this.token) throw new XProviderError(503, 0);
    if (respectRestCooldown && now < this.restRetryAt) {
      throw new XProviderError(429, this.restRetryAt);
    }
    this.ensureRequestDay(now);
    if (this.requestCount >= this.dailyRequestLimit
      || !await this.budget.consume(this.requestDay, this.dailyRequestLimit, now)) {
      this.requestCount = this.dailyRequestLimit;
      this.restRetryAt = Math.max(this.restRetryAt, nextUtcDay(now));
      throw new XProviderError(429, this.restRetryAt);
    }
    this.requestCount += 1;
  }

  private async providerFetch(
    url: URL,
    init: RequestInit,
    now: number,
    timeoutMs = REQUEST_TIMEOUT_MS,
    respectRestCooldown = true,
    requestReserved = false,
  ): Promise<Response> {
    if (!requestReserved) await this.reserveProviderRequest(now, respectRestCooldown);
    const timeout = new AbortController();
    this.providerControllers.add(timeout);
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout.signal])
      : timeout.signal;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...init.headers,
        },
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (respectRestCooldown) {
        this.restRetryAt = Math.max(this.restRetryAt, now + 60_000);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.providerControllers.delete(timeout);
    }
    if (!response.ok) {
      const resetSeconds = Number(response.headers.get('x-rate-limit-reset'));
      const retrySeconds = Number(response.headers.get('retry-after'));
      const resetAt = Number.isFinite(resetSeconds) ? resetSeconds * 1_000 : 0;
      const retryAt = Number.isFinite(retrySeconds) ? now + retrySeconds * 1_000 : 0;
      const providerRetryAt = Math.max(resetAt, retryAt, response.status === 429 ? now + 60_000 : 0);
      if (respectRestCooldown && response.status === 429) {
        this.restRetryAt = Math.max(this.restRetryAt, providerRetryAt);
      }
      if (respectRestCooldown && (response.status === 401 || response.status === 403)) {
        // Authentication/plan failures apply to the whole app, not one public
        // account. A shared circuit prevents rotating catalog ids from burning
        // the daily paid-request budget while credentials are unhealthy.
        this.restRetryAt = Math.max(this.restRetryAt, now + 5 * 60_000);
      } else if (respectRestCooldown && response.status >= 500) {
        this.restRetryAt = Math.max(this.restRetryAt, now + 60_000);
      }
      throw new XProviderError(response.status, providerRetryAt);
    }
    return response;
  }

  private async getJson(
    url: URL,
    now: number,
    init: RequestInit = {},
    requestReserved = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.providerControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    try {
      const response = await this.providerFetch(
        url,
        { ...init, signal },
        now,
        REQUEST_TIMEOUT_MS,
        true,
        requestReserved,
      );
      return await response.json();
    } finally {
      clearTimeout(timer);
      this.providerControllers.delete(controller);
    }
  }

  private prune(now: number): void {
    for (const [id, item] of this.items) {
      if (item.expiresAt > now) continue;
      this.items.delete(id);
      this.itemSourceIds.delete(id);
    }
  }
}
