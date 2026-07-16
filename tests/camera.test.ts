import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { ThirdPersonCamera } from '../src/player/ThirdPersonCamera';
import { cloneMovementTuning } from '../src/player/MovementConfig';

const FLAT_GROUND = (): number => 0;
const TARGET = new THREE.Vector3();

class PointerSurface extends EventTarget {
  public setPointerCapture(_pointerId: number): void {}

  public releasePointerCapture(_pointerId: number): void {}
}

function pointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

function advance(
  controller: ThirdPersonCamera,
  frames: number,
  obstacleAt?: (x: number, y: number, z: number) => boolean,
): void {
  for (let frame = 0; frame < frames; frame += 1) {
    controller.update(1 / 60, TARGET, FLAT_GROUND, obstacleAt);
  }
}

describe('ThirdPersonCamera chase motion', () => {
  it('can start at the outer zoom bound without changing subsequent zoom bounds', () => {
    const controller = new ThirdPersonCamera({
      camera: new THREE.PerspectiveCamera(),
      distance: 8,
      maxDistance: 14,
      startAtMaxDistance: true,
    });

    expect(controller.zoomDistance).toBe(14);
    controller.setOrbit(0, 0.35, 8);
    expect(controller.zoomDistance).toBe(8);
    controller.setOrbit(0, 0.35, 50);
    expect(controller.zoomDistance).toBe(14);
    controller.dispose();
  });

  it('preserves the legacy default boom and fox framing', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({ camera, distance: 8 });

    controller.update(1 / 60, TARGET, FLAT_GROUND);

    expect(camera.position.x).toBeCloseTo(0, 8);
    expect(camera.position.y).toBeCloseTo(3.59318, 4);
    expect(camera.position.z).toBeCloseTo(7.51498, 4);
    expect(camera.getWorldDirection(new THREE.Vector3()).y).toBeCloseTo(-Math.sin(0.35), 5);
    controller.dispose();
  });

  it('looks at the lean fox height by default', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({ camera, distance: 8 });

    controller.update(1 / 60, TARGET, FLAT_GROUND);

    const expectedFocus = new THREE.Vector3(0, 0.85, 0);
    const expectedDirection = expectedFocus.clone().sub(camera.position).normalize();
    const actualDirection = camera.getWorldDirection(new THREE.Vector3());
    expect(actualDirection.dot(expectedDirection)).toBeGreaterThan(0.999999);
    controller.dispose();
  });

  it('gently recenters behind the fox only after sustained movement', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({ camera, yaw: 1.2, distance: 8 });
    controller.setChaseMotion(0, 1);

    advance(controller, 60);
    expect(controller.yaw).toBeCloseTo(1.2, 8);

    advance(controller, 60);
    expect(controller.yaw).toBeGreaterThan(0);
    expect(controller.yaw).toBeLessThan(0.36);

    controller.setOrbit(0, 0.35);
    controller.setChaseMotion(Math.PI / 2, 1);
    advance(controller, 240);
    expect(controller.yaw).toBeCloseTo(Math.PI / 2, 1);
    expect(camera.position.x).toBeGreaterThan(7);
    controller.dispose();
  });

  it('does not let lateral camera-relative input steer its own camera basis', () => {
    const controller = new ThirdPersonCamera({
      camera: new THREE.PerspectiveCamera(),
      yaw: 0,
      distance: 8,
    });
    controller.setChaseMotion(-Math.PI / 2, 1, 0);
    advance(controller, 600);

    expect(controller.yaw).toBeCloseTo(0, 8);
    controller.dispose();
  });

  it('lets a pointer orbit linger before chase recentering resumes', () => {
    const surface = new PointerSurface();
    const controller = new ThirdPersonCamera({
      camera: new THREE.PerspectiveCamera(),
      domElement: surface as unknown as HTMLElement,
      yaw: 1,
    });
    controller.setChaseMotion(0, 1);
    advance(controller, 120);

    surface.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    surface.dispatchEvent(pointerEvent('pointermove', 40, 100));
    surface.dispatchEvent(pointerEvent('pointerup', 40, 100));
    const draggedYaw = controller.yaw;

    advance(controller, 60);
    expect(controller.yaw).toBeCloseTo(draggedYaw, 8);
    advance(controller, 30);
    expect(Math.abs(controller.yaw)).toBeLessThan(Math.abs(draggedYaw));
    controller.dispose();
  });

  it('lets vertical pointer orbit aim about 55 degrees into the sky', () => {
    const surface = new PointerSurface();
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({
      camera,
      domElement: surface as unknown as HTMLElement,
      distance: 8,
    });

    surface.dispatchEvent(pointerEvent('pointerdown', 100, 240));
    surface.dispatchEvent(pointerEvent('pointermove', 100, -120));
    surface.dispatchEvent(pointerEvent('pointerup', 100, -120));
    controller.update(1 / 60, TARGET, FLAT_GROUND);

    const direction = camera.getWorldDirection(new THREE.Vector3());
    expect(controller.pitch).toBeCloseTo(-0.96, 8);
    expect(THREE.MathUtils.radToDeg(Math.asin(direction.y))).toBeCloseTo(55, 0);
    expect(direction.z).toBeLessThan(0);
    controller.dispose();
  });

  it('keeps the camera above uneven terrain while aiming fully upward', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({ camera, distance: 8 });
    controller.setOrbit(0, -0.96);
    let terrainHeight = 0;
    const raisedGround = (): number => terrainHeight;

    controller.update(1 / 60, TARGET, raisedGround);
    terrainHeight = 2.5;
    controller.update(1 / 60, TARGET, raisedGround);

    expect(camera.position.y).toBeGreaterThanOrEqual(2.88 - 0.000001);
    expect(camera.getWorldDirection(new THREE.Vector3()).y).toBeGreaterThan(0.81);
    controller.dispose();
  });

  it('adds bounded run framing without changing zoom and still obeys collision', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({ camera, distance: 8, autoRecenter: false });
    controller.setChaseMotion(0, 1);
    advance(controller, 240);

    const runningFocus = new THREE.Vector3(0, 0.85, -0.55);
    const runningDistance = camera.position.distanceTo(runningFocus);
    expect(controller.zoomDistance).toBe(8);
    expect(runningDistance).toBeGreaterThan(8.65);
    expect(runningDistance).toBeLessThanOrEqual(8.701);

    advance(controller, 120, () => true);
    expect(camera.position.distanceTo(runningFocus)).toBeLessThan(4.4);
    expect(controller.zoomDistance).toBe(8);

    advance(controller, 180);
    expect(camera.position.distanceTo(runningFocus)).toBeGreaterThan(8.5);

    controller.setChaseMotion(0, 0);
    advance(controller, 240);
    expect(camera.position.distanceTo(new THREE.Vector3(0, 0.85, 0))).toBeCloseTo(8, 2);
    controller.dispose();
  });

  it('subdues automatic framing and disables recentering in reduced motion', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new ThirdPersonCamera({
      camera,
      distance: 8,
      yaw: 1,
      reducedMotion: true,
    });
    controller.setChaseMotion(0, 1);
    advance(controller, 240);

    const gentleFocus = new THREE.Vector3(0, 0.85, -0.11);
    expect(controller.yaw).toBeCloseTo(1, 8);
    expect(camera.position.distanceTo(gentleFocus)).toBeGreaterThan(8.1);
    expect(camera.position.distanceTo(gentleFocus)).toBeLessThan(8.17);
    controller.dispose();
  });

  it('adds state-driven run/glide FOV, pullback, bank, and a decaying landing dip', () => {
    const camera = new THREE.PerspectiveCamera(52, 1, 0.08, 360);
    const controller = new ThirdPersonCamera({ camera, distance: 8, autoRecenter: false });
    controller.setMovementPresentation('run', 0, 1, 0);
    advance(controller, 180);
    expect(camera.fov).toBeGreaterThan(55.5);
    expect(camera.fov).toBeLessThan(56.1);
    const runDistance = camera.position.distanceTo(TARGET.clone().setY(0.85).add(new THREE.Vector3(0, 0, -0.55)));

    controller.setMovementPresentation('glide', 0, 1, 1);
    advance(controller, 180);
    expect(camera.fov).toBeGreaterThan(58.5);
    expect(camera.rotation.z).toBeLessThan(-0.02);
    const glideDistance = camera.position.distanceTo(TARGET.clone().setY(0.85).add(new THREE.Vector3(0, 0, -1.15)));
    expect(glideDistance).toBeGreaterThan(runDistance + 0.4);

    const beforeDip = camera.position.y;
    controller.triggerLanding(1, true);
    controller.setMovementPresentation('land-heavy', 0, 0, 0);
    controller.update(1 / 60, TARGET, () => 0);
    expect(camera.position.y).toBeLessThan(beforeDip);
    advance(controller, 180);
    expect(camera.fov).toBeCloseTo(52, 1);
    expect(Math.abs(camera.rotation.z)).toBeLessThan(0.002);
    controller.dispose();
  });

  it('uses independently tunable, softer focus and position follow while gliding', () => {
    const tuning = cloneMovementTuning();
    Object.assign(tuning.camera, {
      runFovDegrees: 0,
      glideFovDegrees: 0,
      runLookAhead: 0,
      glideLookAhead: 0,
      runBoomExtension: 0,
      glideBoomExtension: 0,
      focusResponse: 30,
      glideFocusResponse: 1,
      positionResponse: 30,
      glidePositionResponse: 1,
    });
    const runCamera = new THREE.PerspectiveCamera();
    const glideCamera = new THREE.PerspectiveCamera();
    const run = new ThirdPersonCamera({ camera: runCamera, distance: 8, tuning });
    const glide = new ThirdPersonCamera({ camera: glideCamera, distance: 8, tuning });
    run.setMovementPresentation('run', 0, 0);
    glide.setMovementPresentation('glide', 0, 0);
    run.update(1 / 60, TARGET, FLAT_GROUND);
    glide.update(1 / 60, TARGET, FLAT_GROUND);

    const movedTarget = new THREE.Vector3(0, 0, -6);
    run.update(1 / 60, movedTarget, FLAT_GROUND);
    glide.update(1 / 60, movedTarget, FLAT_GROUND);

    expect(runCamera.position.z).toBeLessThan(glideCamera.position.z - 0.7);
    expect(tuning.camera.glideFocusResponse).toBeLessThan(tuning.camera.focusResponse);
    expect(tuning.camera.glidePositionResponse).toBeLessThan(tuning.camera.positionResponse);
    run.dispose();
    glide.dispose();
  });
});
