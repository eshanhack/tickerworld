import { describe, expect, it, vi } from 'vitest';
import {
  BrowserMarketRouteHistory,
  LAST_MARKET_STORAGE_KEY,
  MARKET_SLUGS,
  marketPath,
  resolveMarketRoute,
  symbolForMarketSlug,
  type MarketHistoryEnvironment,
} from '../src/routing';

function fakeBrowser(pathname = '/') {
  const location = { pathname, search: '?data=sim', hash: '#world' };
  const popListeners = new Set<EventListener>();
  const writes: Array<{ kind: 'push' | 'replace'; url: string | URL | null | undefined }> = [];
  const applyUrl = (url: string | URL | null | undefined): void => {
    if (url === null || url === undefined) return;
    const parsed = new URL(String(url), 'https://tickerworld.io');
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  const environment: MarketHistoryEnvironment = {
    location,
    history: {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        writes.push({ kind: 'push', url });
        applyUrl(url);
      },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        writes.push({ kind: 'replace', url });
        applyUrl(url);
      },
    },
    addEventListener: (_type, listener) => popListeners.add(listener),
    removeEventListener: (_type, listener) => popListeners.delete(listener),
  };
  return {
    environment,
    location,
    writes,
    pop: (nextPath: string): void => {
      location.pathname = nextPath;
      for (const listener of popListeners) listener(new Event('popstate'));
    },
    listenerCount: (): number => popListeners.size,
  };
}

describe('market route resolution', () => {
  it('resolves all eight canonical market slugs', () => {
    for (const slug of MARKET_SLUGS) {
      expect(resolveMarketRoute(`/${slug}`)).toMatchObject({
        kind: 'market',
        market: symbolForMarketSlug(slug),
        canonicalPath: `/${slug}`,
        reason: 'route',
        shouldReplace: false,
      });
    }
  });

  it('canonicalises case and trailing slashes without accepting nested paths', () => {
    expect(resolveMarketRoute('/ETH/')).toMatchObject({
      kind: 'market',
      market: 'ETH',
      canonicalPath: '/eth',
      shouldReplace: true,
    });
    expect(resolveMarketRoute('/eth/chart')).toMatchObject({ kind: 'chooser', reason: 'unknown' });
  });

  it('uses the remembered market at root and BTC as the safe default', () => {
    expect(resolveMarketRoute('/', 'sol')).toMatchObject({
      kind: 'market', market: 'SOL', reason: 'remembered', canonicalPath: '/sol',
    });
    expect(resolveMarketRoute('/', 'not-a-market')).toMatchObject({
      kind: 'market', market: 'BTC', reason: 'default', canonicalPath: '/btc',
    });
  });

  it('returns a friendly complete chooser model for unknown worlds', () => {
    const route = resolveMarketRoute('/pepe');
    expect(route).toMatchObject({
      kind: 'chooser',
      requestedPath: '/pepe',
      title: "PEPE isn't open yet",
    });
    if (route.kind !== 'chooser') return;
    expect(route.choices).toHaveLength(8);
    expect(route.choices.map(({ path }) => path)).toEqual(MARKET_SLUGS.map((slug) => `/${slug}`));
  });
});

describe('BrowserMarketRouteHistory', () => {
  it('canonicalises root, remembers navigation, and preserves QA query/hash state', () => {
    const browser = fakeBrowser('/');
    const memory = new Map([[LAST_MARKET_STORAGE_KEY, 'link']]);
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    };
    const history = new BrowserMarketRouteHistory({ environment: browser.environment, storage });

    expect(history.current()).toMatchObject({ market: 'LINK', reason: 'remembered' });
    expect(history.canonicalize()).toMatchObject({ market: 'LINK', shouldReplace: false });
    expect(browser.writes.at(-1)).toEqual({ kind: 'replace', url: '/link?data=sim#world' });

    history.push('AVAX');
    expect(browser.writes.at(-1)).toEqual({ kind: 'push', url: '/avax?data=sim#world' });
    expect(memory.get(LAST_MARKET_STORAGE_KEY)).toBe('avax');
    history.dispose();
    expect(browser.listenerCount()).toBe(0);
  });

  it('emits push and pop routes while ignoring storage failures', () => {
    const browser = fakeBrowser('/btc');
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new Error('denied'); }),
    };
    const history = new BrowserMarketRouteHistory({ environment: browser.environment, storage });
    const listener = vi.fn();
    history.subscribe(listener);

    expect(history.push('ETH').canonicalPath).toBe(marketPath('ETH'));
    browser.pop('/sol');
    expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ market: 'ETH' }));
    expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({ market: 'SOL' }));
    history.dispose();
  });
});
