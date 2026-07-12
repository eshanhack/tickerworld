import { ASSET_SYMBOLS, type AssetSymbol, type NewsScope } from '@tickerworld/shared';
import type { RuntimeSwitchboard } from './runtimeSwitches.js';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/types.js';

const X_ORIGIN = 'https://api.x.com';
const NEWS_TTL_MS = 10 * 60_000;

interface XUser {
  id: string;
  name: string;
  username: string;
  profileImageUrl: string | null;
}

export interface CachedNewsItem {
  id: string;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inferScope(text: string): NewsScope {
  const tags = [...text.matchAll(/\$([A-Za-z]{2,8})\b/g)].map((match) => match[1]?.toUpperCase());
  const asset = tags.find((tag): tag is AssetSymbol => (
    typeof tag === 'string' && (ASSET_SYMBOLS as readonly string[]).includes(tag)
  ));
  return asset ?? 'global';
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

function postContent(value: Record<string, unknown>): { text: string; entities: unknown } | null {
  const note = isRecord(value.note_tweet) ? value.note_tweet : null;
  if (note && typeof note.text === 'string' && note.text.trim()) {
    return { text: note.text, entities: note.entities ?? note.entity_set ?? value.entities };
  }
  return typeof value.text === 'string' && value.text.trim()
    ? { text: value.text, entities: value.entities }
    : null;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface NewsRequestBudget {
  consume(dayUtc: string, limit: number, now: number): Promise<boolean>;
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

/** Persists paid-provider usage so a process restart cannot reset the daily kill. */
export class DatabaseNewsRequestBudget implements NewsRequestBudget {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async consume(dayUtc: string, limit: number, now: number): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction.selectFrom('provider_budgets')
        .select('request_count')
        .where('provider', '=', 'x')
        .where('day_utc', '=', dayUtc)
        .executeTakeFirst();
      if ((current?.request_count ?? 0) >= limit) return false;
      if (current) {
        await transaction.updateTable('provider_budgets')
          .set({ request_count: current.request_count + 1, updated_at: now })
          .where('provider', '=', 'x')
          .where('day_utc', '=', dayUtc)
          .execute();
      } else {
        await transaction.insertInto('provider_budgets').values({
          provider: 'x', day_utc: dayUtc, request_count: 1, updated_at: now,
        }).execute();
      }
      return true;
    });
  }
}

/** Centralized, one-process X ingestion with a bounded daily spend and retry gate. */
export class NewsIngestService {
  private readonly items = new Map<string, CachedNewsItem>();
  private readonly users = new Map<string, { value: XUser; expiresAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private nextAttemptAt = 0;
  private checkedAt = 0;
  private lastSuccessAt = 0;
  private failureCount = 0;
  private requestDay = '';
  private requestCount = 0;

  constructor(
    private readonly token: string | null,
    private readonly handles: readonly string[],
    private readonly dailyRequestLimit: number,
    private readonly switches: RuntimeSwitchboard,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 60_000,
    private readonly budget: NewsRequestBudget = new MemoryNewsRequestBudget(),
  ) {}

  start(): void {
    if (this.timer || !this.token || this.handles.length === 0) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), Math.min(this.intervalMs, 30_000));
    this.timer.unref?.();
  }

  available(now = this.now()): boolean {
    return Boolean(this.token && this.handles.length > 0 && this.switches.enabled('newsIngest')
      && this.lastSuccessAt > 0 && now - this.lastSuccessAt <= 5 * 60_000);
  }

  snapshot(scope?: AssetSymbol, now = this.now()): NewsCacheSnapshot {
    this.prune(now);
    const configured = Boolean(this.token && this.handles.length > 0 && this.switches.enabled('newsIngest'));
    const mode: NewsCacheSnapshot['mode'] = !configured
      ? 'unconfigured'
      : this.available(now) ? 'live' : 'unavailable';
    const items = [...this.items.values()]
      .filter((item) => item.scope === 'global' || item.scope === scope)
      .sort((left, right) => right.createdAt - left.createdAt);
    return { mode, items, checkedAt: this.checkedAt || now };
  }

  refresh(now = this.now()): Promise<void> {
    if (!this.token || this.handles.length === 0
      || !this.switches.enabled('newsIngest') || now < this.nextAttemptAt) {
      return Promise.resolve();
    }
    if (this.inFlight) return this.inFlight;
    if (this.requestDay !== utcDay(now)) {
      this.requestDay = utcDay(now);
      this.requestCount = 0;
    }
    if (this.requestCount >= this.dailyRequestLimit) {
      this.nextAttemptAt = Date.parse(`${this.requestDay}T00:00:00.000Z`) + 24 * 60 * 60_000;
      return Promise.resolve();
    }
    this.inFlight = this.performRefresh(now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.items.clear();
    this.users.clear();
  }

  private async performRefresh(now: number): Promise<void> {
    try {
      const collected: CachedNewsItem[] = [];
      for (const handle of this.handles) {
        const user = await this.loadUser(handle, now);
        const start = new Date(now - NEWS_TTL_MS - 60_000).toISOString();
        const url = new URL(`/2/users/${encodeURIComponent(user.id)}/tweets`, X_ORIGIN);
        url.searchParams.set('max_results', '100');
        url.searchParams.set('exclude', 'replies,retweets');
        url.searchParams.set('start_time', start);
        url.searchParams.set('tweet.fields', 'created_at,author_id,note_tweet,entities');
        const payload = await this.getJson(url, now);
        if (!isRecord(payload) || !Array.isArray(payload.data)) continue;
        for (const value of payload.data) {
          if (!isRecord(value) || typeof value.id !== 'string') continue;
          const content = postContent(value);
          const text = content?.text ?? '';
          const createdAt = typeof value.created_at === 'string' ? Date.parse(value.created_at) : Number.NaN;
          if (!text || !Number.isFinite(createdAt) || createdAt > now + 60_000) continue;
          const expiresAt = createdAt + NEWS_TTL_MS;
          if (expiresAt <= now) continue;
          collected.push({
            id: value.id,
            source: 'x',
            text,
            links: normalizeEntityLinks(content?.entities),
            createdAt,
            expiresAt,
            authorName: user.name,
            authorHandle: user.username,
            authorAvatarUrl: user.profileImageUrl,
            permalink: `https://x.com/${encodeURIComponent(user.username)}/status/${encodeURIComponent(value.id)}`,
            demo: false,
            scope: inferScope(text),
          });
        }
      }
      for (const item of collected) this.items.set(item.id, item);
      this.prune(now);
      this.checkedAt = now;
      this.lastSuccessAt = now;
      this.failureCount = 0;
      this.nextAttemptAt = now + this.intervalMs;
    } catch {
      this.checkedAt = now;
      this.failureCount += 1;
      const maximum = Math.min(30 * 60_000, 1_000 * 2 ** Math.min(11, this.failureCount));
      this.nextAttemptAt = Math.max(this.nextAttemptAt, now + Math.floor(maximum * (0.5 + Math.random() * 0.5)));
    }
  }

  private async loadUser(handle: string, now: number): Promise<XUser> {
    const cached = this.users.get(handle.toLowerCase());
    if (cached && cached.expiresAt > now) return cached.value;
    const url = new URL(`/2/users/by/username/${encodeURIComponent(handle)}`, X_ORIGIN);
    url.searchParams.set('user.fields', 'name,username,profile_image_url');
    const payload = await this.getJson(url, now);
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    if (!data || typeof data.id !== 'string' || typeof data.name !== 'string'
      || typeof data.username !== 'string') throw new Error('invalid_x_user');
    const user: XUser = {
      id: data.id,
      name: data.name,
      username: data.username,
      profileImageUrl: typeof data.profile_image_url === 'string' ? data.profile_image_url : null,
    };
    this.users.set(handle.toLowerCase(), { value: user, expiresAt: now + 24 * 60 * 60_000 });
    return user;
  }

  private async getJson(url: URL, now: number): Promise<unknown> {
    if (!this.token) throw new Error('x_unconfigured');
    if (this.requestCount >= this.dailyRequestLimit) throw new Error('x_daily_limit');
    if (!await this.budget.consume(this.requestDay, this.dailyRequestLimit, now)) {
      this.requestCount = this.dailyRequestLimit;
      throw new Error('x_daily_limit');
    }
    this.requestCount += 1;
    const response = await this.fetcher(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    const resetSeconds = Number(response.headers.get('x-rate-limit-reset'));
    const retrySeconds = Number(response.headers.get('retry-after'));
    if (response.status === 429) {
      const resetAt = Number.isFinite(resetSeconds) ? resetSeconds * 1_000 : 0;
      const retryAt = Number.isFinite(retrySeconds) ? now + retrySeconds * 1_000 : 0;
      this.nextAttemptAt = Math.max(this.nextAttemptAt, resetAt, retryAt, now + 60_000);
    }
    if (!response.ok) throw new Error(`x_${response.status}`);
    return response.json();
  }

  private prune(now: number): void {
    for (const [id, item] of this.items) if (item.expiresAt <= now) this.items.delete(id);
  }
}
