import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoxPlayer, type FoxActionEvent } from '../src/player/FoxPlayer';
import { PlayerInputController } from '../src/player/InputController';
import { parseRemote } from '../src/net/RoomClientSystem';
import {
  DEFAULT_MOVEMENT_TUNING,
  MOVEMENT_TUNING_BOUNDS,
  clampMovementTuningValue,
  cloneMovementTuning,
  getMovementTuningBounds,
  loadMovementTuning,
  movementTuningCode,
  persistMovementTuning,
  setMovementTuningValue,
} from '../src/player/MovementConfig';
import { ANIMAL_KINDS } from '../shared/src/index.js';

const players: FoxPlayer[] = [];
const flat = (): number => 0;
const grass = () => 'grass' as const;

function player(): { fox: FoxPlayer; input: PlayerInputController } {
  const input = new PlayerInputController({ target: null, document: null, gamepads: null });
  const fox = new FoxPlayer({ input });
  players.push(fox);
  fox.update(1 / 60, 0, flat, grass);
  return { fox, input };
}

function step(fox: FoxPlayer, delta: number, actions?: FoxActionEvent[]): void {
  fox.update(7e-16 + delta, 0, flat, grass, undefined, actions ? (event) => actions.push(event) : undefined);
}

afterEach(() => {
  for (const fox of players.splice(0)) fox.dispose();
  vi.unstubAllGlobals();
});

describe('movement overhaul', () => {
  it('polls left-stick, run, and jump edges through the shared input buffer', () => {
    let jumpPressed = false;
    const gamepad = {
      connected: true,
      axes: [0.7, -0.8],
      buttons: Array.from({ length: 8 }, (_, index) => ({
        pressed: index === 0 ? jumpPressed : index === 1,
        touched: false,
        value: index === 0 ? Number(jumpPressed) : index === 1 ? 1 : 0,
      })),
    } as unknown as Gamepad;
    const input = new PlayerInputController({
      target: null,
      document: null,
      gamepads: () => [gamepad],
    });
    input.pollGamepad();
    expect(input.state.moveX).toBeGreaterThan(0.6);
    expect(input.state.moveForward).toBeGreaterThan(0.7);
    expect(input.state.sprint).toBe(true);
    expect(input.consumeJump()).toBe(false);
    jumpPressed = true;
    (gamepad.buttons[0] as { pressed: boolean; value: number }).pressed = true;
    (gamepad.buttons[0] as { pressed: boolean; value: number }).value = 1;
    input.pollGamepad();
    expect(input.consumeJump()).toBe(true);
    input.pollGamepad();
    expect(input.consumeJump()).toBe(false);
    input.dispose();
  });

  it('keeps ordinary disabled input gated while allowing a debug-only queued edge', () => {
    const input = new PlayerInputController({ target: null, document: null, gamepads: null });
    input.setEnabled(false);
    input.requestJump();
    expect(input.consumeJump()).toBe(false);
    input.requestJump(true);
    expect(input.consumeJump()).toBe(true);
    expect(input.consumeJump()).toBe(false);
    input.dispose();
  });

  it('applies live gamepad deadzone and sprint tuning without rebuilding input', () => {
    const tuning = cloneMovementTuning();
    tuning.input.gamepadDeadzone = 0.9;
    tuning.input.gamepadSprintThreshold = 0.95;
    const gamepad = {
      connected: true,
      axes: [0.7, -0.8],
      buttons: Array.from({ length: 8 }, () => ({ pressed: false, touched: false, value: 0 })),
    } as unknown as Gamepad;
    const input = new PlayerInputController({
      target: null,
      document: null,
      gamepads: () => [gamepad],
      tuning: tuning.input,
    });
    input.pollGamepad();
    expect(input.state.moveX).toBe(0);
    expect(input.state.moveForward).toBe(0);
    expect(input.state.sprint).toBe(false);

    tuning.input.gamepadDeadzone = 0.1;
    tuning.input.gamepadSprintThreshold = 0.5;
    input.pollGamepad();
    expect(input.state.moveX).toBeGreaterThan(0.6);
    expect(input.state.moveForward).toBeGreaterThan(0.7);
    expect(input.state.sprint).toBe(true);
    input.dispose();
  });

  it('keeps every runtime constant centralized, editable, and exportable', () => {
    const tuning = cloneMovementTuning();
    expect(setMovementTuningValue(tuning, 'jump.fallGravityScale', 2.05)).toBe(true);
    expect(setMovementTuningValue(tuning, 'physics.jumpImpulseScale', 1.2)).toBe(true);
    expect(tuning.jump.fallGravityScale).toBe(2.05);
    expect(tuning.physics.jumpImpulseScale).toBe(1.2);
    expect(setMovementTuningValue(tuning, 'jump.missing', 2)).toBe(false);
    expect(movementTuningCode(tuning)).toContain('"fallGravityScale": 2.05');
    expect(DEFAULT_MOVEMENT_TUNING.simulation.fixedStepSeconds).toBeCloseTo(1 / 60, 8);
  });

  it('applies live global speed and jump physics over each authored species profile', () => {
    const tuning = cloneMovementTuning();
    tuning.physics.sprintSpeedScale = 1.35;
    tuning.physics.jumpImpulseScale = 1.3;
    const input = new PlayerInputController({ target: null, document: null, gamepads: null });
    const fox = new FoxPlayer({ input, tuning, animal: 'fox' });
    players.push(fox);
    fox.update(1 / 60, 0, flat, grass);
    input.setVirtualInput(0, 1, true);
    for (let frame = 0; frame < 90; frame += 1) step(fox, 1 / 60);
    expect(fox.snapshot.speed).toBeGreaterThan(9.2);

    input.setVirtualInput(0, 0, false);
    for (let frame = 0; frame < 30; frame += 1) step(fox, 1 / 60);
    fox.requestJump();
    for (let frame = 0; frame < 4; frame += 1) step(fox, 1 / 60);
    expect(fox.snapshot.verticalSpeed).toBeGreaterThan(10);
  });

  it('uses one exhaustive bounds source and clamps unsafe live values', () => {
    for (const [section, entries] of Object.entries(DEFAULT_MOVEMENT_TUNING)) {
      for (const [key, value] of Object.entries(entries)) {
        const path = `${section}.${key}` as Parameters<typeof getMovementTuningBounds>[0];
        const range = getMovementTuningBounds(path);
        expect(range, path).toBeDefined();
        expect(value, path).toBeGreaterThanOrEqual(range!.min);
        expect(value, path).toBeLessThanOrEqual(range!.max);
      }
    }
    expect(Object.keys(MOVEMENT_TUNING_BOUNDS.camera)).toEqual(
      Object.keys(DEFAULT_MOVEMENT_TUNING.camera),
    );

    const tuning = cloneMovementTuning();
    expect(setMovementTuningValue(tuning, 'simulation.fixedStepSeconds', 0)).toBe(true);
    expect(tuning.simulation.fixedStepSeconds).toBe(1 / 120);
    expect(setMovementTuningValue(tuning, 'simulation.maxSubSteps', 2.6)).toBe(true);
    expect(tuning.simulation.maxSubSteps).toBe(3);
    expect(setMovementTuningValue(tuning, 'jump.terminalSpeed', 100)).toBe(true);
    expect(tuning.jump.terminalSpeed).toBe(-1);
    expect(clampMovementTuningValue('camera.glideFocusResponse', -5)).toBe(0.1);
    expect(setMovementTuningValue(tuning, 'camera.glideFocusResponse', Number.NaN)).toBe(false);
  });

  it('sanitizes persisted and loaded debug tuning without mutating the caller', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const unsafe = cloneMovementTuning();
    unsafe.simulation.fixedStepSeconds = 0;
    unsafe.simulation.maxSubSteps = 2.6;
    unsafe.camera.glidePositionResponse = -50;
    unsafe.jump.terminalSpeed = Number.POSITIVE_INFINITY;

    persistMovementTuning(unsafe);
    expect(unsafe.simulation.fixedStepSeconds).toBe(0);
    const persisted = JSON.parse([...values.values()][0]!) as typeof unsafe;
    expect(persisted.simulation.fixedStepSeconds).toBe(1 / 120);
    expect(persisted.simulation.maxSubSteps).toBe(3);
    expect(persisted.camera.glidePositionResponse).toBe(0.1);
    expect(persisted.jump.terminalSpeed).toBe(DEFAULT_MOVEMENT_TUNING.jump.terminalSpeed);

    const loaded = loadMovementTuning(true);
    expect(loaded.simulation.fixedStepSeconds).toBe(1 / 120);
    expect(loaded.simulation.maxSubSteps).toBe(3);
    expect(loaded.camera.glidePositionResponse).toBe(0.1);
    expect(loaded.jump.terminalSpeed).toBe(DEFAULT_MOVEMENT_TUNING.jump.terminalSpeed);
  });

  it('keeps legacy clients on inferred gait when a new server supplies zero defaults', () => {
    const legacy = parseRemote({
      actorId: 'legacy-actor',
      x: 1,
      y: 0,
      z: 2,
      yaw: 0.5,
      speed: 4,
      verticalSpeed: 0,
      grounded: true,
      gait: 'run',
      movementState: 'run',
      gaitPhase: 0.42,
      movementBlend: 1,
      runBlend: 0.8,
      airProgress: 1,
      simulationTick: 0,
      motionStateV2: false,
      velocityX: 0,
      velocityZ: 0,
      turnLean: 0,
      accelerationLean: 0,
      glideBank: 0,
      stateTransitionSequence: 0,
      stateTransitionTick: 0,
      animal: 'fox',
      skin: 'base',
      username: null,
      updatedAt: 1,
    });
    expect(legacy?.movementState).toBe('run');
    expect(legacy?.gaitPhase).toBe(0.42);
    expect(legacy?.movementBlend).toBe(1);
    expect(legacy?.velocityX).toBeUndefined();
    expect(legacy?.turnLean).toBeUndefined();
    expect(legacy?.stateTransitionSequence).toBeUndefined();
  });

  it('accepts exact remote detail only when the sending player advertises v2 motion', () => {
    const exact = parseRemote({
      actorId: 'v2-actor',
      x: 1,
      y: 0,
      z: 2,
      yaw: 0.5,
      speed: 4,
      verticalSpeed: -2,
      grounded: false,
      gait: 'air',
      movementState: 'glide',
      gaitPhase: 0.42,
      movementBlend: 1,
      runBlend: 0.8,
      airProgress: 0.5,
      simulationTick: 84,
      motionStateV2: true,
      velocityX: 3.2,
      velocityZ: -4.1,
      turnLean: 0.14,
      accelerationLean: -0.03,
      glideBank: 0.62,
      stateTransitionSequence: 7,
      stateTransitionTick: 81,
      animal: 'fox',
      skin: 'base',
      username: null,
      updatedAt: 1,
    });
    expect(exact?.motionStateV2).toBe(true);
    expect(exact?.velocityX).toBe(3.2);
    expect(exact?.velocityZ).toBe(-4.1);
    expect(exact?.turnLean).toBe(0.14);
    expect(exact?.glideBank).toBe(0.62);
    expect(exact?.stateTransitionSequence).toBe(7);
  });

  it('runs equivalent fixed simulation across 30, 60, 120, and jittered render frames', () => {
    const sequences = [
      Array.from({ length: 60 }, () => 1 / 30),
      Array.from({ length: 120 }, () => 1 / 60),
      Array.from({ length: 240 }, () => 1 / 120),
      Array.from({ length: 120 }, (_, index) => index % 2 === 0 ? 1 / 45 : 1 / 90),
    ];
    const snapshots = sequences.map((sequence) => {
      const { fox, input } = player();
      input.setVirtualInput(0, 1, true);
      for (const delta of sequence) step(fox, delta);
      return fox.snapshot;
    });
    const zs = snapshots.map(({ z }) => z);
    const speeds = snapshots.map(({ speed }) => speed);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.13);
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeLessThan(0.03);
    expect(snapshots.every(({ speed }) => speed > 7)).toBe(true);
  });

  it('hits ninety percent run speed within 250ms and brakes even faster', () => {
    const { fox, input } = player();
    input.setVirtualInput(0, 1, true);
    let reachedAt = 0;
    for (let frame = 1; frame <= 30; frame += 1) {
      step(fox, 1 / 60);
      if (reachedAt === 0 && fox.normalizedSpeed >= 0.9) reachedAt = frame / 60;
    }
    expect(reachedAt).toBeGreaterThan(0);
    expect(reachedAt).toBeLessThanOrEqual(0.25);
    input.setVirtualInput(0, 0);
    let stoppedAt = 0;
    for (let frame = 1; frame <= 30; frame += 1) {
      step(fox, 1 / 60);
      if (stoppedAt === 0 && fox.normalizedSpeed <= 0.1) stoppedAt = frame / 60;
    }
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(reachedAt);
  });

  it('keeps every species responsive while preserving distinct top speeds', () => {
    const topSpeeds: number[] = [];
    for (const animal of ANIMAL_KINDS) {
      const input = new PlayerInputController({ target: null, document: null, gamepads: null });
      const fox = new FoxPlayer({ input, animal });
      players.push(fox);
      fox.update(1 / 60, 0, flat, grass);
      input.setVirtualInput(0, 1, true);
      let reachedAt = 0;
      for (let frame = 1; frame <= 30; frame += 1) {
        step(fox, 1 / 60);
        if (reachedAt === 0 && fox.normalizedSpeed >= 0.9) reachedAt = frame / 60;
      }
      expect(reachedAt, animal).toBeGreaterThan(0);
      expect(reachedAt, animal).toBeLessThanOrEqual(0.25);
      topSpeeds.push(fox.snapshot.speed);
    }
    expect(Math.max(...topSpeeds) - Math.min(...topSpeeds)).toBeGreaterThan(3.5);
  });

  it('faces low-speed input within two rendered frames without a moonwalk', () => {
    const { fox, input } = player();
    input.setVirtualInput(1, 0);
    step(fox, 1 / 60);
    step(fox, 1 / 60);
    const visualYaw = fox.group.getObjectByName('FoxHeadingPivot')!.rotation.y;
    const error = Math.atan2(
      Math.sin(fox.travelYaw - visualYaw),
      Math.cos(fox.travelYaw - visualYaw),
    );
    expect(Math.abs(error)).toBeLessThan(0.08);
  });

  it('cuts an early-released jump while held input reaches a higher apex', () => {
    const held = player().fox;
    const released = player().fox;
    held.setGlideHeld(true);
    released.setGlideHeld(true);
    held.requestJump();
    released.requestJump();
    let releasedHold = true;
    let heldApex = 0;
    let releasedApex = 0;
    for (let frame = 0; frame < 90; frame += 1) {
      if (frame === 10) {
        released.setGlideHeld(false);
        releasedHold = false;
      }
      step(held, 1 / 60);
      step(released, 1 / 60);
      heldApex = Math.max(heldApex, held.position.y);
      releasedApex = Math.max(releasedApex, released.position.y);
    }
    expect(releasedHold).toBe(false);
    expect(heldApex - releasedApex).toBeGreaterThan(0.28);
  });

  it('keeps a release edge through anticipation and a zero-substep 120Hz frame', () => {
    const held = player().fox;
    const tapped = player().fox;
    held.setGlideHeld(true);
    tapped.setGlideHeld(true);
    held.requestJump();
    tapped.requestJump();
    step(tapped, 1 / 120);
    expect(tapped.getMotionDebugSnapshot()).toMatchObject({
      locomotionState: 'jump-anticipate',
      fixedSteps: 0,
    });
    let heldApex = 0;
    let tappedApex = 0;
    for (let frame = 0; frame < 220; frame += 1) {
      if (frame === 2) tapped.setGlideHeld(false);
      step(held, 1 / 120);
      step(tapped, 1 / 120);
      heldApex = Math.max(heldApex, held.position.y);
      tappedApex = Math.max(tappedApex, tapped.position.y);
    }
    expect(heldApex - tappedApex).toBeGreaterThan(0.3);
  });

  it('preserves a press-and-release that happens entirely between rendered frames', () => {
    const full = player().fox;
    const tapped = player().fox;
    full.setGlideHeld(true);
    full.requestJump();
    tapped.setGlideHeld(true);
    tapped.requestJump();
    // Mobile taps and very fast keyboard taps can release before the next RAF.
    // The release must survive until the fixed simulation consumes it.
    tapped.setGlideHeld(false);

    let fullApex = 0;
    let tappedApex = 0;
    for (let frame = 0; frame < 150; frame += 1) {
      step(full, 1 / 120);
      step(tapped, 1 / 120);
      fullApex = Math.max(fullApex, full.position.y);
      tappedApex = Math.max(tappedApex, tapped.position.y);
    }

    expect(fullApex - tappedApex).toBeGreaterThan(0.3);
  });

  it('uses analog magnitude once and preserves traversal speed while lightly steering a glide', () => {
    const half = player();
    const full = player();
    half.input.setVirtualInput(0, 0.5);
    full.input.setVirtualInput(0, 1);
    for (let frame = 0; frame < 120; frame += 1) {
      step(half.fox, 1 / 60);
      step(full.fox, 1 / 60);
    }
    expect(half.fox.snapshot.speed / full.fox.snapshot.speed).toBeGreaterThan(0.45);
    expect(half.fox.snapshot.speed / full.fox.snapshot.speed).toBeLessThan(0.55);

    const gliders = [player(), player()];
    for (const { fox, input } of gliders) {
      input.setVirtualInput(0, 1, true);
      fox.setGlideHeld(true);
      fox.requestJump();
    }
    for (let frame = 0; frame < 12; frame += 1) {
      for (const { fox } of gliders) step(fox, 1 / 60);
    }
    for (const { fox } of gliders) fox.requestJump();
    for (let frame = 0; frame < 90 && !gliders.every(({ fox }) => fox.isGliding); frame += 1) {
      for (const { fox } of gliders) step(fox, 1 / 60);
    }
    expect(gliders.every(({ fox }) => fox.isGliding)).toBe(true);
    gliders[0]!.input.setVirtualInput(0.2, 0, false);
    gliders[1]!.input.setVirtualInput(0, 0, false);
    for (let frame = 0; frame < 30; frame += 1) {
      for (const { fox } of gliders) step(fox, 1 / 60);
    }
    expect(gliders[0]!.fox.snapshot.speed).toBeGreaterThan(7.2);
    expect(Math.abs(gliders[0]!.fox.snapshot.speed - gliders[1]!.fox.snapshot.speed)).toBeLessThan(0.45);
  });

  it('preserves the ground jump throughout the 110ms coyote window', () => {
    const input = new PlayerInputController({ target: null, document: null, gamepads: null });
    const fox = new FoxPlayer({ input });
    players.push(fox);
    const ledge = (_x: number, z: number): number => z > -1.1 ? 0 : -3;
    fox.update(1 / 60, 0, ledge, grass);
    input.setVirtualInput(0, 1, true);
    for (let frame = 0; frame < 90 && fox.snapshot.grounded; frame += 1) {
      fox.update(1 / 60, 0, ledge, grass);
    }
    expect(fox.snapshot.grounded).toBe(false);
    expect(fox.snapshot.jumpsUsed).toBe(0);

    const actions: FoxActionEvent[] = [];
    fox.requestJump();
    fox.update(1 / 60, 0, ledge, grass, undefined, (event) => actions.push(event));
    expect(actions.map(({ type }) => type)).toContain('jump');
    expect(actions.map(({ type }) => type)).not.toContain('double-jump');
    expect(fox.snapshot.jumpsUsed).toBe(1);
  });

  it('turns a late airborne press into a same-contact buffered hop', () => {
    const { fox } = player();
    const actions: FoxActionEvent[] = [];
    fox.requestJump();
    for (let frame = 0; frame < 5; frame += 1) step(fox, 1 / 60, actions);
    fox.requestJump();
    step(fox, 1 / 60, actions);
    expect(actions.filter(({ type }) => type === 'double-jump')).toHaveLength(1);

    let buffered = false;
    for (let frame = 0; frame < 180; frame += 1) {
      const motion = fox.getMotionDebugSnapshot();
      if (!buffered && motion.verticalVelocity < 0 && fox.position.y < 0.65) {
        fox.requestJump();
        buffered = true;
      }
      step(fox, 1 / 60, actions);
      if (buffered && actions.filter(({ type }) => type === 'jump').length === 2) break;
    }
    expect(buffered).toBe(true);
    const types = actions.map(({ type }) => type);
    const landingIndex = types.lastIndexOf('land');
    expect(landingIndex).toBeGreaterThan(0);
    expect(types[landingIndex + 1]).toBe('jump');
    expect(fox.snapshot.grounded).toBe(false);
    expect(fox.snapshot.verticalSpeed).toBeGreaterThan(0);
  });

  it('spaces two pre-takeoff edges into a full jump, double jump, and glide sentence', () => {
    const { fox } = player();
    const actions: Array<{ frame: number; event: FoxActionEvent }> = [];
    fox.setGlideHeld(true);
    fox.requestJump(true);
    fox.requestJump(true);
    for (let frame = 0; frame < 180; frame += 1) {
      fox.update(1 / 60, 0, flat, grass, undefined, (event) => actions.push({ frame, event }));
      if (actions.some(({ event }) => event.type === 'glide-start')) break;
    }
    const jump = actions.find(({ event }) => event.type === 'jump');
    const doubleJump = actions.find(({ event }) => event.type === 'double-jump');
    expect(jump).toBeDefined();
    expect(doubleJump).toBeDefined();
    expect(doubleJump!.frame - jump!.frame).toBeGreaterThanOrEqual(6);
    expect(actions.some(({ event }) => event.type === 'glide-start')).toBe(true);
  });

  it('emits one synchronized skid and preserves immediate steering control', () => {
    const { fox, input } = player();
    const actions: FoxActionEvent[] = [];
    input.setVirtualInput(0, 1, true);
    for (let frame = 0; frame < 60; frame += 1) step(fox, 1 / 60, actions);
    const speedBefore = fox.snapshot.speed;
    input.setVirtualInput(0, -1, true);
    let minimumPivotSpeed = Number.POSITIVE_INFINITY;
    for (let frame = 0; frame < 12; frame += 1) {
      step(fox, 1 / 60, actions);
      minimumPivotSpeed = Math.min(minimumPivotSpeed, fox.snapshot.speed);
    }
    expect(actions.filter(({ type }) => type === 'skid')).toHaveLength(1);
    expect(speedBefore).toBeGreaterThan(6.5);
    expect(minimumPivotSpeed).toBeGreaterThan(5.6);
    expect(fox.snapshot.speed).toBeGreaterThan(6.6);
    expect(fox.getMotionDebugSnapshot().locomotionState).not.toBe('idle');
  });

  it('sweeps thin blockers and keeps tangential wall movement flowing', () => {
    const { fox, input } = player();
    const samples: Array<{ x: number; z: number }> = [];
    const thinWall = (
      previousX: number,
      _previousZ: number,
      nextX: number,
      nextZ: number,
    ) => ({
      // This intentionally behaves like an endpoint-only district collider.
      // Micro-sweeping must prevent a fast diagonal step from skipping it.
      x: nextX >= 1 && nextX <= 1.04 ? previousX : nextX,
      z: nextZ,
    });
    input.setVirtualInput(1, 1, true);
    for (let frame = 0; frame < 150; frame += 1) {
      fox.update(1 / 60, 0, flat, grass, undefined, undefined, thinWall);
      samples.push({ x: fox.snapshot.x, z: fox.snapshot.z });
    }

    expect(Math.max(...samples.map(({ x }) => x))).toBeLessThan(1.001);
    expect(samples.at(-1)!.z).toBeLessThan(-8);
    const wallSamples = samples.filter(({ x }) => x > 0.9);
    expect(wallSamples.length).toBeGreaterThan(30);
    expect(wallSamples.every(({ x }) => x < 1.001)).toBe(true);
  });

  it('keeps ordinary full jumps soft while reserving heavy landings for real drops', () => {
    const { fox } = player();
    const actions: FoxActionEvent[] = [];
    fox.setGlideHeld(true);
    fox.requestJump();
    let releasedAtApex = false;
    for (let frame = 0; frame < 180; frame += 1) {
      if (!releasedAtApex && fox.getMotionDebugSnapshot().verticalVelocity < 0) {
        fox.setGlideHeld(false);
        releasedAtApex = true;
      }
      step(fox, 1 / 60, actions);
      if (actions.some(({ type }) => type === 'land')) break;
    }
    expect(releasedAtApex).toBe(true);
    expect(actions.find(({ type }) => type === 'land')?.landing).toBe('soft');

    const dropped = player().fox;
    const dropActions: FoxActionEvent[] = [];
    dropped.setPosition(0, 8, 0);
    // Reinitialize against a floor far below the teleport height.
    const floor = () => 0;
    for (let frame = 0; frame < 180; frame += 1) {
      dropped.update(1 / 60, 0, floor, grass, undefined, (event) => dropActions.push(event));
      if (dropActions.some(({ type }) => type === 'land')) break;
    }
    expect(dropActions.find(({ type }) => type === 'land')?.landing).toBe('heavy');
  });

  it('interpolates airborne presentation at 120Hz and leaves takeoff rings world-locked', () => {
    const { fox, input } = player();
    input.setVirtualInput(0, 1, true);
    fox.setGlideHeld(true);
    fox.requestJump();
    const airborneY: number[] = [];
    let ring: THREE.Object3D | undefined;
    let ringStart: THREE.Vector3 | undefined;
    for (let frame = 0; frame < 40; frame += 1) {
      step(fox, 1 / 120);
      if (!fox.snapshot.grounded) airborneY.push(fox.renderPosition.y);
      ring ??= fox.group.getObjectByName('MovementRing1');
      if (ring?.visible && !ringStart) {
        fox.group.updateMatrixWorld(true);
        ringStart = ring.getWorldPosition(new THREE.Vector3());
      }
    }
    const movingPairs = airborneY.slice(1).filter((value, index) => Math.abs(value - airborneY[index]!) > 1e-5);
    expect(movingPairs.length).toBeGreaterThan(airborneY.length * 0.75);
    expect(ringStart).toBeDefined();
    fox.group.updateMatrixWorld(true);
    const ringEnd = ring!.getWorldPosition(new THREE.Vector3());
    expect(ringEnd.distanceTo(ringStart!)).toBeLessThan(0.12);
  });

  it('samples grounded support at the interpolated render position on slopes', () => {
    const input = new PlayerInputController({ target: null, document: null, gamepads: null });
    const fox = new FoxPlayer({ input });
    players.push(fox);
    const slope = (x: number, z: number): number => x * 0.08 + z * 0.16;
    fox.update(1 / 60, 0, slope, grass);
    input.setVirtualInput(0.35, 1, true);

    const renderedY: number[] = [];
    for (let frame = 0; frame < 48; frame += 1) {
      fox.update(1 / 120, 0, slope, grass);
      const render = fox.renderPosition;
      renderedY.push(render.y);
      expect(render.y).toBeCloseTo(slope(render.x, render.z), 5);
    }

    const movingPairs = renderedY.slice(1).filter(
      (value, index) => Math.abs(value - renderedY[index]!) > 1e-5,
    );
    expect(movingPairs.length).toBeGreaterThan(renderedY.length * 0.75);
  });

  it('reuses the public player snapshot instead of allocating every frame', () => {
    const { fox, input } = player();
    const first = fox.snapshot;
    input.setVirtualInput(0, 1, true);
    step(fox, 1 / 60);
    const second = fox.snapshot;
    expect(second).toBe(first);
    expect(second.speed).toBeGreaterThan(0);
  });

  it('supports jump, double jump, glide cancellation/redeployment, and a bounded landing', () => {
    const { fox } = player();
    const actions: FoxActionEvent[] = [];
    fox.requestJump();
    for (let frame = 0; frame < 6; frame += 1) step(fox, 1 / 60, actions);
    fox.requestJump();
    fox.setGlideHeld(true);
    let cancelled = false;
    let redeployed = false;
    const states = new Set<string>();
    for (let frame = 0; frame < 220; frame += 1) {
      if (fox.isGliding && !cancelled) {
        fox.setGlideHeld(false);
        cancelled = true;
      } else if (cancelled && !fox.isGliding && !redeployed && !fox.snapshot.grounded) {
        fox.setGlideHeld(true);
        redeployed = true;
      }
      step(fox, 1 / 60, actions);
      states.add(fox.movementState);
      const renderedPose = fox.getMotionDebugSnapshot().rig.pose.airPose;
      if (fox.movementState === 'double-jump') expect(renderedPose).toBe('double');
      if (fox.movementState === 'glide') expect(renderedPose).toBe('glide');
      if (fox.snapshot.grounded && actions.some(({ type }) => type === 'land')) break;
    }
    expect(actions.filter(({ type }) => type === 'jump')).toHaveLength(1);
    expect(actions.filter(({ type }) => type === 'double-jump')).toHaveLength(1);
    expect(cancelled && redeployed).toBe(true);
    expect(states).toEqual(expect.objectContaining(new Set(['double-jump', 'glide', 'fall'])));
    const landing = actions.find(({ type }) => type === 'land');
    expect(landing?.landing).toMatch(/soft|heavy/);
    expect(landing?.airtime).toBeGreaterThan(0.1);
    expect(fox.movementTuning.jump.heavyRecoverySeconds).toBeLessThanOrEqual(0.08);
  });

  it('keeps pooled movement effects bounded and exposes exact replication state', () => {
    const { fox } = player();
    const initialMeshes = new Set<THREE.Object3D>();
    fox.group.traverse((object) => initialMeshes.add(object));
    fox.setGlideHeld(true);
    for (let jump = 0; jump < 16; jump += 1) {
      fox.requestJump();
      for (let frame = 0; frame < 4; frame += 1) step(fox, 1 / 60);
    }
    const afterMeshes = new Set<THREE.Object3D>();
    fox.group.traverse((object) => afterMeshes.add(object));
    expect(afterMeshes.size).toBe(initialMeshes.size);
    expect([...afterMeshes].filter(({ name }) => name.startsWith('MovementRing'))).toHaveLength(5);
    expect([...afterMeshes].filter(({ name }) => name.startsWith('GlideRibbon'))).toHaveLength(2);
    expect(fox.networkMotion.simulationTick).toBeGreaterThan(0);
    expect(fox.networkMotion.gaitPhase).toBeGreaterThanOrEqual(0);
    expect(fox.networkMotion.gaitPhase).toBeLessThan(1);
    expect(fox.networkMotion.velocityX).toBeCloseTo(fox.snapshot.speed * -Math.sin(fox.travelYaw), 3);
    expect(fox.networkMotion.velocityZ).toBeCloseTo(fox.snapshot.speed * -Math.cos(fox.travelYaw), 3);
    expect(Math.abs(fox.networkMotion.turnLean)).toBeLessThanOrEqual(fox.movementTuning.glide.bankRadians);
    expect(Math.abs(fox.networkMotion.glideBank)).toBeLessThanOrEqual(1);
    expect(fox.networkMotion.jumpSequence).toBeGreaterThan(0);
    expect(fox.networkMotion.doubleJumpSequence).toBeGreaterThan(0);
  });

  it('draws sampled world-space glide ribbons and bank sparkles from fixed pools', () => {
    const { fox, input } = player();
    input.setVirtualInput(0.45, 1, true);
    fox.setGlideHeld(true);
    fox.requestJump();
    for (let frame = 0; frame < 12; frame += 1) step(fox, 1 / 60);
    fox.requestJump();
    for (let frame = 0; frame < 90 && !fox.isGliding; frame += 1) step(fox, 1 / 60);
    expect(fox.isGliding).toBe(true);
    for (let frame = 0; frame < 30; frame += 1) step(fox, 1 / 60);

    const ribbon = fox.group.getObjectByName('GlideRibbonLeft');
    expect(ribbon).toBeInstanceOf(THREE.InstancedMesh);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const centers: number[] = [];
    for (let index = 0; index < (ribbon as THREE.InstancedMesh).count; index += 1) {
      (ribbon as THREE.InstancedMesh).getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      if (scale.lengthSq() > 0.00001) centers.push(position.z);
    }
    expect(centers.length).toBeGreaterThan(6);
    expect(Math.max(...centers) - Math.min(...centers)).toBeGreaterThan(0.25);
    const visibleSparkles = [...fox.group.children]
      .flatMap((child) => child.children)
      .filter(({ name, visible }) => name.startsWith('FoxMagicParticle') && visible);
    expect(visibleSparkles.length).toBeGreaterThan(0);
  });

  it('keeps glide trail history stable across 30, 60, and 120 Hz rendering', () => {
    const measureTrail = (delta: number): number => {
      const { fox, input } = player();
      input.setVirtualInput(0, 1, true);
      fox.setGlideHeld(true);
      fox.requestJump();
      for (let frame = 0; frame < 12; frame += 1) step(fox, 1 / 60);
      fox.requestJump();
      for (let frame = 0; frame < 90 && !fox.isGliding; frame += 1) step(fox, 1 / 60);
      expect(fox.isGliding).toBe(true);
      for (let elapsed = 0; elapsed < 0.6; elapsed += delta) step(fox, delta);

      const ribbon = fox.group.getObjectByName('GlideRibbonLeft') as THREE.InstancedMesh;
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const centers: number[] = [];
      for (let index = 0; index < ribbon.count; index += 1) {
        ribbon.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        if (scale.lengthSq() > 0.00001) centers.push(position.z);
      }
      expect(centers.length).toBeGreaterThan(10);
      return Math.max(...centers) - Math.min(...centers);
    };
    const extents = [measureTrail(1 / 30), measureTrail(1 / 60), measureTrail(1 / 120)];
    expect(Math.max(...extents) - Math.min(...extents)).toBeLessThan(0.45);
  });

  it('keeps network motion ticks monotonic across a hard position correction', () => {
    const { fox, input } = player();
    input.setVirtualInput(0, 1, true);
    for (let frame = 0; frame < 12; frame += 1) step(fox, 1 / 60);
    const before = fox.networkMotion.simulationTick;
    fox.setPosition(3, 0, -4);
    expect(fox.networkMotion.simulationTick).toBe(before);
    step(fox, 1 / 60);
    expect(fox.networkMotion.simulationTick).toBe(before + 1);
  });

  it('soaks one logical minute of circles, hops, double jumps, and glides with bounded pools', () => {
    const { fox, input } = player();
    const rollingGround = (x: number, z: number): number => (
      Math.sin(x * 0.17) * 0.12 + Math.cos(z * 0.14) * 0.1
    );
    fox.setPosition(6, rollingGround(6, 0), 0);
    const initialObjects = new Set<THREE.Object3D>();
    fox.group.traverse((object) => initialObjects.add(object));
    const states = new Set<string>();
    let airborneStage = -1;
    let maximumParticles = 0;
    let maximumRings = 0;
    let maximumTrailSegments = 0;
    const guard = (
      _previousX: number,
      _previousZ: number,
      nextX: number,
      nextZ: number,
    ): { x: number; z: number } => {
      const radius = Math.hypot(nextX, nextZ);
      if (radius > 30) return { x: nextX / radius * 30, z: nextZ / radius * 30 };
      if (radius < 4) {
        const safe = Math.max(0.001, radius);
        return { x: nextX / safe * 4, z: nextZ / safe * 4 };
      }
      return { x: nextX, z: nextZ };
    };

    for (let frame = 0; frame < 3_600; frame += 1) {
      const phase = frame * 0.018;
      input.setVirtualInput(Math.sin(phase), Math.cos(phase), frame % 480 < 360);
      if (airborneStage < 0 && fox.snapshot.grounded && frame % 210 === 0) {
        fox.setGlideHeld(true);
        fox.requestJump();
        airborneStage = 0;
      } else if (airborneStage >= 0) {
        airborneStage += 1;
        if (airborneStage === 12) fox.requestJump();
        if (airborneStage === 82) fox.setGlideHeld(false);
        if (airborneStage > 20 && fox.snapshot.grounded) airborneStage = -1;
      }
      fox.update(1 / 60, 0, rollingGround, grass, undefined, undefined, guard);
      const motion = fox.getMotionDebugSnapshot();
      states.add(motion.locomotionState);
      maximumParticles = Math.max(maximumParticles, motion.activeParticles);
      maximumRings = Math.max(maximumRings, motion.activeRings);
      maximumTrailSegments = Math.max(maximumTrailSegments, motion.activeTrailSegments);
      expect([
        fox.snapshot.x,
        fox.snapshot.y,
        fox.snapshot.z,
        fox.snapshot.speed,
        fox.snapshot.verticalSpeed,
      ].every(Number.isFinite)).toBe(true);
    }

    const finalObjects = new Set<THREE.Object3D>();
    fox.group.traverse((object) => finalObjects.add(object));
    expect(finalObjects.size).toBe(initialObjects.size);
    expect(states).toEqual(expect.objectContaining(new Set([
      'run',
      'double-jump',
      'glide',
      'land-soft',
    ])));
    expect(maximumParticles).toBeLessThanOrEqual(32);
    expect(maximumRings).toBeLessThanOrEqual(5);
    expect(maximumTrailSegments).toBeLessThanOrEqual(72);
    expect(Math.hypot(fox.snapshot.x, fox.snapshot.z)).toBeLessThanOrEqual(30.01);
  });

  it('keeps every animal responsive through the full airborne chain', () => {
    const apexes = new Map<string, number>();
    for (const animal of ANIMAL_KINDS) {
      const input = new PlayerInputController({ target: null, document: null, gamepads: null });
      const fox = new FoxPlayer({ input, animal });
      players.push(fox);
      step(fox, 1 / 60);
      input.setVirtualInput(0, 1, true);
      fox.requestJump();
      fox.setGlideHeld(true);
      let apex = 0;
      let doubleRequested = false;
      let sawGlide = false;
      for (let frame = 0; frame < 150; frame += 1) {
        if (!doubleRequested && !fox.snapshot.grounded && frame > 6) {
          fox.requestJump();
          doubleRequested = true;
        }
        step(fox, 1 / 60);
        apex = Math.max(apex, fox.position.y);
        sawGlide ||= fox.isGliding;
      }
      expect(fox.group.matrixWorld.elements.every(Number.isFinite), animal).toBe(true);
      expect(doubleRequested, animal).toBe(true);
      expect(sawGlide, animal).toBe(true);
      apexes.set(animal, apex);
    }
    expect(apexes.get('frog')!).toBeGreaterThan(apexes.get('bear')! + 0.4);
    expect(apexes.get('rabbit')!).toBeGreaterThan(apexes.get('penguin')!);
  });
});
