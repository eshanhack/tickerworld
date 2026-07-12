import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  EMOTE_KINDS,
  EmoteRateGate,
  EmoteVisualSystem,
  createEmoteNonce,
  parseServerEmote,
} from '../src/social';

describe('emote protocol and visuals', () => {
  it('keeps the six launch emotes typed and rejects malformed room events', () => {
    expect(EMOTE_KINDS).toEqual(['wave', 'sparkle-heart', 'cheer', 'spin', 'gasp', 'curl-nap']);
    expect(parseServerEmote({
      protocolVersion: 2,
      actorId: 'actor-a',
      kind: 'wave',
      nonce: 'nonce_123',
      sentAt: 123,
    })).toMatchObject({ actorId: 'actor-a', kind: 'wave' });
    expect(parseServerEmote({ actorId: 'actor-a', kind: 'dance', nonce: 'bad', sentAt: 1 })).toBeNull();
  });

  it('applies a small client courtesy cooldown and stable protocol-safe nonces', () => {
    const gate = new EmoteRateGate(500);
    expect(gate.tryTake(1_000)).toBe(true);
    expect(gate.tryTake(1_200)).toBe(false);
    expect(gate.retryAfterMs(1_200)).toBe(300);
    expect(gate.tryTake(1_500)).toBe(true);
    expect(createEmoteNonce(() => 0.5, 12_345)).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
  });

  it('deduplicates events, blooms arrivals, and keeps one bounded draw pool', () => {
    let now = 1_000;
    const scene = new THREE.Scene();
    const anchors = new Map([
      ['local', { x: 0, y: 0, z: 0 }],
      ['remote-a', { x: 2, y: 0, z: 1 }],
      ['remote-b', { x: -2, y: 0, z: 1 }],
    ]);
    const visuals = new EmoteVisualSystem({
      parent: scene,
      resolveActor: (actorId) => anchors.get(actorId) ?? null,
      now: () => now,
      maxEffects: 3,
      particlesPerEffect: 6,
    });

    visuals.setActors(['remote-a', 'remote-b']);
    expect(visuals.getDebugStats()).toMatchObject({ active: 2, capacity: 3, instances: 18, drawCalls: 1 });
    expect(visuals.trigger({ actorId: 'local', kind: 'cheer', nonce: 'nonce_123' })).toBe(true);
    expect(visuals.trigger({ actorId: 'local', kind: 'cheer', nonce: 'nonce_123' })).toBe(false);
    expect(visuals.getDebugStats().active).toBe(3);

    // The oldest effect is reused rather than allocating beyond the cap.
    expect(visuals.trigger({ actorId: 'local', kind: 'spin', nonce: 'nonce_456' })).toBe(true);
    expect(visuals.getDebugStats().active).toBe(3);
    visuals.setBlockedActors(new Set(['local']));
    expect(visuals.trigger({ actorId: 'local', kind: 'wave', nonce: 'nonce_789' })).toBe(false);
    expect(visuals.getDebugStats().active).toBeLessThan(3);
    visuals.update();
    now += 4_000;
    visuals.update();
    expect(visuals.getDebugStats().active).toBe(0);

    visuals.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
