import {
  createDemoNewsItem,
  findGenuinelyNewItems,
  mergeNewsItems,
  parseNewsApiResponse,
  pruneExpiredNewsItems,
} from './newsMath.js';
import {
  NEWS_DEMO_INTERVAL_MS,
  NEWS_POLL_INTERVAL_MS,
  type NewsFeed,
  type NewsFeedListener,
  type NewsFeedMode,
  type NewsFeedUpdate,
  type NewsItem,
} from './types.js';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface BrowserNewsFeedOptions {
  endpoint?: string;
  pollIntervalMs?: number;
  demoIntervalMs?: number;
  now?: () => number;
  fetcher?: Fetcher;
  forceSimulation?: boolean;
}

function simulationRequested(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('news') === 'sim';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class BrowserNewsFeed implements NewsFeed {
  private readonly endpoint: string;
  private readonly pollIntervalMs: number;
  private readonly demoIntervalMs: number;
  private readonly now: () => number;
  private readonly fetcher: Fetcher;
  private readonly forceSimulation: boolean;
  private readonly listeners = new Set<NewsFeedListener>();
  private readonly seenIds = new Set<string>();
  private newestCreatedAt = Number.NEGATIVE_INFINITY;
  private liveBaselineEstablished = false;
  private demoSequence = 0;
  private demoActive = false;
  private started = false;
  private paused = false;
  private disposed = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private demoTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private requestController: AbortController | undefined;
  private snapshot: NewsFeedUpdate;

  constructor(options: BrowserNewsFeedOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/news';
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? NEWS_POLL_INTERVAL_MS);
    this.demoIntervalMs = Math.max(1_000, options.demoIntervalMs ?? NEWS_DEMO_INTERVAL_MS);
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.forceSimulation = options.forceSimulation ?? simulationRequested();
    this.snapshot = {
      mode: this.forceSimulation ? 'simulated' : 'connecting',
      items: [],
      added: [],
      updatedAt: this.now(),
    };
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.paused = false;
    if (this.forceSimulation) {
      this.enterDemo();
      return;
    }
    await this.pollOnce();
    this.schedulePoll();
  }

  pause(): void {
    if (this.disposed || this.paused) return;
    this.paused = true;
    this.clearTimers();
    this.requestController?.abort();
    this.requestController = undefined;
  }

  resume(): void {
    if (this.disposed || !this.started || !this.paused) return;
    this.paused = false;
    this.pruneAndPublish();
    if (this.forceSimulation) {
      this.demoActive = true;
      this.scheduleDemo();
      return;
    }
    if (this.demoActive) this.scheduleDemo();
    void this.pollAndSchedule();
  }

  subscribe(listener: NewsFeedListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): NewsFeedUpdate {
    return this.snapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    this.listeners.clear();
    this.seenIds.clear();
  }

  private async pollAndSchedule(): Promise<void> {
    await this.pollOnce();
    this.schedulePoll();
  }

  private async pollOnce(): Promise<void> {
    if (this.paused || this.disposed || this.forceSimulation) return;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`News endpoint returned ${response.status}`);
      const parsed = parseNewsApiResponse(await response.json(), this.now());
      if (!parsed) throw new Error('News endpoint returned an invalid payload');
      if (this.paused || this.disposed || controller.signal.aborted) return;

      if (parsed.mode === 'unconfigured') {
        this.enterDemo();
      } else if (parsed.mode === 'unavailable') {
        this.leaveDemo();
        this.publish('unavailable', this.xItems(), [], parsed.checkedAt);
      } else {
        this.leaveDemo();
        this.acceptLiveItems(parsed.items, parsed.checkedAt);
      }
    } catch (error) {
      if (this.paused || this.disposed || controller.signal.aborted || isAbortError(error)) return;
      this.leaveDemo();
      this.publish('unavailable', this.xItems(), [], this.now());
    } finally {
      if (this.requestController === controller) this.requestController = undefined;
    }
  }

  private acceptLiveItems(incoming: readonly NewsItem[], checkedAt: number): void {
    const result = findGenuinelyNewItems(
      incoming,
      { seenIds: this.seenIds, newestCreatedAt: this.newestCreatedAt },
      !this.liveBaselineEstablished,
    );
    this.seenIds.clear();
    // A bounded history is enough to reject all plausible ten-minute backfill duplicates.
    [...result.seenIds].slice(-512).forEach((id) => this.seenIds.add(id));
    // The first successful response is all backfill, including an empty response whose posts
    // may appear on a later eventually-consistent poll. Seed the edge at the response time.
    this.newestCreatedAt = this.liveBaselineEstablished
      ? result.newestCreatedAt
      : Math.max(result.newestCreatedAt, checkedAt);
    this.liveBaselineEstablished = true;
    const items = mergeNewsItems(this.xItems(), incoming, this.now());
    this.publish('live', items, result.added, checkedAt);
  }

  private enterDemo(): void {
    if (this.demoActive || this.paused || this.disposed) return;
    this.demoActive = true;
    const item = createDemoNewsItem(this.demoSequence, this.now());
    this.demoSequence += 1;
    // The immediate demo item is initial content, not a notification event.
    this.publish('simulated', [item], [], this.now());
    this.scheduleDemo();
  }

  private emitDemoItem(): void {
    if (!this.demoActive || this.paused || this.disposed) return;
    const item = createDemoNewsItem(this.demoSequence, this.now());
    this.demoSequence += 1;
    const items = mergeNewsItems(this.snapshot.items, [item], this.now());
    this.publish('simulated', items, [item], this.now());
    this.scheduleDemo();
  }

  private leaveDemo(): void {
    this.demoActive = false;
    if (this.demoTimer !== undefined) clearTimeout(this.demoTimer);
    this.demoTimer = undefined;
  }

  private xItems(): NewsItem[] {
    return pruneExpiredNewsItems(
      this.snapshot.items.filter((item) => item.source === 'x'),
      this.now(),
    );
  }

  private pruneAndPublish(): void {
    const items = pruneExpiredNewsItems(this.snapshot.items, this.now());
    if (items.length !== this.snapshot.items.length) {
      this.publish(this.snapshot.mode, items, [], this.now());
    } else {
      this.scheduleExpiry();
    }
  }

  private publish(
    mode: NewsFeedMode,
    items: readonly NewsItem[],
    added: readonly NewsItem[],
    updatedAt: number,
  ): void {
    const activeItems = pruneExpiredNewsItems(items, this.now());
    const activeIds = new Set(activeItems.map((item) => `${item.source}:${item.id}`));
    const activeAdded = added.filter((item) => activeIds.has(`${item.source}:${item.id}`));
    const event: NewsFeedUpdate = { mode, items: activeItems, added: activeAdded, updatedAt };
    // New subscribers and getSnapshot() must not replay a historical notification.
    this.snapshot = { ...event, added: [] };
    this.listeners.forEach((listener) => listener(event));
    this.scheduleExpiry();
  }

  private schedulePoll(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.paused || this.disposed || this.forceSimulation) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollAndSchedule();
    }, this.pollIntervalMs);
  }

  private scheduleDemo(): void {
    if (this.demoTimer !== undefined) clearTimeout(this.demoTimer);
    this.demoTimer = undefined;
    if (!this.demoActive || this.paused || this.disposed) return;
    this.demoTimer = setTimeout(() => {
      this.demoTimer = undefined;
      this.emitDemoItem();
    }, this.demoIntervalMs);
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.paused || this.disposed || this.snapshot.items.length === 0) return;
    const nextExpiry = Math.min(...this.snapshot.items.map((item) => item.expiresAt));
    const delay = Math.max(1, nextExpiry - this.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.pruneAndPublish();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.demoTimer !== undefined) clearTimeout(this.demoTimer);
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.pollTimer = undefined;
    this.demoTimer = undefined;
    this.expiryTimer = undefined;
  }
}
