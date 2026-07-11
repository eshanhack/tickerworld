import * as THREE from 'three';
import type { HeightSampler } from './FoxPlayer';

export type CameraObstacleSampler = (x: number, y: number, z: number) => boolean;

export interface ThirdPersonCameraOptions {
  readonly camera?: THREE.PerspectiveCamera;
  readonly domElement?: HTMLElement | null;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly distance?: number;
  readonly minDistance?: number;
  readonly maxDistance?: number;
  readonly lookHeight?: number;
  readonly collisionClearance?: number;
  readonly reducedMotion?: boolean;
  readonly autoRecenter?: boolean;
}

const CHASE_RECENTER_DELAY = 1.1;
const CHASE_RECENTER_RESPONSE = 1.65;
const MAX_CHASE_BOOM_EXTENSION = 0.7;
const MAX_CHASE_LOOK_AHEAD = 0.55;
const CHASE_MOVEMENT_THRESHOLD = 0.08;

function damp(current: number, target: number, responsiveness: number, deltaSeconds: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-responsiveness * deltaSeconds));
}

function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function sampledHeight(heightAt: HeightSampler, x: number, z: number): number {
  const value = heightAt(x, z);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Smooth orbiting chase camera with terrain and optional obstacle boom tests. */
export class ThirdPersonCamera {
  public readonly camera: THREE.PerspectiveCamera;
  public yaw: number;
  public pitch: number;

  private readonly domElement: HTMLElement | null;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly lookHeight: number;
  private readonly collisionClearance: number;
  private readonly focus = new THREE.Vector3();
  private readonly desiredFocus = new THREE.Vector3();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly boomOffset = new THREE.Vector3();
  private readonly chaseLookAhead = new THREE.Vector3();
  private readonly desiredChaseLookAhead = new THREE.Vector3();
  private readonly autoRecenter: boolean;
  private distance: number;
  private resolvedDistance: number;
  private chaseHeadingYaw = 0;
  private chaseSpeed = 0;
  private chaseRecenterWeight = 1;
  private chaseBoomExtension = 0;
  private chaseMoveSeconds = 0;
  private activePointer: number | null = null;
  private pointerX = 0;
  private pointerY = 0;
  private initialized = false;
  private enabled = true;
  private reducedMotion: boolean;

  public constructor(options: ThirdPersonCameraOptions = {}) {
    this.camera = options.camera ?? new THREE.PerspectiveCamera(43, 1, 0.08, 360);
    this.domElement = options.domElement ?? null;
    this.yaw = options.yaw ?? 0;
    this.pitch = THREE.MathUtils.clamp(options.pitch ?? 0.35, 0.12, 0.88);
    this.minDistance = options.minDistance ?? 4.2;
    this.maxDistance = options.maxDistance ?? 12.5;
    this.distance = THREE.MathUtils.clamp(options.distance ?? 7.8, this.minDistance, this.maxDistance);
    this.resolvedDistance = this.distance;
    this.lookHeight = options.lookHeight ?? 0.85;
    this.collisionClearance = options.collisionClearance ?? 0.38;
    this.reducedMotion = options.reducedMotion ?? false;
    this.autoRecenter = options.autoRecenter ?? true;

    this.camera.name = this.camera.name || 'ThirdPersonCamera';
    this.domElement?.addEventListener('pointerdown', this.onPointerDown);
    this.domElement?.addEventListener('pointermove', this.onPointerMove);
    this.domElement?.addEventListener('pointerup', this.onPointerUp);
    this.domElement?.addEventListener('pointercancel', this.onPointerUp);
    this.domElement?.addEventListener('wheel', this.onWheel, { passive: false });
  }

  public get zoomDistance(): number {
    return this.distance;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.activePointer = null;
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (reducedMotion) this.chaseMoveSeconds = 0;
  }

  public setOrbit(yaw: number, pitch: number, distance = this.distance): void {
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, 0.12, 0.88);
    this.distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
    this.chaseMoveSeconds = 0;
  }

  /**
   * Supplies the fox's world-space heading and speed for gentle chase framing.
   * A heading of zero faces world -Z, placing the camera behind it on +Z.
   */
  public setChaseMotion(
    headingYaw: number,
    normalizedSpeed: number,
    recenterWeight = 1,
  ): void {
    if (Number.isFinite(headingYaw)) this.chaseHeadingYaw = headingYaw;
    this.chaseSpeed = THREE.MathUtils.clamp(
      Number.isFinite(normalizedSpeed) ? normalizedSpeed : 0,
      0,
      1,
    );
    this.chaseRecenterWeight = THREE.MathUtils.clamp(
      Number.isFinite(recenterWeight) ? recenterWeight : 0,
      0,
      1,
    );
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Samples the boom from the fox toward the requested orbit position. Terrain
   * alone is sufficient; pass `obstacleAt` to include props or monument bounds.
   */
  public update(
    deltaSeconds: number,
    target: Readonly<THREE.Vector3>,
    heightAt: HeightSampler,
    obstacleAt?: CameraObstacleSampler,
  ): void {
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.updateChaseMotion(delta);
    this.desiredFocus.set(
      target.x + this.chaseLookAhead.x,
      target.y + this.lookHeight,
      target.z + this.chaseLookAhead.z,
    );

    if (!this.initialized) {
      this.focus.copy(this.desiredFocus);
      this.initialized = true;
    } else {
      const focusResponse = this.reducedMotion ? 18 : 11;
      this.focus.lerp(this.desiredFocus, 1 - Math.exp(-focusResponse * delta));
    }

    const requestedDistance = Math.min(this.maxDistance, this.distance + this.chaseBoomExtension);
    const horizontalDistance = Math.cos(this.pitch) * requestedDistance;
    this.boomOffset.set(
      Math.sin(this.yaw) * horizontalDistance,
      Math.sin(this.pitch) * requestedDistance,
      Math.cos(this.yaw) * horizontalDistance,
    );

    const safeDistance = this.findSafeDistance(requestedDistance, heightAt, obstacleAt);
    const distanceResponse = safeDistance < this.resolvedDistance ? 24 : 5.5;
    this.resolvedDistance = damp(this.resolvedDistance, safeDistance, distanceResponse, delta);
    const distanceScale = requestedDistance <= 0 ? 1 : this.resolvedDistance / requestedDistance;
    this.desiredPosition.copy(this.focus).addScaledVector(this.boomOffset, distanceScale);

    const ground = sampledHeight(heightAt, this.desiredPosition.x, this.desiredPosition.z);
    this.desiredPosition.y = Math.max(this.desiredPosition.y, ground + this.collisionClearance);
    if (this.camera.position.lengthSq() === 0 || delta === 0) {
      this.camera.position.copy(this.desiredPosition);
    } else {
      const positionResponse = safeDistance < this.resolvedDistance ? 20 : (this.reducedMotion ? 16 : 8.5);
      this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-positionResponse * delta));
    }
    this.camera.lookAt(this.focus);
    this.camera.updateMatrixWorld();
  }

  public dispose(): void {
    this.domElement?.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement?.removeEventListener('pointermove', this.onPointerMove);
    this.domElement?.removeEventListener('pointerup', this.onPointerUp);
    this.domElement?.removeEventListener('pointercancel', this.onPointerUp);
    this.domElement?.removeEventListener('wheel', this.onWheel);
    this.activePointer = null;
  }

  private updateChaseMotion(delta: number): void {
    const moving = this.chaseSpeed > CHASE_MOVEMENT_THRESHOLD;
    const forwardChase = this.chaseRecenterWeight > 0.9;
    if (this.enabled && moving && forwardChase && this.activePointer === null) this.chaseMoveSeconds += delta;
    else this.chaseMoveSeconds = 0;

    if (
      this.enabled
      && this.autoRecenter
      && !this.reducedMotion
      && moving
      && forwardChase
      && this.activePointer === null
      && this.chaseMoveSeconds >= CHASE_RECENTER_DELAY
    ) {
      const yawError = shortestAngle(this.yaw, this.chaseHeadingYaw);
      this.yaw += yawError * (1 - Math.exp(-CHASE_RECENTER_RESPONSE * delta));
    }

    const motionScale = this.reducedMotion ? 0.2 : 1;
    const targetExtension = this.chaseSpeed * MAX_CHASE_BOOM_EXTENSION * motionScale;
    this.chaseBoomExtension = damp(
      this.chaseBoomExtension,
      targetExtension,
      targetExtension > this.chaseBoomExtension ? 3.2 : 4.6,
      delta,
    );

    const lookAheadDistance = this.chaseSpeed * MAX_CHASE_LOOK_AHEAD * motionScale;
    this.desiredChaseLookAhead.set(
      -Math.sin(this.chaseHeadingYaw) * lookAheadDistance,
      0,
      -Math.cos(this.chaseHeadingYaw) * lookAheadDistance,
    );
    const lookAheadResponse = lookAheadDistance > this.chaseLookAhead.length() ? 5.2 : 6.5;
    this.chaseLookAhead.lerp(
      this.desiredChaseLookAhead,
      1 - Math.exp(-lookAheadResponse * delta),
    );
  }

  private findSafeDistance(
    requestedDistance: number,
    heightAt: HeightSampler,
    obstacleAt?: CameraObstacleSampler,
  ): number {
    const sampleCount = 16;
    let lastClearFraction = 1;
    let hit = false;
    for (let index = 2; index <= sampleCount; index += 1) {
      const fraction = index / sampleCount;
      const x = this.focus.x + this.boomOffset.x * fraction;
      const y = this.focus.y + this.boomOffset.y * fraction;
      const z = this.focus.z + this.boomOffset.z * fraction;
      const belowTerrain = y < sampledHeight(heightAt, x, z) + this.collisionClearance;
      if (belowTerrain || obstacleAt?.(x, y, z) === true) {
        lastClearFraction = (index - 1) / sampleCount;
        hit = true;
        break;
      }
    }
    if (!hit) return requestedDistance;
    return THREE.MathUtils.clamp(
      requestedDistance * lastClearFraction - 0.3,
      this.minDistance,
      requestedDistance,
    );
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    this.activePointer = event.pointerId;
    this.chaseMoveSeconds = 0;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.domElement?.setPointerCapture?.(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled || event.pointerId !== this.activePointer) return;
    const deltaX = event.clientX - this.pointerX;
    const deltaY = event.clientY - this.pointerY;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.chaseMoveSeconds = 0;
    this.yaw -= deltaX * 0.0062;
    this.pitch = THREE.MathUtils.clamp(this.pitch + deltaY * 0.0045, 0.12, 0.88);
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointer) return;
    this.domElement?.releasePointerCapture?.(event.pointerId);
    this.activePointer = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    this.distance = THREE.MathUtils.clamp(this.distance + event.deltaY * 0.008, this.minDistance, this.maxDistance);
    event.preventDefault();
  };
}
