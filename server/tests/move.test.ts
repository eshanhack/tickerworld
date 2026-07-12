import {
  MAX_SPRINT_SPEED,
  PROTOCOL_VERSION,
  sampleBoundedTerrainHeight,
  type MoveSnapshot,
} from '@tickerworld/shared';
import { describe, expect, it } from 'vitest';
import { validateMove, type MoveTracker } from '../src/rooms/MoveValidator.js';

function snapshot(overrides: Partial<MoveSnapshot> = {}): MoveSnapshot {
  const x = overrides.x ?? 0;
  const z = overrides.z ?? 14;
  return {
    protocolVersion: PROTOCOL_VERSION,
    sequence: 1,
    sentAt: 1_000,
    x,
    y: sampleBoundedTerrainHeight(x, z),
    z,
    yaw: 0,
    speed: 0,
    verticalSpeed: 0,
    grounded: true,
    gait: 'idle',
    ...overrides,
  };
}

function tracker(overrides: Partial<MoveTracker> = {}): MoveTracker {
  return { lastSequence: 0, lastAcceptedAt: 900, lastReceivedAt: 900, ...overrides };
}

describe('authoritative movement validation', () => {
  it('accepts a plausible 10 Hz movement update', () => {
    expect(validateMove(snapshot({ x: 0.4 }), { x: 0, y: 0, z: 14 }, tracker(), 1_000)).toEqual({ accepted: true });
  });

  it('accepts the fastest lightweight species and rejects speed above the shared ceiling tolerance', () => {
    expect(validateMove(
      snapshot({ x: 0.8, speed: MAX_SPRINT_SPEED }),
      { x: 0, y: 0, z: 14 },
      tracker(),
      1_000,
    )).toEqual({ accepted: true });
    const impossible = validateMove(
      snapshot({ speed: MAX_SPRINT_SPEED * 1.1 }),
      { x: 0, y: 0, z: 14 },
      tracker(),
      1_000,
    );
    expect(impossible.accepted).toBe(false);
    if (!impossible.accepted && !impossible.drop) {
      expect(impossible.correction.reason).toBe('speed');
    }
  });

  it('drops high-frequency spam without moving authoritative state', () => {
    expect(validateMove(snapshot(), { x: 0, y: 0, z: 14 }, tracker({ lastReceivedAt: 970 }), 1_000)).toEqual({
      accepted: false,
      drop: true,
    });
  });

  it('hard-corrects podium, world edge, teleport, and impossible height', () => {
    for (const invalid of [
      snapshot({ x: 0, z: 0 }),
      snapshot({ x: 90, z: 0 }),
      snapshot({ x: 8, z: 20 }),
      snapshot({ y: 30 }),
    ]) {
      const result = validateMove(invalid, { x: 0, y: 0, z: 14 }, tracker(), 1_000);
      expect(result.accepted).toBe(false);
      if (!result.accepted && !result.drop) expect(result.correction.hard).toBe(true);
    }
  });

  it('rejects stale sequences and non-finite data', () => {
    const stale = validateMove(snapshot({ sequence: 2 }), { x: 0, y: 0, z: 14 }, tracker({ lastSequence: 2 }), 1_000);
    const nonFinite = validateMove(snapshot({ x: Number.NaN }), { x: 0, y: 0, z: 14 }, tracker(), 1_000);
    expect(stale.accepted).toBe(false);
    expect(nonFinite.accepted).toBe(false);
  });
});
