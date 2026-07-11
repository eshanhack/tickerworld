import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { search: '' },
    configurable: true,
  });
});

import { FoxPlayer, PlayerInputController, ThirdPersonCamera } from '../src/player';

function emitKey(target: EventTarget, type: 'keydown' | 'keyup', code: string, repeat = false): void {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: repeat },
  });
  target.dispatchEvent(event);
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
  it('moves forward relative to a south-facing camera and emits alternating footsteps', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const sides: string[] = [];
    input.setVirtualInput(0, 1);

    for (let frame = 0; frame < 180; frame += 1) {
      fox.update(1 / 60, 0, () => 2, () => 'stone', (event) => sides.push(event.side));
    }

    expect(fox.position.z).toBeLessThan(-5);
    expect(fox.position.y).toBeCloseTo(2, 2);
    expect(fox.snapshot.surface).toBe('stone');
    expect(sides.length).toBeGreaterThan(2);
    expect(sides.slice(0, 2)).toEqual(['left', 'right']);
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

    expect(Math.abs(sprinter.position.z)).toBeGreaterThan(Math.abs(walker.position.z) * 1.4);
    walker.dispose();
    sprinter.dispose();
  });

  it('keeps four named legs and paws above the sampled ground while animated', () => {
    const input = new PlayerInputController({ target: null, document: null });
    const fox = new FoxPlayer({ input });
    const pawNames = ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight']
      .map((name) => `Fox${name}Paw`);

    input.setVirtualInput(0.35, 1, true);
    for (let frame = 0; frame < 240; frame += 1) {
      fox.update(1 / 60, 0, () => 0, () => 'grass');
      if (frame % 12 === 0) {
        fox.group.updateMatrixWorld(true);
        for (const pawName of pawNames) {
          const paw = fox.group.getObjectByName(pawName);
          const bounds = new THREE.Box3().setFromObject(paw!);
          expect(bounds.min.y, `${pawName} should stay above ground throughout its stride`).toBeGreaterThanOrEqual(-0.02);
        }
      }
    }
    fox.group.updateMatrixWorld(true);

    for (const pawName of pawNames) {
      const paw = fox.group.getObjectByName(pawName);
      expect(paw, `${pawName} should exist`).toBeTruthy();
      const bounds = new THREE.Box3().setFromObject(paw!);
      expect(bounds.min.y, `${pawName} should not sink underground`).toBeGreaterThanOrEqual(-0.02);
    }
    expect(fox.group.getObjectByName('FoxFrontLeftLeg')).toBeTruthy();
    expect(fox.group.getObjectByName('FoxFrontRightLeg')).toBeTruthy();
    expect(fox.group.getObjectByName('FoxHindLeftLeg')).toBeTruthy();
    expect(fox.group.getObjectByName('FoxHindRightLeg')).toBeTruthy();
    const model = fox.group.getObjectByName('FoxModel');
    expect(model?.scale.x).toBeGreaterThan(0.74);
    expect(model?.scale.x).toBeLessThan(0.82);
    const foxBounds = new THREE.Box3().setFromObject(fox.group);
    expect(foxBounds.max.y).toBeLessThan(2.2);
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
    update();
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
    update();
    expect(actions.filter((type) => type.includes('jump'))).toEqual(['jump', 'double-jump', 'jump']);
    fox.dispose();
  });

  it('glides while jump is held, streams its legs, and does not create extra jump edges', () => {
    const fox = new FoxPlayer({ input: new PlayerInputController({ target: null, document: null }) });
    const actions: string[] = [];
    const update = () => fox.update(1 / 60, 0, () => 0, () => 'grass', undefined, (event) => actions.push(event.type));
    update();
    fox.requestJump();
    fox.setGlideHeld(true);

    for (let frame = 0; frame < 60; frame += 1) update();

    expect(fox.isGliding).toBe(true);
    expect(fox.snapshot.grounded).toBe(false);
    expect(fox.position.y).toBeGreaterThan(2.2);
    expect(fox.snapshot.verticalSpeed).toBeGreaterThan(-3.2);
    expect(actions.filter((type) => type.includes('jump'))).toEqual(['jump']);
    expect(fox.group.getObjectByName('FoxFrontLeftLegPivot')!.rotation.x).toBeGreaterThan(0.45);
    expect(fox.group.getObjectByName('FoxHindLeftLegPivot')!.rotation.x).toBeLessThan(-0.3);
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
