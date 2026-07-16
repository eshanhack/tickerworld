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

  it('accepts bounded explicit motion state while retaining legacy snapshots', () => {
    expect(validateMove(snapshot({
      movementState: 'double-jump',
      gaitPhase: 0.98,
      movementBlend: 1,
      runBlend: 0.72,
      airProgress: 0.4,
      speed: Math.hypot(7.2, -3.1),
      simulationTick: 4_294_967_295,
      velocityX: 7.2,
      velocityZ: -3.1,
      turnLean: 0.18,
      accelerationLean: -0.07,
      glideBank: -0.82,
      anticipationSequence: 4,
      jumpSequence: 4,
      doubleJumpSequence: 3,
      landSequence: 2,
      skidSequence: 1,
      anticipationTick: 4_294_967_280,
      jumpTick: 4_294_967_283,
      doubleJumpTick: 4_294_967_290,
      landTick: 4_294_967_294,
      skidTick: 4_294_967_270,
      landingTier: 'heavy',
      stateTransitionSequence: 12,
      stateTransitionTick: 4_294_967_294,
    }), { x: 0, y: 0, z: 14 }, tracker(), 1_000)).toEqual({ accepted: true });
    const invalid = validateMove(snapshot({ gaitPhase: Number.NaN }), { x: 0, y: 0, z: 14 }, tracker(), 1_000);
    expect(invalid.accepted).toBe(false);
    expect(validateMove(
      snapshot({ glideBank: 1.01 }),
      { x: 0, y: 0, z: 14 },
      tracker(),
      1_000,
    ).accepted).toBe(false);
    expect(validateMove(
      snapshot({ speed: 1, velocityX: 8, velocityZ: 8 }),
      { x: 0, y: 0, z: 14 },
      tracker(),
      1_000,
    ).accepted).toBe(false);
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

  it('accepts uint32 action wrap but rejects rewinds and implausible serial jumps', () => {
    const previous = snapshot({
      sequence: 10,
      simulationTick: 0xffff_ffff,
      doubleJumpSequence: 0xffff_ffff,
      doubleJumpTick: 0xffff_fffc,
      stateTransitionSequence: 0xffff_ffff,
      stateTransitionTick: 0xffff_fffd,
    });
    const wrapped = snapshot({
      sequence: 11,
      simulationTick: 5,
      doubleJumpSequence: 0,
      doubleJumpTick: 2,
      stateTransitionSequence: 0,
      stateTransitionTick: 3,
    });
    expect(validateMove(
      wrapped,
      { x: 0, y: 0, z: 14 },
      tracker({ lastSequence: 10, lastMotion: previous }),
      1_000,
    )).toEqual({ accepted: true });

    const rewind = snapshot({
      sequence: 11,
      simulationTick: 104,
      doubleJumpSequence: 8,
      doubleJumpTick: 98,
    });
    const baseline = snapshot({
      sequence: 10,
      simulationTick: 100,
      doubleJumpSequence: 9,
      doubleJumpTick: 98,
    });
    expect(validateMove(
      rewind,
      { x: 0, y: 0, z: 14 },
      tracker({ lastSequence: 10, lastMotion: baseline }),
      1_000,
    ).accepted).toBe(false);
    expect(validateMove(
      snapshot({
        sequence: 11,
        simulationTick: 104,
        doubleJumpSequence: 20,
        doubleJumpTick: 102,
      }),
      { x: 0, y: 0, z: 14 },
      tracker({ lastSequence: 10, lastMotion: baseline }),
      1_000,
    ).accepted).toBe(false);
  });

  it('accepts the first jump action after a long idle simulation', () => {
    const idle = snapshot({
      sequence: 10,
      simulationTick: 4_200,
      anticipationSequence: 0,
      anticipationTick: 0,
      jumpSequence: 0,
      jumpTick: 0,
      stateTransitionSequence: 1,
      stateTransitionTick: 1,
    });
    const anticipation = snapshot({
      sequence: 11,
      simulationTick: 4_206,
      movementState: 'jump-anticipate',
      anticipationSequence: 1,
      anticipationTick: 4_203,
      jumpSequence: 0,
      jumpTick: 0,
      stateTransitionSequence: 2,
      stateTransitionTick: 4_203,
    });

    expect(validateMove(
      anticipation,
      { x: 0, y: 0, z: 14 },
      tracker({ lastSequence: 10, lastMotion: idle }),
      1_000,
    )).toEqual({ accepted: true });
  });

  it('rejects a newly-fired action tick outside its simulation interval', () => {
    const idle = snapshot({
      sequence: 10,
      simulationTick: 4_200,
      anticipationSequence: 0,
      anticipationTick: 0,
    });
    const futureEvent = snapshot({
      sequence: 11,
      simulationTick: 4_206,
      anticipationSequence: 1,
      anticipationTick: 4_207,
    });
    const staleEvent = snapshot({
      sequence: 11,
      simulationTick: 4_206,
      anticipationSequence: 1,
      anticipationTick: 4_199,
    });

    expect(validateMove(
      futureEvent,
      { x: 0, y: 0, z: 14 },
      tracker({ lastSequence: 10, lastMotion: idle }),
      1_000,
    ).accepted).toBe(false);
    expect(validateMove(
      staleEvent,
      { x: 0, y: 0, z: 14 },
      tracker({ lastSequence: 10, lastMotion: idle }),
      1_000,
    ).accepted).toBe(false);
  });
});
