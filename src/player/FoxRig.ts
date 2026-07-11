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
  private readonly materials: RigMaterials;
  private readonly appearanceRoots: THREE.Group[] = [];
  private readonly plantBounds = new THREE.Box3();
  private readonly plantFloor = new THREE.Vector3();
  private readonly plantScale = new THREE.Vector3();
  private lastPose: Required<Omit<
    FoxRigPoseInput,
    'turnLean' | 'accelerationLean' | 'groundPitch' | 'groundRoll' | 'pawGroundOffsets' | 'reducedMotion'
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
    if (appearance.animal !== 'fox' || appearance.premium) {
      this.buildAppearanceAttachments(appearance);
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

    this.animateTail(elapsed, gaitPhase, movementBlend, runBlend, airPose, airBlend, turnLean, motionScale, poseDelta);
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
    const earsVisible = animal === 'fox' || animal === 'cat';
    const tailVisible = animal === 'fox' || animal === 'cat' || animal === 'axolotl';
    const muzzleVisible = animal === 'fox' || animal === 'bear' || animal === 'rabbit' || animal === 'cat';
    const leftEar = this.root.getObjectByName('FoxEarLeft');
    const rightEar = this.root.getObjectByName('FoxEarRight');
    const tailRoot = this.root.getObjectByName('FoxTailJoint1');
    const muzzle = this.root.getObjectByName('FoxMuzzle');
    const nose = this.root.getObjectByName('FoxNose');
    if (leftEar) leftEar.visible = earsVisible;
    if (rightEar) rightEar.visible = earsVisible;
    if (tailRoot) tailRoot.visible = tailVisible;
    if (muzzle) muzzle.visible = muzzleVisible;
    if (nose) nose.visible = muzzleVisible;
  }

  private buildAppearanceAttachments(appearance: AnimalAppearanceProfile): void {
    const materials = this.createAppearanceMaterials();
    const head = this.createAppearanceRoot('Head');
    const body = this.createAppearanceRoot('Body');
    const rump = this.createAppearanceRoot('Rump');
    this.head.add(head);
    this.chest.add(body);
    this.pelvis.add(rump);
    this.appearanceRoots.push(head, body, rump);

    switch (appearance.animal) {
      case 'fox':
        break;
      case 'penguin':
        this.addPenguinFeatures(head, body, materials);
        break;
      case 'frog':
        this.addFrogFeatures(head, materials);
        break;
      case 'duck':
        this.addDuckFeatures(head, body, materials);
        break;
      case 'bear':
        this.addBearFeatures(head, rump, materials);
        break;
      case 'rabbit':
        this.addRabbitFeatures(head, rump, materials);
        break;
      case 'cat':
        this.addCatFeatures(head, materials);
        break;
      case 'axolotl':
        this.addAxolotlFeatures(head, rump, materials);
        break;
    }

    if (appearance.premium) this.addPremiumCrest(head, materials);
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

  private addPenguinFeatures(
    head: THREE.Group,
    body: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    const cap = makeEllipsoid('PenguinHeadCap', materials.dark, new THREE.Vector3(0.255, 0.19, 0.3), 9);
    cap.position.set(0, 0.04, 0.025);
    head.add(cap);
    const beak = makeEllipsoid('PenguinBeak', materials.accent, new THREE.Vector3(0.13, 0.055, 0.2), 7);
    beak.position.set(0, -0.035, -0.5);
    head.add(beak);
    for (const side of [-1, 1] as const) {
      const flipper = makeEllipsoid(
        side < 0 ? 'PenguinFlipperLeft' : 'PenguinFlipperRight',
        materials.dark,
        new THREE.Vector3(0.08, 0.31, 0.2),
        8,
      );
      flipper.position.set(side * 0.36, -0.01, -0.02);
      flipper.rotation.z = side * -0.42;
      body.add(flipper);
    }
  }

  private addFrogFeatures(head: THREE.Group, materials: AppearanceMaterials): void {
    for (const side of [-1, 1] as const) {
      const eyeBulb = makeEllipsoid(
        side < 0 ? 'FrogEyeBulbLeft' : 'FrogEyeBulbRight',
        materials.secondary,
        new THREE.Vector3(0.115, 0.115, 0.105),
        8,
      );
      eyeBulb.position.set(side * 0.17, 0.19, -0.15);
      const pupil = makeEllipsoid(
        side < 0 ? 'FrogPupilLeft' : 'FrogPupilRight',
        materials.dark,
        new THREE.Vector3(0.045, 0.055, 0.028),
        7,
      );
      pupil.position.set(side * 0.17, 0.2, -0.245);
      head.add(eyeBulb, pupil);
    }
  }

  private addDuckFeatures(
    head: THREE.Group,
    body: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    const bill = makeEllipsoid('DuckBill', materials.accent, new THREE.Vector3(0.2, 0.055, 0.23), 7);
    bill.position.set(0, -0.05, -0.5);
    head.add(bill);
    for (const side of [-1, 1] as const) {
      const wing = makeEllipsoid(
        side < 0 ? 'DuckWingLeft' : 'DuckWingRight',
        materials.highlight,
        new THREE.Vector3(0.075, 0.25, 0.31),
        8,
      );
      wing.position.set(side * 0.36, -0.02, 0.02);
      wing.rotation.z = side * -0.22;
      body.add(wing);
    }
  }

  private addBearFeatures(
    head: THREE.Group,
    body: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    for (const side of [-1, 1] as const) {
      const ear = makeEllipsoid(
        side < 0 ? 'BearEarLeft' : 'BearEarRight',
        materials.primary,
        new THREE.Vector3(0.13, 0.13, 0.085),
        8,
      );
      ear.position.set(side * 0.19, 0.18, -0.015);
      head.add(ear);
    }
    const tail = makeEllipsoid('BearTail', materials.secondary, new THREE.Vector3(0.14, 0.14, 0.14), 8);
    tail.position.set(0, 0.04, 0.47);
    body.add(tail);
  }

  private addRabbitFeatures(
    head: THREE.Group,
    body: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    for (const side of [-1, 1] as const) {
      const ear = makeEllipsoid(
        side < 0 ? 'RabbitEarLeft' : 'RabbitEarRight',
        materials.primary,
        new THREE.Vector3(0.105, 0.34, 0.08),
        8,
      );
      ear.position.set(side * 0.13, 0.38, 0.02);
      ear.rotation.z = side * -0.08;
      const inner = makeEllipsoid(
        side < 0 ? 'RabbitInnerEarLeft' : 'RabbitInnerEarRight',
        materials.accent,
        new THREE.Vector3(0.045, 0.24, 0.035),
        7,
      );
      inner.position.set(side * 0.13, 0.38, -0.075);
      inner.rotation.z = side * -0.08;
      head.add(ear, inner);
    }
    const tail = makeEllipsoid('RabbitTail', materials.secondary, new THREE.Vector3(0.17, 0.17, 0.17), 8);
    tail.position.set(0, 0.02, 0.5);
    body.add(tail);
  }

  private addCatFeatures(head: THREE.Group, materials: AppearanceMaterials): void {
    for (const side of [-1, 1] as const) {
      for (let index = -1; index <= 1; index += 1) {
        const whisker = shadows(new THREE.Mesh(
          new THREE.CylinderGeometry(0.006, 0.006, 0.3, 5),
          materials.dark,
        ));
        whisker.name = `${side < 0 ? 'CatWhiskerLeft' : 'CatWhiskerRight'}${index + 2}`;
        whisker.position.set(side * 0.24, -0.05 + index * 0.045, -0.46);
        whisker.rotation.z = Math.PI * 0.5;
        whisker.rotation.x = index * 0.12;
        head.add(whisker);
      }
    }
  }

  private addAxolotlFeatures(
    head: THREE.Group,
    body: THREE.Group,
    materials: AppearanceMaterials,
  ): void {
    for (const side of [-1, 1] as const) {
      for (let index = -1; index <= 1; index += 1) {
        const gill = makeCapsule(
          `${side < 0 ? 'AxolotlGillLeft' : 'AxolotlGillRight'}${index + 2}`,
          materials.accent,
          0.035,
          0.16,
          0,
        );
        gill.position.set(side * (0.28 + Math.abs(index) * 0.025), 0.06 + index * 0.105, -0.02);
        gill.rotation.z = side * (-Math.PI * 0.5 + index * 0.18);
        head.add(gill);
      }
    }
    const fin = makeEllipsoid('AxolotlTailFin', materials.highlight, new THREE.Vector3(0.055, 0.19, 0.3), 8);
    fin.position.set(0, 0.05, 0.45);
    body.add(fin);
  }

  private addPremiumCrest(head: THREE.Group, materials: AppearanceMaterials): void {
    const crest = shadows(new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.18, 5), materials.highlight));
    crest.name = 'PremiumAnimalCrest';
    crest.position.set(0, 0.35, 0.02);
    crest.rotation.z = Math.PI;
    head.add(crest);
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
    geometries.forEach((geometry) => geometry.dispose());
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
      this.tail.push({ pivot, restPitch });
      parent = pivot;
    });

    const tip = makeEllipsoid('FoxTailTip', materials.cream, new THREE.Vector3(0.09, 0.08, 0.16), 7);
    tip.position.z = (lengths.at(-1) ?? 0.25) + 0.035;
    parent.add(tip);
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
      joint.pivot.rotation.y = dampAngle(joint.pivot.rotation.y, targetYaw, 8.4 - index * 0.42, delta);
      joint.pivot.rotation.x = dampAngle(joint.pivot.rotation.x, targetPitch, 8.9 - index * 0.44, delta);
    });
  }
}
