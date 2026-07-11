import * as THREE from 'three';
import { PALETTE } from '../config';
import type { PlayerSnapshot, SurfaceKind } from '../types';
import { PlayerInputController } from './InputController';

export type HeightSampler = (x: number, z: number) => number;
export type SurfaceSampler = (x: number, z: number) => SurfaceKind;

export interface FootstepEvent {
  readonly position: THREE.Vector3;
  readonly side: 'left' | 'right';
  readonly surface: SurfaceKind;
  readonly sprinting: boolean;
  /** Normalized gait energy in the range 0..1. */
  readonly intensity: number;
}

export type FootstepListener = (event: FootstepEvent) => void;

export type FoxActionKind = 'jump' | 'double-jump' | 'land';

export interface FoxActionEvent {
  readonly type: FoxActionKind;
  readonly position: THREE.Vector3;
  readonly surface: SurfaceKind;
  /** Normalized action energy in the range 0..1. */
  readonly intensity: number;
}

export type FoxActionListener = (event: FoxActionEvent) => void;

export interface FoxPlayerOptions {
  readonly input?: PlayerInputController;
  readonly spawn?: Readonly<THREE.Vector3>;
  readonly reducedMotion?: boolean;
  readonly walkSpeed?: number;
  readonly sprintSpeed?: number;
}

interface LegRig {
  readonly pivot: THREE.Group;
  readonly restY: number;
  readonly restZ: number;
  readonly phase: number;
  readonly front: boolean;
  readonly side: -1 | 1;
}

interface TailJoint {
  readonly pivot: THREE.Group;
  readonly restPitch: number;
  yawVelocity: number;
  pitchVelocity: number;
}

interface MagicParticle {
  readonly mesh: THREE.Mesh;
  readonly velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_SURFACE: SurfaceSampler = () => 'grass';
const NO_HEIGHT: HeightSampler = () => 0;
const MODEL_SCALE = 0.78;
const GRAVITY = 25.5;
const GLIDE_ASCENT_GRAVITY = 10.5;
const GLIDE_FALL_GRAVITY = 4.35;
const GLIDE_TERMINAL_SPEED = -3.15;
const FALL_TERMINAL_SPEED = -18;
const GLIDE_ENTRY_SECONDS = 0.09;
const JUMP_IMPULSE = 8.65;
const DOUBLE_JUMP_IMPULSE = 8.15;
const COYOTE_SECONDS = 0.11;
const JUMP_BUFFER_SECONDS = 0.14;

function damp(current: number, target: number, responsiveness: number, deltaSeconds: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-responsiveness * deltaSeconds));
}

function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function safeHeight(heightAt: HeightSampler, x: number, z: number, fallback: number): number {
  const sampled = heightAt(x, z);
  return Number.isFinite(sampled) ? sampled : fallback;
}

function enableShadows(mesh: THREE.Mesh): THREE.Mesh {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A light, rounded low-poly fox plus camera-relative locomotion. */
export class FoxPlayer {
  public readonly group = new THREE.Group();
  public readonly input: PlayerInputController;

  private readonly model = new THREE.Group();
  private readonly magicGroup = new THREE.Group();
  private readonly velocity = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly movementDirection = new THREE.Vector3();
  private readonly legs: LegRig[] = [];
  private readonly tail: TailJoint[] = [];
  private readonly eyes: THREE.Mesh[] = [];
  private readonly ears: THREE.Object3D[] = [];
  private readonly magicParticles: MagicParticle[] = [];
  private readonly frameStart = new THREE.Vector3();
  private readonly frameDisplacement = new THREE.Vector3();
  private readonly walkSpeed: number;
  private readonly sprintSpeed: number;
  private elapsed = 0;
  private travelled = 0;
  private distanceSinceFootstep = 0;
  private nextFoot = 0;
  private nextBlink = 2.15;
  private blinkProgress = -1;
  private nextEarFlick = 3.4;
  private earFlickProgress = -1;
  private squashPulse = 0;
  private wasMoving = false;
  private grounded = false;
  private groundInitialized = false;
  private verticalVelocity = 0;
  private jumpsUsed = 0;
  private coyoteRemaining = 0;
  private jumpBufferRemaining = 0;
  private airborneTime = 0;
  private spinProgress = -1;
  private glideActive = false;
  private glideBlend = 0;
  private landingBloom = 0;
  private magicCursor = 0;
  private magicTimer = 0;
  private currentSurface: SurfaceKind = 'grass';
  private reducedMotion: boolean;
  private disposed = false;

  public constructor(options: FoxPlayerOptions = {}) {
    this.input = options.input ?? new PlayerInputController();
    this.walkSpeed = options.walkSpeed ?? 4.1;
    this.sprintSpeed = options.sprintSpeed ?? 7.15;
    this.reducedMotion = options.reducedMotion ?? false;

    this.group.name = 'FoxPlayer';
    this.model.name = 'FoxModel';
    this.magicGroup.name = 'FoxMagicEffects';
    this.model.scale.setScalar(MODEL_SCALE);
    this.group.add(this.model, this.magicGroup);
    if (options.spawn) this.group.position.copy(options.spawn);
    this.buildFox();
    this.buildMagicPool();
  }

  public get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Whether held jump input is currently slowing and shaping the fall. */
  public get isGliding(): boolean {
    return this.glideActive;
  }

  public get snapshot(): PlayerSnapshot {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    return {
      x: this.group.position.x,
      y: this.group.position.y,
      z: this.group.position.z,
      speed,
      sprinting: speed > this.walkSpeed * 1.08,
      surface: this.currentSurface,
      grounded: this.grounded,
      jumpsUsed: this.jumpsUsed,
      verticalSpeed: this.verticalVelocity,
    };
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  public setPosition(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.grounded = true;
    this.groundInitialized = true;
    this.jumpsUsed = 0;
    this.coyoteRemaining = COYOTE_SECONDS;
    this.jumpBufferRemaining = 0;
    this.airborneTime = 0;
    this.glideActive = false;
    this.glideBlend = 0;
    this.landingBloom = 0;
    for (const particle of this.magicParticles) particle.mesh.visible = false;
  }

  public setVirtualInput(moveX: number, moveForward: number, sprint = false): void {
    this.input.setVirtualInput(moveX, moveForward, sprint);
  }

  /** Queue a jump through the same edge-triggered path used by the Space key. */
  public requestJump(): void {
    this.input.requestJump();
  }

  /** Hold from touch/pointer UI to glide; keyboard Space is tracked automatically. */
  public setGlideHeld(held: boolean): void {
    this.input.setVirtualGlide(held);
  }

  /**
   * Advances movement and animation. `cameraYaw = 0` means the camera is south
   * of the fox looking toward world -Z, so forward input travels toward -Z.
   */
  public update(
    deltaSeconds: number,
    cameraYaw: number,
    heightAt: HeightSampler = NO_HEIGHT,
    surfaceAt: SurfaceSampler = DEFAULT_SURFACE,
    onFootstep?: FootstepListener,
    onAction?: FoxActionListener,
  ): PlayerSnapshot {
    if (this.disposed) return this.snapshot;
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.05);
    if (delta === 0) return this.snapshot;
    this.elapsed += delta;
    this.frameStart.copy(this.group.position);

    const input = this.input.state;
    if (this.input.consumeJump()) this.jumpBufferRemaining = JUMP_BUFFER_SECONDS;
    else this.jumpBufferRemaining = Math.max(0, this.jumpBufferRemaining - delta);
    const inputMagnitude = Math.min(1, Math.hypot(input.moveX, input.moveForward));
    const sprintRequested = input.sprint && inputMagnitude > 0.15;
    const topSpeed = sprintRequested ? this.sprintSpeed : this.walkSpeed;
    const glideIntent = input.jumpHeld && !this.grounded && this.jumpsUsed > 0;
    const steeringSpeed = glideIntent ? topSpeed * 1.1 : topSpeed;

    const forwardX = -Math.sin(cameraYaw);
    const forwardZ = -Math.cos(cameraYaw);
    const rightX = Math.cos(cameraYaw);
    const rightZ = -Math.sin(cameraYaw);
    this.movementDirection.set(
      rightX * input.moveX + forwardX * input.moveForward,
      0,
      rightZ * input.moveX + forwardZ * input.moveForward,
    );
    if (this.movementDirection.lengthSq() > 1) this.movementDirection.normalize();

    this.desiredVelocity.copy(this.movementDirection).multiplyScalar(steeringSpeed * inputMagnitude);
    const currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const desiredSpeed = Math.hypot(this.desiredVelocity.x, this.desiredVelocity.z);
    const groundedResponse = desiredSpeed > currentSpeed ? (sprintRequested ? 6.8 : 7.8) : 9.5;
    const response = this.grounded
      ? groundedResponse
      : glideIntent
        ? (desiredSpeed > 0.05 ? 8.6 : 0.85)
        : (desiredSpeed > 0.05 ? 6.4 : 1.8);
    const velocityBlend = 1 - Math.exp(-response * delta);
    this.velocity.lerp(this.desiredVelocity, velocityBlend);
    if (desiredSpeed === 0 && this.velocity.lengthSq() < 0.0004) this.velocity.set(0, 0, 0);

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = speed > 0.12;
    if (moving !== this.wasMoving) {
      this.squashPulse = moving ? 1 : -0.58;
      this.wasMoving = moving;
    }

    if (speed > 0.05) {
      const targetRotation = Math.atan2(-this.velocity.x, -this.velocity.z);
      this.model.rotation.y += shortestAngle(this.model.rotation.y, targetRotation) * (1 - Math.exp(-(this.grounded ? 9.5 : 7.2) * delta));
    }

    this.group.position.x += this.velocity.x * delta;
    this.group.position.z += this.velocity.z * delta;
    const groundY = safeHeight(heightAt, this.group.position.x, this.group.position.z, this.group.position.y);
    this.currentSurface = surfaceAt(this.group.position.x, this.group.position.z);
    if (!this.groundInitialized) {
      this.group.position.y = groundY;
      this.grounded = true;
      this.groundInitialized = true;
      this.coyoteRemaining = COYOTE_SECONDS;
    } else if (this.grounded && this.group.position.y - groundY > 0.24) {
      this.grounded = false;
    } else {
      if (this.grounded) {
        this.group.position.y = damp(this.group.position.y, groundY, 18, delta);
        this.verticalVelocity = 0;
        this.coyoteRemaining = COYOTE_SECONDS;
      } else {
        this.coyoteRemaining = Math.max(0, this.coyoteRemaining - delta);
      }
    }

    if (this.jumpBufferRemaining > 0) {
      if (this.grounded || (this.coyoteRemaining > 0 && this.jumpsUsed === 0)) {
        this.performJump(false, onAction);
      } else if (!this.grounded && this.jumpsUsed === 1) {
        this.performJump(true, onAction);
      }
    }

    if (!this.grounded) {
      this.airborneTime += delta;
      this.glideActive = input.jumpHeld
        && this.jumpsUsed > 0
        && this.airborneTime >= GLIDE_ENTRY_SECONDS;
      const gravity = this.glideActive
        ? (this.verticalVelocity > 0 ? GLIDE_ASCENT_GRAVITY : GLIDE_FALL_GRAVITY)
        : GRAVITY;
      const terminalSpeed = this.glideActive ? GLIDE_TERMINAL_SPEED : FALL_TERMINAL_SPEED;
      this.verticalVelocity = Math.max(terminalSpeed, this.verticalVelocity - gravity * delta);
      this.group.position.y += this.verticalVelocity * delta;
      if (this.group.position.y <= groundY && this.verticalVelocity <= 0) {
        const landingSpeed = Math.abs(this.verticalVelocity);
        const wasAirborneLongEnough = this.airborneTime > 0.075;
        this.group.position.y = groundY;
        this.verticalVelocity = 0;
        this.grounded = true;
        this.jumpsUsed = 0;
        this.coyoteRemaining = COYOTE_SECONDS;
        this.airborneTime = 0;
        this.glideActive = false;
        this.spinProgress = -1;
        this.model.rotation.x = 0;
        if (wasAirborneLongEnough) {
          const intensity = THREE.MathUtils.clamp(landingSpeed / 11, 0.25, 1);
          this.squashPulse = 0.82 + intensity * 0.38;
          this.landingBloom = 1;
          this.spawnMagic(6, 0.68);
          onAction?.({
            type: 'land',
            position: this.group.position.clone(),
            surface: this.currentSurface,
            intensity,
          });
        }
      }
    }

    const distance = speed * delta;
    this.travelled += distance;
    this.distanceSinceFootstep += distance;
    const stride = THREE.MathUtils.lerp(1.14, 0.82, THREE.MathUtils.clamp((speed - this.walkSpeed) / Math.max(0.1, this.sprintSpeed - this.walkSpeed), 0, 1));
    if (this.grounded && moving && this.distanceSinceFootstep >= stride * 0.5) {
      this.distanceSinceFootstep %= stride * 0.5;
      const side: FootstepEvent['side'] = this.nextFoot++ % 2 === 0 ? 'left' : 'right';
      onFootstep?.({
        position: this.group.position.clone(),
        side,
        surface: this.currentSurface,
        sprinting: sprintRequested,
        intensity: THREE.MathUtils.clamp(speed / this.sprintSpeed, 0.2, 1),
      });
    }

    this.animate(delta, speed, sprintRequested);
    this.frameDisplacement.copy(this.group.position).sub(this.frameStart);
    this.updateMagic(delta, this.frameDisplacement, speed);
    return this.snapshot;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.dispose();
    this.group.removeFromParent();
    const materials = new Set<THREE.Material>();
    const geometries = new Set<THREE.BufferGeometry>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
      else materials.add(object.material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }

  private performJump(doubleJump: boolean, onAction?: FoxActionListener): void {
    this.jumpBufferRemaining = 0;
    this.grounded = false;
    this.coyoteRemaining = 0;
    this.airborneTime = 0;
    this.glideActive = false;
    this.jumpsUsed = doubleJump ? 2 : 1;
    this.verticalVelocity = doubleJump ? DOUBLE_JUMP_IMPULSE : JUMP_IMPULSE;
    this.squashPulse = doubleJump ? -0.62 : -0.82;
    if (doubleJump) this.spinProgress = 0;
    this.spawnMagic(doubleJump ? 10 : 7, doubleJump ? 1.2 : 0.92);
    onAction?.({
      type: doubleJump ? 'double-jump' : 'jump',
      position: this.group.position.clone(),
      surface: this.currentSurface,
      intensity: doubleJump ? 1 : 0.78,
    });
  }

  private animate(delta: number, speed: number, sprinting: boolean): void {
    const speedRatio = THREE.MathUtils.clamp(speed / this.sprintSpeed, 0, 1);
    const movementAmount = THREE.MathUtils.smoothstep(speedRatio, 0.01, 0.7);
    const gaitPhase = this.travelled * (sprinting ? 5.7 : 5.15);
    const motionScale = this.reducedMotion ? 0.3 : 1;
    this.glideBlend = damp(this.glideBlend, this.glideActive ? 1 : 0, this.glideActive ? 7.2 : 9.5, delta);
    this.landingBloom *= Math.exp(-5.4 * delta);

    for (const leg of this.legs) {
      const phase = gaitPhase + leg.phase;
      const strideWave = Math.sin(phase);
      const pawArc = Math.pow(Math.max(0, Math.sin(phase + Math.PI * 0.22)), 1.45);
      const swing = strideWave * (0.14 + speedRatio * 0.43) * movementAmount * motionScale;
      const lift = pawArc * (0.026 + speedRatio * 0.085) * movementAmount * motionScale;
      const poisedIdle = Math.sin(this.elapsed * 1.25 + leg.phase) * 0.009 * (1 - movementAmount) * motionScale;
      const jumpTuck = this.grounded ? 0 : (leg.front ? 0.3 : -0.23) * motionScale;
      const glideReach = (leg.front ? 0.72 : -0.56) * motionScale;
      const rotationTarget = THREE.MathUtils.lerp(swing * (leg.front ? 1 : 0.92) + jumpTuck, glideReach, this.glideBlend);
      const heightTarget = leg.restY + lift + poisedIdle
        + (this.grounded
          ? this.landingBloom * 0.055 * motionScale
          : THREE.MathUtils.lerp(0.075, 0.15, this.glideBlend) * motionScale);
      leg.pivot.rotation.x = damp(leg.pivot.rotation.x, rotationTarget, this.glideActive ? 8 : 11.5, delta);
      leg.pivot.rotation.z = damp(
        leg.pivot.rotation.z,
        leg.side * this.glideBlend * (leg.front ? 0.075 : 0.045) * motionScale,
        9,
        delta,
      );
      leg.pivot.position.y = damp(leg.pivot.position.y, heightTarget, 12.5, delta);
      leg.pivot.position.z = damp(leg.pivot.position.z, leg.restZ + strideWave * 0.018 * movementAmount * motionScale, 10, delta);
    }

    const idleBreath = Math.sin(this.elapsed * 2.15) * 0.018;
    const gaitBob = (0.5 + 0.5 * Math.sin(gaitPhase * 2 - 0.45)) * 0.034 * movementAmount * motionScale;
    const airborneFloat = this.grounded ? 0 : Math.sin(this.airborneTime * 4.2) * 0.018 * motionScale;
    this.model.position.y = idleBreath + gaitBob + airborneFloat + this.landingBloom * 0.015;
    this.model.rotation.z = Math.sin(gaitPhase * 0.5) * 0.035 * movementAmount * motionScale
      + Math.sin(this.airborneTime * 2.2) * 0.018 * this.glideBlend * motionScale;

    if (this.spinProgress >= 0) {
      this.spinProgress += delta / 0.52;
      if (this.spinProgress >= 1) {
        this.spinProgress = -1;
        this.model.rotation.x = 0;
      } else if (this.reducedMotion) {
        this.model.rotation.x = -Math.sin(this.spinProgress * Math.PI) * 0.18;
      } else {
        const eased = THREE.MathUtils.smoothstep(this.spinProgress, 0, 1);
        this.model.rotation.x = -eased * Math.PI * 2;
      }
    } else {
      const flowingPitch = (this.glideBlend * 0.115 - (this.grounded ? speedRatio * 0.035 : 0.015)) * motionScale;
      this.model.rotation.x = damp(this.model.rotation.x, flowingPitch, this.glideActive ? 7 : 11, delta);
    }

    this.squashPulse *= Math.exp(-6.8 * delta);
    const strideSquash = Math.sin(gaitPhase * 2) * 0.018 * movementAmount * motionScale;
    const squash = this.squashPulse * motionScale + strideSquash;
    this.model.scale.set(
      MODEL_SCALE * (1 + squash * 0.055),
      MODEL_SCALE * (1 - squash * 0.09),
      MODEL_SCALE * (1 + squash * 0.045),
    );

    this.animateBlink(delta);
    this.animateEars(delta, speedRatio, motionScale);
    this.animateTail(delta, speedRatio, sprinting, motionScale);
  }

  private animateBlink(delta: number): void {
    if (this.blinkProgress < 0) {
      if (this.elapsed >= this.nextBlink) this.blinkProgress = 0;
    } else {
      this.blinkProgress += delta;
      if (this.blinkProgress >= 0.18) {
        this.blinkProgress = -1;
        this.nextBlink = this.elapsed + 2.35 + (Math.sin(this.elapsed * 1.73) + 1) * 0.7;
      }
    }

    const blink = this.blinkProgress < 0 ? 0 : Math.sin((this.blinkProgress / 0.18) * Math.PI);
    for (const eye of this.eyes) eye.scale.y = 1 - blink * 0.9;
  }

  private animateEars(delta: number, speedRatio: number, motionScale: number): void {
    if (this.earFlickProgress < 0) {
      if (this.elapsed >= this.nextEarFlick) this.earFlickProgress = 0;
    } else {
      this.earFlickProgress += delta;
      if (this.earFlickProgress >= 0.36) {
        this.earFlickProgress = -1;
        this.nextEarFlick = this.elapsed + 3.1 + (Math.cos(this.elapsed * 0.91) + 1) * 1.2;
      }
    }
    const flick = this.earFlickProgress < 0 ? 0 : Math.sin((this.earFlickProgress / 0.36) * Math.PI * 2) * 0.14;
    this.ears.forEach((ear, index) => {
      const side = index === 0 ? 1 : -1;
      ear.rotation.z = side * (0.08 + flick * motionScale + Math.sin(this.elapsed * 8 + index) * speedRatio * 0.025 * motionScale);
    });
  }

  private animateTail(delta: number, speedRatio: number, sprinting: boolean, motionScale: number): void {
    const springDelta = Math.min(delta, 1 / 30);
    this.tail.forEach((joint, index) => {
      const delay = index * 0.42;
      const wagSpeed = this.glideBlend > 0.05 ? 1.65 : (sprinting ? 4.6 : 2.05);
      const groundedYaw = Math.sin(this.elapsed * wagSpeed - delay) * (0.105 + speedRatio * 0.2) * motionScale;
      const glideYaw = Math.sin(this.elapsed * wagSpeed - delay * 0.62) * (0.18 - index * 0.012) * motionScale;
      const targetYaw = THREE.MathUtils.lerp(groundedYaw, glideYaw, this.glideBlend);
      const groundedPitch = joint.restPitch + Math.sin(this.elapsed * 1.35 - delay) * 0.035 * motionScale - speedRatio * 0.035;
      const glidePitch = joint.restPitch - (0.19 - index * 0.018) + Math.sin(this.elapsed * 1.1 - delay) * 0.045 * motionScale;
      const targetPitch = THREE.MathUtils.lerp(groundedPitch, glidePitch, this.glideBlend);
      const stiffness = 34 - index * 2.7;
      const damping = Math.exp(-(8.2 - index * 0.45) * springDelta);
      joint.yawVelocity = (joint.yawVelocity + (targetYaw - joint.pivot.rotation.y) * stiffness * springDelta) * damping;
      joint.pitchVelocity = (joint.pitchVelocity + (targetPitch - joint.pivot.rotation.x) * stiffness * springDelta) * damping;
      joint.pivot.rotation.y += joint.yawVelocity * springDelta;
      joint.pivot.rotation.x += joint.pitchVelocity * springDelta;
    });
  }

  private buildMagicPool(): void {
    const sparkleGeometry = new THREE.OctahedronGeometry(0.075, 0);
    const wispGeometry = new THREE.SphereGeometry(0.055, 6, 4);
    const materials = [
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.82, depthWrite: false, blending: THREE.AdditiveBlending }),
      new THREE.MeshBasicMaterial({ color: 0xd9c8ff, transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending }),
      new THREE.MeshBasicMaterial({ color: 0xbcebd8, transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending }),
    ];

    for (let index = 0; index < 32; index += 1) {
      const mesh = new THREE.Mesh(index % 3 === 0 ? sparkleGeometry : wispGeometry, materials[index % materials.length]);
      mesh.name = `FoxMagicParticle${index + 1}`;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      this.magicGroup.add(mesh);
      this.magicParticles.push({ mesh, velocity: new THREE.Vector3(), life: 0, maxLife: 1, baseScale: 1 });
    }
  }

  private spawnMagic(count: number, energy: number): void {
    if (this.reducedMotion) count = Math.max(1, Math.ceil(count * 0.42));
    for (let index = 0; index < count; index += 1) {
      const serial = this.magicCursor++;
      const particle = this.magicParticles[serial % this.magicParticles.length];
      if (!particle) continue;
      const phase = serial * 2.39996 + this.elapsed * 0.73;
      const radius = 0.18 + ((serial * 17) % 11) / 32;
      const height = 0.3 + ((serial * 13) % 17) / 14;
      particle.mesh.position.set(Math.cos(phase) * radius, height, Math.sin(phase) * radius);
      const outward = 0.28 + energy * 0.32;
      particle.velocity.set(
        Math.cos(phase) * outward,
        0.22 + energy * (0.16 + (serial % 5) * 0.035),
        Math.sin(phase) * outward,
      );
      particle.maxLife = 0.48 + (serial % 7) * 0.055 + energy * 0.14;
      particle.life = particle.maxLife;
      particle.baseScale = 0.65 + energy * 0.38 + (serial % 3) * 0.09;
      particle.mesh.scale.setScalar(particle.baseScale * 0.15);
      particle.mesh.visible = true;
    }
  }

  private updateMagic(delta: number, displacement: THREE.Vector3, speed: number): void {
    for (let index = 0; index < this.magicParticles.length; index += 1) {
      const particle = this.magicParticles[index];
      if (!particle?.mesh.visible) continue;
      particle.mesh.position.sub(displacement);
      particle.life -= delta;
      if (particle.life <= 0) {
        particle.mesh.visible = false;
        continue;
      }
      particle.velocity.y += delta * 0.12;
      particle.mesh.position.addScaledVector(particle.velocity, delta);
      particle.mesh.position.x += Math.sin(this.elapsed * 5 + index) * delta * 0.035;
      particle.mesh.position.z += Math.cos(this.elapsed * 4.2 + index) * delta * 0.035;
      particle.mesh.rotation.y += delta * (2.4 + (index % 4));
      const normalizedLife = particle.life / particle.maxLife;
      const bloom = Math.sin(Math.min(1, (1 - normalizedLife) * 5) * Math.PI * 0.5);
      particle.mesh.scale.setScalar(particle.baseScale * Math.max(0.02, normalizedLife) * Math.max(0.2, bloom));
    }

    this.magicTimer -= delta;
    if (this.magicTimer > 0) return;
    const active = !this.grounded || speed > 0.55;
    this.spawnMagic(1, this.glideActive ? 0.52 : (active ? 0.38 : 0.2));
    this.magicTimer = this.reducedMotion
      ? (active ? 0.24 : 0.85)
      : (this.glideActive ? 0.065 : (active ? 0.105 : 0.52));
  }

  private buildFox(): void {
    const fur = new THREE.MeshStandardMaterial({ color: PALETTE.fox, roughness: 0.86, flatShading: true });
    const cream = new THREE.MeshStandardMaterial({ color: PALETTE.foxCream, roughness: 0.9, flatShading: true });
    const ink = new THREE.MeshStandardMaterial({ color: PALETTE.ink, roughness: 0.72, flatShading: true });
    const innerEar = new THREE.MeshStandardMaterial({ color: PALETTE.pink, roughness: 0.9, flatShading: true });
    const magicAccent = new THREE.MeshStandardMaterial({
      color: 0xeadcff,
      emissive: 0x7b68a8,
      emissiveIntensity: 0.34,
      roughness: 0.48,
      flatShading: true,
    });

    const body = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), fur));
    body.name = 'FoxBody';
    body.position.set(0, 1.05, 0.08);
    body.scale.set(0.7, 0.61, 0.94);
    this.model.add(body);

    const belly = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), cream));
    belly.name = 'FoxBelly';
    belly.position.set(0, 1.04, -0.73);
    belly.scale.set(0.43, 0.43, 0.2);
    this.model.add(belly);

    const head = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), fur));
    head.name = 'FoxHead';
    head.position.set(0, 1.72, -0.67);
    head.scale.set(0.58, 0.54, 0.57);
    this.model.add(head);

    const muzzle = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), cream));
    muzzle.name = 'FoxMuzzle';
    muzzle.position.set(0, 1.59, -1.14);
    muzzle.scale.set(0.36, 0.24, 0.3);
    this.model.add(muzzle);

    const nose = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 5), ink));
    nose.name = 'FoxNose';
    nose.position.set(0, 1.65, -1.42);
    nose.scale.set(1.08, 0.78, 0.72);
    this.model.add(nose);

    for (const side of [-1, 1] as const) {
      const eye = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(0.067, 7, 5), ink));
      eye.name = side < 0 ? 'FoxEyeLeft' : 'FoxEyeRight';
      eye.position.set(side * 0.22, 1.82, -1.16);
      eye.scale.set(0.88, 1, 0.5);
      this.eyes.push(eye);
      this.model.add(eye);

      const ear = new THREE.Group();
      ear.name = side < 0 ? 'FoxEarLeft' : 'FoxEarRight';
      ear.position.set(side * 0.3, 2.08, -0.65);
      ear.rotation.z = side * 0.08;
      const outer = enableShadows(new THREE.Mesh(new THREE.ConeGeometry(0.27, 0.67, 5), fur));
      outer.position.y = 0.28;
      const inner = enableShadows(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 5), innerEar));
      inner.position.set(0, 0.28, -0.13);
      ear.add(outer, inner);
      this.ears.push(ear);
      this.model.add(ear);
    }

    const charm = enableShadows(new THREE.Mesh(new THREE.OctahedronGeometry(0.105, 0), magicAccent));
    charm.name = 'FoxMagicCharm';
    charm.position.set(0, 1.99, -1.18);
    charm.rotation.z = Math.PI * 0.25;
    charm.scale.set(0.72, 1, 0.42);
    this.model.add(charm);

    const legPositions = [
      { name: 'FrontLeft', x: -0.42, z: -0.5, phase: 0.18, front: true },
      { name: 'FrontRight', x: 0.42, z: -0.5, phase: Math.PI + 0.18, front: true },
      { name: 'HindLeft', x: -0.42, z: 0.5, phase: Math.PI, front: false },
      { name: 'HindRight', x: 0.42, z: 0.5, phase: 0, front: false },
    ] as const;
    for (const definition of legPositions) {
      const pivot = new THREE.Group();
      // A little clearance keeps the cream soles skimming above uneven ground
      // even while the whole body leans into a flowing stride.
      const restY = 0.755;
      pivot.name = `Fox${definition.name}LegPivot`;
      pivot.position.set(definition.x, restY, definition.z);
      const leg = enableShadows(new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.34, 3, 6), fur));
      leg.name = `Fox${definition.name}Leg`;
      leg.position.y = -0.3;
      const paw = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(0.18, 7, 5), cream));
      paw.name = `Fox${definition.name}Paw`;
      paw.position.set(0, -0.59, -0.035);
      paw.scale.set(1.05, 0.58, 1.2);
      pivot.add(leg, paw);
      this.legs.push({
        pivot,
        restY,
        restZ: definition.z,
        phase: definition.phase,
        front: definition.front,
        side: definition.x < 0 ? -1 : 1,
      });
      this.model.add(pivot);
    }

    let parent: THREE.Object3D = this.model;
    const segmentLengths = [0.48, 0.46, 0.43, 0.39, 0.33];
    for (let index = 0; index < segmentLengths.length; index += 1) {
      const length = segmentLengths[index] ?? 0.4;
      const pivot = new THREE.Group();
      pivot.name = `FoxTailJoint${index + 1}`;
      if (index === 0) pivot.position.set(0, 1.2, 0.77);
      else pivot.position.z = (segmentLengths[index - 1] ?? length) * 0.72;
      const restPitch = -0.2 + index * 0.025;
      pivot.rotation.x = restPitch;
      const segment = enableShadows(new THREE.Mesh(
        new THREE.SphereGeometry(1, 9, 6),
        index >= segmentLengths.length - 2 ? cream : fur,
      ));
      const taper = 1 - index * 0.105;
      segment.position.z = length * 0.43;
      segment.scale.set(0.31 * taper, 0.29 * taper, length * 0.55);
      pivot.add(segment);
      parent.add(pivot);
      this.tail.push({ pivot, restPitch, yawVelocity: 0, pitchVelocity: 0 });
      parent = pivot;
    }

    // A tiny cream tail tip keeps the silhouette readable at a distance.
    const tip = enableShadows(new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 5), cream));
    tip.position.z = 0.29;
    tip.scale.set(0.8, 0.75, 1.2);
    parent.add(tip);

    // Keep world-up semantics explicit for downstream camera and audio code.
    this.group.up.copy(UP);
  }
}
