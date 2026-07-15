import * as THREE from 'three';
import type { AnimalKind, SkinId } from '../../shared/src/index.js';
import { PALETTE } from '../config';
import {
  resolveAnimalAppearance,
  type AnimalAppearanceProfile,
} from './animalAppearance';
import {
  FOX_LEG_KEYS,
  sampleFoxAirLegPose,
  sampleFoxLegMotion,
  type FoxAirPose,
  type FoxLegKey,
} from './foxMotion';

export interface FoxRigPoseInput {
  readonly deltaSeconds: number;
  readonly elapsedSeconds: number;
  /** Shared gait phase in radians. */
  readonly gaitPhase: number;
  /** Idle-to-moving blend in the range 0..1. */
  readonly movementBlend: number;
  /** Walk-to-run blend in the range 0..1. */
  readonly runBlend: number;
  readonly airPose?: FoxAirPose;
  /** Grounded-to-air-pose blend in the range 0..1. */
  readonly airBlend?: number;
  /** Normalized progress through anticipate, double, or land poses. */
  readonly airProgress?: number;
  readonly turnLean?: number;
  readonly accelerationLean?: number;
  readonly appendageSpring?: number;
  readonly appendageDamping?: number;
  readonly groundPitch?: number;
  readonly groundRoll?: number;
  /** Per-paw floor height relative to the rig root's parent origin. */
  readonly pawGroundOffsets?: Readonly<Partial<Record<FoxLegKey, number>>>;
  readonly reducedMotion?: boolean;
}

export interface FoxRigLegDebugPose {
  readonly hip: number;
  readonly knee: number;
  readonly hock: number;
  readonly paw: number;
  readonly contact: boolean;
  readonly clearance: number;
  readonly plantWeight: number;
  readonly downwardImpact: number;
}

/** Same-frame state measured from the rendered paw after damping and planting. */
export interface FoxRigRenderedPawState {
  readonly leg: FoxLegKey;
  /** Distance from the rendered paw sole to its sampled floor, in world units. */
  readonly clearance: number;
  /** How strongly the current gait pose is trying to plant this paw, in 0..1. */
  readonly plantWeight: number;
  /** World-space position of the rendered paw sole. */
  readonly position: THREE.Vector3;
  /** Contact latch using separate enter and exit clearances. */
  readonly contact: boolean;
  /** Downward sole speed measured on the contact frame, in world units/second. */
  readonly downwardImpact: number;
}

export interface FoxRigDebugSnapshot {
  readonly bounds: {
    readonly width: number;
    readonly height: number;
    readonly length: number;
    readonly minY: number;
    readonly maxY: number;
  };
  readonly proportions: typeof FOX_RIG_PROPORTIONS;
  readonly pose: {
    readonly gaitPhase: number;
    readonly movementBlend: number;
    readonly runBlend: number;
    readonly airPose: FoxAirPose;
    readonly strideExtension: number;
    readonly spinePitch: number;
    readonly legs: Readonly<Record<FoxLegKey, FoxRigLegDebugPose>>;
  };
}

interface LegRig {
  readonly key: FoxLegKey;
  readonly hip: THREE.Group;
  readonly knee: THREE.Group;
  readonly hock: THREE.Group;
  readonly paw: THREE.Mesh;
  readonly restHipY: number;
  readonly restHip: number;
  readonly restKnee: number;
  readonly restHock: number;
  readonly restPaw: number;
}

interface MutableRenderedPawState {
  readonly leg: FoxLegKey;
  clearance: number;
  plantWeight: number;
  readonly position: THREE.Vector3;
  contact: boolean;
  downwardImpact: number;
  previousClearance: number;
}

interface TailRig {
  readonly pivot: THREE.Group;
  readonly restPitch: number;
  yawVelocity: number;
  pitchVelocity: number;
}

interface EarRig {
  readonly pivot: THREE.Group;
  readonly side: -1 | 1;
  readonly restPitch: number;
  readonly restRoll: number;
  pitchVelocity: number;
  rollVelocity: number;
}

interface RigMaterials {
  readonly fur: THREE.MeshStandardMaterial;
  readonly cream: THREE.MeshStandardMaterial;
  readonly ink: THREE.MeshStandardMaterial;
  readonly innerEar: THREE.MeshStandardMaterial;
}

interface AppearanceMaterials {
  readonly primary: THREE.MeshStandardMaterial;
  readonly secondary: THREE.MeshStandardMaterial;
  readonly dark: THREE.MeshStandardMaterial;
  readonly accent: THREE.MeshStandardMaterial;
  readonly highlight: THREE.MeshStandardMaterial;
}

interface AnimatedSpeciesPart {
  readonly object: THREE.Object3D;
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Euler;
  readonly scale: THREE.Vector3;
}

interface SpeciesVisualRig {
  readonly animal: Exclude<AnimalKind, 'fox'>;
  readonly root: THREE.Group;
  readonly parts: ReadonlyMap<string, AnimatedSpeciesPart>;
}

export const FOX_RIG_PROPORTIONS = Object.freeze({
  torsoLength: 1.82,
  torsoWidth: 0.82,
  torsoLengthToWidth: 1.82 / 0.82,
  headWidth: 0.52,
  headToTorsoWidth: 0.52 / 0.82,
  exposedLegLength: 0.86,
  tailLength: 2,
  tailToTorsoLength: 2 / 1.82,
});

const BODY_REST = {
  pelvisY: 1,
  pelvisPitch: 0.02,
  spinePitch: -0.015,
  chestPitch: 0.015,
  neckPitch: -0.02,
  headPitch: -0.12,
} as const;

const PAW_CONTACT_ENTER_CLEARANCE = 0.06;
const PAW_CONTACT_EXIT_CLEARANCE = 0.1;
const PAW_CONTACT_ENTER_WEIGHT = 0.08;
const PAW_CONTACT_EXIT_WEIGHT = 0.02;

function makeRenderedPawState(leg: FoxLegKey): MutableRenderedPawState {
  return {
    leg,
    clearance: Number.POSITIVE_INFINITY,
    plantWeight: 0,
    position: new THREE.Vector3(),
    contact: false,
    downwardImpact: 0,
    previousClearance: Number.POSITIVE_INFINITY,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return THREE.MathUtils.clamp(value, 0, 1);
}

function finiteOr(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function damp(current: number, target: number, response: number, deltaSeconds: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-response * deltaSeconds));
}

function dampAngle(current: number, target: number, response: number, deltaSeconds: number): number {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-response * deltaSeconds));
}

function shadows(mesh: THREE.Mesh): THREE.Mesh {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeEllipsoid(
  name: string,
  material: THREE.Material,
  scale: Readonly<THREE.Vector3>,
  segments = 9,
): THREE.Mesh {
  const mesh = shadows(new THREE.Mesh(new THREE.SphereGeometry(1, segments, 6), material));
  mesh.name = name;
  mesh.scale.copy(scale);
  return mesh;
}

function makeCapsule(
  name: string,
  material: THREE.Material,
  radius: number,
  cylinderLength: number,
  centerY: number,
): THREE.Mesh {
  const mesh = shadows(new THREE.Mesh(new THREE.CapsuleGeometry(radius, cylinderLength, 3, 6), material));
  mesh.name = name;
  mesh.position.y = centerY;
  return mesh;
}

function airBodyPitch(pose: FoxAirPose, progress: number): number {
  switch (pose) {
    case 'grounded': return 0;
    case 'anticipate': return 0.08 * progress;
    case 'rise': return 0.21;
    case 'apex': return 0.035;
    case 'fall': return -0.08;
    case 'double': return 0.12 * Math.sin(progress * Math.PI);
    case 'glide': return 0.075;
    case 'land': return -0.07 * (1 - progress) ** 2;
  }
}

/**
 * Original low-poly fox rig with a lean silhouette and joint topology suitable
 * for naturalistic four-beat walking, rotary galloping, and staged air poses.
 */
export class FoxRig {
  public readonly root = new THREE.Group();
  public readonly pelvis = new THREE.Group();
  public readonly spine = new THREE.Group();
  public readonly chest = new THREE.Group();
  public readonly neck = new THREE.Group();
  public readonly head = new THREE.Group();

  private readonly legs: Readonly<Record<FoxLegKey, LegRig>>;
  private readonly renderedPaws: Record<FoxLegKey, MutableRenderedPawState>;
  private readonly tail: TailRig[] = [];
  private readonly ears: EarRig[] = [];
  private readonly materials: RigMaterials;
  private readonly appearanceRoots: THREE.Group[] = [];
  private readonly appearanceOwnedMaterials = new Set<THREE.Material>();
  private readonly foxVisualMeshes: THREE.Mesh[] = [];
  private speciesVisual: SpeciesVisualRig | null = null;
  private readonly plantBounds = new THREE.Box3();
  private readonly plantFloor = new THREE.Vector3();
  private readonly plantScale = new THREE.Vector3();
  private lastPose: Required<Omit<
    FoxRigPoseInput,
    'turnLean' | 'accelerationLean' | 'appendageSpring' | 'appendageDamping'
    | 'groundPitch' | 'groundRoll' | 'pawGroundOffsets' | 'reducedMotion'
  >> & {
    turnLean: number;
    accelerationLean: number;
    groundPitch: number;
    groundRoll: number;
    reducedMotion: boolean;
  } = {
    deltaSeconds: 0,
    elapsedSeconds: 0,
    gaitPhase: 0,
    movementBlend: 0,
    runBlend: 0,
    airPose: 'grounded',
    airBlend: 0,
    airProgress: 1,
    turnLean: 0,
    accelerationLean: 0,
    groundPitch: 0,
    groundRoll: 0,
    reducedMotion: false,
  };
  private strideExtension = 0;
  private currentAnimal: AnimalKind = 'fox';
  private currentSkin: SkinId = 'base';

  public constructor() {
    const materials = this.createMaterials();
    this.materials = materials;
    this.root.name = 'FoxModel';
    this.pelvis.name = 'FoxPelvis';
    this.spine.name = 'FoxSpine';
    this.chest.name = 'FoxChest';
    this.neck.name = 'FoxNeck';
    this.head.name = 'FoxHead';

    this.root.add(this.pelvis);
    this.pelvis.add(this.spine);
    this.spine.add(this.chest);
    this.chest.add(this.neck);
    this.neck.add(this.head);
    this.setRestBodyPose();
    this.buildBody(materials);

    this.legs = {
      frontLeft: this.buildLeg('frontLeft', materials),
      frontRight: this.buildLeg('frontRight', materials),
      hindLeft: this.buildLeg('hindLeft', materials),
      hindRight: this.buildLeg('hindRight', materials),
    };
    this.renderedPaws = {
      frontLeft: makeRenderedPawState('frontLeft'),
      frontRight: makeRenderedPawState('frontRight'),
      hindLeft: makeRenderedPawState('hindLeft'),
      hindRight: makeRenderedPawState('hindRight'),
    };
    this.buildTail(materials);
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) this.foxVisualMeshes.push(object);
    });
  }

  public get animal(): AnimalKind {
    return this.currentAnimal;
  }

  public get skin(): SkinId {
    return this.currentSkin;
  }

  /**
   * Changes only the visual layer. The articulated hierarchy, leg geometry,
   * planted-paw state, and animation inputs remain exactly the same.
   */
  public setAnimal(animal: AnimalKind, skin: SkinId = 'base'): void {
    const appearance = resolveAnimalAppearance(animal, skin);
    if (appearance.animal === this.currentAnimal && appearance.skin === this.currentSkin) return;

    this.disposeAppearanceRoots();
    this.currentAnimal = appearance.animal;
    this.currentSkin = appearance.skin;
    this.applyAppearancePalette(appearance);
    this.applyFoxFeatureVisibility(appearance.animal);
    if (appearance.animal !== 'fox') {
      this.buildAppearanceAttachments(appearance);
    }
  }

  public resetSecondaryMotion(): void {
    for (const joint of this.tail) {
      joint.yawVelocity = 0;
      joint.pitchVelocity = 0;
      joint.pivot.rotation.y = 0;
      joint.pivot.rotation.x = joint.restPitch;
    }
    for (const ear of this.ears) {
      ear.pitchVelocity = 0;
      ear.rollVelocity = 0;
      ear.pivot.rotation.x = ear.restPitch;
      ear.pivot.rotation.z = ear.restRoll;
    }
  }

  public updatePose(input: FoxRigPoseInput): void {
    const delta = THREE.MathUtils.clamp(finiteOr(input.deltaSeconds), 0, 0.05);
    const elapsed = finiteOr(input.elapsedSeconds);
    const gaitPhase = finiteOr(input.gaitPhase);
    const movementBlend = clamp01(input.movementBlend);
    const runBlend = clamp01(input.runBlend);
    const airPose = input.airPose ?? 'grounded';
    const airBlend = airPose === 'grounded' ? 0 : clamp01(input.airBlend ?? 1);
    const airProgress = clamp01(input.airProgress ?? (airPose === 'land' ? 0 : 1));
    const turnLean = finiteOr(input.turnLean);
    const accelerationLean = finiteOr(input.accelerationLean);
    const appendageSpring = Math.max(1, finiteOr(input.appendageSpring, 72));
    const appendageDamping = Math.max(0.1, finiteOr(input.appendageDamping, 12.5));
    const groundPitch = finiteOr(input.groundPitch);
    const groundRoll = finiteOr(input.groundRoll);
    const reducedMotion = input.reducedMotion ?? false;
    const motionScale = reducedMotion ? 0.42 : 1;
    const response = reducedMotion ? 18 : 16.5;
    const poseDelta = delta === 0 ? 1 : delta;

    this.lastPose = {
      deltaSeconds: delta,
      elapsedSeconds: elapsed,
      gaitPhase,
      movementBlend,
      runBlend,
      airPose,
      airBlend,
      airProgress,
      turnLean,
      accelerationLean,
      groundPitch,
      groundRoll,
      reducedMotion,
    };

    for (const key of FOX_LEG_KEYS) {
      const leg = this.legs[key];
      const ground = sampleFoxLegMotion(key, gaitPhase, runBlend);
      const air = sampleFoxAirLegPose(key, airPose, airProgress);
      const groundHip = leg.restHip + ground.hip * movementBlend * motionScale;
      const groundKnee = leg.restKnee + ground.knee * movementBlend * motionScale;
      const groundHock = leg.restHock + ground.hock * movementBlend * motionScale;
      const groundPaw = leg.restPaw + ground.paw * movementBlend * motionScale;
      const hipTarget = THREE.MathUtils.lerp(groundHip, leg.restHip + air.hip * motionScale, airBlend);
      const kneeTarget = THREE.MathUtils.lerp(groundKnee, leg.restKnee + air.knee * motionScale, airBlend);
      const hockTarget = THREE.MathUtils.lerp(groundHock, leg.restHock + air.hock * motionScale, airBlend);
      const pawTarget = THREE.MathUtils.lerp(groundPaw, leg.restPaw + air.paw * motionScale, airBlend);

      leg.hip.rotation.x = dampAngle(leg.hip.rotation.x, hipTarget, response, poseDelta);
      leg.knee.rotation.x = dampAngle(leg.knee.rotation.x, kneeTarget, response * 1.08, poseDelta);
      leg.hock.rotation.x = dampAngle(leg.hock.rotation.x, hockTarget, response * 1.12, poseDelta);
      leg.paw.rotation.x = dampAngle(leg.paw.rotation.x, pawTarget, response * 1.18, poseDelta);
    }

    const runExtension = Math.cos(gaitPhase) * movementBlend * runBlend * motionScale;
    const headRunExtension = Math.cos(gaitPhase - 0.3) * movementBlend * runBlend * motionScale;
    const walkSway = Math.sin(gaitPhase) * movementBlend * (1 - runBlend) * motionScale;
    this.strideExtension = runExtension;
    const bodyAir = airBodyPitch(airPose, airProgress) * airBlend * motionScale;
    const walkBob = (0.5 + 0.5 * Math.cos(gaitPhase * 2)) * 0.012;
    const runBob = (0.5 + 0.5 * Math.cos(gaitPhase)) * 0.15;
    const idleBreath = (0.5 + 0.5 * Math.sin(elapsed * 1.45)) * 0.01 * (1 - movementBlend);
    const airCompression = airPose === 'anticipate'
      ? -0.085 * airProgress
      : airPose === 'land'
        ? -0.075 * (1 - airProgress) ** 2
        : 0;
    const rootY = 0.015 + idleBreath
      + THREE.MathUtils.lerp(walkBob, runBob, runBlend) * movementBlend * motionScale
      + airCompression * airBlend * motionScale;

    this.root.position.y = damp(this.root.position.y, rootY, response, poseDelta);
    this.root.rotation.x = dampAngle(
      this.root.rotation.x,
      groundPitch * (1 - airBlend) + (accelerationLean + bodyAir - runExtension * 0.08) * motionScale,
      response,
      poseDelta,
    );
    this.root.rotation.z = dampAngle(
      this.root.rotation.z,
      groundRoll * (1 - airBlend) + turnLean * motionScale,
      response,
      poseDelta,
    );
    this.pelvis.rotation.x = dampAngle(
      this.pelvis.rotation.x,
      BODY_REST.pelvisPitch + runExtension * 0.26 - bodyAir * 0.18,
      response,
      poseDelta,
    );
    this.pelvis.rotation.z = dampAngle(this.pelvis.rotation.z, walkSway * 0.025, response, poseDelta);
    this.spine.rotation.x = dampAngle(
      this.spine.rotation.x,
      BODY_REST.spinePitch - runExtension * 0.5 + bodyAir * 0.42,
      response,
      poseDelta,
    );
    this.spine.rotation.z = dampAngle(this.spine.rotation.z, -walkSway * 0.032, response, poseDelta);
    this.chest.rotation.x = dampAngle(
      this.chest.rotation.x,
      BODY_REST.chestPitch + runExtension * 0.32 + bodyAir * 0.28,
      response,
      poseDelta,
    );
    this.neck.rotation.x = dampAngle(
      this.neck.rotation.x,
      BODY_REST.neckPitch - headRunExtension * 0.14 - bodyAir * 0.5,
      response * 0.85,
      poseDelta,
    );
    this.head.rotation.x = dampAngle(
      this.head.rotation.x,
      BODY_REST.headPitch - headRunExtension * 0.08 - bodyAir * 0.38,
      response * 0.8,
      poseDelta,
    );
    this.head.rotation.y = dampAngle(
      this.head.rotation.y,
      Math.sin(elapsed * 0.43) * 0.045 * (1 - movementBlend) * motionScale,
      response * 0.45,
      poseDelta,
    );

    this.animateEars(
      elapsed,
      movementBlend,
      airPose,
      airBlend,
      turnLean,
      accelerationLean,
      motionScale,
      appendageSpring,
      appendageDamping,
      delta,
    );
    this.animateTail(
      elapsed,
      gaitPhase,
      movementBlend,
      runBlend,
      airPose,
      airBlend,
      turnLean,
      motionScale,
      appendageSpring,
      appendageDamping,
      delta,
    );
    this.animateSpeciesVisual(elapsed, gaitPhase, movementBlend, runBlend, airPose, airBlend, airProgress, motionScale);
    this.plantGroundedPaws(
      gaitPhase,
      movementBlend,
      runBlend,
      airBlend,
      input.pawGroundOffsets,
      response,
      poseDelta,
    );
  }

  public getDebugSnapshot(): FoxRigDebugSnapshot {
    this.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.root);
    const size = bounds.getSize(new THREE.Vector3());
    const legDebug = (key: FoxLegKey): FoxRigLegDebugPose => {
      const leg = this.legs[key];
      const rendered = this.renderedPaws[key];
      return {
        hip: leg.hip.rotation.x,
        knee: leg.knee.rotation.x,
        hock: leg.hock.rotation.x,
        paw: leg.paw.rotation.x,
        contact: rendered.contact,
        clearance: rendered.clearance,
        plantWeight: rendered.plantWeight,
        downwardImpact: rendered.downwardImpact,
      };
    };

    return {
      bounds: {
        width: size.x,
        height: size.y,
        length: size.z,
        minY: bounds.min.y,
        maxY: bounds.max.y,
      },
      proportions: FOX_RIG_PROPORTIONS,
      pose: {
        gaitPhase: this.lastPose.gaitPhase,
        movementBlend: this.lastPose.movementBlend,
        runBlend: this.lastPose.runBlend,
        airPose: this.lastPose.airPose,
        strideExtension: this.strideExtension,
        spinePitch: this.spine.rotation.x,
        legs: {
          frontLeft: legDebug('frontLeft'),
          frontRight: legDebug('frontRight'),
          hindLeft: legDebug('hindLeft'),
          hindRight: legDebug('hindRight'),
        },
      },
    };
  }

  /**
   * Returns stable same-frame views of the four rendered paw contacts. Callers
   * that retain a position beyond the frame should clone its Vector3.
   */
  public getRenderedPawStates(): Readonly<Record<FoxLegKey, FoxRigRenderedPawState>> {
    return this.renderedPaws;
  }

  private createMaterials(): RigMaterials {
    return {
      fur: new THREE.MeshStandardMaterial({ color: PALETTE.fox, roughness: 0.92, flatShading: true }),
      cream: new THREE.MeshStandardMaterial({ color: PALETTE.foxCream, roughness: 0.94, flatShading: true }),
      ink: new THREE.MeshStandardMaterial({ color: PALETTE.ink, roughness: 0.9, flatShading: true }),
      innerEar: new THREE.MeshStandardMaterial({ color: PALETTE.pink, roughness: 0.94, flatShading: true }),
    };
  }

  private applyAppearancePalette(appearance: AnimalAppearanceProfile): void {
    this.materials.fur.color.setHex(appearance.palette.primary);
    this.materials.cream.color.setHex(appearance.palette.secondary);
    this.materials.ink.color.setHex(appearance.palette.dark);
    this.materials.innerEar.color.setHex(appearance.palette.accent);
  }

  private applyFoxFeatureVisibility(animal: AnimalKind): void {
    const foxVisible = animal === 'fox';
    for (const mesh of this.foxVisualMeshes) mesh.visible = foxVisible;
    const tailRoot = this.root.getObjectByName('FoxTailJoint1');
    if (tailRoot) tailRoot.visible = foxVisible;
  }

  private buildAppearanceAttachments(appearance: AnimalAppearanceProfile): void {
    const materials = this.createAppearanceMaterials();
    const root = this.createAppearanceRoot('Species');
    root.name = `AnimalModel-${appearance.animal}`;
    this.root.add(root);
    this.appearanceRoots.push(root);

    switch (appearance.animal) {
      case 'fox': break;
      case 'penguin':
        this.addPenguinFeatures(root, materials);
        break;
      case 'frog':
        this.addFrogFeatures(root, materials);
        break;
      case 'duck':
        this.addDuckFeatures(root, materials);
        break;
      case 'bear':
        this.addBearFeatures(root, materials);
        break;
      case 'rabbit':
        this.addRabbitFeatures(root, materials);
        break;
      case 'cat':
        this.addCatFeatures(root, materials);
        break;
      case 'axolotl':
        this.addAxolotlFeatures(root, materials);
        break;
      case 'saylor':
        this.addSaylorFeatures(root, materials);
        break;
    }
    if (appearance.animal === 'fox') return;
    const parts = new Map<string, AnimatedSpeciesPart>();
    root.traverse((object) => {
      if (!object.name.startsWith('SpeciesMotion')) return;
      parts.set(object.name, {
        object,
        position: object.position.clone(),
        rotation: object.rotation.clone(),
        scale: object.scale.clone(),
      });
    });
    this.speciesVisual = { animal: appearance.animal, root, parts };
  }

  private createAppearanceRoot(part: string): THREE.Group {
    const root = new THREE.Group();
    root.name = `AnimalAppearance${part}`;
    return root;
  }

  private createAppearanceMaterials(): AppearanceMaterials {
    // Appearance geometry shares the four baseline rig materials. This keeps
    // switching allocation-free for materials and lets FoxPlayer own and
    // dispose the complete material set once with its ordinary traversal.
    return {
      primary: this.materials.fur,
      secondary: this.materials.cream,
      dark: this.materials.ink,
      accent: this.materials.innerEar,
      highlight: this.materials.innerEar,
    };
  }

  private createOwnedAppearanceMaterial(color: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
    });
    this.appearanceOwnedMaterials.add(material);
    return material;
  }

  private addShape(
    parent: THREE.Object3D,
    name: string,
    material: THREE.Material,
    scale: readonly [number, number, number],
    position: readonly [number, number, number],
  ): THREE.Mesh {
    const shape = makeEllipsoid(name, material, new THREE.Vector3(...scale), 9);
    shape.position.set(...position);
    parent.add(shape);
    return shape;
  }

  private addMotionGroup(
    parent: THREE.Object3D,
    name: string,
    position: readonly [number, number, number],
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `SpeciesMotion${name}`;
    group.position.set(...position);
    parent.add(group);
    return group;
  }

  private addEyes(
    parent: THREE.Object3D,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    scale = 0.045,
  ): void {
    for (const side of [-1, 1] as const) {
      this.addShape(
        parent,
        side < 0 ? 'AnimalEyeLeft' : 'AnimalEyeRight',
        material,
        [scale, scale * 1.12, scale * 0.55],
        [side * x, y, z],
      );
    }
  }

  private addLimb(
    parent: THREE.Object3D,
    key: 'FrontLeft' | 'FrontRight' | 'HindLeft' | 'HindRight',
    material: THREE.Material,
    pawMaterial: THREE.Material,
    position: readonly [number, number, number],
    length: number,
    radius: number,
    pawScale: readonly [number, number, number],
  ): THREE.Group {
    const limb = this.addMotionGroup(parent, key, position);
    const leg = makeCapsule(`Animal${key}Leg`, material, radius, Math.max(0.04, length - radius * 2), -length * 0.48);
    const paw = this.addShape(limb, `Animal${key}Paw`, pawMaterial, pawScale, [0, -length, -pawScale[2] * 0.38]);
    limb.add(leg);
    paw.castShadow = true;
    return limb;
  }

  private addPenguinFeatures(
    root: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'PenguinBody', materials.dark, [0.48, 0.72, 0.43], [0, 0.86, 0.03]);
    this.addShape(body, 'PenguinBelly', materials.secondary, [0.31, 0.52, 0.12], [0, 0.82, -0.39]);
    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    this.addShape(head, 'PenguinHeadCap', materials.dark, [0.4, 0.39, 0.38], [0, 1.52, -0.08]);
    this.addShape(head, 'PenguinFace', materials.secondary, [0.27, 0.25, 0.09], [0, 1.48, -0.42]);
    this.addEyes(head, materials.dark, 0.14, 1.57, -0.5, 0.038);
    this.addShape(head, 'PenguinBeak', materials.accent, [0.14, 0.065, 0.2], [0, 1.43, -0.54]);
    for (const side of [-1, 1] as const) {
      const flipper = this.addMotionGroup(root, side < 0 ? 'WingLeft' : 'WingRight', [side * 0.42, 1.08, 0]);
      const mesh = this.addShape(flipper, side < 0 ? 'PenguinFlipperLeft' : 'PenguinFlipperRight', materials.dark, [0.1, 0.42, 0.2], [side * 0.08, -0.18, 0]);
      mesh.rotation.z = side * -0.28;
    }
    this.addLimb(root, 'HindLeft', materials.accent, materials.accent, [-0.2, 0.38, 0], 0.28, 0.055, [0.16, 0.055, 0.2]);
    this.addLimb(root, 'HindRight', materials.accent, materials.accent, [0.2, 0.38, 0], 0.28, 0.055, [0.16, 0.055, 0.2]);
  }

  private addFrogFeatures(root: THREE.Group, materials: AppearanceMaterials): void {
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'FrogBody', materials.primary, [0.55, 0.3, 0.6], [0, 0.48, 0.12]);
    this.addShape(body, 'FrogBelly', materials.secondary, [0.36, 0.15, 0.32], [0, 0.4, -0.43]);
    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    this.addShape(head, 'FrogHead', materials.primary, [0.5, 0.31, 0.42], [0, 0.75, -0.37]);
    for (const side of [-1, 1] as const) {
      this.addShape(head, side < 0 ? 'FrogEyeBulbLeft' : 'FrogEyeBulbRight', materials.secondary, [0.14, 0.14, 0.13], [side * 0.25, 1.02, -0.5]);
      this.addShape(head, side < 0 ? 'FrogPupilLeft' : 'FrogPupilRight', materials.dark, [0.055, 0.065, 0.03], [side * 0.25, 1.04, -0.62]);
    }
    this.addLimb(root, 'FrontLeft', materials.primary, materials.secondary, [-0.36, 0.5, -0.35], 0.32, 0.07, [0.18, 0.045, 0.2]);
    this.addLimb(root, 'FrontRight', materials.primary, materials.secondary, [0.36, 0.5, -0.35], 0.32, 0.07, [0.18, 0.045, 0.2]);
    this.addLimb(root, 'HindLeft', materials.primary, materials.secondary, [-0.43, 0.5, 0.3], 0.36, 0.12, [0.28, 0.055, 0.3]);
    this.addLimb(root, 'HindRight', materials.primary, materials.secondary, [0.43, 0.5, 0.3], 0.36, 0.12, [0.28, 0.055, 0.3]);
  }

  private addDuckFeatures(
    root: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'DuckBody', materials.primary, [0.48, 0.44, 0.6], [0, 0.78, 0.08]);
    this.addShape(body, 'DuckChest', materials.secondary, [0.3, 0.34, 0.12], [0, 0.75, -0.5]);
    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    this.addShape(head, 'DuckHead', materials.primary, [0.35, 0.36, 0.34], [0, 1.32, -0.34]);
    this.addEyes(head, materials.dark, 0.14, 1.4, -0.65, 0.04);
    this.addShape(head, 'DuckBill', materials.accent, [0.27, 0.075, 0.27], [0, 1.27, -0.71]);
    for (const side of [-1, 1] as const) {
      const wing = this.addMotionGroup(root, side < 0 ? 'WingLeft' : 'WingRight', [side * 0.42, 0.9, 0.02]);
      this.addShape(wing, side < 0 ? 'DuckWingLeft' : 'DuckWingRight', materials.highlight, [0.12, 0.3, 0.4], [side * 0.04, -0.08, 0.04]);
    }
    this.addLimb(root, 'HindLeft', materials.accent, materials.accent, [-0.19, 0.39, 0], 0.28, 0.05, [0.19, 0.045, 0.25]);
    this.addLimb(root, 'HindRight', materials.accent, materials.accent, [0.19, 0.39, 0], 0.28, 0.05, [0.19, 0.045, 0.25]);
  }

  private addBearFeatures(
    root: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'BearBody', materials.primary, [0.58, 0.64, 0.66], [0, 0.82, 0.1]);
    this.addShape(body, 'BearBelly', materials.secondary, [0.34, 0.4, 0.13], [0, 0.72, -0.56]);
    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    this.addShape(head, 'BearHead', materials.primary, [0.48, 0.45, 0.44], [0, 1.42, -0.42]);
    this.addShape(head, 'BearMuzzle', materials.secondary, [0.26, 0.18, 0.2], [0, 1.31, -0.78]);
    this.addShape(head, 'BearNose', materials.dark, [0.08, 0.06, 0.055], [0, 1.36, -0.96]);
    this.addEyes(head, materials.dark, 0.19, 1.5, -0.8, 0.042);
    for (const side of [-1, 1] as const) {
      this.addShape(head, side < 0 ? 'BearEarLeft' : 'BearEarRight', materials.primary, [0.15, 0.15, 0.1], [side * 0.31, 1.74, -0.38]);
    }
    this.addLimb(root, 'FrontLeft', materials.primary, materials.dark, [-0.39, 0.79, -0.4], 0.62, 0.11, [0.16, 0.085, 0.2]);
    this.addLimb(root, 'FrontRight', materials.primary, materials.dark, [0.39, 0.79, -0.4], 0.62, 0.11, [0.16, 0.085, 0.2]);
    this.addLimb(root, 'HindLeft', materials.primary, materials.dark, [-0.4, 0.76, 0.45], 0.58, 0.13, [0.18, 0.09, 0.23]);
    this.addLimb(root, 'HindRight', materials.primary, materials.dark, [0.4, 0.76, 0.45], 0.58, 0.13, [0.18, 0.09, 0.23]);
    const tail = this.addMotionGroup(root, 'Tail', [0, 0.9, 0.7]);
    this.addShape(tail, 'BearTail', materials.secondary, [0.16, 0.16, 0.16], [0, 0, 0]);
  }

  private addRabbitFeatures(
    root: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'RabbitBody', materials.primary, [0.42, 0.5, 0.55], [0, 0.72, 0.08]);
    this.addShape(body, 'RabbitHaunches', materials.primary, [0.5, 0.44, 0.48], [0, 0.58, 0.46]);
    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    this.addShape(head, 'RabbitHead', materials.primary, [0.36, 0.36, 0.38], [0, 1.22, -0.38]);
    this.addShape(head, 'RabbitMuzzle', materials.secondary, [0.22, 0.14, 0.17], [0, 1.12, -0.71]);
    this.addEyes(head, materials.dark, 0.15, 1.31, -0.71, 0.045);
    for (const side of [-1, 1] as const) {
      const ear = this.addMotionGroup(root, side < 0 ? 'EarLeft' : 'EarRight', [side * 0.17, 1.48, -0.36]);
      const outer = this.addShape(ear, side < 0 ? 'RabbitEarLeft' : 'RabbitEarRight', materials.primary, [0.12, 0.48, 0.09], [0, 0.38, 0]);
      outer.rotation.z = side * -0.08;
      this.addShape(ear, side < 0 ? 'RabbitInnerEarLeft' : 'RabbitInnerEarRight', materials.accent, [0.052, 0.34, 0.04], [0, 0.38, -0.08]).rotation.z = side * -0.08;
    }
    this.addLimb(root, 'FrontLeft', materials.primary, materials.secondary, [-0.28, 0.63, -0.32], 0.48, 0.07, [0.12, 0.06, 0.22]);
    this.addLimb(root, 'FrontRight', materials.primary, materials.secondary, [0.28, 0.63, -0.32], 0.48, 0.07, [0.12, 0.06, 0.22]);
    this.addLimb(root, 'HindLeft', materials.primary, materials.secondary, [-0.35, 0.56, 0.4], 0.38, 0.12, [0.19, 0.075, 0.34]);
    this.addLimb(root, 'HindRight', materials.primary, materials.secondary, [0.35, 0.56, 0.4], 0.38, 0.12, [0.19, 0.075, 0.34]);
    const tail = this.addMotionGroup(root, 'Tail', [0, 0.72, 0.66]);
    this.addShape(tail, 'RabbitTail', materials.secondary, [0.2, 0.2, 0.2], [0, 0, 0]);
  }

  private addCatFeatures(root: THREE.Group, materials: AppearanceMaterials): void {
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'CatBody', materials.primary, [0.4, 0.36, 0.72], [0, 0.8, 0.08]);
    this.addShape(body, 'CatChest', materials.secondary, [0.22, 0.26, 0.11], [0, 0.78, -0.62]);
    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    this.addShape(head, 'CatHead', materials.primary, [0.35, 0.34, 0.36], [0, 1.23, -0.61]);
    this.addShape(head, 'CatMuzzle', materials.secondary, [0.22, 0.13, 0.15], [0, 1.13, -0.93]);
    this.addEyes(head, materials.dark, 0.15, 1.31, -0.92, 0.045);
    for (const side of [-1, 1] as const) {
      const ear = shadows(new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 5), materials.primary));
      ear.name = side < 0 ? 'CatEarLeft' : 'CatEarRight';
      ear.position.set(side * 0.22, 1.56, -0.6);
      head.add(ear);
    }
    for (const side of [-1, 1] as const) {
      for (let index = -1; index <= 1; index += 1) {
        const whisker = shadows(new THREE.Mesh(
          new THREE.CylinderGeometry(0.006, 0.006, 0.3, 5),
          materials.dark,
        ));
        whisker.name = `${side < 0 ? 'CatWhiskerLeft' : 'CatWhiskerRight'}${index + 2}`;
        whisker.position.set(side * 0.25, 1.14 + index * 0.045, -0.95);
        whisker.rotation.z = Math.PI * 0.5;
        whisker.rotation.x = index * 0.12;
        head.add(whisker);
      }
    }
    this.addLimb(root, 'FrontLeft', materials.primary, materials.secondary, [-0.3, 0.68, -0.47], 0.53, 0.065, [0.11, 0.055, 0.18]);
    this.addLimb(root, 'FrontRight', materials.primary, materials.secondary, [0.3, 0.68, -0.47], 0.53, 0.065, [0.11, 0.055, 0.18]);
    this.addLimb(root, 'HindLeft', materials.primary, materials.secondary, [-0.3, 0.68, 0.5], 0.53, 0.075, [0.12, 0.06, 0.2]);
    this.addLimb(root, 'HindRight', materials.primary, materials.secondary, [0.3, 0.68, 0.5], 0.53, 0.075, [0.12, 0.06, 0.2]);
    const tail = this.addMotionGroup(root, 'Tail', [0, 0.88, 0.7]);
    const tailMesh = makeCapsule('CatTail', materials.primary, 0.075, 0.78, 0.42);
    tailMesh.rotation.x = Math.PI * 0.48;
    tailMesh.rotation.z = -0.25;
    tail.add(tailMesh);
  }

  private addAxolotlFeatures(
    root: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'AxolotlBody', materials.primary, [0.38, 0.25, 0.78], [0, 0.45, 0.08]);
    this.addShape(body, 'AxolotlBelly', materials.secondary, [0.26, 0.1, 0.48], [0, 0.35, -0.36]);
    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    this.addShape(head, 'AxolotlHead', materials.primary, [0.48, 0.3, 0.4], [0, 0.62, -0.62]);
    this.addEyes(head, materials.dark, 0.21, 0.72, -0.98, 0.04);
    for (const side of [-1, 1] as const) {
      for (let index = -1; index <= 1; index += 1) {
        const gill = makeCapsule(
          `${side < 0 ? 'AxolotlGillLeft' : 'AxolotlGillRight'}${index + 2}`,
          materials.accent,
          0.035,
          0.16,
          0,
        );
        gill.position.set(side * (0.47 + Math.abs(index) * 0.025), 0.65 + index * 0.15, -0.6);
        gill.rotation.z = side * (-Math.PI * 0.5 + index * 0.18);
        head.add(gill);
      }
    }
    this.addLimb(root, 'FrontLeft', materials.primary, materials.secondary, [-0.3, 0.38, -0.36], 0.25, 0.045, [0.12, 0.035, 0.15]);
    this.addLimb(root, 'FrontRight', materials.primary, materials.secondary, [0.3, 0.38, -0.36], 0.25, 0.045, [0.12, 0.035, 0.15]);
    this.addLimb(root, 'HindLeft', materials.primary, materials.secondary, [-0.3, 0.38, 0.38], 0.25, 0.045, [0.12, 0.035, 0.15]);
    this.addLimb(root, 'HindRight', materials.primary, materials.secondary, [0.3, 0.38, 0.38], 0.25, 0.045, [0.12, 0.035, 0.15]);
    const tail = this.addMotionGroup(root, 'Tail', [0, 0.47, 0.75]);
    const fin = this.addShape(tail, 'AxolotlTailFin', materials.highlight, [0.09, 0.27, 0.58], [0, 0, 0.36]);
    fin.rotation.x = 0.16;
  }

  private addSaylorFeatures(root: THREE.Group, materials: AppearanceMaterials): void {
    const formalDark = this.createOwnedAppearanceMaterial(0x252b32);
    const silver = this.createOwnedAppearanceMaterial(0x9aa0a4);
    const body = this.addMotionGroup(root, 'Body', [0, 0, 0]);
    this.addShape(body, 'SaylorSuitTorso', materials.primary, [0.46, 0.53, 0.3], [0, 1.18, 0.03]);
    this.addShape(body, 'SaylorShoulders', materials.primary, [0.56, 0.17, 0.28], [0, 1.47, 0]);
    this.addShape(body, 'SaylorBlackShirt', formalDark, [0.18, 0.33, 0.045], [0, 1.27, -0.29]);
    for (const side of [-1, 1] as const) {
      const lapel = this.addShape(
        body,
        side < 0 ? 'SaylorLapelLeft' : 'SaylorLapelRight',
        formalDark,
        [0.105, 0.3, 0.035],
        [side * 0.15, 1.34, -0.315],
      );
      lapel.rotation.z = side * -0.27;
    }
    this.addShape(body, 'SaylorJacketHemLeft', materials.primary, [0.22, 0.25, 0.25], [-0.2, 0.84, 0.05]);
    this.addShape(body, 'SaylorJacketHemRight', materials.primary, [0.22, 0.25, 0.25], [0.2, 0.84, 0.05]);

    const tie = this.addMotionGroup(root, 'Tail', [0, 1.51, -0.345]);
    this.addShape(tie, 'SaylorOrangeTieKnot', materials.accent, [0.075, 0.065, 0.035], [0, -0.05, 0]);
    const tieBlade = this.addShape(tie, 'SaylorOrangeTie', materials.accent, [0.07, 0.25, 0.025], [0, -0.31, 0]);
    tieBlade.rotation.z = 0.02;

    const coin = this.addMotionGroup(root, 'Coin', [-0.245, 1.43, -0.34]);
    const pin = shadows(new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.035, 12), materials.accent));
    pin.name = 'SaylorBitcoinPin';
    pin.rotation.x = Math.PI * 0.5;
    coin.add(pin);
    this.addShape(coin, 'SaylorBitcoinPinMark', formalDark, [0.018, 0.045, 0.012], [0, 0, -0.025]);

    const head = this.addMotionGroup(root, 'Head', [0, 0, 0]);
    const neck = makeCapsule('SaylorNeck', materials.secondary, 0.105, 0.13, 1.57);
    head.add(neck);
    this.addShape(head, 'SaylorFace', materials.secondary, [0.285, 0.335, 0.245], [0, 1.86, -0.02]);
    this.addShape(head, 'SaylorJaw', materials.secondary, [0.23, 0.18, 0.21], [0, 1.7, -0.08]);
    for (const side of [-1, 1] as const) {
      this.addShape(
        head,
        side < 0 ? 'SaylorEarLeft' : 'SaylorEarRight',
        materials.secondary,
        [0.055, 0.105, 0.045],
        [side * 0.28, 1.86, -0.01],
      );
      this.addShape(
        head,
        side < 0 ? 'SaylorEyeLeft' : 'SaylorEyeRight',
        formalDark,
        [0.035, 0.046, 0.018],
        [side * 0.105, 1.9, -0.245],
      );
      const brow = makeCapsule(
        side < 0 ? 'SaylorBrowLeft' : 'SaylorBrowRight',
        formalDark,
        0.014,
        0.105,
        0,
      );
      brow.position.set(side * 0.105, 1.995, -0.248);
      brow.rotation.z = side * 0.1;
      head.add(brow);
    }
    this.addShape(head, 'SaylorNose', materials.secondary, [0.06, 0.085, 0.085], [0, 1.82, -0.275]);
    this.addShape(head, 'SaylorSilverBeard', silver, [0.215, 0.115, 0.035], [0, 1.66, -0.235]);
    this.addShape(head, 'SaylorSilverMustache', silver, [0.12, 0.025, 0.025], [0, 1.75, -0.29]);
    this.addShape(head, 'SaylorSilverHairCap', silver, [0.29, 0.11, 0.235], [0, 2.12, -0.01]);
    const sweptHair = this.addShape(
      head,
      'SaylorSweptSilverHair',
      silver,
      [0.22, 0.075, 0.15],
      [0.075, 2.19, -0.06],
    );
    sweptHair.rotation.z = -0.16;

    for (const side of [-1, 1] as const) {
      const arm = this.addMotionGroup(
        root,
        side < 0 ? 'FrontLeft' : 'FrontRight',
        [side * 0.49, 1.43, 0],
      );
      const sleeve = makeCapsule(
        side < 0 ? 'SaylorArmLeft' : 'SaylorArmRight',
        materials.primary,
        0.095,
        0.5,
        -0.32,
      );
      arm.add(sleeve);
      this.addShape(
        arm,
        side < 0 ? 'SaylorHandLeft' : 'SaylorHandRight',
        materials.secondary,
        [0.09, 0.105, 0.085],
        [0, -0.67, -0.02],
      );

      const leg = this.addMotionGroup(
        root,
        side < 0 ? 'HindLeft' : 'HindRight',
        [side * 0.21, 0.82, 0.04],
      );
      const trouser = makeCapsule(
        side < 0 ? 'SaylorLegLeft' : 'SaylorLegRight',
        materials.primary,
        0.115,
        0.53,
        -0.35,
      );
      leg.add(trouser);
      this.addShape(
        leg,
        side < 0 ? 'SaylorShoeLeft' : 'SaylorShoeRight',
        formalDark,
        [0.13, 0.075, 0.2],
        [0, -0.75, -0.1],
      );
    }
  }

  private animateSpeciesVisual(
    elapsed: number,
    gaitPhase: number,
    movementBlend: number,
    runBlend: number,
    airPose: FoxAirPose,
    airBlend: number,
    airProgress: number,
    motionScale: number,
  ): void {
    const visual = this.speciesVisual;
    if (!visual) return;
    for (const part of visual.parts.values()) {
      part.object.position.copy(part.position);
      part.object.rotation.copy(part.rotation);
      part.object.scale.copy(part.scale);
    }
    const part = (name: string): THREE.Object3D | undefined => visual.parts.get(`SpeciesMotion${name}`)?.object;
    const phase = gaitPhase;
    const stride = Math.sin(phase) * movementBlend * motionScale;
    const opposite = Math.sin(phase + Math.PI) * movementBlend * motionScale;
    const pulse = Math.abs(Math.sin(phase)) * movementBlend * motionScale;
    const doubleKick = airPose === 'double' ? Math.sin(airProgress * Math.PI) * motionScale : 0;
    const riseShape = airPose === 'rise' || airPose === 'apex' ? airBlend * motionScale : 0;
    const fallShape = airPose === 'fall' ? airBlend * motionScale : 0;
    const glideShape = airPose === 'glide' ? airBlend * motionScale : 0;
    const anticipateShape = airPose === 'anticipate' ? airProgress * motionScale : 0;
    const body = part('Body');
    const head = part('Head');
    const frontLeft = part('FrontLeft');
    const frontRight = part('FrontRight');
    const hindLeft = part('HindLeft');
    const hindRight = part('HindRight');
    const wingLeft = part('WingLeft');
    const wingRight = part('WingRight');
    const earLeft = part('EarLeft');
    const earRight = part('EarRight');
    const tail = part('Tail');
    const coin = part('Coin');

    switch (visual.animal) {
      case 'penguin': {
        if (body) body.rotation.z += stride * 0.13;
        if (head) head.rotation.z -= stride * 0.055;
        if (hindLeft) hindLeft.rotation.x += stride * 0.42;
        if (hindRight) hindRight.rotation.x += opposite * 0.42;
        if (hindLeft) hindLeft.rotation.x -= riseShape * 0.42;
        if (hindRight) hindRight.rotation.x -= riseShape * 0.42;
        const flap = (airBlend * (0.75 + doubleKick * 0.65) + pulse * 0.16);
        if (wingLeft) wingLeft.rotation.z += flap;
        if (wingRight) wingRight.rotation.z -= flap;
        visual.root.position.y = pulse * 0.035;
        break;
      }
      case 'frog': {
        const spring = (0.5 + 0.5 * Math.cos(phase * 2)) * movementBlend;
        visual.root.position.y = spring * 0.12 * motionScale;
        if (body) body.scale.y *= 1 - spring * 0.09 * motionScale;
        if (frontLeft) frontLeft.rotation.x += stride * 0.3 - doubleKick * 0.5 + fallShape * 0.45;
        if (frontRight) frontRight.rotation.x += opposite * 0.3 - doubleKick * 0.5 + fallShape * 0.45;
        if (hindLeft) hindLeft.rotation.x += -0.35 + spring * 0.9 + doubleKick * 1.15 - riseShape * 0.9;
        if (hindRight) hindRight.rotation.x += -0.35 + spring * 0.9 + doubleKick * 1.15 - riseShape * 0.9;
        if (body) body.rotation.x -= riseShape * 0.12;
        break;
      }
      case 'duck': {
        if (body) body.rotation.z += stride * 0.11;
        if (head) head.rotation.z -= stride * 0.045;
        if (hindLeft) hindLeft.rotation.x += stride * 0.5;
        if (hindRight) hindRight.rotation.x += opposite * 0.5;
        if (hindLeft) hindLeft.rotation.x -= riseShape * 0.55;
        if (hindRight) hindRight.rotation.x -= riseShape * 0.55;
        const flap = airBlend * (0.7 + Math.sin(elapsed * 18) * 0.35) + doubleKick * 0.55;
        if (wingLeft) wingLeft.rotation.z += flap;
        if (wingRight) wingRight.rotation.z -= flap;
        visual.root.position.y = pulse * 0.04;
        break;
      }
      case 'bear': {
        const heavy = Math.sin(phase * 2) * movementBlend;
        visual.root.position.y = Math.abs(heavy) * 0.025 * motionScale;
        if (body) body.rotation.z += stride * 0.035;
        if (frontLeft) frontLeft.rotation.x += stride * 0.38;
        if (frontRight) frontRight.rotation.x += opposite * 0.38;
        if (hindLeft) hindLeft.rotation.x += opposite * 0.3;
        if (hindRight) hindRight.rotation.x += stride * 0.3;
        if (frontLeft) frontLeft.rotation.x += riseShape * 0.38;
        if (frontRight) frontRight.rotation.x += riseShape * 0.38;
        if (hindLeft) hindLeft.rotation.x -= riseShape * 0.42;
        if (hindRight) hindRight.rotation.x -= riseShape * 0.42;
        if (body) body.rotation.x += riseShape * 0.08 - fallShape * 0.06;
        if (tail) tail.rotation.y += Math.sin(elapsed * 1.8) * 0.08;
        break;
      }
      case 'rabbit': {
        const bound = (0.5 + 0.5 * Math.sin(phase * 2)) * movementBlend;
        visual.root.position.y = bound * (0.08 + runBlend * 0.08) * motionScale;
        if (frontLeft) frontLeft.rotation.x += -bound * 0.55 - doubleKick * 0.55 + riseShape * 0.55;
        if (frontRight) frontRight.rotation.x += -bound * 0.55 - doubleKick * 0.55 + riseShape * 0.55;
        if (hindLeft) hindLeft.rotation.x += bound * 0.95 + doubleKick * 1.1 - riseShape * 0.85;
        if (hindRight) hindRight.rotation.x += bound * 0.95 + doubleKick * 1.1 - riseShape * 0.85;
        const earBounce = Math.sin(phase * 2 + 0.7) * movementBlend * 0.12 - airBlend * 0.13;
        if (earLeft) earLeft.rotation.x += earBounce;
        if (earRight) earRight.rotation.x += earBounce * 0.9;
        if (tail) tail.scale.setScalar(1 + bound * 0.08);
        break;
      }
      case 'cat': {
        visual.root.position.y = pulse * 0.025;
        if (body) body.rotation.z += stride * 0.028;
        if (head) head.rotation.z -= stride * 0.025;
        if (frontLeft) frontLeft.rotation.x += stride * 0.5;
        if (frontRight) frontRight.rotation.x += opposite * 0.5;
        if (hindLeft) hindLeft.rotation.x += opposite * 0.48;
        if (hindRight) hindRight.rotation.x += stride * 0.48;
        if (frontLeft) frontLeft.rotation.x += riseShape * 0.48;
        if (frontRight) frontRight.rotation.x += riseShape * 0.48;
        if (hindLeft) hindLeft.rotation.x -= riseShape * 0.6;
        if (hindRight) hindRight.rotation.x -= riseShape * 0.6;
        if (body) body.rotation.x += riseShape * 0.1 - fallShape * 0.12;
        if (tail) {
          tail.rotation.y += Math.sin(elapsed * 1.9 + phase * 0.2) * 0.42 + doubleKick * 0.35;
          tail.rotation.z += Math.sin(elapsed * 1.2) * 0.12;
        }
        break;
      }
      case 'axolotl': {
        const swim = Math.sin(phase * 1.25) * movementBlend;
        if (body) body.rotation.y += swim * 0.08;
        if (head) head.rotation.y -= swim * 0.05;
        visual.root.position.y = pulse * 0.03;
        for (const limb of [frontLeft, frontRight, hindLeft, hindRight]) {
          if (limb) {
            limb.rotation.z += (limb === frontLeft || limb === hindRight ? stride : opposite) * 0.4;
            limb.rotation.x += airBlend * 0.48;
          }
        }
        if (body) body.rotation.x -= riseShape * 0.09;
        if (tail) tail.rotation.y += Math.sin(elapsed * 3.2 + phase) * (0.28 + movementBlend * 0.22) + doubleKick * 0.7;
        break;
      }
      case 'saylor': {
        const executiveStride = 0.55 + runBlend * 0.3;
        const armSpread = glideShape * 1.22 + doubleKick * 0.58;
        visual.root.position.y = pulse * (0.025 + runBlend * 0.02) - anticipateShape * 0.055;
        if (body) {
          body.rotation.z += stride * 0.025;
          body.rotation.x += riseShape * 0.06 - fallShape * 0.075 - glideShape * 0.08;
          body.scale.y *= 1 - anticipateShape * 0.035 + doubleKick * 0.025;
        }
        if (head) {
          head.rotation.z -= stride * 0.018;
          head.rotation.y += Math.sin(elapsed * 0.55) * 0.025 * (1 - movementBlend);
          head.rotation.x -= riseShape * 0.04;
        }
        if (frontLeft) {
          frontLeft.rotation.x += opposite * executiveStride - riseShape * 0.32;
          frontLeft.rotation.z -= armSpread;
        }
        if (frontRight) {
          frontRight.rotation.x += stride * executiveStride - riseShape * 0.32;
          frontRight.rotation.z += armSpread;
        }
        if (hindLeft) {
          hindLeft.rotation.x += stride * (0.62 + runBlend * 0.18) + doubleKick * 0.72 - anticipateShape * 0.2;
          hindLeft.rotation.z -= doubleKick * 0.1;
        }
        if (hindRight) {
          hindRight.rotation.x += opposite * (0.62 + runBlend * 0.18) + doubleKick * 0.72 - anticipateShape * 0.2;
          hindRight.rotation.z += doubleKick * 0.1;
        }
        if (tail) {
          tail.rotation.x += glideShape * 0.82 + fallShape * 0.28;
          tail.rotation.z += Math.sin(elapsed * 2.2) * (0.018 + movementBlend * 0.025) + doubleKick * 0.32;
        }
        if (coin) {
          coin.rotation.y += doubleKick * Math.PI * 1.5;
          coin.rotation.z += Math.sin(elapsed * 1.8) * 0.025 + doubleKick * 0.2;
          coin.scale.setScalar(1 + doubleKick * 0.28);
        }
        break;
      }
    }
  }

  private disposeAppearanceRoots(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    for (const root of this.appearanceRoots) {
      root.removeFromParent();
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
      });
    }
    this.appearanceRoots.length = 0;
    this.speciesVisual = null;
    geometries.forEach((geometry) => geometry.dispose());
    this.appearanceOwnedMaterials.forEach((material) => material.dispose());
    this.appearanceOwnedMaterials.clear();
  }

  private setRestBodyPose(): void {
    this.pelvis.position.set(0, BODY_REST.pelvisY, 0.45);
    this.pelvis.rotation.x = BODY_REST.pelvisPitch;
    this.spine.position.set(0, 0.02, -0.32);
    this.spine.rotation.x = BODY_REST.spinePitch;
    this.chest.position.set(0, 0.04, -0.58);
    this.chest.rotation.x = BODY_REST.chestPitch;
    this.neck.position.set(0, 0.1, -0.36);
    this.neck.rotation.x = BODY_REST.neckPitch;
    this.head.position.set(0, 0.1, -0.36);
    this.head.rotation.x = BODY_REST.headPitch;
  }

  private buildBody(materials: RigMaterials): void {
    const haunches = makeEllipsoid('FoxHaunches', materials.fur, new THREE.Vector3(0.41, 0.35, 0.5), 10);
    this.pelvis.add(haunches);

    const torso = makeEllipsoid('FoxTorso', materials.fur, new THREE.Vector3(0.37, 0.32, 0.7), 11);
    torso.position.z = -0.16;
    this.spine.add(torso);

    const chestCoat = makeEllipsoid('FoxChestCoat', materials.fur, new THREE.Vector3(0.39, 0.36, 0.44), 10);
    this.chest.add(chestCoat);
    const chestPatch = makeEllipsoid('FoxChestCream', materials.cream, new THREE.Vector3(0.24, 0.3, 0.075), 8);
    chestPatch.position.set(0, -0.08, -0.39);
    this.chest.add(chestPatch);

    const neckCoat = makeEllipsoid('FoxNeckCoat', materials.fur, new THREE.Vector3(0.26, 0.3, 0.34), 9);
    neckCoat.position.set(0, 0.01, -0.04);
    neckCoat.rotation.x = -0.42;
    this.neck.add(neckCoat);
    const throat = makeEllipsoid('FoxThroatCream', materials.cream, new THREE.Vector3(0.17, 0.27, 0.07), 8);
    throat.position.set(0, -0.04, -0.25);
    this.neck.add(throat);

    const skull = makeEllipsoid('FoxHeadMesh', materials.fur, new THREE.Vector3(0.25, 0.23, 0.35), 10);
    this.head.add(skull);
    const jaw = makeEllipsoid('FoxJawCream', materials.cream, new THREE.Vector3(0.2, 0.13, 0.27), 8);
    jaw.position.set(0, -0.09, -0.27);
    this.head.add(jaw);

    const muzzle = shadows(new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.17, 0.54, 7, 1), materials.cream));
    muzzle.name = 'FoxMuzzle';
    muzzle.position.set(0, -0.04, -0.45);
    muzzle.rotation.x = -Math.PI * 0.5;
    muzzle.scale.z = 0.76;
    this.head.add(muzzle);
    const nose = makeEllipsoid('FoxNose', materials.ink, new THREE.Vector3(0.105, 0.075, 0.09), 7);
    nose.position.set(0, -0.035, -0.74);
    this.head.add(nose);

    for (const side of [-1, 1] as const) {
      const eye = makeEllipsoid(
        side < 0 ? 'FoxEyeLeft' : 'FoxEyeRight',
        materials.ink,
        new THREE.Vector3(0.045, 0.055, 0.025),
        7,
      );
      eye.position.set(side * 0.16, 0.055, -0.305);
      this.head.add(eye);

      const ear = new THREE.Group();
      ear.name = side < 0 ? 'FoxEarLeft' : 'FoxEarRight';
      ear.position.set(side * 0.17, 0.15, -0.015);
      ear.rotation.z = side * -0.08;
      const outer = shadows(new THREE.Mesh(new THREE.ConeGeometry(0.155, 0.41, 5), materials.fur));
      outer.name = `${ear.name}Outer`;
      outer.position.y = 0.18;
      const inner = shadows(new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.245, 5), materials.innerEar));
      inner.name = `${ear.name}Inner`;
      inner.position.set(0, 0.18, -0.065);
      ear.add(outer, inner);
      this.head.add(ear);
      this.ears.push({
        pivot: ear,
        side,
        restPitch: ear.rotation.x,
        restRoll: ear.rotation.z,
        pitchVelocity: 0,
        rollVelocity: 0,
      });
    }
  }

  private buildLeg(key: FoxLegKey, materials: RigMaterials): LegRig {
    const front = key.startsWith('front');
    const left = key.endsWith('Left');
    const side = left ? -1 : 1;
    const label = `${front ? 'Front' : 'Hind'}${left ? 'Left' : 'Right'}`;
    const hip = new THREE.Group();
    const knee = new THREE.Group();
    const hock = new THREE.Group();
    hip.name = `Fox${label}LegPivot`;
    knee.name = `Fox${label}Knee`;
    hock.name = `Fox${label}Hock`;

    const restHip = front ? -0.1 : 0.28;
    const restKnee = front ? 0.16 : -0.5;
    const restHock = front ? -0.06 : 0.24;
    const restPaw = 0;
    hip.rotation.x = restHip;
    knee.rotation.x = restKnee;
    hock.rotation.x = restHock;
    hip.position.set(side * (front ? 0.31 : 0.32), front ? -0.08 : -0.05, front ? -0.13 : 0.1);
    knee.position.y = front ? -0.37 : -0.36;
    hock.position.y = -0.36;

    const upper = makeCapsule(`Fox${label}Leg`, materials.fur, front ? 0.06 : 0.075, front ? 0.27 : 0.25, front ? -0.195 : -0.19);
    const lower = makeCapsule(`Fox${label}LowerLeg`, materials.ink, 0.052, 0.26, -0.185);
    const hockSegment = makeCapsule(`Fox${label}HockSegment`, materials.ink, 0.047, 0.13, -0.1);
    const paw = makeEllipsoid(`Fox${label}Paw`, materials.ink, new THREE.Vector3(0.085, 0.045, 0.13), 7);
    paw.position.set(0, -0.15, -0.06);

    hip.add(upper, knee);
    knee.add(lower, hock);
    hock.add(hockSegment, paw);
    (front ? this.chest : this.pelvis).add(hip);

    return {
      key,
      hip,
      knee,
      hock,
      paw,
      restHipY: hip.position.y,
      restHip,
      restKnee,
      restHock,
      restPaw,
    };
  }

  private plantGroundedPaws(
    gaitPhase: number,
    movementBlend: number,
    runBlend: number,
    airBlend: number,
    groundOffsets: Readonly<Partial<Record<FoxLegKey, number>>> | undefined,
    response: number,
    delta: number,
  ): void {
    const parent = this.root.parent;
    if (parent) parent.getWorldPosition(this.plantFloor);
    else this.plantFloor.set(0, 0, 0);
    this.root.getWorldScale(this.plantScale);
    const scaleY = Math.max(0.001, Math.abs(this.plantScale.y));

    if (airBlend > 0.05) {
      for (const key of FOX_LEG_KEYS) {
        const leg = this.legs[key];
        leg.hip.position.y = damp(leg.hip.position.y, leg.restHipY, response, delta);
      }
      this.root.updateMatrixWorld(true);
      for (const key of FOX_LEG_KEYS) {
        const legFloorY = this.plantFloor.y + finiteOr(groundOffsets?.[key]);
        this.captureRenderedPaw(key, legFloorY, 0, false, this.lastPose.deltaSeconds);
      }
      return;
    }

    for (const key of FOX_LEG_KEYS) {
      const leg = this.legs[key];
      const stride = sampleFoxLegMotion(key, gaitPhase, runBlend);
      const idlePlant = 1 - movementBlend;
      const plantWeight = Math.max(idlePlant, stride.contactWeight * movementBlend) * (1 - airBlend);
      const legFloorY = this.plantFloor.y + finiteOr(groundOffsets?.[key]);
      if (plantWeight < 0.04) {
        leg.hip.position.y = damp(leg.hip.position.y, leg.restHipY, response, delta);
        this.root.updateMatrixWorld(true);
        const pawBottom = this.plantBounds.setFromObject(leg.paw).min.y;
        if (pawBottom < legFloorY + 0.01) {
          leg.hip.position.y += THREE.MathUtils.clamp(
            (legFloorY + 0.01 - pawBottom) / scaleY,
            0,
            0.14,
          );
        }
        this.root.updateMatrixWorld(true);
        this.captureRenderedPaw(key, legFloorY, plantWeight, true, this.lastPose.deltaSeconds);
        continue;
      }

      this.root.updateMatrixWorld(true);
      const pawBottom = this.plantBounds.setFromObject(leg.paw).min.y;
      const worldCorrection = legFloorY + 0.035 - pawBottom;
      const localCorrection = THREE.MathUtils.clamp(worldCorrection / scaleY, -0.34, 0.16);
      const plantedTarget = THREE.MathUtils.clamp(
        leg.hip.position.y + localCorrection * Math.min(1, plantWeight * 1.72),
        leg.restHipY - 0.34,
        leg.restHipY + 0.1,
      );
      if (stride.contact || idlePlant > 0.5) {
        leg.hip.position.y = plantedTarget;
        this.root.updateMatrixWorld(true);
        const settledBottom = this.plantBounds.setFromObject(leg.paw).min.y;
        leg.hip.position.y = THREE.MathUtils.clamp(
          leg.hip.position.y + (legFloorY + 0.035 - settledBottom) / scaleY,
          leg.restHipY - 0.34,
          leg.restHipY + 0.18,
        );
      } else {
        const plantResponse = localCorrection > 0 ? 60 : 38;
        leg.hip.position.y = damp(leg.hip.position.y, plantedTarget, plantResponse, delta);
      }
      this.root.updateMatrixWorld(true);
      this.captureRenderedPaw(key, legFloorY, plantWeight, true, this.lastPose.deltaSeconds);
    }
  }

  private captureRenderedPaw(
    key: FoxLegKey,
    floorY: number,
    plantWeight: number,
    allowContact: boolean,
    deltaSeconds: number,
  ): void {
    const state = this.renderedPaws[key];
    const paw = this.legs[key].paw;
    const pawBottom = this.plantBounds.setFromObject(paw).min.y;
    paw.getWorldPosition(state.position);
    state.position.y = pawBottom;
    const clearance = pawBottom - floorY;
    state.downwardImpact = Number.isFinite(state.previousClearance) && deltaSeconds > 0
      ? Math.max(0, (state.previousClearance - clearance) / deltaSeconds)
      : 0;
    state.previousClearance = clearance;
    state.clearance = clearance;
    state.plantWeight = THREE.MathUtils.clamp(plantWeight, 0, 1);

    if (!allowContact) {
      state.contact = false;
      return;
    }
    if (state.contact) {
      if (clearance >= PAW_CONTACT_EXIT_CLEARANCE || state.plantWeight <= PAW_CONTACT_EXIT_WEIGHT) {
        state.contact = false;
      }
    } else if (
      clearance <= PAW_CONTACT_ENTER_CLEARANCE
      && state.plantWeight >= PAW_CONTACT_ENTER_WEIGHT
    ) {
      state.contact = true;
    }
  }

  private buildTail(materials: RigMaterials): void {
    const lengths = [0.42, 0.39, 0.36, 0.33, 0.29, 0.21] as const;
    const pitches = [0.22, -0.08, -0.09, -0.07, 0.015, 0.05] as const;
    const radii = [0.25, 0.275, 0.265, 0.235, 0.2, 0.16, 0.09] as const;
    let parent: THREE.Object3D = this.pelvis;

    lengths.forEach((length, index) => {
      const pivot = new THREE.Group();
      pivot.name = `FoxTailJoint${index + 1}`;
      if (index === 0) pivot.position.set(0, 0.02, 0.35);
      else pivot.position.z = lengths[index - 1] ?? 0;
      const restPitch = pitches[index] ?? 0;
      pivot.rotation.x = restPitch;
      const material = index >= lengths.length - 2 ? materials.cream : materials.fur;
      const baseRadius = radii[index] ?? 0.1;
      const tipRadius = radii[index + 1] ?? baseRadius * 0.7;
      const segment = shadows(new THREE.Mesh(
        new THREE.CylinderGeometry(tipRadius, baseRadius, length * 1.08, 8, 1),
        material,
      ));
      segment.name = `FoxTailSegment${index + 1}`;
      segment.position.z = length * 0.5;
      segment.rotation.x = Math.PI * 0.5;
      segment.scale.z = 0.9;
      pivot.add(segment);
      parent.add(pivot);
      this.tail.push({ pivot, restPitch, yawVelocity: 0, pitchVelocity: 0 });
      parent = pivot;
    });

    const tip = makeEllipsoid('FoxTailTip', materials.cream, new THREE.Vector3(0.09, 0.08, 0.16), 7);
    tip.position.z = (lengths.at(-1) ?? 0.25) + 0.035;
    parent.add(tip);
  }

  private animateEars(
    elapsed: number,
    movementBlend: number,
    airPose: FoxAirPose,
    airBlend: number,
    turnLean: number,
    accelerationLean: number,
    motionScale: number,
    spring: number,
    damping: number,
    delta: number,
  ): void {
    if (delta <= 0) return;
    // A deterministic, rare ear-flick window replaces constant twitching and
    // gives local and remote rigs the same small moments of awareness.
    const flickWave = Math.sin(elapsed * 0.47 + 1.9);
    const flick = THREE.MathUtils.smoothstep(flickWave, 0.955, 1) * (1 - movementBlend);
    const airFold = airPose === 'glide'
      ? 0.16
      : airPose === 'rise'
        ? -0.065
        : airPose === 'fall'
          ? 0.045
          : 0;
    for (const ear of this.ears) {
      const targetPitch = ear.restPitch + (
        -accelerationLean * 1.4
        + airFold * airBlend
        + flick * 0.075 * (ear.side < 0 ? 1 : 0.38)
      ) * motionScale;
      const targetRoll = ear.restRoll + (
        ear.side * turnLean * 0.72
        + ear.side * flick * 0.045
      ) * motionScale;
      const pitchError = Math.atan2(
        Math.sin(targetPitch - ear.pivot.rotation.x),
        Math.cos(targetPitch - ear.pivot.rotation.x),
      );
      const rollError = Math.atan2(
        Math.sin(targetRoll - ear.pivot.rotation.z),
        Math.cos(targetRoll - ear.pivot.rotation.z),
      );
      ear.pitchVelocity += (pitchError * spring - ear.pitchVelocity * damping) * delta;
      ear.rollVelocity += (rollError * spring - ear.rollVelocity * damping) * delta;
      ear.pivot.rotation.x += ear.pitchVelocity * delta;
      ear.pivot.rotation.z += ear.rollVelocity * delta;
    }
  }

  private animateTail(
    elapsed: number,
    gaitPhase: number,
    movementBlend: number,
    runBlend: number,
    airPose: FoxAirPose,
    airBlend: number,
    turnLean: number,
    motionScale: number,
    spring: number,
    damping: number,
    delta: number,
  ): void {
    const airPitch = airPose === 'glide'
      ? -0.15
      : airPose === 'rise'
        ? 0.18
        : airPose === 'fall'
          ? -0.1
          : 0;
    this.tail.forEach((joint, index) => {
      const follow = index * 0.38;
      const idleYaw = Math.sin(elapsed * 1.15 - follow) * 0.045 * (1 - movementBlend);
      const gaitYaw = Math.sin(gaitPhase - follow) * (0.045 + runBlend * 0.035) * movementBlend;
      const counterTurn = -turnLean * (0.72 - index * 0.075);
      const targetYaw = (idleYaw + gaitYaw + counterTurn) * motionScale;
      const runPitch = Math.cos(gaitPhase - follow * 0.45) * runBlend * movementBlend * 0.06;
      const targetPitch = joint.restPitch + (runPitch + airPitch * airBlend * (1 - index * 0.08)) * motionScale;
      if (delta <= 0) return;
      const jointSpring = spring * (1 - index * 0.065);
      const jointDamping = damping * (1 - index * 0.025);
      const yawError = Math.atan2(
        Math.sin(targetYaw - joint.pivot.rotation.y),
        Math.cos(targetYaw - joint.pivot.rotation.y),
      );
      const pitchError = Math.atan2(
        Math.sin(targetPitch - joint.pivot.rotation.x),
        Math.cos(targetPitch - joint.pivot.rotation.x),
      );
      joint.yawVelocity += (yawError * jointSpring - joint.yawVelocity * jointDamping) * delta;
      joint.pitchVelocity += (pitchError * jointSpring - joint.pitchVelocity * jointDamping) * delta;
      joint.pivot.rotation.y += joint.yawVelocity * delta;
      joint.pivot.rotation.x += joint.pitchVelocity * delta;
    });
  }
}
