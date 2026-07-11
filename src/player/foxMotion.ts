export const FOX_LEG_KEYS = [
  'frontLeft',
  'frontRight',
  'hindLeft',
  'hindRight',
] as const;

export type FoxLegKey = (typeof FOX_LEG_KEYS)[number];

export type FoxAirPose =
  | 'grounded'
  | 'anticipate'
  | 'rise'
  | 'apex'
  | 'fall'
  | 'double'
  | 'glide'
  | 'land';

export interface FoxLegMotionSample {
  /** Normalized 0..1 phase for the selected leg. */
  readonly phase: number;
  /** Hip rotation offset in radians. Positive reaches toward model-forward (-Z). */
  readonly hip: number;
  /** Knee rotation offset in radians. */
  readonly knee: number;
  /** Hock rotation offset in radians. */
  readonly hock: number;
  /** Paw counter-rotation in radians. */
  readonly paw: number;
  /** Normalized visual clearance of the paw during swing. */
  readonly lift: number;
  /** Soft 0..1 stance weight, suitable for IK or planted-paw blending. */
  readonly contactWeight: number;
  /** True through the stable middle of the stance portion. */
  readonly contact: boolean;
}

export interface FoxAirLegPose {
  readonly hip: number;
  readonly knee: number;
  readonly hock: number;
  readonly paw: number;
}

const TAU = Math.PI * 2;

// A four-beat lateral walk. Each foot gets a discrete landing rather than the
// diagonal two-beat trot used by the original rounded fox.
const WALK_PHASE_OFFSET: Readonly<Record<FoxLegKey, number>> = {
  hindLeft: 0,
  frontLeft: 0.25,
  hindRight: 0.5,
  frontRight: 0.75,
};

// A lightly asymmetric rotary gallop: the hind feet gather and push first,
// followed by the staggered front landing and one suspended stretch.
const RUN_PHASE_OFFSET: Readonly<Record<FoxLegKey, number>> = {
  hindLeft: 0,
  hindRight: 0.09,
  frontRight: 0.38,
  frontLeft: 0.48,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function fract(value: number): number {
  return ((value % 1) + 1) % 1;
}

function smooth01(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

function mix(a: number, b: number, blend: number): number {
  return a + (b - a) * blend;
}

function sampleStride(
  leg: FoxLegKey,
  phase: number,
  run: boolean,
): FoxLegMotionSample {
  const front = leg.startsWith('front');
  // A gallop needs a real suspension interval. Keeping run paws in swing for
  // just over three-fifths of the cycle creates a brief all-paws-airborne
  // stretch between the hind push and front landing.
  const swingFraction = run ? 0.61 : 0.34;
  const reach = run ? (front ? 0.88 : 0.82) : (front ? 0.29 : 0.25);
  let hip: number;
  let lift = 0;
  let contactWeight = 0;

  if (phase < swingFraction) {
    const swing = smooth01(phase / swingFraction);
    hip = mix(-reach, reach, swing);
    lift = Math.sin(swing * Math.PI);
  } else {
    const stance = (phase - swingFraction) / (1 - swingFraction);
    hip = mix(reach, -reach, smooth01(stance));
    const contactRamp = run ? 0.4 : 0.12;
    const enter = smooth01(stance / contactRamp);
    const leave = smooth01((1 - stance) / contactRamp);
    contactWeight = Math.min(enter, leave);
  }

  const flex = lift * (run ? 1 : 0.72);
  const knee = front
    ? flex * (run ? 0.58 : 0.32)
    : -flex * (run ? 0.82 : 0.43);
  const hock = front
    ? -flex * (run ? 0.4 : 0.2)
    : flex * (run ? 0.66 : 0.34);
  const paw = -(hip + knee + hock) * (run ? 0.36 : 0.28);

  return {
    phase,
    hip,
    knee,
    hock,
    paw,
    lift,
    contactWeight,
    contact: contactWeight >= (run ? 0.72 : 0.55),
  };
}

/** Converts the shared radian gait phase into a stable normalized cycle. */
export function normalizeFoxGaitPhase(gaitPhase: number): number {
  return fract((Number.isFinite(gaitPhase) ? gaitPhase : 0) / TAU);
}

/**
 * Samples the same leg curves used by FoxRig. Consumers can use `contact` or
 * `contactWeight` to emit footfalls and plant paws without duplicating phases.
 */
export function sampleFoxLegMotion(
  leg: FoxLegKey,
  gaitPhase: number,
  runBlend: number,
): FoxLegMotionSample {
  const cycle = normalizeFoxGaitPhase(gaitPhase);
  const blend = clamp01(runBlend);
  const walk = sampleStride(leg, fract(cycle + WALK_PHASE_OFFSET[leg]), false);
  const run = sampleStride(leg, fract(cycle + RUN_PHASE_OFFSET[leg]), true);
  const contactWeight = mix(walk.contactWeight, run.contactWeight, blend);

  return {
    phase: mix(walk.phase, run.phase, blend),
    hip: mix(walk.hip, run.hip, blend),
    knee: mix(walk.knee, run.knee, blend),
    hock: mix(walk.hock, run.hock, blend),
    paw: mix(walk.paw, run.paw, blend),
    lift: mix(walk.lift, run.lift, blend),
    contactWeight,
    contact: contactWeight >= mix(0.55, 0.72, blend),
  };
}

export function isFoxLegInContact(
  leg: FoxLegKey,
  gaitPhase: number,
  runBlend: number,
): boolean {
  return sampleFoxLegMotion(leg, gaitPhase, runBlend).contact;
}

/** Reference-style airborne joint offsets, blended over `progress` by FoxRig. */
export function sampleFoxAirLegPose(
  leg: FoxLegKey,
  pose: FoxAirPose,
  progress = 1,
): FoxAirLegPose {
  const front = leg.startsWith('front');
  const amount = clamp01(progress);

  switch (pose) {
    case 'grounded':
      return { hip: 0, knee: 0, hock: 0, paw: 0 };
    case 'anticipate': {
      const crouch = smooth01(amount);
      return front
        ? { hip: -0.08 * crouch, knee: 0.2 * crouch, hock: -0.13 * crouch, paw: 0.04 * crouch }
        : { hip: 0.3 * crouch, knee: -0.54 * crouch, hock: 0.42 * crouch, paw: -0.08 * crouch };
    }
    case 'rise':
      return front
        ? { hip: 0.28, knee: 0.34, hock: -0.27, paw: -0.08 }
        : { hip: -0.46, knee: -0.14, hock: 0.25, paw: 0.12 };
    case 'apex':
      return front
        ? { hip: 0.62, knee: 0.18, hock: -0.18, paw: -0.15 }
        : { hip: -0.36, knee: -0.34, hock: 0.38, paw: 0.1 };
    case 'fall':
      return front
        ? { hip: 0.18, knee: 0.08, hock: -0.08, paw: -0.05 }
        : { hip: 0.1, knee: -0.14, hock: 0.13, paw: -0.02 };
    case 'double': {
      const kick = Math.sin(amount * Math.PI);
      return front
        ? { hip: -0.3 * kick, knee: 0.66 * kick, hock: -0.44 * kick, paw: 0.08 * kick }
        : { hip: 0.4 * kick, knee: -0.74 * kick, hock: 0.6 * kick, paw: -0.14 * kick };
    }
    case 'glide':
      return front
        ? { hip: 0.64, knee: 0.09, hock: -0.14, paw: -0.12 }
        : { hip: -0.5, knee: -0.08, hock: 0.15, paw: 0.1 };
    case 'land': {
      const recover = (1 - amount) ** 2;
      return front
        ? { hip: 0.22 * recover, knee: 0.07 * recover, hock: -0.06 * recover, paw: -0.08 * recover }
        : { hip: 0.32 * recover, knee: -0.44 * recover, hock: 0.36 * recover, paw: -0.08 * recover };
    }
  }
}
