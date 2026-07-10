import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { search: '' },
    configurable: true,
  });
});

import { FoxPlayer, PlayerInputController, ThirdPersonCamera } from '../src/player';

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
