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
}

function damp(current: number, target: number, responsiveness: number, deltaSeconds: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-responsiveness * deltaSeconds));
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
  private distance: number;
  private resolvedDistance: number;
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
    this.lookHeight = options.lookHeight ?? 1.18;
    this.collisionClearance = options.collisionClearance ?? 0.38;
    this.reducedMotion = options.reducedMotion ?? false;

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
  }

  public setOrbit(yaw: number, pitch: number, distance = this.distance): void {
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, 0.12, 0.88);
    this.distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
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
    this.desiredFocus.set(target.x, target.y + this.lookHeight, target.z);

    if (!this.initialized) {
      this.focus.copy(this.desiredFocus);
      this.initialized = true;
    } else {
      const focusResponse = this.reducedMotion ? 18 : 11;
      this.focus.lerp(this.desiredFocus, 1 - Math.exp(-focusResponse * delta));
    }

    const horizontalDistance = Math.cos(this.pitch) * this.distance;
    this.boomOffset.set(
      Math.sin(this.yaw) * horizontalDistance,
      Math.sin(this.pitch) * this.distance,
      Math.cos(this.yaw) * horizontalDistance,
    );

    const safeDistance = this.findSafeDistance(heightAt, obstacleAt);
    const distanceResponse = safeDistance < this.resolvedDistance ? 24 : 5.5;
    this.resolvedDistance = damp(this.resolvedDistance, safeDistance, distanceResponse, delta);
    const distanceScale = this.distance <= 0 ? 1 : this.resolvedDistance / this.distance;
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

  private findSafeDistance(heightAt: HeightSampler, obstacleAt?: CameraObstacleSampler): number {
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
    if (!hit) return this.distance;
    return THREE.MathUtils.clamp(this.distance * lastClearFraction - 0.3, this.minDistance, this.distance);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    this.activePointer = event.pointerId;
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
