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
import { PlayerInputController, type PlayerInputState } from './InputController';
import {
  loadMovementTuning,
  type MovementTuning,
} from './MovementConfig';
import { DEBUG_MODE } from '../config';

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

export type FoxActionKind =
  | 'jump'
  | 'double-jump'
  | 'glide-start'
  | 'glide-end'
  | 'land'
  | 'skid';

export interface FoxActionEvent {
  readonly type: FoxActionKind;
  readonly position: THREE.Vector3;
  readonly surface: SurfaceKind;
  /** Normalized action energy in the range 0..1. */
  readonly intensity: number;
  readonly state: FoxLocomotionState;
  readonly horizontalSpeed: number;
  readonly verticalSpeed: number;
  readonly airtime: number;
  readonly landing?: 'soft' | 'heavy';
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
  readonly tuning?: MovementTuning;
}

export type FoxLocomotionState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'jump-anticipate'
  | 'jump-rise'
  | 'apex'
  | 'fall'
  | 'double-jump'
  | 'glide'
  | 'land-soft'
  | 'land-heavy'
  | 'skid';

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
  readonly fixedSteps: number;
  readonly interpolationAlpha: number;
  readonly airtime: number;
  readonly coyoteRemaining: number;
  readonly jumpBufferRemaining: number;
  readonly jumpsUsed: number;
  readonly glideBank: number;
  readonly activeParticles: number;
  readonly activeRings: number;
  readonly activeTrailSegments: number;
  readonly inputEnabled: boolean;
  readonly jumpHeld: boolean;
  readonly jumpEdgeQueued: boolean;
  readonly jumpRequestSequence: number;
  readonly inputClearSequence: number;
  readonly jumpSequence: number;
  readonly doubleJumpSequence: number;
  readonly glideSequence: number;
  readonly stateTransitionSequence: number;
  readonly bufferedDoubleSequence: number;
  readonly delayedDoubleSequence: number;
  readonly maxAirtimeObserved: number;
  readonly tuning: Readonly<MovementTuning>;
  readonly rig: FoxRigDebugSnapshot;
}

export interface FoxNetworkMotionSnapshot {
  readonly movementState: FoxLocomotionState;
  readonly gaitPhase: number;
  readonly movementBlend: number;
  readonly runBlend: number;
  readonly airProgress: number;
  readonly simulationTick: number;
  readonly velocityX: number;
  readonly velocityZ: number;
  readonly turnLean: number;
  readonly accelerationLean: number;
  readonly glideBank: number;
  readonly anticipationSequence: number;
  readonly jumpSequence: number;
  readonly doubleJumpSequence: number;
  readonly landSequence: number;
  readonly skidSequence: number;
  readonly anticipationTick: number;
  readonly jumpTick: number;
  readonly doubleJumpTick: number;
  readonly landTick: number;
  readonly skidTick: number;
  readonly landingTier: 'soft' | 'heavy';
  readonly stateTransitionSequence: number;
  readonly stateTransitionTick: number;
}

interface MagicParticle {
  readonly mesh: THREE.Mesh;
  readonly velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
  bornFrame: number;
}

interface MovementRing {
  readonly mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  targetScale: number;
  bornFrame: number;
}

interface GlideTrailSegment {
  readonly center: THREE.Vector3;
  readonly direction: THREE.Vector3;
  life: number;
  maxLife: number;
  active: boolean;
}

const DEFAULT_SURFACE: SurfaceSampler = () => 'grass';
const NO_HEIGHT: HeightSampler = () => 0;
const SPRINT_CLUSTER_SECONDS = 0.08;
const GLIDE_TRAIL_SEGMENTS_PER_SIDE = 36;
const GLIDE_TRAIL_LIFETIME_SECONDS = 0.56;
const GLIDE_TRAIL_SAMPLE_DISTANCE = 0.08;

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
  private readonly movementFxGroup = new THREE.Group();
  private readonly velocity = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly movementDirection = new THREE.Vector3();
  private readonly magicParticles: MagicParticle[] = [];
  private readonly movementRings: MovementRing[] = [];
  private readonly glideRibbons: readonly THREE.Mesh[];
  private readonly glideTrailSegments: readonly [GlideTrailSegment[], GlideTrailSegment[]] = [[], []];
  private readonly glideTrailLast: readonly [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private readonly glideTrailReady = [false, false];
  private readonly glideTrailCursor = [0, 0];
  private readonly glideTrailMatrix = new THREE.Matrix4();
  private readonly glideTrailPosition = new THREE.Vector3();
  private readonly glideTrailDirection = new THREE.Vector3();
  private readonly glideTrailScale = new THREE.Vector3();
  private readonly glideTrailQuaternion = new THREE.Quaternion();
  private readonly glideTrailForward = new THREE.Vector3(0, 0, 1);
  private readonly simulationPosition = new THREE.Vector3();
  private readonly previousSimulationPosition = new THREE.Vector3();
  private readonly renderedPosition = new THREE.Vector3();
  /** Stable view returned from `snapshot`; refreshed in place to avoid RAF garbage. */
  private readonly playerSnapshot: PlayerSnapshot = {
    x: 0,
    y: 0,
    z: 0,
    speed: 0,
    sprinting: false,
    surface: 'grass',
    grounded: false,
    jumpsUsed: 0,
    verticalSpeed: 0,
  };
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
  private readonly tuning: MovementTuning;
  private readonly walkSpeedOverride: number | undefined;
  private readonly sprintSpeedOverride: number | undefined;
  private walkSpeed = 0;
  private sprintSpeed = 0;
  private motionProfile: AnimalMotionProfile;
  private elapsed = 0;
  private gaitPhase = 0;
  private previousGaitPhase = 0;
  private movementBlend = 0;
  private previousMovementBlend = 0;
  private runBlend = 0;
  private previousRunBlend = 0;
  private facingYaw = 0;
  private previousFacingYaw = 0;
  private horizontalSpeed = 0;
  private facingAngularVelocity = 0;
  private turnLean = 0;
  private previousTurnLean = 0;
  private accelerationLean = 0;
  private previousAccelerationLean = 0;
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
  private delayedDoubleJumpQueued = false;
  private bufferedDoubleSequence = 0;
  private delayedDoubleSequence = 0;
  private maxAirtimeObserved = 0;
  private airborneTime = 0;
  private doublePoseRemaining = 0;
  private landingRemaining = 0;
  private glideActive = false;
  private airPose: FoxAirPose = 'grounded';
  private previousAirPose: FoxAirPose = 'grounded';
  private airProgress = 1;
  private previousAirProgress = 1;
  private landingBloom = 0;
  private magicCursor = 0;
  private magicTimer = 0;
  private currentSurface: SurfaceKind = 'grass';
  private stateValue: FoxLocomotionState = 'idle';
  private fixedAccumulator = 0;
  private fixedStepsLastFrame = 0;
  private simulationTick = 0;
  private anticipationSequence = 0;
  private jumpSequence = 0;
  private doubleJumpSequence = 0;
  private glideSequence = 0;
  private landSequence = 0;
  private skidSequence = 0;
  private anticipationTick = 0;
  private jumpTick = 0;
  private doubleJumpTick = 0;
  private landTick = 0;
  private skidTick = 0;
  private stateTransitionSequence = 0;
  private stateTransitionTick = 0;
  private interpolationAlpha = 0;
  private skidRemaining = 0;
  private glideBank = 0;
  private jumpWasHeld = false;
  private jumpReleaseQueued = false;
  private jumpCutQueued = false;
  private jumpCutApplied = false;
  private lastLanding: 'soft' | 'heavy' = 'soft';
  private ringCursor = 0;
  private renderFrame = 0;
  private reducedMotion: boolean;
  private disposed = false;

  public constructor(options: FoxPlayerOptions = {}) {
    this.input = options.input ?? new PlayerInputController();
    const initialAnimal = options.animal ?? 'fox';
    this.motionProfile = animalMotionProfile(initialAnimal);
    this.walkSpeedOverride = options.walkSpeed;
    this.sprintSpeedOverride = options.sprintSpeed;
    this.reducedMotion = options.reducedMotion ?? false;
    this.tuning = options.tuning ?? loadMovementTuning(DEBUG_MODE);
    this.syncMotionProfileTuning();
    this.input.setTuning(this.tuning.input);

    this.group.name = 'FoxPlayer';
    this.headingPivot.name = 'FoxHeadingPivot';
    this.aerialPivot.name = 'AnimalAerialPivot';
    this.magicGroup.name = 'FoxMagicEffects';
    this.movementFxGroup.name = 'PlayerMovementEffects';
    this.model.scale.setScalar(this.motionProfile.modelScale);
    this.aerialPivot.add(this.model);
    this.headingPivot.add(this.aerialPivot);
    this.group.add(this.headingPivot, this.magicGroup, this.movementFxGroup);
    if (options.spawn) this.group.position.copy(options.spawn);
    this.simulationPosition.copy(this.group.position);
    this.previousSimulationPosition.copy(this.group.position);
    this.renderedPosition.copy(this.group.position);
    this.buildMagicPool();
    this.glideRibbons = this.buildMovementFxPool();
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

  /** Fixed-step authoritative position used for replication and corrections. */
  public get authoritativePosition(): Readonly<THREE.Vector3> {
    return this.simulationPosition;
  }

  /** Interpolated visual position for the camera and presentation systems. */
  public get renderPosition(): Readonly<THREE.Vector3> {
    return this.renderedPosition;
  }

  public get movementState(): FoxLocomotionState {
    return this.stateValue;
  }

  public get movementTuning(): Readonly<MovementTuning> {
    return this.tuning;
  }

  public get networkMotion(): FoxNetworkMotionSnapshot {
    return {
      movementState: this.stateValue,
      gaitPhase: ((this.gaitPhase / (Math.PI * 2)) % 1 + 1) % 1,
      movementBlend: this.movementBlend,
      runBlend: this.runBlend,
      airProgress: this.airProgress,
      simulationTick: this.simulationTick >>> 0,
      velocityX: this.velocity.x,
      velocityZ: this.velocity.z,
      turnLean: this.turnLean,
      accelerationLean: this.accelerationLean,
      glideBank: this.glideBank,
      anticipationSequence: this.anticipationSequence >>> 0,
      jumpSequence: this.jumpSequence >>> 0,
      doubleJumpSequence: this.doubleJumpSequence >>> 0,
      landSequence: this.landSequence >>> 0,
      skidSequence: this.skidSequence >>> 0,
      anticipationTick: this.anticipationTick >>> 0,
      jumpTick: this.jumpTick >>> 0,
      doubleJumpTick: this.doubleJumpTick >>> 0,
      landTick: this.landTick >>> 0,
      skidTick: this.skidTick >>> 0,
      landingTier: this.lastLanding,
      stateTransitionSequence: this.stateTransitionSequence >>> 0,
      stateTransitionTick: this.stateTransitionTick >>> 0,
    };
  }

  public get glideBankAmount(): number {
    return this.glideBank;
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

  /** Actual planar travel direction, used by the camera through skids and banks. */
  public get travelYaw(): number {
    return this.horizontalSpeed > 0.025
      ? Math.atan2(-this.velocity.x, -this.velocity.z)
      : this.facingYaw;
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
    this.playerSnapshot.x = this.simulationPosition.x;
    this.playerSnapshot.y = this.simulationPosition.y;
    this.playerSnapshot.z = this.simulationPosition.z;
    this.playerSnapshot.speed = this.horizontalSpeed;
    this.playerSnapshot.sprinting = this.horizontalSpeed > this.walkSpeed * 1.08;
    this.playerSnapshot.surface = this.currentSurface;
    this.playerSnapshot.grounded = this.grounded;
    this.playerSnapshot.jumpsUsed = this.jumpsUsed;
    this.playerSnapshot.verticalSpeed = this.verticalVelocity;
    return this.playerSnapshot;
  }

  public getMotionDebugSnapshot(): FoxMotionDebugSnapshot {
    let activeParticles = 0;
    let activeRings = 0;
    let activeTrailSegments = 0;
    for (const particle of this.magicParticles) if (particle.mesh.visible) activeParticles += 1;
    for (const ring of this.movementRings) if (ring.mesh.visible) activeRings += 1;
    for (const side of this.glideTrailSegments) {
      for (const segment of side) if (segment.active) activeTrailSegments += 1;
    }
    return {
      locomotionState: this.stateValue,
      airPose: this.airPose,
      gaitPhase: this.gaitPhase,
      movementBlend: this.movementBlend,
      runBlend: this.runBlend,
      headingYaw: this.facingYaw,
      horizontalSpeed: this.horizontalSpeed,
      verticalVelocity: this.verticalVelocity,
      anticipationProgress: this.anticipationRemaining > 0
        ? 1 - this.anticipationRemaining / this.tuning.jump.anticipationSeconds
        : 1,
      landingProgress: this.landingRemaining > 0
        ? 1 - this.landingRemaining / (this.lastLanding === 'heavy'
            ? this.tuning.jump.heavyRecoverySeconds
            : this.tuning.jump.softRecoverySeconds)
        : 1,
      fixedSteps: this.fixedStepsLastFrame,
      interpolationAlpha: this.interpolationAlpha,
      airtime: this.airborneTime,
      coyoteRemaining: this.coyoteRemaining,
      jumpBufferRemaining: this.jumpBufferRemaining,
      jumpsUsed: this.jumpsUsed,
      glideBank: this.glideBank,
      activeParticles,
      activeRings,
      activeTrailSegments,
      inputEnabled: this.input.isEnabled,
      jumpHeld: this.input.state.jumpHeld,
      jumpEdgeQueued: this.input.hasQueuedJump,
      jumpRequestSequence: this.input.debugJumpRequestSequence,
      inputClearSequence: this.input.debugClearSequence,
      jumpSequence: this.jumpSequence >>> 0,
      doubleJumpSequence: this.doubleJumpSequence >>> 0,
      glideSequence: this.glideSequence >>> 0,
      stateTransitionSequence: this.stateTransitionSequence >>> 0,
      bufferedDoubleSequence: this.bufferedDoubleSequence >>> 0,
      delayedDoubleSequence: this.delayedDoubleSequence >>> 0,
      maxAirtimeObserved: this.maxAirtimeObserved,
      tuning: this.tuning,
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
    this.syncMotionProfileTuning();
    this.model.scale.setScalar(this.motionProfile.modelScale);
  }

  private syncMotionProfileTuning(): void {
    this.walkSpeed = (this.walkSpeedOverride ?? this.motionProfile.walkSpeed)
      * this.tuning.physics.walkSpeedScale;
    this.sprintSpeed = (this.sprintSpeedOverride ?? this.motionProfile.sprintSpeed)
      * this.tuning.physics.sprintSpeedScale;
  }

  public setPosition(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.simulationPosition.set(x, y, z);
    this.previousSimulationPosition.set(x, y, z);
    this.renderedPosition.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.horizontalSpeed = 0;
    this.verticalVelocity = 0;
    this.grounded = true;
    this.groundInitialized = true;
    this.jumpsUsed = 0;
    this.coyoteRemaining = this.tuning.input.coyoteSeconds;
    this.jumpBufferRemaining = 0;
    this.anticipationRemaining = 0;
    this.bufferedDoubleJump = false;
    this.delayedDoubleJumpQueued = false;
    this.airborneTime = 0;
    this.doublePoseRemaining = 0;
    this.landingRemaining = 0;
    this.glideActive = false;
    this.fixedAccumulator = 0;
    this.interpolationAlpha = 0;
    this.facingAngularVelocity = 0;
    this.skidRemaining = 0;
    this.jumpCutApplied = false;
    this.jumpReleaseQueued = false;
    this.jumpCutQueued = false;
    this.airPose = 'grounded';
    this.previousAirPose = 'grounded';
    this.airProgress = 1;
    this.previousAirProgress = 1;
    this.previousGaitPhase = this.gaitPhase;
    this.previousMovementBlend = this.movementBlend;
    this.previousRunBlend = this.runBlend;
    this.previousFacingYaw = this.facingYaw;
    this.previousTurnLean = this.turnLean;
    this.previousAccelerationLean = this.accelerationLean;
    this.commitState('idle');
    this.aerialPivot.rotation.set(0, 0, 0);
    this.aerialPivot.scale.set(1, 1, 1);
    this.rig.resetSecondaryMotion();
    for (const particle of this.magicParticles) particle.mesh.visible = false;
    for (const ring of this.movementRings) ring.mesh.visible = false;
    for (const ribbon of this.glideRibbons) ribbon.visible = false;
    for (const side of [0, 1] as const) {
      this.glideTrailReady[side] = false;
      for (const segment of this.glideTrailSegments[side]) segment.active = false;
    }
  }

  public setHeadingYaw(yaw: number): void {
    if (!Number.isFinite(yaw)) return;
    this.facingYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    this.previousFacingYaw = this.facingYaw;
    this.headingPivot.rotation.y = this.facingYaw;
  }

  /** Shifts fixed and interpolated state together so soft server correction sticks. */
  public applyNetworkCorrection(x: number, y: number, z: number, amount = 0.2): void {
    if (![x, y, z].every(Number.isFinite)) return;
    const alpha = THREE.MathUtils.clamp(amount, 0, 1);
    const next = new THREE.Vector3(
      THREE.MathUtils.lerp(this.simulationPosition.x, x, alpha),
      THREE.MathUtils.lerp(this.simulationPosition.y, y, Math.min(1, alpha * 0.65)),
      THREE.MathUtils.lerp(this.simulationPosition.z, z, alpha),
    );
    const shift = next.sub(this.simulationPosition);
    this.simulationPosition.add(shift);
    this.previousSimulationPosition.add(shift);
    this.renderedPosition.add(shift);
    this.group.position.add(shift);
  }

  public setVirtualInput(moveX: number, moveForward: number, sprint = false): void {
    this.input.setVirtualInput(moveX, moveForward, sprint);
  }

  /** Queue a jump through the same edge-triggered path used by the Space key. */
  public requestJump(force = false): void {
    this.input.requestJump(force);
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
    this.syncMotionProfileTuning();
    this.renderFrame = (this.renderFrame + 1) >>> 0;
    const delta = Math.min(
      Math.max(deltaSeconds, 0),
      this.tuning.simulation.maxFrameDeltaSeconds,
    );
    if (delta === 0) return this.snapshot;
    this.frameStart.copy(this.renderedPosition);
    this.input.pollGamepad();
    const input = this.input.state;
    if (this.input.consumeJumpRelease() || (!input.jumpHeld && this.jumpWasHeld)) {
      this.jumpReleaseQueued = true;
    }
    if (this.input.consumeJump()) {
      if (this.anticipationRemaining > 0) {
        if (!this.bufferedDoubleJump) {
          this.bufferedDoubleSequence = (this.bufferedDoubleSequence + 1) >>> 0;
        }
        this.bufferedDoubleJump = true;
      }
      else if (this.grounded) {
        // Begin the visible squash on the input frame even when a high-refresh
        // RAF has not accumulated a physics step yet. Physics still advances
        // only inside the fixed loop below.
        this.jumpBufferRemaining = 0;
        this.anticipationRemaining = this.tuning.jump.anticipationSeconds;
        this.markAnticipation();
        this.landingRemaining = 0;
        this.airPose = 'anticipate';
        this.airProgress = 0;
        this.commitState('jump-anticipate');
      } else {
        this.jumpBufferRemaining = this.tuning.input.jumpBufferSeconds;
      }
    }
    this.fixedAccumulator = Math.min(
      this.fixedAccumulator + delta,
      this.tuning.simulation.fixedStepSeconds * this.tuning.simulation.maxSubSteps,
    );
    this.fixedStepsLastFrame = 0;
    const fixed = this.tuning.simulation.fixedStepSeconds;
    while (
      this.fixedAccumulator + 1e-9 >= fixed
      && this.fixedStepsLastFrame < this.tuning.simulation.maxSubSteps
    ) {
      this.previousSimulationPosition.copy(this.simulationPosition);
      this.previousGaitPhase = this.gaitPhase;
      this.previousMovementBlend = this.movementBlend;
      this.previousRunBlend = this.runBlend;
      this.previousFacingYaw = this.facingYaw;
      this.previousTurnLean = this.turnLean;
      this.previousAccelerationLean = this.accelerationLean;
      this.previousAirPose = this.airPose;
      this.previousAirProgress = this.airProgress;
      this.group.position.copy(this.simulationPosition);
      this.simulateFixedStep(
        fixed,
        cameraYaw,
        input,
        heightAt,
        surfaceAt,
        onAction,
        resolveHorizontal,
      );
      this.simulationPosition.copy(this.group.position);
      this.fixedAccumulator = Math.max(0, this.fixedAccumulator - fixed);
      this.fixedStepsLastFrame += 1;
    }
    this.interpolationAlpha = fixed > 0
      ? THREE.MathUtils.clamp(this.fixedAccumulator / fixed, 0, 1)
      : 1;
    this.renderedPosition.lerpVectors(
      this.previousSimulationPosition,
      this.simulationPosition,
      this.interpolationAlpha,
    );
    // Sample support at the interpolated XZ position. Copying the latest fixed
    // Y here produced visible 60 Hz stair-steps on slopes even when horizontal
    // movement and the camera were interpolating smoothly at a higher refresh.
    if (this.grounded) {
      this.renderedPosition.y = safeHeight(
        heightAt,
        this.renderedPosition.x,
        this.renderedPosition.z,
        this.simulationPosition.y,
      );
    }
    this.group.position.copy(this.simulationPosition);
    this.headingPivot.position.copy(this.renderedPosition).sub(this.simulationPosition);
    this.magicGroup.position.copy(this.headingPivot.position);
    this.movementFxGroup.position.copy(this.headingPivot.position);
    const renderedFacing = this.previousFacingYaw
      + shortestAngle(this.previousFacingYaw, this.facingYaw) * this.interpolationAlpha;
    const renderedGait = this.previousGaitPhase
      + shortestAngle(this.previousGaitPhase, this.gaitPhase) * this.interpolationAlpha;
    const renderedMovementBlend = THREE.MathUtils.lerp(
      this.previousMovementBlend,
      this.movementBlend,
      this.interpolationAlpha,
    );
    const renderedRunBlend = THREE.MathUtils.lerp(
      this.previousRunBlend,
      this.runBlend,
      this.interpolationAlpha,
    );
    const renderedTurnLean = THREE.MathUtils.lerp(
      this.previousTurnLean,
      this.turnLean,
      this.interpolationAlpha,
    );
    const renderedAccelerationLean = THREE.MathUtils.lerp(
      this.previousAccelerationLean,
      this.accelerationLean,
      this.interpolationAlpha,
    );
    const renderedAirPose = this.airPose;
    const renderedAirProgress = this.previousAirPose === renderedAirPose
      ? THREE.MathUtils.lerp(this.previousAirProgress, this.airProgress, this.interpolationAlpha)
      : this.airProgress;
    this.headingPivot.rotation.y = renderedFacing;
    this.updateDoubleJumpFlourish(delta, renderedAirPose, renderedAirProgress);
    const groundY = safeHeight(
      heightAt,
      this.renderedPosition.x,
      this.renderedPosition.z,
      this.simulationPosition.y,
    );
    const groundPose = this.samplePawGround(heightAt, groundY);
    this.rig.updatePose({
      deltaSeconds: delta,
      elapsedSeconds: this.elapsed + this.interpolationAlpha * fixed,
      gaitPhase: renderedGait,
      movementBlend: renderedMovementBlend,
      runBlend: renderedRunBlend,
      airPose: renderedAirPose,
      airBlend: renderedAirPose === 'grounded' ? 0 : 1,
      airProgress: renderedAirProgress,
      turnLean: renderedTurnLean,
      accelerationLean: renderedAccelerationLean,
      appendageSpring: this.tuning.animation.appendageSpring,
      appendageDamping: this.tuning.animation.appendageDamping,
      groundPitch: groundPose.pitch,
      groundRoll: groundPose.roll,
      pawGroundOffsets: this.pawGroundOffsets,
      reducedMotion: this.reducedMotion,
    });
    this.emitFootfalls(this.horizontalSpeed > 0.12, surfaceAt, onFootstep);
    this.frameDisplacement.copy(this.renderedPosition).sub(this.frameStart);
    this.updateMagic(delta, this.frameDisplacement, this.horizontalSpeed);
    this.updateMovementFx(delta);
    this.jumpWasHeld = input.jumpHeld;
    return this.snapshot;
  }

  private simulateFixedStep(
    delta: number,
    cameraYaw: number,
    input: PlayerInputState,
    heightAt: HeightSampler,
    surfaceAt: SurfaceSampler,
    onAction?: FoxActionListener,
    resolveHorizontal?: HorizontalMovementResolver,
  ): void {
    this.elapsed += delta;
    this.simulationTick = (this.simulationTick + 1) >>> 0;
    const inputMagnitude = Math.min(1, Math.hypot(input.moveX, input.moveForward));
    const hasMoveIntent = inputMagnitude > this.tuning.input.deadzone;
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
    if (hasMoveIntent && this.movementDirection.lengthSq() > 1e-8) this.movementDirection.normalize();
    // Gliding is a committed forward movement state, not an airborne brake.
    // Keep carrying the animal along its facing direction when the player
    // releases the stick, while still allowing wide steering when input returns.
    if (this.glideActive && !hasMoveIntent) {
      this.movementDirection.set(-Math.sin(this.facingYaw), 0, -Math.cos(this.facingYaw));
    }

    const previousSpeed = this.horizontalSpeed;
    let turnError = 0;
    if (hasMoveIntent) {
      const targetYaw = Math.atan2(-this.movementDirection.x, -this.movementDirection.z);
      turnError = shortestAngle(this.facingYaw, targetYaw);
      if (this.grounded && this.horizontalSpeed <= this.tuning.ground.lowSpeedFacingSnap) {
        this.facingYaw = targetYaw;
        this.facingAngularVelocity = 0;
        turnError = 0;
      } else {
        const turnScale = this.grounded
          ? THREE.MathUtils.lerp(
              this.tuning.ground.walkTurnResponse,
              this.tuning.ground.runTurnResponse,
              THREE.MathUtils.clamp(this.horizontalSpeed / this.sprintSpeed, 0, 1),
            ) / this.tuning.ground.walkTurnResponse
          : (this.glideActive
              ? this.tuning.glide.turnResponse
              : this.tuning.jump.airTurnResponse) / this.tuning.ground.walkTurnResponse;
        const spring = this.tuning.ground.facingSpring * turnScale * this.motionProfile.turnScale;
        const damping = this.tuning.ground.facingDamping * Math.sqrt(Math.max(0.2, turnScale));
        this.facingAngularVelocity += (turnError * spring - this.facingAngularVelocity * damping) * delta;
        this.facingYaw += this.facingAngularVelocity * delta;
        this.facingYaw = Math.atan2(Math.sin(this.facingYaw), Math.cos(this.facingYaw));
      }
      if (
        this.grounded
        && this.skidRemaining <= 0
        && this.horizontalSpeed / this.sprintSpeed >= this.tuning.ground.skidMinSpeedRatio
        && Math.abs(turnError) >= this.tuning.ground.skidTurnRadians
      ) {
        this.skidRemaining = this.tuning.ground.skidSeconds;
        const retainedSpeed = this.horizontalSpeed * this.tuning.ground.skidBrake;
        this.velocity.set(
          this.movementDirection.x * retainedSpeed,
          0,
          this.movementDirection.z * retainedSpeed,
        );
        this.commitState('skid');
        this.spawnMagic(this.tuning.vfx.skidDustCount, 0.72);
        this.spawnMovementRing(0.6, 0xd7bd8a);
        this.emitAction('skid', 0.82, onAction);
      }
    } else {
      this.facingAngularVelocity *= Math.exp(-this.tuning.ground.facingDamping * delta);
    }

    const topSpeed = sprintRequested ? this.sprintSpeed : this.walkSpeed;
    let desiredSpeed = hasMoveIntent ? topSpeed * inputMagnitude : 0;
    if (!this.grounded && !hasMoveIntent) desiredSpeed = this.horizontalSpeed;
    if (this.glideActive) {
      desiredSpeed = Math.max(
        desiredSpeed,
        this.horizontalSpeed,
        this.sprintSpeed * this.tuning.glide.speedScale,
      );
    }
    if (hasMoveIntent && this.grounded) {
      const probeDistance = 0.8;
      const here = safeHeight(heightAt, this.group.position.x, this.group.position.z, this.group.position.y);
      const ahead = safeHeight(
        heightAt,
        this.group.position.x + this.movementDirection.x * probeDistance,
        this.group.position.z + this.movementDirection.z * probeDistance,
        here,
      );
      const slope = THREE.MathUtils.clamp((ahead - here) / probeDistance, -1, 1);
      desiredSpeed *= slope > 0
        ? 1 - slope * this.tuning.ground.uphillSpeedLoss
        : 1 + -slope * this.tuning.ground.downhillSpeedGain;
    }
    if (this.glideActive) {
      // The animal's banked heading owns the trajectory; raw stick input only
      // steers that heading, giving glides a broad committed turning circle.
      this.desiredVelocity.set(
        -Math.sin(this.facingYaw) * desiredSpeed,
        0,
        -Math.cos(this.facingYaw) * desiredSpeed,
      );
    } else if (!this.grounded && !hasMoveIntent) {
      this.desiredVelocity.set(this.velocity.x, 0, this.velocity.z);
    } else {
      this.desiredVelocity.set(
        this.movementDirection.x * desiredSpeed,
        0,
        this.movementDirection.z * desiredSpeed,
      );
    }
    const accelerating = desiredSpeed > previousSpeed + 0.06;
    let speedResponse = this.grounded
      ? (!hasMoveIntent
          ? this.tuning.ground.coastResponse
          : accelerating
            ? (sprintRequested
                ? this.tuning.ground.runAccelerationResponse
                : this.tuning.ground.walkAccelerationResponse)
              * this.motionProfile.accelerationScale
            : this.tuning.ground.brakingResponse)
      : (hasMoveIntent || this.glideActive
          ? this.tuning.ground.runAccelerationResponse * this.tuning.jump.airAccelerationRatio
          : 0);
    if (!this.grounded && Math.abs(this.verticalVelocity) <= this.tuning.jump.apexVelocity) {
      speedResponse *= this.tuning.jump.apexAirControlScale;
    }
    this.velocity.x = damp(this.velocity.x, this.desiredVelocity.x, speedResponse, delta);
    this.velocity.z = damp(this.velocity.z, this.desiredVelocity.z, speedResponse, delta);
    if (!hasMoveIntent && this.grounded && this.velocity.lengthSq() < 0.0004) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const horizontalAcceleration = (this.horizontalSpeed - previousSpeed) / delta;
    this.accelerationLean = damp(
      this.accelerationLean,
      this.grounded
        ? THREE.MathUtils.clamp(
            -horizontalAcceleration * this.tuning.animation.accelerationLeanScale,
            -0.09,
            0.065,
          )
        : 0,
      5.8,
      delta,
    );
    const turnEnergy = THREE.MathUtils.smoothstep(this.horizontalSpeed / this.sprintSpeed, 0.08, 0.78);
    this.turnLean = damp(
      this.turnLean,
      this.grounded || this.glideActive
        ? THREE.MathUtils.clamp(
            -turnError * turnEnergy * this.tuning.animation.turnLeanRadians,
            -this.tuning.glide.bankRadians,
            this.tuning.glide.bankRadians,
          )
        : 0,
      7.1,
      delta,
    );
    this.glideBank = damp(
      this.glideBank,
      this.glideActive
        ? THREE.MathUtils.clamp(
            this.turnLean / Math.max(0.001, this.tuning.glide.bankRadians),
            -1,
            1,
          )
        : 0,
      this.glideActive ? 5.5 : 8,
      delta,
    );
    const stepStartX = this.group.position.x;
    const stepStartZ = this.group.position.z;
    const displacementX = this.velocity.x * delta;
    const displacementZ = this.velocity.z * delta;
    const displacementLength = Math.hypot(displacementX, displacementZ);
    const sweepStep = Math.max(0.01, this.tuning.ground.collisionSweepStep);
    const sweepCount = Math.max(1, Math.min(8, Math.ceil(displacementLength / sweepStep)));
    const segmentX = displacementX / sweepCount;
    const segmentZ = displacementZ / sweepCount;
    for (let segment = 0; segment < sweepCount; segment += 1) {
      const segmentStartX = this.group.position.x;
      const segmentStartZ = this.group.position.z;
      let nextX = segmentStartX + segmentX;
      let nextZ = segmentStartZ + segmentZ;
      if (this.grounded) {
        const currentGround = safeHeight(heightAt, segmentStartX, segmentStartZ, this.group.position.y);
        const proposedGround = safeHeight(heightAt, nextX, nextZ, currentGround);
        if (proposedGround - currentGround > this.tuning.ground.groundSnapHeight) {
          const xGround = safeHeight(heightAt, nextX, segmentStartZ, currentGround);
          const zGround = safeHeight(heightAt, segmentStartX, nextZ, currentGround);
          if (xGround - currentGround > this.tuning.ground.groundSnapHeight) nextX = segmentStartX;
          if (zGround - currentGround > this.tuning.ground.groundSnapHeight) nextZ = segmentStartZ;
          const finalGround = safeHeight(heightAt, nextX, nextZ, currentGround);
          if (finalGround - currentGround > this.tuning.ground.groundSnapHeight) {
            nextX = segmentStartX;
            nextZ = segmentStartZ;
          }
        }
      }
      if (resolveHorizontal) {
        const resolved = resolveHorizontal(segmentStartX, segmentStartZ, nextX, nextZ);
        if (Number.isFinite(resolved.x) && Number.isFinite(resolved.z)) {
          nextX = resolved.x;
          nextZ = resolved.z;
        }
      }
      this.group.position.x = nextX;
      this.group.position.z = nextZ;
    }
    const actualX = (this.group.position.x - stepStartX) / delta;
    const actualZ = (this.group.position.z - stepStartZ) / delta;
    if (Math.abs(actualX - this.velocity.x) > 0.25) this.velocity.x = actualX;
    if (Math.abs(actualZ - this.velocity.z) > 0.25) this.velocity.z = actualZ;
    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const groundY = safeHeight(heightAt, this.group.position.x, this.group.position.z, this.group.position.y);
    this.currentSurface = surfaceAt(this.group.position.x, this.group.position.z);
    this.updateGrounding(delta, groundY);
    this.updateJumpState(delta, input.jumpHeld, groundY, onAction);
    this.skidRemaining = Math.max(0, this.skidRemaining - delta);

    this.advanceGait(delta, sprintRequested);
    this.updateAirPose(delta);
    this.commitState(this.deriveLocomotionState());
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

  private deriveLocomotionState(): FoxLocomotionState {
    if (this.anticipationRemaining > 0) return 'jump-anticipate';
    if (!this.grounded) {
      if (this.doublePoseRemaining > 0) return 'double-jump';
      if (this.glideActive) return 'glide';
      if (Math.abs(this.verticalVelocity) <= this.tuning.jump.apexVelocity) return 'apex';
      return this.verticalVelocity > 0 ? 'jump-rise' : 'fall';
    }
    if (this.skidRemaining > 0) return 'skid';
    if (this.landingRemaining > 0) return this.lastLanding === 'heavy' ? 'land-heavy' : 'land-soft';
    if (this.horizontalSpeed < 0.12) return 'idle';
    return this.runBlend > 0.52 ? 'run' : 'walk';
  }

  private updateGrounding(delta: number, groundY: number): void {
    if (!this.groundInitialized) {
      this.group.position.y = groundY;
      this.grounded = true;
      this.groundInitialized = true;
      this.coyoteRemaining = this.tuning.input.coyoteSeconds;
      return;
    }

    if (this.grounded && this.group.position.y - groundY > this.tuning.ground.groundSnapHeight) {
      this.grounded = false;
      // Keep the ground jump alive through the coyote window. Once that timer
      // expires it becomes the consumed first jump, leaving one air jump.
      this.airPose = 'fall';
      this.airborneTime = 0;
      return;
    }

    if (this.grounded) {
      this.group.position.y = groundY > this.group.position.y
        ? groundY
        : damp(this.group.position.y, groundY, 18, delta);
      this.verticalVelocity = 0;
      this.coyoteRemaining = this.tuning.input.coyoteSeconds;
    } else {
      this.coyoteRemaining = Math.max(0, this.coyoteRemaining - delta);
      if (this.coyoteRemaining === 0 && this.jumpsUsed === 0) this.jumpsUsed = 1;
    }
  }

  private updateJumpState(
    delta: number,
    jumpHeld: boolean,
    groundY: number,
    onAction?: FoxActionListener,
  ): void {
    if (this.jumpReleaseQueued) {
      if (this.anticipationRemaining > 0) {
        this.jumpCutQueued = true;
      } else if (!this.grounded && this.verticalVelocity > 0 && !this.jumpCutApplied) {
        this.verticalVelocity *= this.tuning.input.jumpReleaseCut;
        this.jumpCutApplied = true;
      }
      this.jumpReleaseQueued = false;
    }
    if (this.anticipationRemaining > 0) {
      this.anticipationRemaining = Math.max(0, this.anticipationRemaining - delta);
      this.airPose = 'anticipate';
      this.airProgress = 1 - this.anticipationRemaining / this.tuning.jump.anticipationSeconds;
      if (this.anticipationRemaining <= 1e-6) {
        this.anticipationRemaining = 0;
        const queueSecondJump = this.bufferedDoubleJump;
        this.bufferedDoubleJump = false;
        this.launchJump(false, onAction);
        if (queueSecondJump) {
          this.delayedDoubleJumpQueued = true;
          this.delayedDoubleSequence = (this.delayedDoubleSequence + 1) >>> 0;
        }
      }
    } else if (this.jumpBufferRemaining > 0) {
      if (this.grounded) {
        this.jumpBufferRemaining = 0;
        // The trigger tick counts as the first anticipation frame.
        this.anticipationRemaining = Math.max(
          0,
          this.tuning.jump.anticipationSeconds - delta,
        );
        this.markAnticipation();
        this.landingRemaining = 0;
        this.airPose = 'anticipate';
        this.airProgress = 1 - this.anticipationRemaining / this.tuning.jump.anticipationSeconds;
        if (this.anticipationRemaining <= 1e-6) {
          this.anticipationRemaining = 0;
          this.launchJump(false, onAction);
        }
      } else if (this.coyoteRemaining > 0 && this.jumpsUsed === 0) {
        this.launchJump(false, onAction);
      } else if (this.jumpsUsed === 1) {
        this.launchJump(true, onAction);
      }
    }

    if (this.grounded) {
      if (this.glideActive) {
        this.glideActive = false;
        this.emitAction('glide-end', 0.3, onAction);
      }
      if (this.landingRemaining > 0) this.landingRemaining = Math.max(0, this.landingRemaining - delta);
      this.jumpBufferRemaining = Math.max(0, this.jumpBufferRemaining - delta);
      return;
    }

    this.airborneTime += delta;
    this.maxAirtimeObserved = Math.max(this.maxAirtimeObserved, this.airborneTime);
    if (
      this.delayedDoubleJumpQueued
      && this.jumpsUsed === 1
      && this.airborneTime >= 0.12
    ) {
      this.delayedDoubleJumpQueued = false;
      this.launchJump(true, onAction);
    }
    this.doublePoseRemaining = Math.max(0, this.doublePoseRemaining - delta);
    const nextGlideActive = jumpHeld
      && !this.grounded
      && this.doublePoseRemaining <= 0
      && this.airborneTime >= this.tuning.glide.entrySeconds
      && this.verticalVelocity <= this.tuning.glide.entryVelocity;
    if (nextGlideActive !== this.glideActive) {
      this.glideActive = nextGlideActive;
      this.emitAction(this.glideActive ? 'glide-start' : 'glide-end', 0.45, onAction);
    }

    const gravityScale = this.tuning.physics.gravityScale;
    let gravity: number;
    if (this.glideActive && this.verticalVelocity <= 0) {
      gravity = this.motionProfile.glideGravity * this.tuning.physics.glideGravityScale;
    } else if (Math.abs(this.verticalVelocity) <= this.tuning.jump.apexVelocity) {
      gravity = this.motionProfile.gravity * gravityScale * this.tuning.jump.apexGravityScale;
    } else if (this.verticalVelocity < 0) {
      gravity = this.motionProfile.gravity * gravityScale * this.tuning.jump.fallGravityScale;
    } else {
      gravity = this.motionProfile.gravity * gravityScale * this.tuning.jump.riseGravityScale;
    }
    const terminalSpeed = this.glideActive
      ? this.motionProfile.glideTerminalSpeed * this.tuning.physics.glideTerminalSpeedScale
      : this.tuning.jump.terminalSpeed;
    this.verticalVelocity = Math.max(terminalSpeed, this.verticalVelocity - gravity * delta);
    this.group.position.y += this.verticalVelocity * delta;

    if (this.group.position.y <= groundY && this.verticalVelocity <= 0) {
      const landingSpeed = Math.abs(this.verticalVelocity);
      const landingAirtime = this.airborneTime;
      const wasAirborneLongEnough = this.airborneTime > 0.075;
      this.group.position.y = groundY;
      this.verticalVelocity = 0;
      this.grounded = true;
      this.jumpsUsed = 0;
      this.bufferedDoubleJump = false;
      this.delayedDoubleJumpQueued = false;
      this.coyoteRemaining = this.tuning.input.coyoteSeconds;
      this.airborneTime = 0;
      this.doublePoseRemaining = 0;
      if (this.glideActive) this.emitAction('glide-end', 0.3, onAction);
      this.glideActive = false;
      this.lastLanding = landingSpeed >= this.tuning.jump.heavyLandingSpeed ? 'heavy' : 'soft';
      this.landingRemaining = this.lastLanding === 'heavy'
        ? this.tuning.jump.heavyRecoverySeconds
        : this.tuning.jump.softRecoverySeconds;
      this.airPose = 'land';
      this.airProgress = 0;
      if (wasAirborneLongEnough) {
        const landingRange = Math.max(
          0.1,
          this.tuning.jump.heavyLandingSpeed - this.tuning.jump.softLandingSpeed,
        );
        const intensity = THREE.MathUtils.lerp(
          0.25,
          1,
          THREE.MathUtils.clamp(
            (landingSpeed - this.tuning.jump.softLandingSpeed) / landingRange,
            0,
            1,
          ),
        );
        this.landingBloom = 1;
        this.spawnMagic(6, 0.68);
        this.spawnMovementRing(this.tuning.vfx.landRingScale * (0.75 + intensity * 0.4), 0xffe9a8);
        this.emitAction('land', intensity, onAction, this.lastLanding, landingSpeed, landingAirtime);
      }
      // A press buffered during the final fall becomes a fluid bunny hop on
      // the exact contact tick, without another anticipation pause.
      if (this.jumpBufferRemaining > 0) {
        this.jumpBufferRemaining = 0;
        this.launchJump(false, onAction);
      }
    }
    this.jumpBufferRemaining = Math.max(0, this.jumpBufferRemaining - delta);
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
      ? this.motionProfile.doubleJumpImpulse * this.tuning.physics.doubleJumpImpulseScale
      : this.motionProfile.jumpImpulse * this.tuning.physics.jumpImpulseScale;
    if (doubleJump && this.movementDirection.lengthSq() > 1e-8) {
      const controlSpeed = Math.max(this.horizontalSpeed, this.walkSpeed);
      this.velocity.x = THREE.MathUtils.lerp(
        this.velocity.x,
        this.movementDirection.x * controlSpeed,
        this.tuning.jump.doubleControlBurst,
      );
      this.velocity.z = THREE.MathUtils.lerp(
        this.velocity.z,
        this.movementDirection.z * controlSpeed,
        this.tuning.jump.doubleControlBurst,
      );
      this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    }
    this.doublePoseRemaining = doubleJump ? this.tuning.jump.doublePoseSeconds : 0;
    this.jumpCutApplied = false;
    if (!doubleJump && this.jumpCutQueued) {
      this.verticalVelocity *= this.tuning.input.jumpReleaseCut;
      this.jumpCutApplied = true;
      this.jumpCutQueued = false;
    }
    this.airPose = doubleJump ? 'double' : 'rise';
    this.airProgress = 0;
    this.spawnMagic(doubleJump ? 10 : 7, doubleJump ? 1.2 : 0.92);
    this.spawnMovementRing(
      doubleJump ? this.tuning.vfx.doubleRingScale : this.tuning.vfx.jumpRingScale,
      doubleJump ? 0xd9c8ff : 0xffe9a8,
    );
    this.emitAction(doubleJump ? 'double-jump' : 'jump', doubleJump ? 1 : 0.78, onAction);
  }

  private advanceGait(delta: number, sprinting: boolean): void {
    const movementTarget = THREE.MathUtils.smoothstep(this.horizontalSpeed, 0.06, 0.72);
    this.movementBlend = damp(
      this.movementBlend,
      movementTarget,
      this.tuning.animation.movementBlendResponse,
      delta,
    );
    const runTarget = THREE.MathUtils.smoothstep(
      this.horizontalSpeed,
      this.walkSpeed * 0.9,
      this.sprintSpeed * 0.9,
    );
    this.runBlend = damp(
      this.runBlend,
      runTarget,
      this.tuning.animation.runBlendResponse * (sprinting ? 0.9 : 1),
      delta,
    );
    const gaitRadiansPerMetre = THREE.MathUtils.lerp(
      this.tuning.animation.gaitWalkRadiansPerMetre,
      this.tuning.animation.gaitRunRadiansPerMetre,
      this.runBlend,
    )
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
        this.airProgress = 1 - this.landingRemaining / (this.lastLanding === 'heavy'
          ? this.tuning.jump.heavyRecoverySeconds
          : this.tuning.jump.softRecoverySeconds);
      } else {
        this.airPose = 'grounded';
        this.airProgress = 1;
      }
      return;
    }

    if (this.doublePoseRemaining > 0) {
      this.airPose = 'double';
      this.airProgress = 1 - this.doublePoseRemaining / this.tuning.jump.doublePoseSeconds;
    } else if (this.glideActive) {
      this.airPose = 'glide';
      this.airProgress = THREE.MathUtils.clamp(
        (this.airborneTime - this.tuning.glide.entrySeconds) / 0.22,
        0,
        1,
      );
    } else if (this.verticalVelocity > 1.15) {
      this.airPose = 'rise';
      this.airProgress = THREE.MathUtils.clamp(
        1 - this.verticalVelocity
          / (this.motionProfile.jumpImpulse * this.tuning.physics.jumpImpulseScale),
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

  private updateDoubleJumpFlourish(
    delta: number,
    airPose: FoxAirPose = this.airPose,
    airProgress: number = this.airProgress,
  ): void {
    const motion = this.reducedMotion ? 0.35 : 1;
    if (airPose === 'double') {
      const progress = THREE.MathUtils.clamp(airProgress, 0, 1);
      const eased = progress * progress * (3 - 2 * progress);
      const [turnX, turnY, turnZ] = this.motionProfile.doubleJumpTurns;
      const angle = Math.PI * 2 * eased * motion;
      this.aerialPivot.rotation.set(turnX * angle, turnY * angle, turnZ * angle);
      const squash = Math.sin(progress * Math.PI) * (this.reducedMotion ? 0.025 : 0.075);
      this.aerialPivot.scale.set(1 + squash, 1 - squash * 0.7, 1 + squash);
      this.aerialPivot.position.y = Math.sin(progress * Math.PI) * 0.035 * motion;
      return;
    }

    let targetY = 1;
    let targetXZ = 1;
    if (airPose === 'anticipate') {
      const compression = 0.15 * airProgress * motion;
      targetY = 1 - compression;
      targetXZ = 1 + compression * 0.52;
    } else if (airPose === 'rise') {
      targetY = 1 + 0.09 * (1 - airProgress * 0.45) * motion;
      targetXZ = 1 / Math.sqrt(targetY);
    } else if (airPose === 'fall') {
      targetY = 1 + 0.055 * airProgress * motion;
      targetXZ = 1 / Math.sqrt(targetY);
    } else if (airPose === 'land') {
      const compression = (this.lastLanding === 'heavy' ? 0.14 : 0.075)
        * (1 - airProgress) ** 2 * motion;
      targetY = 1 - compression;
      targetXZ = 1 + compression * 0.55;
    } else if (airPose === 'glide') {
      targetY = 0.975;
      targetXZ = 1.013;
    } else if (this.stateValue === 'skid') {
      targetY = 0.95;
      targetXZ = 1.026;
    }
    const response = airPose === 'land' ? 20 : 13;
    this.aerialPivot.scale.x = damp(this.aerialPivot.scale.x, targetXZ, response, delta);
    this.aerialPivot.scale.y = damp(this.aerialPivot.scale.y, targetY, response, delta);
    this.aerialPivot.scale.z = damp(this.aerialPivot.scale.z, targetXZ, response, delta);
    const glidePitch = airPose === 'glide'
      ? THREE.MathUtils.clamp(
          -this.verticalVelocity / 10,
          -this.tuning.glide.pitchRadians,
          this.tuning.glide.pitchRadians,
        ) * motion
      : 0;
    this.aerialPivot.rotation.x = damp(this.aerialPivot.rotation.x, glidePitch, 10, delta);
    this.aerialPivot.rotation.y = damp(this.aerialPivot.rotation.y, 0, 14, delta);
    this.aerialPivot.rotation.z = damp(
      this.aerialPivot.rotation.z,
      airPose === 'glide' ? -this.glideBank * this.tuning.glide.bankRadians * motion : 0,
      9,
      delta,
    );
    if (this.grounded && airPose === 'grounded') {
      if (Math.abs(this.aerialPivot.rotation.x) < 0.003) this.aerialPivot.rotation.x = 0;
      if (Math.abs(this.aerialPivot.rotation.y) < 0.003) this.aerialPivot.rotation.y = 0;
      if (Math.abs(this.aerialPivot.rotation.z) < 0.003) this.aerialPivot.rotation.z = 0;
    }
    this.aerialPivot.position.y = airPose === 'glide'
      ? Math.sin(this.elapsed * 3.1) * 0.035 * motion
      : damp(this.aerialPivot.position.y, 0, 12, delta);
  }

  private emitAction(
    type: FoxActionKind,
    intensity: number,
    onAction?: FoxActionListener,
    landing?: 'soft' | 'heavy',
    impactSpeed?: number,
    airtime = this.airborneTime,
  ): void {
    switch (type) {
      case 'jump':
        this.jumpSequence = (this.jumpSequence + 1) >>> 0;
        this.jumpTick = this.simulationTick >>> 0;
        break;
      case 'double-jump':
        this.doubleJumpSequence = (this.doubleJumpSequence + 1) >>> 0;
        this.doubleJumpTick = this.simulationTick >>> 0;
        break;
      case 'glide-start':
        this.glideSequence = (this.glideSequence + 1) >>> 0;
        break;
      case 'land':
        this.landSequence = (this.landSequence + 1) >>> 0;
        this.landTick = this.simulationTick >>> 0;
        break;
      case 'skid':
        this.skidSequence = (this.skidSequence + 1) >>> 0;
        this.skidTick = this.simulationTick >>> 0;
        break;
      default:
        break;
    }
    if (!onAction) return;
    const state = type === 'skid' ? 'skid' : this.deriveLocomotionState();
    onAction({
      type,
      position: this.group.position.clone(),
      surface: this.currentSurface,
      intensity: THREE.MathUtils.clamp(intensity, 0, 1),
      state,
      horizontalSpeed: this.horizontalSpeed,
      verticalSpeed: impactSpeed === undefined ? this.verticalVelocity : -Math.abs(impactSpeed),
      airtime,
      ...(landing ? { landing } : {}),
    });
  }

  private markAnticipation(): void {
    this.anticipationSequence = (this.anticipationSequence + 1) >>> 0;
    this.anticipationTick = this.simulationTick >>> 0;
  }

  private commitState(next: FoxLocomotionState): void {
    if (next === this.stateValue) return;
    this.stateValue = next;
    this.stateTransitionSequence = (this.stateTransitionSequence + 1) >>> 0;
    this.stateTransitionTick = this.simulationTick >>> 0;
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
      && this.skidRemaining === 0
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
        if (movementIntensity >= this.tuning.vfx.runDustMinSpeedRatio) {
          this.spawnFootDust(rendered.position, this.tuning.vfx.runDustCount, movementIntensity);
        }
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
      this.magicParticles.push({
        mesh,
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        baseScale: 1,
        bornFrame: 0,
      });
    }
  }

  private buildMovementFxPool(): readonly THREE.Mesh[] {
    const ringGeometry = new THREE.TorusGeometry(0.5, 0.025, 5, 28);
    for (let index = 0; index < 5; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffe9a8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(ringGeometry, material);
      mesh.name = `MovementRing${index + 1}`;
      mesh.rotation.x = Math.PI * 0.5;
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.movementFxGroup.add(mesh);
      this.movementRings.push({
        mesh,
        life: 0,
        maxLife: 0.5,
        targetScale: 1,
        bornFrame: 0,
      });
    }

    const ribbons: THREE.Mesh[] = [];
    const ribbonGeometry = new THREE.BoxGeometry(1, 1, 1);
    for (const [sideIndex, side] of ([-1, 1] as const).entries()) {
      const material = new THREE.MeshBasicMaterial({
        color: side < 0 ? 0xd9c8ff : 0xbcebd8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ribbon = new THREE.InstancedMesh(
        ribbonGeometry,
        material,
        GLIDE_TRAIL_SEGMENTS_PER_SIDE,
      );
      ribbon.name = side < 0 ? 'GlideRibbonLeft' : 'GlideRibbonRight';
      ribbon.visible = false;
      ribbon.frustumCulled = false;
      ribbon.renderOrder = 2;
      ribbon.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.glideTrailScale.set(0, 0, 0);
      this.glideTrailMatrix.compose(
        this.glideTrailPosition.set(0, -100, 0),
        this.glideTrailQuaternion.identity(),
        this.glideTrailScale,
      );
      for (let index = 0; index < GLIDE_TRAIL_SEGMENTS_PER_SIDE; index += 1) {
        ribbon.setMatrixAt(index, this.glideTrailMatrix);
        this.glideTrailSegments[sideIndex as 0 | 1].push({
          center: new THREE.Vector3(),
          direction: new THREE.Vector3(0, 0, 1),
          life: 0,
          maxLife: GLIDE_TRAIL_LIFETIME_SECONDS,
          active: false,
        });
      }
      ribbon.instanceMatrix.needsUpdate = true;
      this.movementFxGroup.add(ribbon);
      ribbons.push(ribbon);
    }
    return ribbons;
  }

  private spawnMovementRing(scale: number, color: number): void {
    const ring = this.movementRings[this.ringCursor++ % this.movementRings.length];
    if (!ring) return;
    ring.life = this.reducedMotion ? 0.28 : 0.48;
    ring.bornFrame = this.renderFrame;
    ring.maxLife = ring.life;
    ring.targetScale = Math.max(0.2, scale);
    ring.mesh.position.set(0, 0.055, 0);
    ring.mesh.scale.setScalar(0.18);
    const material = ring.mesh.material as THREE.MeshBasicMaterial;
    material.color.setHex(color);
    material.opacity = this.reducedMotion ? 0.28 : 0.62;
    ring.mesh.visible = true;
  }

  private spawnFootDust(position: Readonly<THREE.Vector3>, count: number, energy: number): void {
    const amount = this.reducedMotion ? 1 : Math.max(1, count);
    for (let index = 0; index < amount; index += 1) {
      const serial = this.magicCursor++;
      const particle = this.magicParticles[serial % this.magicParticles.length];
      if (!particle) continue;
      particle.mesh.position.copy(position);
      this.magicGroup.worldToLocal(particle.mesh.position);
      const phase = serial * 2.39996;
      particle.mesh.position.y += 0.035;
      particle.velocity.set(Math.cos(phase) * 0.32, 0.16, Math.sin(phase) * 0.32);
      particle.maxLife = 0.24 + (serial % 3) * 0.035;
      particle.life = particle.maxLife;
      particle.bornFrame = this.renderFrame;
      particle.baseScale = 0.42 + energy * 0.24;
      particle.mesh.scale.setScalar(0.08);
      particle.mesh.visible = true;
    }
  }

  private updateMovementFx(delta: number): void {
    for (const ring of this.movementRings) {
      if (!ring.mesh.visible) continue;
      if (ring.bornFrame !== this.renderFrame) ring.mesh.position.sub(this.frameDisplacement);
      ring.life -= delta;
      if (ring.life <= 0) {
        ring.mesh.visible = false;
        continue;
      }
      const progress = 1 - ring.life / ring.maxLife;
      const scale = THREE.MathUtils.lerp(0.18, ring.targetScale, 1 - (1 - progress) ** 3);
      ring.mesh.scale.setScalar(scale);
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - progress) * (this.reducedMotion ? 0.28 : 0.62);
    }

    const ribbonOpacity = this.reducedMotion
      ? this.tuning.vfx.glideRibbonOpacity * 0.35
      : this.tuning.vfx.glideRibbonOpacity;
    if (this.glideActive) this.sampleGlideTrail();
    else {
      this.glideTrailReady[0] = false;
      this.glideTrailReady[1] = false;
    }
    for (const sideIndex of [0, 1] as const) {
      const ribbon = this.glideRibbons[sideIndex] as THREE.InstancedMesh;
      const material = ribbon.material as THREE.MeshBasicMaterial;
      let anyActive = false;
      for (let index = 0; index < this.glideTrailSegments[sideIndex].length; index += 1) {
        const segment = this.glideTrailSegments[sideIndex][index]!;
        if (segment.active) {
          segment.life -= delta;
          if (segment.life <= 0) segment.active = false;
        }
        if (!segment.active) {
          this.glideTrailMatrix.compose(
            this.glideTrailPosition.set(0, -100, 0),
            this.glideTrailQuaternion.identity(),
            this.glideTrailScale.set(0, 0, 0),
          );
          ribbon.setMatrixAt(index, this.glideTrailMatrix);
          continue;
        }
        anyActive = true;
        const fade = THREE.MathUtils.smoothstep(segment.life / segment.maxLife, 0, 1);
        const length = Math.max(0.01, segment.direction.length());
        this.glideTrailDirection.copy(segment.direction).multiplyScalar(1 / length);
        this.glideTrailQuaternion.setFromUnitVectors(this.glideTrailForward, this.glideTrailDirection);
        this.glideTrailPosition.copy(segment.center).sub(this.renderedPosition);
        this.glideTrailScale.set(0.05 * fade, 0.016 * fade, length * 1.08);
        this.glideTrailMatrix.compose(
          this.glideTrailPosition,
          this.glideTrailQuaternion,
          this.glideTrailScale,
        );
        ribbon.setMatrixAt(index, this.glideTrailMatrix);
      }
      material.opacity = damp(material.opacity, anyActive ? ribbonOpacity : 0, 10, delta);
      ribbon.visible = anyActive || material.opacity >= 0.002;
      ribbon.instanceMatrix.needsUpdate = true;
    }
  }

  private sampleGlideTrail(): void {
    const rightX = Math.cos(this.facingYaw);
    const rightZ = -Math.sin(this.facingYaw);
    for (const sideIndex of [0, 1] as const) {
      const side = sideIndex === 0 ? -1 : 1;
      this.glideTrailPosition.set(
        this.renderedPosition.x + rightX * side * 0.33,
        this.renderedPosition.y + 0.5 + Math.sin(this.elapsed * 4.1 + sideIndex) * 0.025,
        this.renderedPosition.z + rightZ * side * 0.33,
      );
      const previous = this.glideTrailLast[sideIndex];
      if (!this.glideTrailReady[sideIndex]) {
        previous.copy(this.glideTrailPosition);
        this.glideTrailReady[sideIndex] = true;
        continue;
      }
      this.glideTrailDirection.copy(this.glideTrailPosition).sub(previous);
      // Distance-based sampling makes trail history independent of whether the
      // renderer is running at 30, 60, or 120 Hz.
      if (this.glideTrailDirection.lengthSq() < GLIDE_TRAIL_SAMPLE_DISTANCE ** 2) continue;
      const segments = this.glideTrailSegments[sideIndex];
      const cursor = this.glideTrailCursor[sideIndex] ?? 0;
      this.glideTrailCursor[sideIndex] = cursor + 1;
      const segment = segments[cursor % segments.length]!;
      segment.center.copy(previous).add(this.glideTrailPosition).multiplyScalar(0.5);
      segment.direction.copy(this.glideTrailDirection);
      segment.maxLife = this.reducedMotion
        ? GLIDE_TRAIL_LIFETIME_SECONDS * 0.55
        : GLIDE_TRAIL_LIFETIME_SECONDS;
      segment.life = segment.maxLife;
      segment.active = true;
      previous.copy(this.glideTrailPosition);
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
      particle.bornFrame = this.renderFrame;
      particle.baseScale = 0.65 + energy * 0.38 + (serial % 3) * 0.09;
      particle.mesh.scale.setScalar(particle.baseScale * 0.15);
      particle.mesh.visible = true;
    }
  }

  private updateMagic(delta: number, displacement: THREE.Vector3, speed: number): void {
    for (let index = 0; index < this.magicParticles.length; index += 1) {
      const particle = this.magicParticles[index];
      if (!particle?.mesh.visible) continue;
      if (particle.bornFrame !== this.renderFrame) particle.mesh.position.sub(displacement);
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
    if (this.glideActive && Math.abs(this.glideBank) > 0.28) {
      this.spawnBankSparkle(Math.sign(this.glideBank) || 1);
    } else {
      this.spawnMagic(1, this.glideActive ? 0.52 : (active ? 0.38 : 0.2));
    }
    this.magicTimer = this.reducedMotion
      ? (active ? 0.24 : 0.85)
      : (this.glideActive ? 0.065 : (active ? 0.105 : 0.52));
  }

  private spawnBankSparkle(side: number): void {
    const serial = this.magicCursor++;
    const particle = this.magicParticles[serial % this.magicParticles.length];
    if (!particle) return;
    const rightX = Math.cos(this.facingYaw);
    const rightZ = -Math.sin(this.facingYaw);
    const forwardX = -Math.sin(this.facingYaw);
    const forwardZ = -Math.cos(this.facingYaw);
    particle.mesh.position.set(
      rightX * side * 0.42 - forwardX * 0.08,
      0.52,
      rightZ * side * 0.42 - forwardZ * 0.08,
    );
    particle.velocity.set(
      rightX * side * 0.16 + forwardX * 0.22,
      0.08,
      rightZ * side * 0.16 + forwardZ * 0.22,
    );
    particle.maxLife = this.reducedMotion ? 0.2 : 0.34;
    particle.life = particle.maxLife;
    particle.bornFrame = this.renderFrame;
    particle.baseScale = this.reducedMotion ? 0.42 : 0.7;
    particle.mesh.scale.setScalar(0.08);
    particle.mesh.visible = true;
  }
}
