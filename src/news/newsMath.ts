import {
  NEWS_ITEM_TTL_MS,
  type NewsApiMode,
  type NewsApiResponse,
  type NewsItem,
  type NewsLink,
  type NewsLinkKind,
  type NewsSource,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function parseNewsSource(value: unknown): NewsSource | undefined {
  return value === 'x' || value === 'simulation' ? value : undefined;
}

function parseNewsLinkKind(value: unknown): NewsLinkKind | undefined {
  return value === 'url' || value === 'mention' || value === 'hashtag' || value === 'cashtag'
    ? value
    : undefined;
}

function linkDestinationIsSafe(kind: NewsLinkKind, href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
    const hostname = url.hostname.toLowerCase();
    return kind === 'url' ? hostname === 't.co' : hostname === 'x.com';
  } catch {
    return false;
  }
}

function parseNewsLink(value: unknown): NewsLink | undefined {
  if (!isRecord(value)) return undefined;
  const kind = parseNewsLinkKind(value.kind);
  if (
    !kind
    || !Number.isInteger(value.start)
    || !Number.isInteger(value.end)
    || (value.start as number) < 0
    || (value.end as number) <= (value.start as number)
    || typeof value.label !== 'string'
    || value.label.trim() === ''
    || typeof value.href !== 'string'
    || !linkDestinationIsSafe(kind, value.href)
  ) return undefined;
  return {
    kind,
    start: value.start as number,
    end: value.end as number,
    label: value.label,
    href: value.href,
  };
}

function parseNewsLinks(value: unknown): NewsLink[] | undefined {
  // Accept the previous endpoint shape during a rolling deployment or while an edge entry expires.
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const byRange = new Map<string, NewsLink>();
  for (const candidate of value) {
    const link = parseNewsLink(candidate);
    if (!link) continue;
    const key = `${link.kind}:${link.start}:${link.end}:${link.href}`;
    if (!byRange.has(key)) byRange.set(key, link);
  }
  return [...byRange.values()].sort((left, right) => (
    left.start - right.start
    || left.end - right.end
    || left.kind.localeCompare(right.kind)
  ));
}

function parseNewsItem(value: unknown): NewsItem | undefined {
  if (!isRecord(value)) return undefined;
  const source = parseNewsSource(value.source);
  const createdAt = finiteTimestamp(value.createdAt);
  const avatar = nullableString(value.authorAvatarUrl);
  const permalink = nullableString(value.permalink);
  const links = parseNewsLinks(value.links);
  if (
    typeof value.id !== 'string'
    || value.id.length === 0
    || !source
    || typeof value.text !== 'string'
    || value.text.trim() === ''
    || createdAt === undefined
    || createdAt < 0
    || typeof value.authorName !== 'string'
    || value.authorName.length === 0
    || typeof value.authorHandle !== 'string'
    || value.authorHandle.length === 0
    || avatar === undefined
    || permalink === undefined
    || links === undefined
  ) {
    return undefined;
  }

  return {
    id: value.id,
    source,
    text: value.text,
    links: source === 'x' ? links : [],
    createdAt,
    // The client owns the ten-minute lifetime invariant instead of trusting an API value.
    expiresAt: createdAt + NEWS_ITEM_TTL_MS,
    authorName: value.authorName,
    authorHandle: value.authorHandle.replace(/^@/, ''),
    authorAvatarUrl: avatar,
    permalink,
    demo: source === 'simulation',
  };
}

export function dedupeNewsItems(items: readonly NewsItem[]): NewsItem[] {
  const byId = new Map<string, NewsItem>();
  for (const item of items) {
    const key = `${item.source}:${item.id}`;
    if (!byId.has(key)) byId.set(key, item);
  }
  return [...byId.values()].sort((left, right) => (
    right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  ));
}

export function pruneExpiredNewsItems(items: readonly NewsItem[], now = Date.now()): NewsItem[] {
  return dedupeNewsItems(items).filter((item) => item.expiresAt > now);
}

export function mergeNewsItems(
  current: readonly NewsItem[],
  incoming: readonly NewsItem[],
  now = Date.now(),
): NewsItem[] {
  // Incoming records win if X edits a post while it remains on screen.
  return pruneExpiredNewsItems(dedupeNewsItems([...incoming, ...current]), now);
}

export function parseNewsApiResponse(payload: unknown, now = Date.now()): NewsApiResponse | undefined {
  if (!isRecord(payload)) return undefined;
  const mode: NewsApiMode | undefined = payload.mode === 'live'
    || payload.mode === 'unconfigured'
    || payload.mode === 'unavailable'
    ? payload.mode
    : undefined;
  const checkedAt = finiteTimestamp(payload.checkedAt);
  if (!mode || checkedAt === undefined || !Array.isArray(payload.items)) return undefined;

  const parsed = payload.items
    .map(parseNewsItem)
    .filter((item): item is NewsItem => item !== undefined);
  return {
    mode,
    items: pruneExpiredNewsItems(parsed, now),
    checkedAt,
  };
}

export interface NewItemCursor {
  readonly seenIds: ReadonlySet<string>;
  readonly newestCreatedAt: number;
}

export interface NewItemResult extends NewItemCursor {
  readonly added: readonly NewsItem[];
}

/**
 * Finds genuinely new forward-moving items. Unknown older records are backfill and never notify.
 */
export function findGenuinelyNewItems(
  incoming: readonly NewsItem[],
  cursor: NewItemCursor,
  establishBaseline: boolean,
): NewItemResult {
  const ordered = dedupeNewsItems(incoming);
  const seenIds = new Set(cursor.seenIds);
  const added = establishBaseline
    ? []
    : ordered.filter((item) => (
      !seenIds.has(`${item.source}:${item.id}`)
      && item.createdAt >= cursor.newestCreatedAt
    ));

  for (const item of ordered) seenIds.add(`${item.source}:${item.id}`);
  const newestCreatedAt = Math.max(
    cursor.newestCreatedAt,
    ...ordered.map((item) => item.createdAt),
  );
  return { seenIds, newestCreatedAt, added };
}

const DEMO_HEADLINES = [
  'DEMO · FICTIONAL TICKERWORLD NEWS — Moonlit traders report an unusual shimmer over the BTC shrine.',
  'DEMO · FICTIONAL TICKERWORLD NEWS — A flock of candle-sparrows circles the ETH plaza at sunrise.',
  'DEMO · FICTIONAL TICKERWORLD NEWS — The SOL ribbon gardens are humming in perfect harmony.',
  'DEMO · FICTIONAL TICKERWORLD NEWS — Fox couriers spot fresh starlight along the market road.',
] as const;

export function createDemoNewsItem(sequence: number, createdAt: number): NewsItem {
  const safeSequence = Math.max(0, Math.floor(sequence));
  const text = DEMO_HEADLINES[safeSequence % DEMO_HEADLINES.length] ?? DEMO_HEADLINES[0];
  return {
    id: `demo-${safeSequence}-${Math.floor(createdAt / 1_000)}`,
    source: 'simulation',
    text,
    links: [],
    createdAt,
    expiresAt: createdAt + NEWS_ITEM_TTL_MS,
    authorName: 'Tickerworld Demo Desk',
    authorHandle: 'tickerworld_demo',
    authorAvatarUrl: null,
    permalink: null,
    demo: true,
  };
}
