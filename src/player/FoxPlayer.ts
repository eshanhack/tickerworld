import * as THREE from 'three';
import type { AnimalKind, SkinId } from '../../shared/src/index.js';
import type { PlayerSnapshot, SurfaceKind } from '../types';
import {
  animalMotionProfile,
  type AnimalMotionProfile,
} from './animalProfiles';
import { FoxRig, type FoxRigDebugSnapshot } from './FoxRig';
import {
  FOX_LEG_KEYS,
  type FoxAirPose,
  type FoxLegKey,
} from './foxMotion';
import { PlayerInputController } from './InputController';

export type HeightSampler = (x: number, z: number) => number;
export type SurfaceSampler = (x: number, z: number) => SurfaceKind;

export interface HorizontalMovementResult {
  readonly x: number;
  readonly z: number;
}

/**
 * Optional post-integration guard for non-physical world rules such as the
 * sacred podium and bounded market edge. Normal locomotion never needs one.
 */
export type HorizontalMovementResolver = (
  previousX: number,
  previousZ: number,
  nextX: number,
  nextZ: number,
) => HorizontalMovementResult;

export interface FootstepEvent {
  readonly position: THREE.Vector3;
  readonly leg: FoxLegKey;
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
  readonly animal?: AnimalKind;
  readonly skin?: SkinId;
}

export type FoxLocomotionState = 'idle' | 'walk' | 'run' | 'anticipating' | 'airborne' | 'landing';

export interface FoxMotionDebugSnapshot {
  readonly locomotionState: FoxLocomotionState;
  readonly airPose: FoxAirPose;
  readonly gaitPhase: number;
  readonly movementBlend: number;
  readonly runBlend: number;
  readonly headingYaw: number;
  readonly horizontalSpeed: number;
  readonly verticalVelocity: number;
  readonly anticipationProgress: number;
  readonly landingProgress: number;
  readonly rig: FoxRigDebugSnapshot;
}

interface MagicParticle {
  readonly mesh: THREE.Mesh;
  readonly velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
}

const DEFAULT_SURFACE: SurfaceSampler = () => 'grass';
const NO_HEIGHT: HeightSampler = () => 0;
const FALL_TERMINAL_SPEED = -18;
const GLIDE_ENTRY_SECONDS = 0.23;
const GLIDE_APEX_SPEED = 0.5;
const JUMP_ANTICIPATION_SECONDS = 0.1;
const DOUBLE_POSE_SECONDS = 0.46;
const LAND_RECOVERY_SECONDS = 0.22;
const COYOTE_SECONDS = 0.11;
const JUMP_BUFFER_SECONDS = 0.14;
const WALK_ACCELERATION_RESPONSE = 5.4;
const SPRINT_ACCELERATION_RESPONSE = 4.7;
const COAST_RESPONSE = 5;
const WALK_TURN_RESPONSE = 9.2;
const RUN_TURN_RESPONSE = 5.4;
const AIR_TURN_RESPONSE = 3.2;
const GLIDE_TURN_RESPONSE = 5.1;
const SPRINT_CLUSTER_SECONDS = 0.08;

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

/**
 * A lean, articulated fox with camera-relative exploration controls. Locomotion
 * uses discrete grounded and airborne phases so the silhouette has time to
 * gather, stretch, float and recover instead of snapping between poses.
 */
export class FoxPlayer {
  public readonly group = new THREE.Group();
  public readonly input: PlayerInputController;

  private readonly rig = new FoxRig();
  private readonly model = this.rig.root;
  private readonly headingPivot = new THREE.Group();
  private readonly aerialPivot = new THREE.Group();
  private readonly magicGroup = new THREE.Group();
  private readonly velocity = new THREE.Vector3();
  private readonly movementDirection = new THREE.Vector3();
  private readonly magicParticles: MagicParticle[] = [];
  private readonly previousContacts: Record<FoxLegKey, boolean> = {
    frontLeft: false,
    frontRight: false,
    hindLeft: false,
    hindRight: false,
  };
  private readonly pawGroundOffsets: Record<FoxLegKey, number> = {
    frontLeft: 0,
    frontRight: 0,
    hindLeft: 0,
    hindRight: 0,
  };
  private readonly pawGroundCenters: Record<FoxLegKey, number> = {
    frontLeft: 0,
    frontRight: 0,
    hindLeft: 0,
    hindRight: 0,
  };
  private readonly pawObjects: Readonly<Record<FoxLegKey, THREE.Mesh>> = {
    frontLeft: this.model.getObjectByName('FoxFrontLeftPaw') as THREE.Mesh,
    frontRight: this.model.getObjectByName('FoxFrontRightPaw') as THREE.Mesh,
    hindLeft: this.model.getObjectByName('FoxHindLeftPaw') as THREE.Mesh,
    hindRight: this.model.getObjectByName('FoxHindRightPaw') as THREE.Mesh,
  };
  private readonly pawWorldPosition = new THREE.Vector3();
  private readonly pawSupportVertex = new THREE.Vector3();
  private readonly frameStart = new THREE.Vector3();
  private readonly frameDisplacement = new THREE.Vector3();
  private readonly walkSpeedOverride: number | undefined;
  private readonly sprintSpeedOverride: number | undefined;
  private walkSpeed: number;
  private sprintSpeed: number;
  private motionProfile: AnimalMotionProfile;
  private elapsed = 0;
  private gaitPhase = 0;
  private movementBlend = 0;
  private runBlend = 0;
  private facingYaw = 0;
  private horizontalSpeed = 0;
  private turnLean = 0;
  private accelerationLean = 0;
  private lastFootfallAt = Number.NEGATIVE_INFINITY;
  private footfallsArmed = false;
  private grounded = false;
  private groundInitialized = false;
  private verticalVelocity = 0;
  private jumpsUsed = 0;
  private coyoteRemaining = 0;
  private jumpBufferRemaining = 0;
  private anticipationRemaining = 0;
  private bufferedDoubleJump = false;
  private airborneTime = 0;
  private doublePoseRemaining = 0;
  private landingRemaining = 0;
  private glideActive = false;
  private airPose: FoxAirPose = 'grounded';
  private airProgress = 1;
  private landingBloom = 0;
  private magicCursor = 0;
  private magicTimer = 0;
  private currentSurface: SurfaceKind = 'grass';
  private reducedMotion: boolean;
  private disposed = false;

  public constructor(options: FoxPlayerOptions = {}) {
    this.input = options.input ?? new PlayerInputController();
    const initialAnimal = options.animal ?? 'fox';
    this.motionProfile = animalMotionProfile(initialAnimal);
    this.walkSpeedOverride = options.walkSpeed;
    this.sprintSpeedOverride = options.sprintSpeed;
    this.walkSpeed = options.walkSpeed ?? this.motionProfile.walkSpeed;
    this.sprintSpeed = options.sprintSpeed ?? this.motionProfile.sprintSpeed;
    this.reducedMotion = options.reducedMotion ?? false;

    this.group.name = 'FoxPlayer';
    this.headingPivot.name = 'FoxHeadingPivot';
    this.aerialPivot.name = 'AnimalAerialPivot';
    this.magicGroup.name = 'FoxMagicEffects';
    this.model.scale.setScalar(this.motionProfile.modelScale);
    this.aerialPivot.add(this.model);
    this.headingPivot.add(this.aerialPivot);
    this.group.add(this.headingPivot, this.magicGroup);
    if (options.spawn) this.group.position.copy(options.spawn);
    this.buildMagicPool();
    this.rig.updatePose({
      deltaSeconds: 0,
      elapsedSeconds: 0,
      gaitPhase: 0,
      movementBlend: 0,
      runBlend: 0,
    });
    this.rig.setAnimal(initialAnimal, options.skin ?? 'base');
    const renderedPaws = this.rig.getRenderedPawStates();
    for (const leg of FOX_LEG_KEYS) this.previousContacts[leg] = renderedPaws[leg].contact;
  }

  public get position(): THREE.Vector3 {
    return this.group.position;
  }

  public get animal(): AnimalKind {
    return this.rig.animal;
  }

  public get skin(): SkinId {
    return this.rig.skin;
  }

  /** World-space heading in radians. Zero faces world -Z. */
  public get headingYaw(): number {
    return this.facingYaw;
  }

  /** Current horizontal speed normalized against the full sprint speed. */
  public get normalizedSpeed(): number {
    return THREE.MathUtils.clamp(this.horizontalSpeed / this.sprintSpeed, 0, 1);
  }

  /** Prevents a camera-relative A/D/S input from steering its own camera basis. */
  public get chaseRecenterWeight(): number {
    const input = this.input.state;
    const magnitude = Math.hypot(input.moveX, input.moveForward);
    return magnitude > 0.04
      ? THREE.MathUtils.clamp(input.moveForward / magnitude, 0, 1)
      : 0;
  }

  /** Whether held jump input is currently slowing and shaping the fall. */
  public get isGliding(): boolean {
    return this.glideActive;
  }

  public get snapshot(): PlayerSnapshot {
    return {
      x: this.group.position.x,
      y: this.group.position.y,
      z: this.group.position.z,
      speed: this.horizontalSpeed,
      sprinting: this.horizontalSpeed > this.walkSpeed * 1.08,
      surface: this.currentSurface,
      grounded: this.grounded,
      jumpsUsed: this.jumpsUsed,
      verticalSpeed: this.verticalVelocity,
    };
  }

  public getMotionDebugSnapshot(): FoxMotionDebugSnapshot {
    return {
      locomotionState: this.locomotionState(),
      airPose: this.airPose,
      gaitPhase: this.gaitPhase,
      movementBlend: this.movementBlend,
      runBlend: this.runBlend,
      headingYaw: this.facingYaw,
      horizontalSpeed: this.horizontalSpeed,
      verticalVelocity: this.verticalVelocity,
      anticipationProgress: this.anticipationRemaining > 0
        ? 1 - this.anticipationRemaining / JUMP_ANTICIPATION_SECONDS
        : 1,
      landingProgress: this.landingRemaining > 0
        ? 1 - this.landingRemaining / LAND_RECOVERY_SECONDS
        : 1,
      rig: this.rig.getDebugSnapshot(),
    };
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  /** Changes appearance without resetting movement, gait phase, or paw contacts. */
  public setAnimal(animal: AnimalKind, skin: SkinId = 'base'): void {
    if (this.disposed) return;
    this.rig.setAnimal(animal, skin);
    this.motionProfile = animalMotionProfile(this.rig.animal);
    this.walkSpeed = this.walkSpeedOverride ?? this.motionProfile.walkSpeed;
    this.sprintSpeed = this.sprintSpeedOverride ?? this.motionProfile.sprintSpeed;
    this.model.scale.setScalar(this.motionProfile.modelScale);
  }

  public setPosition(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.horizontalSpeed = 0;
    this.verticalVelocity = 0;
    this.grounded = true;
    this.groundInitialized = true;
    this.jumpsUsed = 0;
    this.coyoteRemaining = COYOTE_SECONDS;
    this.jumpBufferRemaining = 0;
    this.anticipationRemaining = 0;
    this.bufferedDoubleJump = false;
    this.airborneTime = 0;
    this.doublePoseRemaining = 0;
    this.landingRemaining = 0;
    this.glideActive = false;
    this.airPose = 'grounded';
    this.airProgress = 1;
    this.aerialPivot.rotation.set(0, 0, 0);
    this.aerialPivot.scale.set(1, 1, 1);
    for (const particle of this.magicParticles) particle.mesh.visible = false;
  }

  public setHeadingYaw(yaw: number): void {
    if (!Number.isFinite(yaw)) return;
    this.facingYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    this.headingPivot.rotation.y = this.facingYaw;
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
    resolveHorizontal?: HorizontalMovementResolver,
  ): PlayerSnapshot {
    if (this.disposed) return this.snapshot;
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.05);
    if (delta === 0) return this.snapshot;
    this.elapsed += delta;
    this.frameStart.copy(this.group.position);

    const input = this.input.state;
    if (this.input.consumeJump()) {
      if (this.anticipationRemaining > 0) this.bufferedDoubleJump = true;
      else this.jumpBufferRemaining = JUMP_BUFFER_SECONDS;
    }
    else this.jumpBufferRemaining = Math.max(0, this.jumpBufferRemaining - delta);

    const inputMagnitude = Math.min(1, Math.hypot(input.moveX, input.moveForward));
    const hasMoveIntent = inputMagnitude > 0.04;
    const sprintRequested = input.sprint && inputMagnitude > 0.15;
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

    const previousSpeed = this.horizontalSpeed;
    let turnError = 0;
    if (hasMoveIntent) {
      const targetYaw = Math.atan2(-this.movementDirection.x, -this.movementDirection.z);
      turnError = shortestAngle(this.facingYaw, targetYaw);
      const speedRatio = THREE.MathUtils.clamp(this.horizontalSpeed / this.sprintSpeed, 0, 1);
      const groundedTurn = THREE.MathUtils.lerp(WALK_TURN_RESPONSE, RUN_TURN_RESPONSE, speedRatio)
        * this.motionProfile.turnScale;
      const turnResponse = this.grounded
        ? groundedTurn
        : (this.glideActive ? GLIDE_TURN_RESPONSE : AIR_TURN_RESPONSE) * this.motionProfile.turnScale;
      this.facingYaw += turnError * (1 - Math.exp(-turnResponse * delta));
      this.facingYaw = Math.atan2(Math.sin(this.facingYaw), Math.cos(this.facingYaw));
    }

    const topSpeed = sprintRequested ? this.sprintSpeed : this.walkSpeed;
    const reversalPenalty = hasMoveIntent
      ? THREE.MathUtils.lerp(1, 0.34, THREE.MathUtils.smoothstep(Math.abs(turnError), 1.05, Math.PI))
      : 1;
    let desiredSpeed = hasMoveIntent ? topSpeed * inputMagnitude * reversalPenalty : 0;
    if (!this.grounded && !hasMoveIntent) desiredSpeed = this.horizontalSpeed * 0.995;
    if (this.glideActive && hasMoveIntent) desiredSpeed *= 1.06;
    const accelerating = desiredSpeed > this.horizontalSpeed + 0.06;
    const speedResponse = this.grounded
      ? (!hasMoveIntent
          ? COAST_RESPONSE
          : accelerating
            ? (sprintRequested ? SPRINT_ACCELERATION_RESPONSE : WALK_ACCELERATION_RESPONSE)
              * this.motionProfile.accelerationScale
            : 5.8)
      : (hasMoveIntent ? (this.glideActive ? 3.8 : 2.5) : 0.34);
    this.horizontalSpeed = damp(this.horizontalSpeed, desiredSpeed, speedResponse, delta);
    if (!hasMoveIntent && this.grounded && this.horizontalSpeed < 0.018) this.horizontalSpeed = 0;

    this.velocity.set(
      -Math.sin(this.facingYaw) * this.horizontalSpeed,
      0,
      -Math.cos(this.facingYaw) * this.horizontalSpeed,
    );
    const horizontalAcceleration = (this.horizontalSpeed - previousSpeed) / delta;
    this.accelerationLean = damp(
      this.accelerationLean,
      this.grounded ? THREE.MathUtils.clamp(-horizontalAcceleration * 0.006, -0.07, 0.052) : 0,
      5.8,
      delta,
    );
    const turnEnergy = THREE.MathUtils.smoothstep(this.horizontalSpeed / this.sprintSpeed, 0.08, 0.78);
    this.turnLean = damp(
      this.turnLean,
      this.grounded ? THREE.MathUtils.clamp(-turnError * turnEnergy * 0.09, -0.095, 0.095) : 0,
      7.1,
      delta,
    );
    this.headingPivot.rotation.y = this.facingYaw;

    this.group.position.x += this.velocity.x * delta;
    this.group.position.z += this.velocity.z * delta;
    if (resolveHorizontal) {
      const resolved = resolveHorizontal(
        this.frameStart.x,
        this.frameStart.z,
        this.group.position.x,
        this.group.position.z,
      );
      if (Number.isFinite(resolved.x) && Number.isFinite(resolved.z)) {
        this.group.position.x = resolved.x;
        this.group.position.z = resolved.z;
      }
    }
    const groundY = safeHeight(heightAt, this.group.position.x, this.group.position.z, this.group.position.y);
    this.currentSurface = surfaceAt(this.group.position.x, this.group.position.z);
    this.updateGrounding(delta, groundY);
    this.updateJumpState(delta, input.jumpHeld, groundY, onAction);

    this.advanceGait(delta, sprintRequested);
    this.updateAirPose(delta);
    this.updateDoubleJumpFlourish();
    const groundPose = this.samplePawGround(heightAt, groundY);
    this.rig.updatePose({
      deltaSeconds: delta,
      elapsedSeconds: this.elapsed,
      gaitPhase: this.gaitPhase,
      movementBlend: this.movementBlend,
      runBlend: this.runBlend,
      airPose: this.airPose,
      airBlend: this.airPose === 'grounded' ? 0 : 1,
      airProgress: this.airProgress,
      turnLean: this.turnLean,
      accelerationLean: this.accelerationLean,
      groundPitch: groundPose.pitch,
      groundRoll: groundPose.roll,
      pawGroundOffsets: this.pawGroundOffsets,
      reducedMotion: this.reducedMotion,
    });
    this.emitFootfalls(this.horizontalSpeed > 0.12, surfaceAt, onFootstep);

    this.frameDisplacement.copy(this.group.position).sub(this.frameStart);
    this.updateMagic(delta, this.frameDisplacement, this.horizontalSpeed);
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

  private locomotionState(): FoxLocomotionState {
    if (!this.grounded) return 'airborne';
    if (this.anticipationRemaining > 0) return 'anticipating';
    if (this.landingRemaining > 0) return 'landing';
    if (this.horizontalSpeed < 0.12) return 'idle';
    return this.runBlend > 0.52 ? 'run' : 'walk';
  }

  private updateGrounding(delta: number, groundY: number): void {
    if (!this.groundInitialized) {
      this.group.position.y = groundY;
      this.grounded = true;
      this.groundInitialized = true;
      this.coyoteRemaining = COYOTE_SECONDS;
      return;
    }

    if (this.grounded && this.group.position.y - groundY > 0.24) {
      this.grounded = false;
      this.airPose = 'fall';
      this.airborneTime = 0;
      return;
    }

    if (this.grounded) {
      this.group.position.y = groundY > this.group.position.y
        ? groundY
        : damp(this.group.position.y, groundY, 18, delta);
      this.verticalVelocity = 0;
      this.coyoteRemaining = COYOTE_SECONDS;
    } else {
      this.coyoteRemaining = Math.max(0, this.coyoteRemaining - delta);
    }
  }

  private updateJumpState(
    delta: number,
    jumpHeld: boolean,
    groundY: number,
    onAction?: FoxActionListener,
  ): void {
    if (this.anticipationRemaining > 0) {
      this.anticipationRemaining = Math.max(0, this.anticipationRemaining - delta);
      this.airPose = 'anticipate';
      this.airProgress = 1 - this.anticipationRemaining / JUMP_ANTICIPATION_SECONDS;
      if (this.anticipationRemaining === 0) {
        const queueSecondJump = this.bufferedDoubleJump;
        this.bufferedDoubleJump = false;
        this.launchJump(false, onAction);
        if (queueSecondJump) this.jumpBufferRemaining = JUMP_BUFFER_SECONDS;
      }
    } else if (this.jumpBufferRemaining > 0) {
      if (this.grounded) {
        this.jumpBufferRemaining = 0;
        this.anticipationRemaining = JUMP_ANTICIPATION_SECONDS;
        this.landingRemaining = 0;
        this.airPose = 'anticipate';
        this.airProgress = 0;
      } else if (this.coyoteRemaining > 0 && this.jumpsUsed === 0) {
        this.launchJump(false, onAction);
      } else if (this.jumpsUsed === 1) {
        this.launchJump(true, onAction);
      }
    }

    if (this.grounded) {
      this.glideActive = false;
      if (this.landingRemaining > 0) this.landingRemaining = Math.max(0, this.landingRemaining - delta);
      return;
    }

    this.airborneTime += delta;
    this.doublePoseRemaining = Math.max(0, this.doublePoseRemaining - delta);
    this.glideActive = jumpHeld
      && this.jumpsUsed > 0
      && this.airborneTime >= GLIDE_ENTRY_SECONDS
      && this.verticalVelocity <= GLIDE_APEX_SPEED;

    // Held jump never changes the upward takeoff arc. Glide lift begins only
    // around the apex and affects the descent, preserving a readable leap.
    const gravity = this.glideActive && this.verticalVelocity <= 0
      ? this.motionProfile.glideGravity
      : this.motionProfile.gravity;
    const terminalSpeed = this.glideActive ? this.motionProfile.glideTerminalSpeed : FALL_TERMINAL_SPEED;
    this.verticalVelocity = Math.max(terminalSpeed, this.verticalVelocity - gravity * delta);
    this.group.position.y += this.verticalVelocity * delta;

    if (this.group.position.y <= groundY && this.verticalVelocity <= 0) {
      const landingSpeed = Math.abs(this.verticalVelocity);
      const wasAirborneLongEnough = this.airborneTime > 0.075;
      this.group.position.y = groundY;
      this.verticalVelocity = 0;
      this.grounded = true;
      this.jumpsUsed = 0;
      this.bufferedDoubleJump = false;
      this.coyoteRemaining = COYOTE_SECONDS;
      this.airborneTime = 0;
      this.doublePoseRemaining = 0;
      this.glideActive = false;
      this.landingRemaining = LAND_RECOVERY_SECONDS;
      this.airPose = 'land';
      this.airProgress = 0;
      if (wasAirborneLongEnough) {
        const intensity = THREE.MathUtils.clamp(landingSpeed / 11, 0.25, 1);
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

  private launchJump(doubleJump: boolean, onAction?: FoxActionListener): void {
    this.jumpBufferRemaining = 0;
    this.anticipationRemaining = 0;
    this.grounded = false;
    this.coyoteRemaining = 0;
    this.airborneTime = 0;
    this.glideActive = false;
    this.jumpsUsed = doubleJump ? 2 : 1;
    this.verticalVelocity = doubleJump
      ? this.motionProfile.doubleJumpImpulse
      : this.motionProfile.jumpImpulse;
    this.doublePoseRemaining = doubleJump ? DOUBLE_POSE_SECONDS : 0;
    this.airPose = doubleJump ? 'double' : 'rise';
    this.airProgress = 0;
    this.spawnMagic(doubleJump ? 10 : 7, doubleJump ? 1.2 : 0.92);
    onAction?.({
      type: doubleJump ? 'double-jump' : 'jump',
      position: this.group.position.clone(),
      surface: this.currentSurface,
      intensity: doubleJump ? 1 : 0.78,
    });
  }

  private advanceGait(delta: number, sprinting: boolean): void {
    const movementTarget = THREE.MathUtils.smoothstep(this.horizontalSpeed, 0.06, 0.72);
    this.movementBlend = damp(this.movementBlend, movementTarget, 7.2, delta);
    const runTarget = THREE.MathUtils.smoothstep(
      this.horizontalSpeed,
      this.walkSpeed * 0.9,
      this.sprintSpeed * 0.9,
    );
    this.runBlend = damp(this.runBlend, runTarget, sprinting ? 3.8 : 5, delta);
    const gaitRadiansPerMetre = THREE.MathUtils.lerp(1.82, 2.08, this.runBlend)
      * this.motionProfile.gaitScale;
    this.gaitPhase = (this.gaitPhase + this.horizontalSpeed * delta * gaitRadiansPerMetre) % (Math.PI * 2);
  }

  private samplePawGround(
    heightAt: HeightSampler,
    centerGroundY: number,
  ): { pitch: number; roll: number } {
    this.group.updateMatrixWorld(true);
    for (const key of FOX_LEG_KEYS) {
      const paw = this.pawObjects[key];
      paw.getWorldPosition(this.pawWorldPosition);
      const centerHeight = safeHeight(
        heightAt,
        this.pawWorldPosition.x,
        this.pawWorldPosition.z,
        centerGroundY,
      );
      const positions = paw.geometry.getAttribute('position');
      let bottomVertexY = Number.POSITIVE_INFINITY;
      for (let index = 0; index < positions.count; index += 1) {
        this.pawSupportVertex.fromBufferAttribute(positions, index).applyMatrix4(paw.matrixWorld);
        bottomVertexY = Math.min(bottomVertexY, this.pawSupportVertex.y);
      }
      let supportHeight = centerHeight;
      for (let index = 0; index < positions.count; index += 1) {
        this.pawSupportVertex.fromBufferAttribute(positions, index).applyMatrix4(paw.matrixWorld);
        if (this.pawSupportVertex.y > bottomVertexY + 0.04) continue;
        supportHeight = Math.max(
          supportHeight,
          safeHeight(heightAt, this.pawSupportVertex.x, this.pawSupportVertex.z, centerHeight),
        );
      }
      this.pawGroundCenters[key] = centerHeight - this.group.position.y;
      this.pawGroundOffsets[key] = supportHeight - this.group.position.y;
    }

    const front = (this.pawGroundCenters.frontLeft + this.pawGroundCenters.frontRight) * 0.5;
    const hind = (this.pawGroundCenters.hindLeft + this.pawGroundCenters.hindRight) * 0.5;
    const left = (this.pawGroundCenters.frontLeft + this.pawGroundCenters.hindLeft) * 0.5;
    const right = (this.pawGroundCenters.frontRight + this.pawGroundCenters.hindRight) * 0.5;
    return {
      pitch: THREE.MathUtils.clamp(Math.atan2(front - hind, 1.04), -0.34, 0.34),
      roll: THREE.MathUtils.clamp(Math.atan2(right - left, 0.58), -0.3, 0.3),
    };
  }

  private updateAirPose(delta: number): void {
    this.landingBloom *= Math.exp(-5.4 * delta);
    if (this.anticipationRemaining > 0) return;

    if (this.grounded) {
      if (this.landingRemaining > 0) {
        this.airPose = 'land';
        this.airProgress = 1 - this.landingRemaining / LAND_RECOVERY_SECONDS;
      } else {
        this.airPose = 'grounded';
        this.airProgress = 1;
      }
      return;
    }

    if (this.doublePoseRemaining > 0) {
      this.airPose = 'double';
      this.airProgress = 1 - this.doublePoseRemaining / DOUBLE_POSE_SECONDS;
    } else if (this.glideActive) {
      this.airPose = 'glide';
      this.airProgress = THREE.MathUtils.clamp((this.airborneTime - GLIDE_ENTRY_SECONDS) / 0.22, 0, 1);
    } else if (this.verticalVelocity > 1.15) {
      this.airPose = 'rise';
      this.airProgress = THREE.MathUtils.clamp(
        1 - this.verticalVelocity / this.motionProfile.jumpImpulse,
        0,
        1,
      );
    } else if (this.verticalVelocity > -1.2) {
      this.airPose = 'apex';
      this.airProgress = THREE.MathUtils.clamp((1.15 - this.verticalVelocity) / 2.35, 0, 1);
    } else {
      this.airPose = 'fall';
      this.airProgress = THREE.MathUtils.clamp(Math.abs(this.verticalVelocity) / 9, 0, 1);
    }
  }

  private updateDoubleJumpFlourish(): void {
    if (this.airPose !== 'double') {
      this.aerialPivot.rotation.set(0, 0, 0);
      this.aerialPivot.scale.set(1, 1, 1);
      return;
    }
    const progress = THREE.MathUtils.clamp(this.airProgress, 0, 1);
    const eased = progress * progress * (3 - 2 * progress);
    const [turnX, turnY, turnZ] = this.motionProfile.doubleJumpTurns;
    const intensity = this.reducedMotion ? 0 : 1;
    const angle = Math.PI * 2 * eased * intensity;
    this.aerialPivot.rotation.set(turnX * angle, turnY * angle, turnZ * angle);
    const squash = Math.sin(progress * Math.PI) * (this.reducedMotion ? 0.025 : 0.075);
    this.aerialPivot.scale.set(1 + squash, 1 - squash * 0.7, 1 + squash);
  }

  private emitFootfalls(
    moving: boolean,
    surfaceAt: SurfaceSampler,
    onFootstep?: FootstepListener,
  ): void {
    const renderedPaws = this.rig.getRenderedPawStates();
    const canEmit = this.grounded
      && this.airPose === 'grounded'
      && this.anticipationRemaining === 0
      && this.landingRemaining === 0
      && moving;

    if (!canEmit || !this.footfallsArmed) {
      for (const leg of FOX_LEG_KEYS) this.previousContacts[leg] = renderedPaws[leg].contact;
      this.footfallsArmed = canEmit;
      return;
    }

    for (const leg of FOX_LEG_KEYS) {
      const rendered = renderedPaws[leg];
      // The Saylor tribute is the roster's only biped. Its visible legs are
      // driven by the two hind chains, so front-paw contacts must remain
      // silent or the upright stride would produce four unsynchronised steps.
      if (this.animal === 'saylor' && leg.startsWith('front')) {
        this.previousContacts[leg] = rendered.contact;
        continue;
      }
      if (!this.previousContacts[leg] && rendered.contact) {
        const sprinting = this.runBlend > 0.52;
        const clusteredRunContact = sprinting
          && this.elapsed - this.lastFootfallAt < SPRINT_CLUSTER_SECONDS;
        const movementIntensity = THREE.MathUtils.clamp(this.horizontalSpeed / this.sprintSpeed, 0.2, 1);
        const impactWeight = THREE.MathUtils.clamp(rendered.downwardImpact / 1.8, 0, 1);
        const clusterGain = clusteredRunContact ? 0.78 : 1;
        this.lastFootfallAt = this.elapsed;
        onFootstep?.({
          position: rendered.position.clone(),
          leg,
          side: leg.endsWith('Left') ? 'left' : 'right',
          surface: surfaceAt(rendered.position.x, rendered.position.z),
          sprinting,
          intensity: THREE.MathUtils.clamp(
            movementIntensity * THREE.MathUtils.lerp(0.86, 1, impactWeight) * clusterGain,
            0.15,
            1,
          ),
        });
      }
      this.previousContacts[leg] = rendered.contact;
    }
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
}
