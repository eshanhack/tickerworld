import type { AssetSymbol } from '../types';
import {
  marketPath,
  marketSlugForSymbol,
  resolveMarketRoute,
  type MarketRouteModel,
} from './marketRoutes';

export const LAST_MARKET_STORAGE_KEY = 'tickerworld:last-market';

export type MarketRouteListener = (route: MarketRouteModel) => void;

export interface MarketRouteHistory {
  current(): MarketRouteModel;
  push(market: AssetSymbol): MarketRouteModel;
  replace(market: AssetSymbol): MarketRouteModel;
  canonicalize(): MarketRouteModel;
  subscribe(listener: MarketRouteListener): () => void;
  dispose(): void;
}

export interface MarketHistoryEnvironment {
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  readonly history: Pick<History, 'pushState' | 'replaceState'>;
  addEventListener(type: 'popstate', listener: EventListener): void;
  removeEventListener(type: 'popstate', listener: EventListener): void;
}

export interface BrowserMarketRouteHistoryOptions {
  readonly environment?: MarketHistoryEnvironment;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

function defaultEnvironment(): MarketHistoryEnvironment {
  if (typeof window === 'undefined') {
    throw new Error('BrowserMarketRouteHistory requires a browser environment.');
  }
  return window;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Browser history adapter kept separate from game and rendering lifecycles. */
export class BrowserMarketRouteHistory implements MarketRouteHistory {
  private readonly environment: MarketHistoryEnvironment;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly listeners = new Set<MarketRouteListener>();
  private readonly onPopState = (): void => {
    const route = this.current();
    if (route.kind === 'market' && route.reason === 'route') this.remember(route.market);
    this.emit(route);
  };
  private disposed = false;

  public constructor(options: BrowserMarketRouteHistoryOptions = {}) {
    this.environment = options.environment ?? defaultEnvironment();
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.environment.addEventListener('popstate', this.onPopState);
  }

  public current(): MarketRouteModel {
    return resolveMarketRoute(this.environment.location.pathname, this.readRemembered());
  }

  public push(market: AssetSymbol): MarketRouteModel {
    return this.navigate(market, false);
  }

  public replace(market: AssetSymbol): MarketRouteModel {
    return this.navigate(market, true);
  }

  /** Replaces root, case variants, and trailing slashes with the canonical path. */
  public canonicalize(): MarketRouteModel {
    const route = this.current();
    if (route.kind !== 'market' || !route.shouldReplace) return route;
    this.environment.history.replaceState(
      { tickerworldMarket: route.slug },
      '',
      this.urlFor(route.canonicalPath),
    );
    this.remember(route.market);
    return { ...route, requestedPath: route.canonicalPath, shouldReplace: false };
  }

  public subscribe(listener: MarketRouteListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.environment.removeEventListener('popstate', this.onPopState);
    this.listeners.clear();
  }

  private navigate(market: AssetSymbol, replace: boolean): MarketRouteModel {
    const path = marketPath(market);
    const state = { tickerworldMarket: marketSlugForSymbol(market) };
    if (replace) this.environment.history.replaceState(state, '', this.urlFor(path));
    else this.environment.history.pushState(state, '', this.urlFor(path));
    this.remember(market);
    const route = resolveMarketRoute(path, market);
    this.emit(route);
    return route;
  }

  private urlFor(path: string): string {
    return `${path}${this.environment.location.search}${this.environment.location.hash}`;
  }

  private readRemembered(): string | null {
    try {
      return this.storage?.getItem(LAST_MARKET_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private remember(market: AssetSymbol): void {
    try {
      this.storage?.setItem(LAST_MARKET_STORAGE_KEY, marketSlugForSymbol(market));
    } catch {
      // Storage denial must never prevent local routing or portal travel.
    }
  }

  private emit(route: MarketRouteModel): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(route);
  }
}
