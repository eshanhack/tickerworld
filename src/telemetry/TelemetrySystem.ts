import { inject, track } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import type { AssetSymbol } from '../types';

export const TELEMETRY_EVENT_NAMES = [
  'landing_view',
  'entry',
  'game_ready',
  'first_movement',
  'first_live_market_update',
  'remote_player_seen',
  'emote_used',
  'chat_used',
  'share_completed',
  'invite_created',
  'party_link_activated',
  'portal_completed',
  'session_60_seconds',
  'session_5_minutes',
  'return_session',
  'activated_social_session',
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export interface TelemetryEvent {
  readonly name: TelemetryEventName;
  readonly market?: AssetSymbol;
  readonly mode?: 'live' | 'solo' | 'offline' | 'simulated';
  readonly action?: string;
}

export interface TelemetrySender {
  (name: TelemetryEventName, properties?: Record<string, string | number | boolean | null>): void;
}

export interface TelemetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TelemetrySystemOptions {
  readonly sender?: TelemetrySender;
  readonly storage?: TelemetryStorage | null;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
}

const RETURNING_KEY = 'tickerworld:launch:visited';
const SENSITIVE_PROPERTY_PATTERN = /(?:actor|address|chat|hash|ip|message|party|query|token|url|wallet)/i;

function browserStorage(): TelemetryStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSetTimeout(callback: () => void, delay: number): number {
  return window.setTimeout(callback, delay);
}

function browserClearTimeout(handle: number): void {
  window.clearTimeout(handle);
}

/** Removes query strings and fragments before any browser URL reaches analytics. */
export function sanitizeTelemetryUrl(input: string): string {
  try {
    const parsed = new URL(input, 'https://tickerworld.io');
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return input.split(/[?#]/, 1)[0] ?? '/';
  }
}

/** A final fail-closed boundary for custom event properties. */
export function safeTelemetryProperties(
  event: Omit<TelemetryEvent, 'name'>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event)) {
    if (SENSITIVE_PROPERTY_PATTERN.test(key) || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Launch telemetry deliberately stores only coarse activation facts. It never
 * receives player identity, message text, wallet data, invite tokens, or raw
 * URLs, so those values cannot accidentally reach analytics.
 */
export class TelemetrySystem {
  private readonly sender: TelemetrySender;
  private readonly storage: TelemetryStorage | null;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private readonly sent = new Set<TelemetryEventName>();
  private readonly startedAt: number;
  private readonly timers: number[] = [];
  private moved = false;
  private receivedLiveData = false;
  private wasSocial = false;
  private stayedForMinute = false;
  private disposed = false;

  public constructor(options: TelemetrySystemOptions = {}) {
    this.sender = options.sender ?? ((name, properties) => track(name, properties));
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? browserSetTimeout;
    this.clearTimer = options.clearTimeout ?? browserClearTimeout;
    this.startedAt = this.now();

    this.markReturnVisit();
    this.timers.push(this.setTimer(() => {
      this.stayedForMinute = true;
      this.emitOnce({ name: 'session_60_seconds' });
      this.maybeActivate();
    }, 60_000));
    this.timers.push(this.setTimer(() => this.emitOnce({ name: 'session_5_minutes' }), 300_000));
  }

  public emit(event: TelemetryEvent): void {
    if (this.disposed) return;
    this.sender(event.name, safeTelemetryProperties(event));
    this.observeActivation(event.name);
  }

  public emitOnce(event: TelemetryEvent): void {
    if (this.sent.has(event.name) || this.disposed) return;
    this.sent.add(event.name);
    this.emit(event);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.length = 0;
  }

  private observeActivation(name: TelemetryEventName): void {
    if (name === 'first_movement') this.moved = true;
    if (name === 'first_live_market_update') this.receivedLiveData = true;
    if (name === 'remote_player_seen' || name === 'emote_used') this.wasSocial = true;
    if (name === 'session_60_seconds') this.stayedForMinute = true;
    this.maybeActivate();
  }

  private maybeActivate(): void {
    if (!this.moved || !this.receivedLiveData || !this.wasSocial || !this.stayedForMinute) return;
    this.emitOnce({ name: 'activated_social_session' });
  }

  private markReturnVisit(): void {
    try {
      if (this.storage?.getItem(RETURNING_KEY) === '1') {
        this.emitOnce({ name: 'return_session' });
      }
      this.storage?.setItem(RETURNING_KEY, '1');
    } catch {
      // Analytics must never make storage denial visible to the player.
    }
  }

  public get sessionAgeMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }
}

/** Installs first-party analytics with every URL reduced to its pathname. */
export function initializeObservability(): void {
  if (typeof window === 'undefined' || /^\/admin\/?$/i.test(window.location.pathname)) return;
  inject({
    beforeSend: (event) => ({ ...event, url: sanitizeTelemetryUrl(event.url) }),
  });
  injectSpeedInsights({
    sampleRate: 0.5,
    beforeSend: (event) => ({ ...event, url: sanitizeTelemetryUrl(event.url) }),
  });
}
