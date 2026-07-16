/**
 * Every player-movement constant lives here so the debug movement lab and the
 * shipped controller always tune the same values. Values are expressed in
 * seconds, metres, radians, or normalized 0..1 amounts unless noted.
 */
export interface MovementTuning {
  readonly simulation: {
    fixedStepSeconds: number;
    maxSubSteps: number;
    maxFrameDeltaSeconds: number;
  };
  /** Global live multipliers over each species' authored motion profile. */
  readonly physics: {
    walkSpeedScale: number;
    sprintSpeedScale: number;
    gravityScale: number;
    jumpImpulseScale: number;
    doubleJumpImpulseScale: number;
    glideGravityScale: number;
    glideTerminalSpeedScale: number;
  };
  readonly input: {
    deadzone: number;
    gamepadDeadzone: number;
    gamepadSprintThreshold: number;
    gamepadTriggerThreshold: number;
    coyoteSeconds: number;
    jumpBufferSeconds: number;
    jumpReleaseCut: number;
  };
  readonly ground: {
    walkAccelerationResponse: number;
    runAccelerationResponse: number;
    brakingResponse: number;
    coastResponse: number;
    walkTurnResponse: number;
    runTurnResponse: number;
    facingSpring: number;
    facingDamping: number;
    lowSpeedFacingSnap: number;
    skidMinSpeedRatio: number;
    skidTurnRadians: number;
    skidSeconds: number;
    skidBrake: number;
    groundSnapHeight: number;
    /** Maximum planar integration segment before collision resolution runs. */
    collisionSweepStep: number;
    uphillSpeedLoss: number;
    downhillSpeedGain: number;
  };
  readonly jump: {
    anticipationSeconds: number;
    riseGravityScale: number;
    fallGravityScale: number;
    apexGravityScale: number;
    apexVelocity: number;
    apexAirControlScale: number;
    airAccelerationRatio: number;
    airTurnResponse: number;
    doubleControlBurst: number;
    doublePoseSeconds: number;
    softLandingSpeed: number;
    heavyLandingSpeed: number;
    softRecoverySeconds: number;
    heavyRecoverySeconds: number;
    terminalSpeed: number;
  };
  readonly glide: {
    entrySeconds: number;
    entryVelocity: number;
    speedScale: number;
    turnResponse: number;
    bankRadians: number;
    pitchRadians: number;
  };
  readonly animation: {
    movementBlendResponse: number;
    runBlendResponse: number;
    gaitWalkRadiansPerMetre: number;
    gaitRunRadiansPerMetre: number;
    turnLeanRadians: number;
    accelerationLeanScale: number;
    appendageSpring: number;
    appendageDamping: number;
  };
  readonly camera: {
    runFovDegrees: number;
    glideFovDegrees: number;
    runLookAhead: number;
    glideLookAhead: number;
    runBoomExtension: number;
    glideBoomExtension: number;
    heavyLandDip: number;
    recenterDelaySeconds: number;
    recenterResponse: number;
    movementThreshold: number;
    landingDipResponse: number;
    focusResponse: number;
    glideFocusResponse: number;
    reducedMotionFocusResponse: number;
    collisionDistanceResponse: number;
    distanceRecoveryResponse: number;
    positionResponse: number;
    glidePositionResponse: number;
    reducedMotionPositionResponse: number;
    collisionPositionResponse: number;
    boomExtendResponse: number;
    boomRetractResponse: number;
    lookAheadExtendResponse: number;
    lookAheadRetractResponse: number;
    rollResponse: number;
    fovResponse: number;
  };
  readonly vfx: {
    runDustMinSpeedRatio: number;
    runDustCount: number;
    skidDustCount: number;
    jumpRingScale: number;
    doubleRingScale: number;
    landRingScale: number;
    glideRibbonOpacity: number;
  };
}

export const DEFAULT_MOVEMENT_TUNING: Readonly<MovementTuning> = Object.freeze({
  simulation: {
    fixedStepSeconds: 1 / 60,
    maxSubSteps: 5,
    maxFrameDeltaSeconds: 0.083,
  },
  physics: {
    walkSpeedScale: 1,
    sprintSpeedScale: 1,
    gravityScale: 1,
    jumpImpulseScale: 1,
    doubleJumpImpulseScale: 1,
    glideGravityScale: 1,
    glideTerminalSpeedScale: 1,
  },
  input: {
    deadzone: 0.04,
    gamepadDeadzone: 0.14,
    gamepadSprintThreshold: 0.82,
    gamepadTriggerThreshold: 0.45,
    coyoteSeconds: 0.11,
    jumpBufferSeconds: 0.12,
    jumpReleaseCut: 0.42,
  },
  ground: {
    walkAccelerationResponse: 12.8,
    runAccelerationResponse: 10.8,
    brakingResponse: 18,
    coastResponse: 15.5,
    walkTurnResponse: 11.5,
    runTurnResponse: 7.2,
    facingSpring: 76,
    facingDamping: 13.2,
    lowSpeedFacingSnap: 0.3,
    skidMinSpeedRatio: 0.62,
    skidTurnRadians: 2.15,
    skidSeconds: 0.15,
    skidBrake: 0.92,
    groundSnapHeight: 0.32,
    collisionSweepStep: 0.04,
    uphillSpeedLoss: 0.11,
    downhillSpeedGain: 0.075,
  },
  jump: {
    anticipationSeconds: 0.05,
    riseGravityScale: 1,
    fallGravityScale: 1.92,
    apexGravityScale: 0.58,
    apexVelocity: 1.15,
    apexAirControlScale: 1.12,
    airAccelerationRatio: 0.76,
    airTurnResponse: 4.4,
    doubleControlBurst: 0.26,
    doublePoseSeconds: 0.44,
    softLandingSpeed: 5.5,
    heavyLandingSpeed: 12.2,
    softRecoverySeconds: 0.045,
    heavyRecoverySeconds: 0.08,
    terminalSpeed: -20,
  },
  glide: {
    entrySeconds: 0.12,
    entryVelocity: 0.65,
    speedScale: 1.08,
    turnResponse: 3.25,
    bankRadians: 0.23,
    pitchRadians: 0.12,
  },
  animation: {
    movementBlendResponse: 9,
    runBlendResponse: 6.2,
    gaitWalkRadiansPerMetre: 1.82,
    gaitRunRadiansPerMetre: 2.08,
    turnLeanRadians: 0.12,
    accelerationLeanScale: 0.0065,
    appendageSpring: 72,
    appendageDamping: 12.5,
  },
  camera: {
    runFovDegrees: 4,
    glideFovDegrees: 7,
    runLookAhead: 0.55,
    glideLookAhead: 1.15,
    runBoomExtension: 0.7,
    glideBoomExtension: 1.35,
    heavyLandDip: 0.17,
    recenterDelaySeconds: 1.1,
    recenterResponse: 1.65,
    movementThreshold: 0.08,
    landingDipResponse: 9.5,
    focusResponse: 11,
    glideFocusResponse: 6.5,
    reducedMotionFocusResponse: 18,
    collisionDistanceResponse: 24,
    distanceRecoveryResponse: 5.5,
    positionResponse: 8.5,
    glidePositionResponse: 5.2,
    reducedMotionPositionResponse: 16,
    collisionPositionResponse: 20,
    boomExtendResponse: 3.2,
    boomRetractResponse: 4.6,
    lookAheadExtendResponse: 5.2,
    lookAheadRetractResponse: 6.5,
    rollResponse: 7,
    fovResponse: 5.5,
  },
  vfx: {
    runDustMinSpeedRatio: 0.6,
    runDustCount: 2,
    skidDustCount: 7,
    jumpRingScale: 0.72,
    doubleRingScale: 1.25,
    landRingScale: 0.9,
    glideRibbonOpacity: 0.42,
  },
});

export type MovementTuningSection = keyof MovementTuning;
export type MovementTuningPath = `${MovementTuningSection}.${string}`;

export interface MovementTuningValueBounds {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly integer?: boolean;
}

export type MovementTuningBounds = {
  readonly [Section in MovementTuningSection]: {
    readonly [Key in keyof MovementTuning[Section]]: MovementTuningValueBounds;
  };
};

function bounds(
  min: number,
  max: number,
  step: number,
  integer = false,
): MovementTuningValueBounds {
  return Object.freeze({ min, max, step, ...(integer ? { integer: true } : {}) });
}

/**
 * Canonical safety and UI ranges for every live movement value. Keeping this
 * exhaustive makes adding an unbounded runtime constant a type error.
 */
export const MOVEMENT_TUNING_BOUNDS = Object.freeze({
  simulation: Object.freeze({
    fixedStepSeconds: bounds(1 / 120, 1 / 30, 0.00001),
    maxSubSteps: bounds(1, 16, 1, true),
    maxFrameDeltaSeconds: bounds(0.02, 0.25, 0.001),
  }),
  physics: Object.freeze({
    walkSpeedScale: bounds(0.35, 2, 0.001),
    sprintSpeedScale: bounds(0.35, 2, 0.001),
    gravityScale: bounds(0.25, 2.5, 0.001),
    jumpImpulseScale: bounds(0.25, 2.5, 0.001),
    doubleJumpImpulseScale: bounds(0.25, 2.5, 0.001),
    glideGravityScale: bounds(0.15, 3, 0.001),
    glideTerminalSpeedScale: bounds(0.2, 2.5, 0.001),
  }),
  input: Object.freeze({
    deadzone: bounds(0, 0.3, 0.001),
    gamepadDeadzone: bounds(0, 0.3, 0.001),
    gamepadSprintThreshold: bounds(0, 1, 0.001),
    gamepadTriggerThreshold: bounds(0, 1, 0.001),
    coyoteSeconds: bounds(0, 0.6, 0.001),
    jumpBufferSeconds: bounds(0, 0.6, 0.001),
    jumpReleaseCut: bounds(0, 2, 0.001),
  }),
  ground: Object.freeze({
    walkAccelerationResponse: bounds(0, 100, 0.1),
    runAccelerationResponse: bounds(0, 100, 0.1),
    brakingResponse: bounds(0, 100, 0.1),
    coastResponse: bounds(0, 100, 0.1),
    walkTurnResponse: bounds(0.01, 100, 0.1),
    runTurnResponse: bounds(0, 100, 0.1),
    facingSpring: bounds(0, 180, 0.1),
    facingDamping: bounds(0, 100, 0.1),
    lowSpeedFacingSnap: bounds(0, 2, 0.001),
    skidMinSpeedRatio: bounds(0, 2, 0.001),
    skidTurnRadians: bounds(0, Math.PI, 0.01),
    skidSeconds: bounds(0, 0.6, 0.001),
    skidBrake: bounds(0, 2, 0.001),
    groundSnapHeight: bounds(0, 3, 0.01),
    collisionSweepStep: bounds(0.005, 0.2, 0.001),
    uphillSpeedLoss: bounds(0, 2, 0.001),
    downhillSpeedGain: bounds(0, 2, 0.001),
  }),
  jump: Object.freeze({
    anticipationSeconds: bounds(0.001, 0.6, 0.001),
    riseGravityScale: bounds(0, 4, 0.001),
    fallGravityScale: bounds(0, 4, 0.001),
    apexGravityScale: bounds(0, 4, 0.001),
    apexVelocity: bounds(0, 12, 0.001),
    apexAirControlScale: bounds(0, 3, 0.001),
    airAccelerationRatio: bounds(0, 2, 0.001),
    airTurnResponse: bounds(0, 100, 0.1),
    doubleControlBurst: bounds(0, 2, 0.001),
    doublePoseSeconds: bounds(0, 2, 0.001),
    softLandingSpeed: bounds(0, 30, 0.001),
    heavyLandingSpeed: bounds(0, 30, 0.001),
    softRecoverySeconds: bounds(0, 0.6, 0.001),
    heavyRecoverySeconds: bounds(0, 0.6, 0.001),
    terminalSpeed: bounds(-35, -1, 0.1),
  }),
  glide: Object.freeze({
    entrySeconds: bounds(0, 0.6, 0.001),
    entryVelocity: bounds(0, 12, 0.001),
    speedScale: bounds(0, 2, 0.001),
    turnResponse: bounds(0, 100, 0.1),
    bankRadians: bounds(0, Math.PI, 0.01),
    pitchRadians: bounds(0, Math.PI, 0.01),
  }),
  animation: Object.freeze({
    movementBlendResponse: bounds(0, 100, 0.1),
    runBlendResponse: bounds(0, 100, 0.1),
    gaitWalkRadiansPerMetre: bounds(0, Math.PI * 4, 0.01),
    gaitRunRadiansPerMetre: bounds(0, Math.PI * 4, 0.01),
    turnLeanRadians: bounds(0, Math.PI, 0.01),
    accelerationLeanScale: bounds(0, 2, 0.001),
    appendageSpring: bounds(0, 180, 0.1),
    appendageDamping: bounds(0, 100, 0.1),
  }),
  camera: Object.freeze({
    runFovDegrees: bounds(0, 14, 0.1),
    glideFovDegrees: bounds(0, 14, 0.1),
    runLookAhead: bounds(0, 3, 0.01),
    glideLookAhead: bounds(0, 3, 0.01),
    runBoomExtension: bounds(0, 3, 0.01),
    glideBoomExtension: bounds(0, 4.5, 0.01),
    heavyLandDip: bounds(0, 3, 0.01),
    recenterDelaySeconds: bounds(0, 5, 0.001),
    recenterResponse: bounds(0.1, 60, 0.1),
    movementThreshold: bounds(0, 1, 0.001),
    landingDipResponse: bounds(0.1, 60, 0.1),
    focusResponse: bounds(0.1, 60, 0.1),
    glideFocusResponse: bounds(0.1, 60, 0.1),
    reducedMotionFocusResponse: bounds(0.1, 60, 0.1),
    collisionDistanceResponse: bounds(0.1, 60, 0.1),
    distanceRecoveryResponse: bounds(0.1, 60, 0.1),
    positionResponse: bounds(0.1, 60, 0.1),
    glidePositionResponse: bounds(0.1, 60, 0.1),
    reducedMotionPositionResponse: bounds(0.1, 60, 0.1),
    collisionPositionResponse: bounds(0.1, 60, 0.1),
    boomExtendResponse: bounds(0.1, 60, 0.1),
    boomRetractResponse: bounds(0.1, 60, 0.1),
    lookAheadExtendResponse: bounds(0.1, 60, 0.1),
    lookAheadRetractResponse: bounds(0.1, 60, 0.1),
    rollResponse: bounds(0.1, 60, 0.1),
    fovResponse: bounds(0.1, 60, 0.1),
  }),
  vfx: Object.freeze({
    runDustMinSpeedRatio: bounds(0, 2, 0.001),
    runDustCount: bounds(1, 16, 1, true),
    skidDustCount: bounds(1, 16, 1, true),
    jumpRingScale: bounds(0, 3, 0.001),
    doubleRingScale: bounds(0, 3, 0.001),
    landRingScale: bounds(0, 3, 0.001),
    glideRibbonOpacity: bounds(0, 2, 0.001),
  }),
}) satisfies MovementTuningBounds;

export function getMovementTuningBounds(
  path: MovementTuningPath,
): MovementTuningValueBounds | undefined {
  const [section, key] = path.split('.', 2);
  if (!section || !key || !(section in MOVEMENT_TUNING_BOUNDS)) return undefined;
  const sectionBounds = MOVEMENT_TUNING_BOUNDS[
    section as MovementTuningSection
  ] as unknown as Record<string, MovementTuningValueBounds>;
  return sectionBounds[key];
}

const STORAGE_KEY = 'tickerworld:movement-tuning-v1';

export function cloneMovementTuning(
  source: Readonly<MovementTuning> = DEFAULT_MOVEMENT_TUNING,
): MovementTuning {
  return structuredClone(source) as MovementTuning;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function clampMovementTuningValue(
  path: MovementTuningPath,
  value: number,
): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const range = getMovementTuningBounds(path);
  if (!range) return undefined;
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return range.integer
    ? Math.min(range.max, Math.max(range.min, Math.round(clamped)))
    : clamped;
}

function sanitizedMovementTuning(source: unknown): MovementTuning {
  const tuning = cloneMovementTuning();
  const record = source && typeof source === 'object'
    ? source as Record<string, unknown>
    : {};
  for (const [section, defaults] of Object.entries(DEFAULT_MOVEMENT_TUNING)) {
    const target = tuning[section as MovementTuningSection] as unknown as Record<string, number>;
    const rawSection = record[section];
    const saved = rawSection && typeof rawSection === 'object'
      ? rawSection as Record<string, unknown>
      : {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const candidate = saved[key];
      const path = `${section}.${key}` as MovementTuningPath;
      target[key] = clampMovementTuningValue(
        path,
        typeof candidate === 'number' ? candidate : fallback,
      ) ?? fallback;
    }
  }
  return tuning;
}

/** Debug-only persisted overrides are ignored unless the caller opts in. */
export function loadMovementTuning(includeStoredOverrides = false): MovementTuning {
  const tuning = cloneMovementTuning();
  if (!includeStoredOverrides) return tuning;
  try {
    const raw = safeStorage()?.getItem(STORAGE_KEY);
    if (!raw) return tuning;
    return sanitizedMovementTuning(JSON.parse(raw));
  } catch {
    return cloneMovementTuning();
  }
}

export function persistMovementTuning(tuning: Readonly<MovementTuning>): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(sanitizedMovementTuning(tuning)));
  } catch {
    // Debug tuning is deliberately optional.
  }
}

export function clearPersistedMovementTuning(): void {
  try {
    safeStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Debug tuning is deliberately optional.
  }
}

export function setMovementTuningValue(
  tuning: MovementTuning,
  path: MovementTuningPath,
  value: number,
): boolean {
  const clamped = clampMovementTuningValue(path, value);
  if (clamped === undefined) return false;
  const [section, key] = path.split('.', 2);
  if (!section || !key || !(section in tuning)) return false;
  const record = tuning[section as MovementTuningSection] as unknown as Record<string, number>;
  if (!(key in record)) return false;
  record[key] = clamped;
  return true;
}

export function movementTuningCode(tuning: Readonly<MovementTuning>): string {
  return `export const MOVEMENT_TUNING = ${JSON.stringify(tuning, null, 2)} as const;`;
}
