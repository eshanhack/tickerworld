import { describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_RUNTIME_CAPABILITIES,
  fetchRuntimeCapabilities,
  multiplayerHttpOrigin,
} from '../src/net';

describe('runtime capabilities client', () => {
  it('normalizes websocket endpoints without retaining paths or secrets', () => {
    expect(multiplayerHttpOrigin('wss://multiplayer.tickerworld.io/')).toBe(
      'https://multiplayer.tickerworld.io',
    );
    expect(multiplayerHttpOrigin('ws://127.0.0.1:2567')).toBe('http://127.0.0.1:2567');
    expect(multiplayerHttpOrigin('wss://multiplayer.tickerworld.io/rooms?token=secret')).toBe(
      'https://multiplayer.tickerworld.io',
    );
    expect(multiplayerHttpOrigin('javascript:alert(1)')).toBeNull();
  });

  it('fails closed except for the truthful direct-market solo fallback', async () => {
    const result = await fetchRuntimeCapabilities('', vi.fn());
    expect(result).toEqual(OFFLINE_RUNTIME_CAPABILITIES);
    expect(result.switches).toMatchObject({
      admissions: false,
      chatSend: false,
      directMarketFallback: true,
      publicWalletAuth: false,
      purchases: false,
      adminActions: false,
    });
  });

  it('accepts a complete server capability document', async () => {
    const expected = {
      ...OFFLINE_RUNTIME_CAPABILITIES,
      updatedAt: 123,
      multiplayerAvailable: true,
      marketRelayAvailable: true,
      switches: { ...OFFLINE_RUNTIME_CAPABILITIES.switches, admissions: true },
    };
    const result = await fetchRuntimeCapabilities('wss://multiplayer.tickerworld.io', vi.fn(async () => (
      new Response(JSON.stringify(expected), { status: 200 })
    )) as typeof fetch);
    expect(result).toEqual(expected);
  });
});
