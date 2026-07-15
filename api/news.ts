import {
  dedupeNewsItems,
  parseNewsApiResponse,
  pruneExpiredNewsItems,
} from '../src/news/newsMath.js';
import {
  NEWS_ITEM_TTL_MS,
  type NewsApiMode,
  type NewsApiResponse,
  type NewsItem,
  type NewsLink,
} from '../src/news/types.js';

declare const process: {
  readonly env: Record<string, string | undefined>;
};

const X_API_ORIGIN = 'https://api.x.com';
const X_WEB_ORIGIN = 'https://x.com';
const TRACKED_HANDLE = 'DeItaone';
const X_REQUEST_TIMEOUT_MS = 8_000;
const USER_CACHE_TTL_MS = 24 * 60 * 60_000;
// Browsers poll every five seconds. This remains a shared cache in front of the
// single X ingestor, while keeping post-to-world latency comfortably below one poll.
const CDN_CACHE_CONTROL = 'public, max-age=2, stale-while-revalidate=2';

interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
}

interface CachedUser {
  user: XUser;
  expiresAt: number;
}

type ServerFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let cachedTrackedUser: CachedUser | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseXUser(value: unknown): XUser | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || typeof value.name !== 'string'
    || value.name.length === 0
    || typeof value.username !== 'string'
    || value.username.length === 0
    || (value.profile_image_url !== undefined && typeof value.profile_image_url !== 'string')
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    username: value.username,
    profile_image_url: value.profile_image_url,
  };
}

interface XPostContent {
  text: string;
  entities: Record<string, unknown> | undefined;
}

function postContent(post: Record<string, unknown>): XPostContent | undefined {
  const noteTweet = isRecord(post.note_tweet) ? post.note_tweet : undefined;
  const fullText = noteTweet?.text;
  if (noteTweet && typeof fullText === 'string' && fullText.trim() !== '') {
    // `entities` is the current OpenAPI shape. `entity_set` keeps older cached payloads safe.
    const noteEntities = isRecord(noteTweet.entities)
      ? noteTweet.entities
      : isRecord(noteTweet.entity_set) ? noteTweet.entity_set : undefined;
    return {
      text: fullText,
      entities: noteEntities ?? (isRecord(post.entities) ? post.entities : undefined),
    };
  }
  return typeof post.text === 'string' && post.text.trim() !== ''
    ? { text: post.text, entities: isRecord(post.entities) ? post.entities : undefined }
    : undefined;
}

function entityRange(value: Record<string, unknown>): { start: number; end: number } | undefined {
  if (
    !Number.isInteger(value.start)
    || !Number.isInteger(value.end)
    || (value.start as number) < 0
    || (value.end as number) <= (value.start as number)
  ) return undefined;
  return { start: value.start as number, end: value.end as number };
}

function isOriginalXShortUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 't.co'
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function searchLink(query: string, source: 'hashtag_click' | 'cashtag_click'): string {
  const url = new URL('/search', X_WEB_ORIGIN);
  url.searchParams.set('q', query);
  url.searchParams.set('src', source);
  return url.toString();
}

function normalizeXEntityLinks(entities: Record<string, unknown> | undefined): NewsLink[] {
  if (!entities) return [];
  const links: NewsLink[] = [];
  const append = (
    collection: unknown,
    parse: (entity: Record<string, unknown>) => NewsLink | undefined,
  ) => {
    if (!Array.isArray(collection)) return;
    for (const candidate of collection) {
      if (!isRecord(candidate)) continue;
      const link = parse(candidate);
      if (link) links.push(link);
    }
  };

  append(entities.urls, (entity) => {
    const range = entityRange(entity);
    if (
      !range
      || typeof entity.display_url !== 'string'
      || entity.display_url.trim() === ''
      || typeof entity.url !== 'string'
      || !isOriginalXShortUrl(entity.url)
    ) return undefined;
    return { kind: 'url', ...range, label: entity.display_url, href: entity.url };
  });
  append(entities.mentions, (entity) => {
    const range = entityRange(entity);
    if (!range || typeof entity.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(entity.username)) {
      return undefined;
    }
    return {
      kind: 'mention',
      ...range,
      label: `@${entity.username}`,
      href: new URL(`/${encodeURIComponent(entity.username)}`, X_WEB_ORIGIN).toString(),
    };
  });
  append(entities.hashtags, (entity) => {
    const range = entityRange(entity);
    if (!range || typeof entity.tag !== 'string' || entity.tag.trim() === '') return undefined;
    return {
      kind: 'hashtag',
      ...range,
      label: `#${entity.tag}`,
      href: searchLink(`#${entity.tag}`, 'hashtag_click'),
    };
  });
  append(entities.cashtags, (entity) => {
    const range = entityRange(entity);
    if (!range || typeof entity.tag !== 'string' || entity.tag.trim() === '') return undefined;
    return {
      kind: 'cashtag',
      ...range,
      label: `$${entity.tag}`,
      href: searchLink(`$${entity.tag}`, 'cashtag_click'),
    };
  });

  const deduplicated = new Map<string, NewsLink>();
  for (const link of links) {
    const key = `${link.kind}:${link.start}:${link.end}:${link.href}`;
    if (!deduplicated.has(key)) deduplicated.set(key, link);
  }
  return [...deduplicated.values()].sort((left, right) => (
    left.start - right.start
    || left.end - right.end
    || left.kind.localeCompare(right.kind)
  ));
}

/** Normalizes X data without trimming, rewriting, or truncating the upstream post text. */
export function normalizeXTimelineResponse(
  payload: unknown,
  fallbackAuthor: XUser,
  now = Date.now(),
): NewsItem[] {
  if (!isRecord(payload)) return [];
  const includedUsers = isRecord(payload.includes) && Array.isArray(payload.includes.users)
    ? payload.includes.users
    : [];
  const users = new Map<string, XUser>();
  for (const value of includedUsers) {
    const user = parseXUser(value);
    if (user) users.set(user.id, user);
  }
  users.set(fallbackAuthor.id, users.get(fallbackAuthor.id) ?? fallbackAuthor);

  const posts = Array.isArray(payload.data) ? payload.data : [];
  const items: NewsItem[] = [];
  for (const value of posts) {
    if (!isRecord(value)) continue;
    const content = postContent(value);
    const createdAt = typeof value.created_at === 'string' ? Date.parse(value.created_at) : Number.NaN;
    const authorId = typeof value.author_id === 'string' ? value.author_id : fallbackAuthor.id;
    const author = users.get(authorId) ?? fallbackAuthor;
    if (
      typeof value.id !== 'string'
      || value.id.length === 0
      || !content
      || !Number.isFinite(createdAt)
      || createdAt > now + 60_000
    ) {
      continue;
    }
    items.push({
      id: value.id,
      authorId,
      source: 'x',
      text: content.text,
      links: normalizeXEntityLinks(content.entities),
      createdAt,
      expiresAt: createdAt + NEWS_ITEM_TTL_MS,
      authorName: author.name,
      authorHandle: author.username,
      authorAvatarUrl: author.profile_image_url ?? null,
      permalink: `https://x.com/${encodeURIComponent(author.username)}/status/${encodeURIComponent(value.id)}`,
      demo: false,
      scope: 'global',
    });
  }
  return pruneExpiredNewsItems(dedupeNewsItems(items), now);
}

export function buildXTimelineUrl(userId: string, now = Date.now()): string {
  const url = new URL(`/2/users/${encodeURIComponent(userId)}/tweets`, X_API_ORIGIN);
  // Headline accounts can burst during major announcements; retain the full ten-minute window.
  url.searchParams.set('max_results', '100');
  // Keep the legacy direct-reader semantics aligned with the centralized
  // ingestor: authored replies are news; reposts remain excluded.
  url.searchParams.set('exclude', 'retweets');
  url.searchParams.set('start_time', new Date(now - NEWS_ITEM_TTL_MS - 60_000).toISOString());
  url.searchParams.set('tweet.fields', 'created_at,author_id,note_tweet,entities');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'name,username,profile_image_url');
  return url.toString();
}

async function fetchXJson(url: string, token: string, fetcher: ServerFetcher): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(X_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`X API returned ${response.status}`);
  return response.json();
}

async function getTrackedUser(
  token: string,
  now: number,
  fetcher: ServerFetcher,
): Promise<XUser> {
  if (cachedTrackedUser && cachedTrackedUser.expiresAt > now) return cachedTrackedUser.user;
  const url = new URL(`/2/users/by/username/${encodeURIComponent(TRACKED_HANDLE)}`, X_API_ORIGIN);
  url.searchParams.set('user.fields', 'name,username,profile_image_url');
  const payload = await fetchXJson(url.toString(), token, fetcher);
  const user = isRecord(payload) ? parseXUser(payload.data) : undefined;
  if (!user) throw new Error('X user lookup returned an invalid payload');
  cachedTrackedUser = { user, expiresAt: now + USER_CACHE_TTL_MS };
  return user;
}

export async function fetchXNews(
  token: string,
  now = Date.now(),
  fetcher: ServerFetcher = fetch,
): Promise<NewsItem[]> {
  const author = await getTrackedUser(token, now, fetcher);
  const payload = await fetchXJson(buildXTimelineUrl(author.id, now), token, fetcher);
  return normalizeXTimelineResponse(payload, author, now);
}

function jsonResponse(
  mode: NewsApiMode,
  items: readonly NewsItem[],
  checkedAt: number,
  status = 200,
  accounts?: NewsApiResponse['accounts'],
  maxAccounts?: number,
): Response {
  const body: NewsApiResponse = {
    mode,
    items,
    checkedAt,
    ...(accounts ? { accounts } : {}),
    ...(maxAccounts ? { maxAccounts } : {}),
  };
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Vercel-CDN-Cache-Control': CDN_CACHE_CONTROL,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function rejectedRequest(status: 400 | 405, allow?: string): Response {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (allow) headers.set('Allow', allow);
  return new Response(status === 405 ? 'Method Not Allowed' : 'Bad Request', { status, headers });
}

export async function handleNewsRequest(
  request: Request,
  token: string | undefined = process.env.X_BEARER_TOKEN,
  checkedAt = Date.now(),
  cacheOrigin: string | undefined = process.env.NEWS_CACHE_ORIGIN,
  fetcher: ServerFetcher = fetch,
): Promise<Response> {
  if (request.method !== 'GET') {
    return rejectedRequest(405, 'GET');
  }

  // Scope is the only bounded cache variant. Browsers never contact X: the single multiplayer
  // process owns ingestion and this function reads its ten-minute cache.
  const requestUrl = new URL(request.url);
  const scope = requestUrl.searchParams.get('scope');
  const scopeValues = requestUrl.searchParams.getAll('scope');
  if (
    [...requestUrl.searchParams.keys()].some((key) => key !== 'scope')
    || scopeValues.length > 1
    || (scope !== null && !/^(?:BTC|ETH|SOL|XRP|DOGE|BNB|LINK|AVAX|WTI|TEST|PUMP|ANSEM|SHFL)$/.test(scope))
    || request.headers.has('authorization')
    || request.headers.has('range')
  ) return rejectedRequest(400);

  const normalizedToken = token?.trim();
  const normalizedOrigin = cacheOrigin?.trim();
  if (!normalizedOrigin) {
    return jsonResponse(!normalizedToken ? 'unconfigured' : 'unavailable', [], checkedAt);
  }
  try {
    const upstream = new URL('/api/news', normalizedOrigin);
    if (scope) upstream.searchParams.set('scope', scope);
    const response = await fetcher(upstream, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(X_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('news_cache_unavailable');
    const payload = await response.json() as unknown;
    const parsed = parseNewsApiResponse(payload, checkedAt);
    if (!parsed) throw new Error('invalid_news_cache');
    return jsonResponse(
      parsed.mode,
      parsed.items,
      parsed.checkedAt,
      200,
      parsed.accounts,
      parsed.maxAccounts,
    );
  } catch {
    // Do not expose provider/cache errors or credentials to the browser.
    return jsonResponse('unavailable', [], checkedAt);
  }
}

async function handleRequest(request: Request): Promise<Response> {
  return handleNewsRequest(request);
}

export default {
  fetch: handleRequest,
};
