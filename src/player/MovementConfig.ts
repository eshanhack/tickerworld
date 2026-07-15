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
  readonly input: {
    deadzone: number;
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
  input: {
    deadzone: 0.04,
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

/** Debug-only persisted overrides are ignored unless the caller opts in. */
export function loadMovementTuning(includeStoredOverrides = false): MovementTuning {
  const tuning = cloneMovementTuning();
  if (!includeStoredOverrides) return tuning;
  try {
    const raw = safeStorage()?.getItem(STORAGE_KEY);
    if (!raw) return tuning;
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const [section, defaults] of Object.entries(DEFAULT_MOVEMENT_TUNING)) {
      const target = tuning[section as MovementTuningSection] as unknown as Record<string, number>;
      const saved = parsed[section];
      for (const [key, fallback] of Object.entries(defaults)) {
        const candidate = saved?.[key];
        target[key] = typeof candidate === 'number' && Number.isFinite(candidate)
          ? candidate
          : fallback;
      }
    }
  } catch {
    return cloneMovementTuning();
  }
  return tuning;
}

export function persistMovementTuning(tuning: Readonly<MovementTuning>): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(tuning));
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
  if (!Number.isFinite(value)) return false;
  const [section, key] = path.split('.', 2);
  if (!section || !key || !(section in tuning)) return false;
  const record = tuning[section as MovementTuningSection] as unknown as Record<string, number>;
  if (!(key in record)) return false;
  record[key] = value;
  return true;
}

export function movementTuningCode(tuning: Readonly<MovementTuning>): string {
  return `export const MOVEMENT_TUNING = ${JSON.stringify(tuning, null, 2)} as const;`;
}
