import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { SurfaceKind } from '../src/types';
import { FoxPlayer, type FoxActionEvent } from '../src/player/FoxPlayer';
import { FoxRig } from '../src/player/FoxRig';
import {
  FOX_LEG_KEYS,
  sampleFoxLegMotion,
  type FoxLegKey,
} from '../src/player/foxMotion';
import { PlayerInputController } from '../src/player/InputController';

const TAU = Math.PI * 2;
const FLAT_HEIGHT = (): number => 0;
const GRASS_SURFACE = (): SurfaceKind => 'grass';
const players: FoxPlayer[] = [];

function createPlayer(): { fox: FoxPlayer; input: PlayerInputController } {
  const input = new PlayerInputController({ target: null, document: null });
  const fox = new FoxPlayer({ input });
  players.push(fox);
  return { fox, input };
}

function updatePlayer(
  fox: FoxPlayer,
  deltaSeconds: number,
  onAction?: (event: FoxActionEvent) => void,
): void {
  fox.update(
    deltaSeconds,
    0,
    FLAT_HEIGHT,
    GRASS_SURFACE,
    undefined,
    onAction,
  );
}

function disposeRig(rig: FoxRig): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  rig.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    meshMaterials.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function dominantPeakCount(values: readonly number[]): number {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const threshold = minimum + (maximum - minimum) * 0.68;
  let peaks = 0;

  for (let index = 1; index < values.length - 1; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    const next = values[index + 1]!;
    if (current > previous && current >= next && current > threshold) peaks += 1;
  }
  return peaks;
}

afterEach(() => {
  for (const player of players.splice(0)) player.dispose();
});

describe('fox locomotion acceptance', () => {
  it('keeps a true four-beat walk with one separated contact per paw', () => {
    const sampleCount = 960;
    const landings: Array<{ leg: FoxLegKey; phase: number }> = [];

    for (const leg of FOX_LEG_KEYS) {
      let previous = sampleFoxLegMotion(leg, -TAU / sampleCount, 0).contact;
      for (let index = 0; index < sampleCount; index += 1) {
        const phase = (index / sampleCount) * TAU;
        const contact = sampleFoxLegMotion(leg, phase, 0).contact;
        if (!previous && contact) landings.push({ leg, phase: phase / TAU });
        previous = contact;
      }
    }

    expect(landings).toHaveLength(4);
    expect(new Set(landings.map(({ leg }) => leg))).toEqual(new Set(FOX_LEG_KEYS));

    const ordered = [...landings].sort((left, right) => left.phase - right.phase);
    const cyclicGaps = ordered.map(({ phase }, index) => {
      const next = ordered[(index + 1) % ordered.length]!.phase;
      return next > phase ? next - phase : next + 1 - phase;
    });
    expect(Math.min(...cyclicGaps)).toBeGreaterThan(0.18);
    expect(Math.max(...cyclicGaps)).toBeLessThan(0.32);
  });

  it('has one dominant gather, stretch, and suspension body arc per run cycle', () => {
    const rig = new FoxRig();
    const steps = 240;
    const bodyHeights: number[] = [];
    const extensions: number[] = [];
    let elapsedSeconds = 0;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let index = 0; index < steps; index += 1) {
        const gaitPhase = -Math.PI / 2 + (index / steps) * TAU;
        elapsedSeconds += 1 / 120;
        rig.updatePose({
          deltaSeconds: 1 / 120,
          elapsedSeconds,
          gaitPhase,
          movementBlend: 1,
          runBlend: 1,
        });
        if (cycle === 2) {
          bodyHeights.push(rig.root.position.y);
          extensions.push(rig.getDebugSnapshot().pose.strideExtension);
        }
      }
    }

    const hasSuspension = Array.from({ length: steps }, (_, index) => {
      const gaitPhase = -Math.PI / 2 + (index / steps) * TAU;
      return FOX_LEG_KEYS.every((leg) => !sampleFoxLegMotion(leg, gaitPhase, 1).contact);
    }).some(Boolean);

    expect(Math.max(...extensions)).toBeGreaterThan(0.95);
    expect(Math.min(...extensions)).toBeLessThan(-0.95);
    expect(Math.max(...bodyHeights) - Math.min(...bodyHeights)).toBeGreaterThan(0.02);
    expect(dominantPeakCount(bodyHeights)).toBe(1);
    expect(hasSuspension).toBe(true);
    disposeRig(rig);
  });

  it('anticipates a grounded jump for 80-130ms before takeoff', () => {
    const { fox } = createPlayer();
    const deltaSeconds = 1 / 120;
    updatePlayer(fox, deltaSeconds);
    fox.requestJump();

    let elapsedSeconds = 0;
    let jumpAt: number | undefined;
    let firstRiseAt: number | undefined;
    let maximumPrelaunchVelocity = 0;
    let sawAnticipation = false;

    for (let frame = 0; frame < 40 && jumpAt === undefined; frame += 1) {
      elapsedSeconds += deltaSeconds;
      updatePlayer(fox, deltaSeconds, (event) => {
        if (event.type === 'jump') jumpAt = elapsedSeconds;
      });
      const debug = fox.getMotionDebugSnapshot();
      sawAnticipation ||= debug.airPose === 'anticipate';
      if (jumpAt === undefined) {
        maximumPrelaunchVelocity = Math.max(maximumPrelaunchVelocity, debug.verticalVelocity);
      }
      if (firstRiseAt === undefined && debug.verticalVelocity > 0.05) firstRiseAt = elapsedSeconds;
    }

    expect(sawAnticipation).toBe(true);
    expect(jumpAt).toBeGreaterThanOrEqual(0.08);
    expect(jumpAt).toBeLessThanOrEqual(0.13 + deltaSeconds);
    expect(maximumPrelaunchVelocity).toBeLessThanOrEqual(0.001);
    expect(firstRiseAt).toBeGreaterThanOrEqual(jumpAt! - deltaSeconds);
  });

  it('preserves normal takeoff gravity while held jump becomes a near-apex glide', () => {
    const held = createPlayer().fox;
    const released = createPlayer().fox;
    const deltaSeconds = 1 / 120;
    updatePlayer(held, deltaSeconds);
    updatePlayer(released, deltaSeconds);
    held.setGlideHeld(true);
    held.requestJump();
    released.requestJump();

    let elapsedSeconds = 0;
    let launchAt: number | undefined;
    let firstGlideVelocity: number | undefined;
    let firstGlidePose: string | undefined;
    let earlyComparisons = 0;

    for (let frame = 0; frame < 180; frame += 1) {
      elapsedSeconds += deltaSeconds;
      updatePlayer(held, deltaSeconds, (event) => {
        if (event.type === 'jump') launchAt ??= elapsedSeconds;
      });
      updatePlayer(released, deltaSeconds);

      if (launchAt !== undefined && elapsedSeconds - launchAt <= 0.18) {
        expect(Math.abs(held.snapshot.verticalSpeed - released.snapshot.verticalSpeed)).toBeLessThan(0.04);
        expect(Math.abs(held.position.y - released.position.y)).toBeLessThan(0.015);
        earlyComparisons += 1;
      }
      if (held.snapshot.verticalSpeed > 1.2) expect(held.isGliding).toBe(false);
      if (held.isGliding && firstGlideVelocity === undefined) {
        firstGlideVelocity = held.snapshot.verticalSpeed;
        firstGlidePose = held.getMotionDebugSnapshot().airPose;
      }
    }

    expect(earlyComparisons).toBeGreaterThan(10);
    expect(firstGlideVelocity).toBeDefined();
    expect(firstGlideVelocity).toBeLessThanOrEqual(1.2);
    expect(firstGlideVelocity).toBeGreaterThan(-2.6);
    expect(firstGlidePose).toBe('glide');
  });

  it('uses an articulated double-jump kick without rotating the root through a full flip', () => {
    const { fox } = createPlayer();
    const deltaSeconds = 1 / 120;
    const actions: string[] = [];
    updatePlayer(fox, deltaSeconds);
    fox.requestJump();

    for (let frame = 0; frame < 30 && !actions.includes('jump'); frame += 1) {
      updatePlayer(fox, deltaSeconds, (event) => actions.push(event.type));
    }
    for (let frame = 0; frame < 5; frame += 1) updatePlayer(fox, deltaSeconds);
    fox.requestJump();

    const model = fox.group.getObjectByName('FoxModel');
    expect(model).toBeInstanceOf(THREE.Group);
    let previousPitch = model!.rotation.x;
    let unwrappedPitch = previousPitch;
    let minimumPitch = unwrappedPitch;
    let maximumPitch = unwrappedPitch;

    for (let frame = 0; frame < 150; frame += 1) {
      updatePlayer(fox, deltaSeconds, (event) => actions.push(event.type));
      const pitch = model!.rotation.x;
      unwrappedPitch += Math.atan2(Math.sin(pitch - previousPitch), Math.cos(pitch - previousPitch));
      previousPitch = pitch;
      minimumPitch = Math.min(minimumPitch, unwrappedPitch);
      maximumPitch = Math.max(maximumPitch, unwrappedPitch);
    }

    expect(actions.filter((action) => action.includes('jump'))).toEqual(['jump', 'double-jump']);
    expect(maximumPitch - minimumPitch).toBeLessThan(Math.PI);
  });

  it('passes through landing recovery and settles into a clean grounded state', () => {
    const { fox } = createPlayer();
    const deltaSeconds = 1 / 120;
    const poses = new Set<string>();
    let landedAt: number | undefined;
    let elapsedSeconds = 0;
    updatePlayer(fox, deltaSeconds);
    fox.requestJump();

    for (let frame = 0; frame < 300; frame += 1) {
      elapsedSeconds += deltaSeconds;
      updatePlayer(fox, deltaSeconds, (event) => {
        if (event.type === 'land') landedAt ??= elapsedSeconds;
      });
      poses.add(fox.getMotionDebugSnapshot().airPose);
      if (landedAt !== undefined && elapsedSeconds - landedAt >= 0.5) break;
    }

    const finalDebug = fox.getMotionDebugSnapshot();
    expect(landedAt).toBeDefined();
    expect(poses.has('rise')).toBe(true);
    expect(poses.has('fall')).toBe(true);
    expect(poses.has('land')).toBe(true);
    expect(fox.snapshot.grounded).toBe(true);
    expect(fox.snapshot.jumpsUsed).toBe(0);
    expect(finalDebug.airPose).toBe('grounded');
    expect(Math.abs(finalDebug.verticalVelocity)).toBeLessThan(0.001);
    expect(String(finalDebug.locomotionState)).not.toMatch(/air|jump|fall|glide|land/i);
    expect(finalDebug.rig.pose.airPose).toBe('grounded');
  });

  it('keeps sprint travel and jump apex stable at 30, 60, and 120fps', () => {
    const rates = [30, 60, 120] as const;
    const travelDistances = rates.map((fps) => {
      const { fox, input } = createPlayer();
      const deltaSeconds = 1 / fps;
      updatePlayer(fox, deltaSeconds);
      input.setVirtualInput(0, 1, true);
      for (let frame = 0; frame < fps * 2; frame += 1) updatePlayer(fox, deltaSeconds);
      expect(Number.isFinite(fox.headingYaw)).toBe(true);
      expect(fox.normalizedSpeed).toBeGreaterThan(0.9);
      expect(fox.normalizedSpeed).toBeLessThanOrEqual(1.01);
      return Math.hypot(fox.position.x, fox.position.z);
    });

    const apexHeights = rates.map((fps) => {
      const { fox } = createPlayer();
      const deltaSeconds = 1 / fps;
      updatePlayer(fox, deltaSeconds);
      fox.requestJump();
      let apex = fox.position.y;
      for (let frame = 0; frame < fps * 1.5; frame += 1) {
        updatePlayer(fox, deltaSeconds);
        apex = Math.max(apex, fox.position.y);
      }
      return apex;
    });

    const meanTravel = travelDistances.reduce((sum, value) => sum + value, 0) / travelDistances.length;
    expect(meanTravel).toBeGreaterThan(8);
    expect(meanTravel).toBeLessThan(15);
    expect(Math.max(...travelDistances) - Math.min(...travelDistances)).toBeLessThan(meanTravel * 0.04);
    expect(Math.min(...apexHeights)).toBeGreaterThan(0.9);
    expect(Math.max(...apexHeights)).toBeLessThan(2.3);
    expect(Math.max(...apexHeights) - Math.min(...apexHeights)).toBeLessThan(0.16);
  });
});
