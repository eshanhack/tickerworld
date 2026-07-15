import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { FoxPlayer, type FoxActionEvent } from '../src/player/FoxPlayer';
import { PlayerInputController } from '../src/player/InputController';
import { parseRemote } from '../src/net/RoomClientSystem';
import {
  DEFAULT_MOVEMENT_TUNING,
  cloneMovementTuning,
  movementTuningCode,
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

  it('keeps every runtime constant centralized, editable, and exportable', () => {
    const tuning = cloneMovementTuning();
    expect(setMovementTuningValue(tuning, 'jump.fallGravityScale', 2.05)).toBe(true);
    expect(tuning.jump.fallGravityScale).toBe(2.05);
    expect(setMovementTuningValue(tuning, 'jump.missing', 2)).toBe(false);
    expect(movementTuningCode(tuning)).toContain('"fallGravityScale": 2.05');
    expect(DEFAULT_MOVEMENT_TUNING.simulation.fixedStepSeconds).toBeCloseTo(1 / 60, 8);
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
      movementState: '',
      gaitPhase: 0,
      movementBlend: 0,
      runBlend: 0,
      airProgress: 0,
      simulationTick: 0,
      animal: 'fox',
      skin: 'base',
      username: null,
      updatedAt: 1,
    });
    expect(legacy?.movementState).toBeUndefined();
    expect(legacy?.gaitPhase).toBeUndefined();
    expect(legacy?.movementBlend).toBeUndefined();
    expect(legacy?.runBlend).toBeUndefined();
    expect(legacy?.airProgress).toBeUndefined();
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
