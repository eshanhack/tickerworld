import { describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_MULTIPLAYER_ENDPOINT,
  OFFLINE_RUNTIME_CAPABILITIES,
  fetchRuntimeCapabilities,
  multiplayerHttpOrigin,
  resolveMultiplayerEndpoint,
} from '../src/net';

describe('runtime capabilities client', () => {
  it('auto-selects the canonical endpoint for exact trusted production hosts', () => {
    expect(CANONICAL_MULTIPLAYER_ENDPOINT)
      .toBe('wss://us-lax-489a84b6.colyseus.cloud');
    expect(resolveMultiplayerEndpoint('', { hostname: 'tickerworld.io' }))
      .toBe(CANONICAL_MULTIPLAYER_ENDPOINT);
    expect(resolveMultiplayerEndpoint('', { hostname: 'www.tickerworld.io' }))
      .toBe(CANONICAL_MULTIPLAYER_ENDPOINT);
    expect(resolveMultiplayerEndpoint('', { hostname: 'game-tickerworld.vercel.app' }))
      .toBe(CANONICAL_MULTIPLAYER_ENDPOINT);
    expect(resolveMultiplayerEndpoint('', { hostname: 'game-tickerworld-ishans-projects-5e73516c.vercel.app' }))
      .toBe(CANONICAL_MULTIPLAYER_ENDPOINT);
    expect(resolveMultiplayerEndpoint('', { hostname: 'game-tickerworld-git-main-ishans-projects-5e73516c.vercel.app' }))
      .toBe(CANONICAL_MULTIPLAYER_ENDPOINT);
    expect(resolveMultiplayerEndpoint('', { hostname: 'GAME-TICKERWORLD.VERCEL.APP' }))
      .toBe(CANONICAL_MULTIPLAYER_ENDPOINT);
  });

  it('keeps arbitrary previews and local origins fail-closed', () => {
    expect(resolveMultiplayerEndpoint('', { hostname: 'preview.vercel.app' })).toBe('');
    expect(resolveMultiplayerEndpoint('', { hostname: 'game-tickerworld-pr-42.vercel.app' })).toBe('');
    expect(resolveMultiplayerEndpoint('', { hostname: 'game-tickerworld.vercel.app.attacker.test' })).toBe('');
    expect(resolveMultiplayerEndpoint('', { hostname: '127.0.0.1' })).toBe('');
    expect(resolveMultiplayerEndpoint('ws://127.0.0.1:2567', null)).toBe('ws://127.0.0.1:2567');
    expect(resolveMultiplayerEndpoint('javascript:alert(1)', { hostname: 'preview.vercel.app' })).toBe('');
    expect(resolveMultiplayerEndpoint('wss://user:secret@example.test', null)).toBe('');
    expect(resolveMultiplayerEndpoint('wss://example.test?token=secret', null)).toBe('');
  });

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
