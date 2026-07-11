export { BrowserNewsFeed, type BrowserNewsFeedOptions } from './BrowserNewsFeed.js';
export {
  createDemoNewsItem,
  dedupeNewsItems,
  findGenuinelyNewItems,
  mergeNewsItems,
  parseNewsApiResponse,
  pruneExpiredNewsItems,
  type NewItemCursor,
  type NewItemResult,
} from './newsMath.js';
export {
  NEWS_DEMO_INTERVAL_MS,
  NEWS_ITEM_TTL_MS,
  NEWS_POLL_INTERVAL_MS,
  type NewsApiMode,
  type NewsApiResponse,
  type NewsFeed,
  type NewsFeedListener,
  type NewsFeedMode,
  type NewsFeedUpdate,
  type NewsItem,
  type NewsLink,
  type NewsLinkKind,
  type NewsSource,
} from './types.js';
