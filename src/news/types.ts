import type {
  AssetSymbol,
  NewsAccountStatus,
  NewsScope as SharedNewsScope,
  NewsTrackedAccount,
} from '../../shared/src/index.js';

export type NewsScope = SharedNewsScope;

export const NEWS_ITEM_TTL_MS = 10 * 60_000;
export const NEWS_POLL_INTERVAL_MS = 20_000;
export const NEWS_DEMO_INTERVAL_MS = 5 * 60_000;

export type NewsSource = 'x' | 'simulation';
export type NewsApiMode = 'live' | 'unconfigured' | 'unavailable';
export type NewsFeedMode = 'connecting' | NewsApiMode | 'simulated';
export type NewsLinkKind = 'url' | 'mention' | 'hashtag' | 'cashtag';
export type TrackedNewsAccountStatus = NewsAccountStatus;
export type TrackedNewsAccount = NewsTrackedAccount;

export interface NewsLink {
  kind: NewsLinkKind;
  /** Inclusive start and exclusive end offsets supplied by X for the exact upstream text. */
  start: number;
  end: number;
  /** Display label required by X, which can differ from the text inside the source range. */
  label: string;
  /** X destination. URL entities retain the original t.co URL from the API. */
  href: string;
}

export interface NewsItem {
  id: string;
  source: NewsSource;
  /** Exact upstream text for X items; demo copy is always explicitly labelled fictional. */
  text: string;
  /** Normalized X text entities, ordered by source range. Demo items always use an empty list. */
  links: readonly NewsLink[];
  createdAt: number;
  expiresAt: number;
  /** Immutable X author id when supplied by the canonical ingestion service. */
  authorId?: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string | null;
  permalink: string | null;
  demo: boolean;
  /** Asset-specific posts stay in that world; global posts are contextual, never causal. */
  scope: NewsScope;
}

export interface NewsApiResponse {
  mode: NewsApiMode;
  items: readonly NewsItem[];
  checkedAt: number;
  /** Optional during the compatible server rollout. */
  accounts?: readonly TrackedNewsAccount[];
  /** Server policy can lower, but never raise, the client's eight-account cap. */
  maxAccounts?: number;
}

export interface NewsFeedUpdate {
  mode: NewsFeedMode;
  /** Active items, ordered newest first. */
  items: readonly NewsItem[];
  /** Only genuinely new items from this event. Initial/backfill events always leave this empty. */
  added: readonly NewsItem[];
  updatedAt: number;
  accounts: readonly TrackedNewsAccount[];
  maxAccounts: number;
}

export type NewsFeedListener = (update: NewsFeedUpdate) => void;

export interface NewsFeed {
  start(): Promise<void>;
  setActiveMarket(symbol: AssetSymbol): void;
  pause(): void;
  resume(): void;
  subscribe(listener: NewsFeedListener): () => void;
  getSnapshot(): NewsFeedUpdate;
  dispose(): void;
}
