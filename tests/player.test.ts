import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { search: '' },
    configurable: true,
  });
});

import {
  FoxPlayer,
  PlayerInputController,
  ThirdPersonCamera,
  type FootstepEvent,
} from '../src/player';

function emitKey(target: EventTarget, type: 'keydown' | 'keyup', code: string, repeat = false): void {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: repeat },
  });
  target.dispatchEvent(event);
}

function minimumMeshTerrainClearance(
  mesh: THREE.Mesh,
  heightAt: (x: number, z: number) => number,
): number {
  mesh.updateWorldMatrix(true, false);
  const positions = mesh.geometry.getAttribute('position');
  const vertex = new THREE.Vector3();
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < positions.count; index += 1) {
    vertex.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
    minimum = Math.min(minimum, vertex.y - heightAt(vertex.x, vertex.z));
  }
  return minimum;
}

describe('PlayerInputController', () => {
  it('queues one jump per Space key edge and ignores key repeat', () => {
    const target = new EventTarget();
    const input = new PlayerInputController({ target: target as unknown as Window, document: null });

    emitKey(target, 'keydown', 'Space');
    expect(input.consumeJump()).toBe(true);
    expect(input.state.jumpHeld).toBe(true);
    expect(input.consumeJump()).toBe(false);
    emitKey(target, 'keydown', 'Space', true);
    expect(input.consumeJump()).toBe(false);
    emitKey(target, 'keyup', 'Space');
    expect(input.state.jumpHeld).toBe(false);
    emitKey(target, 'keydown', 'Space');
    expect(input.consumeJump()).toBe(true);
    input.setVirtualGlide(true);
    emitKey(target, 'keyup', 'Space');
    expect(input.state.jumpHeld).toBe(true);
    input.setVirtualGlide(false);
    expect(input.state.jumpHeld).toBe(false);
    input.dispose();
  });
});

describe('FoxPlayer', () => {
  it('switches local animal appearance without changing movement state', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const player = new FoxPlayer({ input, animal: 'penguin', skin: 'bluebell-penguin' });
    input.setVirtualInput(0.3, 1, true);
    for (let frame = 0; frame < 90; frame += 1) player.update(1 / 60, 0);
    const before = player.snapshot;
    const motionBefore = player.getMotionDebugSnapshot();

    player.setAnimal('axolotl', 'aurora-axolotl');

    expect(player.animal).toBe('axolotl');
    expect(player.skin).toBe('aurora-axolotl');
    expect(player.snapshot).toEqual(before);
    const motionAfter = player.getMotionDebugSnapshot();
    expect(motionAfter.gaitPhase).toBe(motionBefore.gaitPhase);
    expect(motionAfter.horizontalSpeed).toBe(motionBefore.horizontalSpeed);
    expect(player.group.getObjectByName('AxolotlGillLeft1')).toBeInstanceOf(THREE.Mesh);
    player.dispose();
  });

  it('moves forward relative to a south-facing camera and emits a lateral four-beat cadence', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const footsteps: FootstepEvent[] = [];
    const footfallFrames: number[] = [];
    input.setVirtualInput(0, 1);

    for (let frame = 0; frame < 180; frame += 1) {
      fox.update(1 / 60, 0, () => 2, () => 'stone', (event) => {
        footsteps.push(event);
        footfallFrames.push(frame);
      });
    }

    expect(fox.position.z).toBeLessThan(-5);
    expect(fox.position.y).toBeCloseTo(2, 2);
    expect(fox.snapshot.surface).toBe('stone');
    expect(footsteps.length).toBeGreaterThan(8);
    const openingSides = footsteps.slice(0, 4).map((event) => event.side);
    expect(openingSides.filter((side) => side === 'left')).toHaveLength(2);
    expect(openingSides.filter((side) => side === 'right')).toHaveLength(2);
    expect(openingSides.some((side, index) => side === openingSides[index + 1])).toBe(true);
    const beatIntervals = footfallFrames.slice(1).map((frame, index) => frame - footfallFrames[index]!);
    expect(Math.min(...beatIntervals)).toBeGreaterThanOrEqual(7);
    expect(Math.max(...beatIntervals)).toBeLessThanOrEqual(24);
    expect(footsteps.every((event) => event.surface === 'stone')).toBe(true);
    expect(footsteps.every((event) => !event.sprinting)).toBe(true);
    expect(footsteps.every((event) => event.position.y >= 2.01 && event.position.y <= 2.065)).toBe(true);
    expect(footsteps.every((event) => event.leg.endsWith(event.side === 'left' ? 'Left' : 'Right'))).toBe(true);
    expect(footsteps.every((event) => event.intensity >= 0.2 && event.intensity <= 1)).toBe(true);
    fox.dispose();
  });

  it('supports faster sprint movement', () => {
    const walkingInput = new PlayerInputController({ target: null, document: null });
    const sprintInput = new PlayerInputController({ target: null, document: null });
    const walker = new FoxPlayer({ input: walkingInput });
    const sprinter = new FoxPlayer({ input: sprintInput });
    walkingInput.setVirtualInput(0, 1, false);
    sprintInput.setVirtualInput(0, 1, true);

    for (let frame = 0; frame < 120; frame += 1) {
      walker.update(1 / 60, 0);
      sprinter.update(1 / 60, 0);
    }

    expect(Math.abs(walker.position.z)).toBeGreaterThan(6.5);
    expect(Math.abs(walker.position.z)).toBeLessThan(8.5);
    expect(Math.abs(sprinter.position.z)).toBeGreaterThan(10.5);
    expect(Math.abs(sprinter.position.z)).toBeLessThan(14.5);
    expect(Math.abs(sprinter.position.z)).toBeGreaterThan(Math.abs(walker.position.z) * 1.4);
    walker.dispose();
    sprinter.dispose();
  });

  it('emits every staggered sprint paw instead of suppressing the clustered strike', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const footfallFrames: number[] = [];
    const legs = new Set<string>();
    const clusteredIntensities: number[] = [];
    input.setVirtualInput(0, 1, true);

    for (let frame = 0; frame < 360; frame += 1) {
      fox.update(1 / 60, 0, () => 0, () => 'grass', (event) => {
        if (frame >= 150) {
          footfallFrames.push(frame);
          legs.add(event.leg);
          clusteredIntensities.push(event.intensity);
        }
      });
    }

    const intervals = footfallFrames.slice(1).map((frame, index) => frame - footfallFrames[index]!);
    expect(footfallFrames.length).toBeGreaterThan(14);
    expect([...legs].sort()).toEqual(['frontLeft', 'frontRight', 'hindLeft', 'hindRight']);
    // The visible paired strike remains two events at full lope.
    expect(Math.min(...intervals)).toBeLessThanOrEqual(3);
    expect(Math.max(...intervals)).toBeLessThanOrEqual(24);
    expect(Math.min(...clusteredIntensities)).toBeLessThan(Math.max(...clusteredIntensities));
    fox.dispose();
  });

  it.each([30, 60])('fires footsteps on the same rendered contact frame at %ifps', (fps) => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const contacts: Array<{ contact: boolean; clearance: number; plantWeight: number }> = [];
    const legs = new Set<string>();
    input.setVirtualInput(0.24, 1, true);

    for (let frame = 0; frame < fps * 6; frame += 1) {
      fox.update(1 / fps, 0, () => 0, () => 'grass', (event) => {
        const paw = fox.getMotionDebugSnapshot().rig.pose.legs[event.leg];
        contacts.push(paw);
        legs.add(event.leg);
      });
    }

    expect(contacts.length).toBeGreaterThan(14);
    expect([...legs].sort()).toEqual(['frontLeft', 'frontRight', 'hindLeft', 'hindRight']);
    expect(contacts.every((paw) => paw.contact)).toBe(true);
    expect(contacts.every((paw) => paw.clearance <= 0.061)).toBe(true);
    expect(contacts.every((paw) => paw.plantWeight >= 0.08)).toBe(true);
    fox.dispose();
  });

  it('suppresses cadence through anticipation, flight, and landing recovery', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const footfallStates: string[] = [];
    const actionFrames: number[] = [];
    input.setVirtualInput(0, 1, true);

    for (let frame = 0; frame < 270; frame += 1) {
      if (frame === 70) fox.requestJump();
      fox.update(
        1 / 60,
        0,
        () => 0,
        () => 'grass',
        () => footfallStates.push(fox.getMotionDebugSnapshot().locomotionState),
        (event) => {
          if (event.type === 'land') actionFrames.push(frame);
        },
      );
    }

    expect(actionFrames).toHaveLength(1);
    expect(footfallStates.length).toBeGreaterThan(8);
    expect(footfallStates.every((state) => state === 'walk' || state === 'run')).toBe(true);
    fox.dispose();
  });

  it('accelerates gracefully and preserves a short, bounded coast before stopping', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    fox.update(1 / 60, 0);
    input.setVirtualInput(0, 1);
    const acceleration: number[] = [];
    for (let frame = 0; frame < 36; frame += 1) {
      acceleration.push(fox.update(1 / 60, 0).speed);
    }

    expect(acceleration[2]).toBeGreaterThan(0);
    expect(acceleration[2]).toBeLessThan(acceleration[12]!);
    expect(acceleration[12]).toBeLessThan(acceleration[30]!);
    const cruisingSpeed = acceleration.at(-1)!;
    expect(cruisingSpeed).toBeGreaterThan(3.7);

    input.setVirtualInput(0, 0);
    const coast: number[] = [];
    for (let frame = 0; frame < 60; frame += 1) {
      coast.push(fox.update(1 / 60, 0).speed);
    }

    expect(coast[5]).toBeGreaterThan(cruisingSpeed * 0.5);
    expect(coast[20]).toBeGreaterThan(0.3);
    expect(coast[20]).toBeLessThan(cruisingSpeed * 0.28);
    expect(coast.at(-1)).toBeLessThan(0.06);
    fox.dispose();
  });

  it('curves through a turn smoothly, leans subtly, and settles without wobble', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const model = fox.group.getObjectByName('FoxModel')!;
    const heading = fox.group.getObjectByName('FoxHeadingPivot')!;
    input.setVirtualInput(0, 1);
    for (let frame = 0; frame < 90; frame += 1) fox.update(1 / 60, 0);

    input.setVirtualInput(1, 0);
    const headings: number[] = [heading.rotation.y];
    const leans: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      fox.update(1 / 60, 0);
      headings.push(heading.rotation.y);
      leans.push(model.rotation.z);
    }

    const headingSteps = headings.slice(1).map((heading, index) => Math.abs(
      Math.atan2(Math.sin(heading - headings[index]!), Math.cos(heading - headings[index]!)),
    ));
    expect(Math.max(...headingSteps)).toBeLessThan(0.18);
    expect(heading.rotation.y).toBeLessThan(-1.32);
    expect(Math.max(...leans.map(Math.abs))).toBeGreaterThan(0.018);
    expect(Math.max(...leans.map(Math.abs))).toBeLessThan(0.13);

    input.setVirtualInput(0, 0);
    for (let frame = 0; frame < 90; frame += 1) fox.update(1 / 60, 0);
    expect(Math.abs(model.rotation.z)).toBeLessThan(0.008);
    fox.dispose();
  });

  it('blends continuously from a four-beat walk into a rotary gallop', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const model = fox.group.getObjectByName('FoxModel')!;
    input.setVirtualInput(0, 1, false);
    for (let frame = 0; frame < 90; frame += 1) fox.update(1 / 60, 0);
    const walking = fox.getMotionDebugSnapshot();
    expect(walking.locomotionState).toBe('walk');
    expect(walking.runBlend).toBeLessThan(0.18);

    const runBlends: number[] = [];
    const bodyHeights: number[] = [];
    const strideExtensions: number[] = [];
    const spinePitches: number[] = [];
    input.setVirtualInput(0, 1, true);
    for (let frame = 0; frame < 120; frame += 1) {
      fox.update(1 / 60, 0);
      const debug = fox.getMotionDebugSnapshot();
      runBlends.push(debug.runBlend);
      bodyHeights.push(model.position.y);
      if (frame >= 60) {
        strideExtensions.push(debug.rig.pose.strideExtension);
        spinePitches.push(debug.rig.pose.spinePitch);
      }
    }

    const blendSteps = runBlends.slice(1).map((blend, index) => Math.abs(blend - runBlends[index]!));
    expect(runBlends[0]).toBeLessThan(runBlends.at(-1)!);
    expect(runBlends.at(-1)).toBeGreaterThan(0.82);
    expect(Math.max(...blendSteps)).toBeLessThan(0.04);
    expect(Math.max(...bodyHeights) - Math.min(...bodyHeights)).toBeGreaterThan(0.015);
    expect(Math.max(...bodyHeights) - Math.min(...bodyHeights)).toBeLessThan(0.18);
    expect(Math.max(...strideExtensions)).toBeGreaterThan(0.8);
    expect(Math.min(...strideExtensions)).toBeLessThan(-0.8);
    expect(Math.max(...spinePitches) - Math.min(...spinePitches)).toBeGreaterThan(0.24);
    expect(fox.getMotionDebugSnapshot().locomotionState).toBe('run');
    fox.dispose();
  });

  it('keeps four named legs and paws above the sampled ground while animated', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const pawNames = ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight']
      .map((name) => `Fox${name}Paw`);

    input.setVirtualInput(0.35, 1, true);
    for (let frame = 0; frame < 240; frame += 1) {
      if (frame === 72) input.setVirtualInput(-1, 0.08, true);
      if (frame === 132) input.setVirtualInput(0, 0, false);
      if (frame === 190) input.setVirtualInput(0.82, -1, true);
      fox.update(1 / 60, 0, () => 0, () => 'grass');
      if (frame % 12 === 0) {
        fox.group.updateMatrixWorld(true);
        for (const pawName of pawNames) {
          const paw = fox.group.getObjectByName(pawName);
          const bounds = new THREE.Box3().setFromObject(paw!);
          expect(bounds.min.y, `${pawName} should stay above ground throughout its stride at frame ${frame}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
    fox.group.updateMatrixWorld(true);

    for (const pawName of pawNames) {
      const paw = fox.group.getObjectByName(pawName);
      expect(paw, `${pawName} should exist`).toBeTruthy();
      const bounds = new THREE.Box3().setFromObject(paw!);
      expect(bounds.min.y, `${pawName} should not sink underground`).toBeGreaterThanOrEqual(0);
    }
    expect(fox.group.getObjectByName('FoxFrontLeftLeg')).toBeTruthy();
    expect(fox.group.getObjectByName('FoxFrontRightLeg')).toBeTruthy();
    expect(fox.group.getObjectByName('FoxHindLeftLeg')).toBeTruthy();
    expect(fox.group.getObjectByName('FoxHindRightLeg')).toBeTruthy();
    const model = fox.group.getObjectByName('FoxModel');
    expect(model?.scale.x).toBeGreaterThan(0.86);
    expect(model?.scale.x).toBeLessThan(0.94);
    const proportions = fox.getMotionDebugSnapshot().rig.proportions;
    expect(proportions.torsoLengthToWidth).toBeGreaterThanOrEqual(2);
    expect(proportions.headToTorsoWidth).toBeLessThan(0.7);
    expect(proportions.tailToTorsoLength).toBeGreaterThan(1.05);
    const foxBounds = new THREE.Box3().setFromObject(fox.group);
    expect(foxBounds.max.y).toBeGreaterThan(1.4);
    expect(foxBounds.max.y).toBeLessThan(2.4);
    fox.dispose();
  });

  it('snaps upward onto plaza tiers without sinking the paws through stone', () => {
    const fox = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    let tierHeight = 0;
    fox.update(1 / 60, 0, () => tierHeight, () => 'stone');
    tierHeight = 0.25;
    fox.update(1 / 60, 0, () => tierHeight, () => 'stone');

    expect(fox.position.y).toBeCloseTo(0.25, 6);
    fox.group.updateMatrixWorld(true);
    for (const name of ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight']) {
      const paw = fox.group.getObjectByName(`Fox${name}Paw`)!;
      expect(new THREE.Box3().setFromObject(paw).min.y).toBeGreaterThanOrEqual(tierHeight);
    }
    fox.dispose();
  });

  it('pitches in local heading space and plants actual paws across a side-facing slope', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const slope = (x: number): number => -0.18 * x;
    const heightAt = (x: number, _z: number): number => slope(x);
    input.setVirtualInput(1, 0, false);
    for (let frame = 0; frame < 120; frame += 1) fox.update(1 / 60, 0, heightAt, () => 'grass');
    input.setVirtualInput(0, 0, false);
    for (let frame = 0; frame < 60; frame += 1) fox.update(1 / 60, 0, heightAt, () => 'grass');

    fox.group.updateMatrixWorld(true);
    const model = fox.group.getObjectByName('FoxModel')!;
    const orientation = model.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation);
    expect(forward.x).toBeGreaterThan(0.9);
    expect(forward.y).toBeLessThan(-0.08);
    expect(Math.abs(right.y)).toBeLessThan(0.045);

    for (const name of ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight']) {
      const paw = fox.group.getObjectByName(`Fox${name}Paw`) as THREE.Mesh;
      const clearance = minimumMeshTerrainClearance(paw, heightAt);
      expect(clearance, `${name} paw should clear its actual local slope`).toBeGreaterThanOrEqual(-0.015);
      expect(clearance, `${name} paw should remain close to its actual local slope`).toBeLessThan(0.12);
    }
    fox.dispose();
  });

  it('follows a responsive jump arc and reports jump and landing actions', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const actions: Array<{ type: string; surface: string; intensity: number }> = [];
    fox.update(1 / 60, 0, () => 1.5, () => 'stone');
    fox.requestJump();
    let highest = fox.position.y;

    for (let frame = 0; frame < 150; frame += 1) {
      fox.update(1 / 60, 0, () => 1.5, () => 'stone', undefined, (event) => actions.push(event));
      highest = Math.max(highest, fox.position.y);
    }

    expect(highest).toBeGreaterThan(2.7);
    expect(fox.position.y).toBeCloseTo(1.5, 3);
    expect(fox.snapshot.grounded).toBe(true);
    expect(fox.snapshot.jumpsUsed).toBe(0);
    expect(actions.map((event) => event.type)).toEqual(['jump', 'land']);
    expect(actions[1]?.surface).toBe('stone');
    expect(actions[1]?.intensity).toBeGreaterThan(0.25);
    fox.dispose();
  });

  it('allows exactly two jumps while airborne and resets the allowance on landing', () => {
    const fox = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    const actions: string[] = [];
    const update = () => fox.update(1 / 60, 0, () => 0, () => 'grass', undefined, (event) => actions.push(event.type));
    update();

    fox.requestJump();
    for (let frame = 0; frame < 12 && !actions.includes('jump'); frame += 1) update();
    expect(actions).toEqual(['jump']);
    expect(fox.snapshot.jumpsUsed).toBe(1);

    fox.requestJump();
    update();
    fox.requestJump();
    update();
    expect(actions.filter((type) => type.includes('jump'))).toEqual(['jump', 'double-jump']);
    expect(fox.snapshot.jumpsUsed).toBe(2);

    for (let frame = 0; frame < 180 && !fox.snapshot.grounded; frame += 1) update();
    expect(fox.snapshot.grounded).toBe(true);
    expect(fox.snapshot.jumpsUsed).toBe(0);

    fox.requestJump();
    for (let frame = 0; frame < 12 && actions.filter((type) => type === 'jump').length < 2; frame += 1) update();
    expect(actions.filter((type) => type.includes('jump'))).toEqual(['jump', 'double-jump', 'jump']);
    fox.dispose();
  });

  it('preserves a rapid second jump tap through the takeoff anticipation', () => {
    const fox = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    const actions: string[] = [];
    const update = () => fox.update(1 / 60, 0, () => 0, () => 'grass', undefined, (event) => actions.push(event.type));
    update();
    fox.requestJump();
    update();
    fox.requestJump();
    for (let frame = 0; frame < 16 && actions.length < 2; frame += 1) update();

    expect(actions.slice(0, 2)).toEqual(['jump', 'double-jump']);
    expect(fox.snapshot.jumpsUsed).toBe(2);
    fox.dispose();
  });

  it('glides while jump is held, streams its legs, and does not create extra jump edges', () => {
    const fox = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    const actions: string[] = [];
    const update = () => fox.update(1 / 60, 0, () => 0, () => 'grass', undefined, (event) => actions.push(event.type));
    update();
    fox.requestJump();
    fox.setGlideHeld(true);

    let apex = fox.position.y;
    let glideEntryVelocity: number | undefined;
    for (let frame = 0; frame < 60; frame += 1) {
      update();
      apex = Math.max(apex, fox.position.y);
      if (fox.isGliding && glideEntryVelocity === undefined) glideEntryVelocity = fox.snapshot.verticalSpeed;
    }

    expect(fox.isGliding).toBe(true);
    expect(fox.snapshot.grounded).toBe(false);
    expect(apex).toBeGreaterThan(1.2);
    expect(glideEntryVelocity).toBeLessThanOrEqual(0.5);
    expect(fox.position.y).toBeGreaterThan(0.45);
    expect(fox.snapshot.verticalSpeed).toBeGreaterThan(-3.2);
    expect(actions.filter((type) => type.includes('jump'))).toEqual(['jump']);
    const glidePose = fox.getMotionDebugSnapshot();
    expect(glidePose.airPose).toBe('glide');
    expect(glidePose.rig.pose.legs.frontLeft.hip - glidePose.rig.pose.legs.hindLeft.hip).toBeGreaterThan(0.65);
    fox.dispose();
  });

  it('returns to a full fall when glide is released and lands gracefully', () => {
    const fox = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    const actions: string[] = [];
    const update = () => fox.update(1 / 60, 0, () => 0, () => 'stone', undefined, (event) => actions.push(event.type));
    update();
    fox.requestJump();
    fox.setGlideHeld(true);
    for (let frame = 0; frame < 62; frame += 1) update();
    const releaseHeight = fox.position.y;

    fox.setGlideHeld(false);
    update();
    expect(fox.isGliding).toBe(false);
    for (let frame = 0; frame < 90 && !fox.snapshot.grounded; frame += 1) update();

    expect(fox.position.y).toBeLessThan(releaseHeight);
    expect(fox.snapshot.grounded).toBe(true);
    expect(fox.position.y).toBeCloseTo(0, 3);
    expect(actions).toEqual(['jump', 'land']);
    fox.dispose();
  });

  it('keeps glide physics while reducing the expressive pose in gentle-motion mode', () => {
    const full = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    const gentle = new FoxPlayer({
      input: new PlayerInputController({ target: null, document: null }),
      reducedMotion: true,
    });
    const advance = (fox: FoxPlayer): void => {
      fox.update(1 / 60, 0, () => 0, () => 'grass');
      fox.requestJump();
      fox.setGlideHeld(true);
      for (let frame = 0; frame < 60; frame += 1) {
        fox.update(1 / 60, 0, () => 0, () => 'grass');
      }
    };

    advance(full);
    advance(gentle);
    const fullReach = Math.abs(full.group.getObjectByName('FoxFrontLeftLegPivot')!.rotation.x);
    const gentleReach = Math.abs(gentle.group.getObjectByName('FoxFrontLeftLegPivot')!.rotation.x);
    expect(full.isGliding).toBe(true);
    expect(gentle.isGliding).toBe(true);
    expect(gentleReach).toBeLessThan(fullReach * 0.55);
    full.dispose();
    gentle.dispose();
  });

  it('disposes pooled magical geometry and materials exactly once', () => {
    const fox = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    fox.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    });
    const geometrySpies = [...geometries].map((geometry) => vi.spyOn(geometry, 'dispose'));
    const materialSpies = [...materials].map((material) => vi.spyOn(material, 'dispose'));

    fox.dispose();
    fox.dispose();

    geometrySpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    materialSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });
});

describe('ThirdPersonCamera', () => {
  it('stays above sampled terrain and looks toward the player', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({ camera, distance: 8 });
    const target = new THREE.Vector3(0, 0, 0);

    controller.update(1 / 60, target, () => 2.8);

    expect(camera.position.y).toBeGreaterThanOrEqual(2.8);
    expect(camera.position.z).toBeGreaterThan(0);
    controller.dispose();
  });

  it('shortens its boom when an obstacle blocks the requested orbit', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({ camera, distance: 10, minDistance: 3 });
    const target = new THREE.Vector3(0, 0, 0);
    controller.update(1 / 60, target, () => 0, (_x, _y, z) => z > 5);
    const blockedDistance = camera.position.distanceTo(new THREE.Vector3(0, 1.18, 0));

    expect(blockedDistance).toBeLessThan(9);
    controller.dispose();
  });
});
