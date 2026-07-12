export type QualityTier = 'high' | 'low';

export interface QualityEnvironment {
  readonly coarsePointer: boolean;
  readonly devicePixelRatio: number;
  readonly viewportWidth: number;
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
}

export interface QualityProfile {
  readonly tier: QualityTier;
  readonly antialias: boolean;
  readonly powerPreference: WebGLPowerPreference;
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly activeChunkRadius: number;
  readonly chunkSegments: number;
  readonly fireworkCapacity: number;
}

export function parseStoredQualityTier(value: string | null): QualityTier | null {
  if (value === 'high' || value === 'low') return value;
  if (value === null || value.trim() === '') return null;
  const legacyPixelRatio = Number(value);
  if (!Number.isFinite(legacyPixelRatio) || legacyPixelRatio <= 0) return null;
  return legacyPixelRatio < 1.05 ? 'low' : 'high';
}

export function chooseQualityTier(
  environment: QualityEnvironment,
  stored: QualityTier | null = null,
): QualityTier {
  if (stored) return stored;
  const limitedMemory = environment.deviceMemory !== undefined && environment.deviceMemory <= 4;
  const limitedCpu = environment.hardwareConcurrency !== undefined
    && environment.hardwareConcurrency <= 4;
  const phoneSized = environment.coarsePointer && environment.viewportWidth <= 900;
  return limitedMemory || limitedCpu || phoneSized ? 'low' : 'high';
}

export function qualityProfile(
  tier: QualityTier,
  devicePixelRatio: number,
): QualityProfile {
  const finiteDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  if (tier === 'low') {
    return {
      tier,
      antialias: false,
      powerPreference: 'low-power',
      pixelRatio: Math.min(finiteDpr, 0.9),
      shadows: false,
      activeChunkRadius: 1,
      chunkSegments: 14,
      fireworkCapacity: 80,
    };
  }
  return {
    tier,
    antialias: true,
    powerPreference: 'high-performance',
    pixelRatio: Math.min(finiteDpr, 2),
    shadows: true,
    activeChunkRadius: 2,
    chunkSegments: 24,
    fireworkCapacity: 160,
  };
}
