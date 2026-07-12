import { describe, expect, it } from 'vitest';
import {
  safeTelemetryProperties,
  sanitizeTelemetryUrl,
  TelemetrySystem,
  type TelemetryEventName,
} from '../src/telemetry';

describe('launch telemetry', () => {
  it('strips query strings and party fragments from analytics URLs', () => {
    expect(sanitizeTelemetryUrl('https://tickerworld.io/btc?debug=1#party=secret')).toBe(
      'https://tickerworld.io/btc',
    );
    expect(sanitizeTelemetryUrl('/eth?wallet=secret#party=secret')).toBe(
      'https://tickerworld.io/eth',
    );
  });

  it('drops sensitive custom property names at the final send boundary', () => {
    expect(safeTelemetryProperties({
      market: 'BTC',
      mode: 'live',
      action: 'wave',
      partyToken: 'secret',
      chatMessage: 'hello',
    } as never)).toEqual({ market: 'BTC', mode: 'live', action: 'wave' });
  });

  it('emits the north-star event only after every truthful activation fact', () => {
    const events: TelemetryEventName[] = [];
    const timers: Array<() => void> = [];
    const telemetry = new TelemetrySystem({
      sender: (name) => events.push(name),
      storage: null,
      now: () => 1_000,
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => undefined,
    });

    telemetry.emitOnce({ name: 'first_movement', market: 'BTC' });
    telemetry.emitOnce({ name: 'first_live_market_update', market: 'BTC', mode: 'live' });
    telemetry.emit({ name: 'emote_used', market: 'BTC', action: 'wave' });
    expect(events).not.toContain('activated_social_session');
    timers[0]?.();
    expect(events.filter((name) => name === 'activated_social_session')).toHaveLength(1);
    timers[0]?.();
    expect(events.filter((name) => name === 'activated_social_session')).toHaveLength(1);
    telemetry.dispose();
  });

  it('records only a coarse return marker in local storage', () => {
    const values = new Map<string, string>([['tickerworld:launch:visited', '1']]);
    const events: TelemetryEventName[] = [];
    const telemetry = new TelemetrySystem({
      sender: (name) => events.push(name),
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    expect(events).toEqual(['return_session']);
    expect([...values.entries()]).toEqual([['tickerworld:launch:visited', '1']]);
    telemetry.dispose();
  });
});
