import {
  MAX_SPRINT_SPEED,
  isAllowedWorldXZ,
  isProtocolVersionAccepted,
  maximumHorizontalTravel,
  sampleBoundedTerrainHeight,
  type CorrectionMessage,
  type MoveSnapshot,
} from '@tickerworld/shared';

export interface AuthoritativePosition {
  x: number;
  y: number;
  z: number;
}

export interface MoveTracker {
  lastSequence: number;
  lastAcceptedAt: number;
  lastReceivedAt: number;
  /** Last accepted sample, retained to validate uint32 motion serials. */
  lastMotion?: MoveSnapshot;
}

export type MoveValidation =
  | { accepted: true }
  | { accepted: false; drop: true }
  | { accepted: false; drop: false; correction: CorrectionMessage };

function correction(
  snapshot: MoveSnapshot,
  position: AuthoritativePosition,
  reason: CorrectionMessage['reason'],
  hard: boolean,
): MoveValidation {
  return {
    accepted: false,
    drop: false,
    correction: {
      sequence: snapshot.sequence,
      x: position.x,
      y: position.y,
      z: position.z,
      reason,
      hard,
    },
  };
}

const ACTION_SERIALS = [
  ['anticipationSequence', 'anticipationTick'],
  ['jumpSequence', 'jumpTick'],
  ['doubleJumpSequence', 'doubleJumpTick'],
  ['landSequence', 'landTick'],
  ['skidSequence', 'skidTick'],
  ['stateTransitionSequence', 'stateTransitionTick'],
] as const satisfies readonly (readonly [keyof MoveSnapshot, keyof MoveSnapshot])[];

function uint32Delta(next: number, previous: number): number {
  return (next - previous) >>> 0;
}

/**
 * Rejects counter rewinds and implausible jumps while still accepting the
 * intentional uint32 wrap from 0xffff_ffff to zero. Event ticks may advance
 * only when their paired action serial advances.
 */
function hasPlausibleMotionProgress(
  snapshot: MoveSnapshot,
  previous: MoveSnapshot | undefined,
  elapsedMs: number,
): boolean {
  if (!previous) return true;
  const maxActionAdvance = Math.min(32, Math.max(4, Math.ceil(elapsedMs / 150)));
  const maxStateAdvance = Math.min(128, Math.max(12, Math.ceil(elapsedMs / 30)));
  const maxTickAdvance = Math.min(
    0x7fff_ffff,
    Math.max(18, Math.ceil(elapsedMs * 0.09) + 12),
  );

  const simulationAdvance = previous.simulationTick === undefined
    ? undefined
    : snapshot.simulationTick === undefined
      ? null
      : uint32Delta(snapshot.simulationTick, previous.simulationTick);
  if (simulationAdvance !== undefined) {
    if (simulationAdvance === null || simulationAdvance > maxTickAdvance) {
      return false;
    }
  }

  for (const [sequenceKey, tickKey] of ACTION_SERIALS) {
    const previousSequence = previous[sequenceKey] as number | undefined;
    const nextSequence = snapshot[sequenceKey] as number | undefined;
    const previousTick = previous[tickKey] as number | undefined;
    const nextTick = snapshot[tickKey] as number | undefined;
    if (previousSequence === undefined && previousTick === undefined) continue;
    if (previousSequence === undefined
      || previousTick === undefined
      || nextSequence === undefined
      || nextTick === undefined) {
      return false;
    }
    const serialAdvance = uint32Delta(nextSequence, previousSequence);
    const allowedAdvance = sequenceKey === 'stateTransitionSequence'
      ? maxStateAdvance
      : maxActionAdvance;
    if (serialAdvance > allowedAdvance) return false;
    const tickAdvance = uint32Delta(nextTick, previousTick);
    if (serialAdvance === 0) {
      if (tickAdvance !== 0) return false;
      continue;
    }

    // An action tick records when that action most recently fired, so after a
    // long idle its delta from the *previous action tick* can legitimately be
    // thousands of fixed steps. Validate a newly-fired event against the
    // simulation interval carried by these two network samples instead. This
    // retains uint32 wrap support while preventing a future/backdated event.
    if (simulationAdvance !== undefined && simulationAdvance !== null) {
      const eventOffset = uint32Delta(nextTick, previous.simulationTick!);
      if (eventOffset > simulationAdvance) return false;
    } else if (tickAdvance > maxTickAdvance) {
      // Legacy motion snapshots may omit simulationTick. Keep the old bounded
      // delta check for that compatibility path.
      return false;
    }
  }
  return true;
}

export function validateMove(
  snapshot: MoveSnapshot,
  authoritative: AuthoritativePosition,
  tracker: MoveTracker,
  now = Date.now(),
): MoveValidation {
  const elapsed = tracker.lastAcceptedAt > 0 ? Math.max(0, now - tracker.lastAcceptedAt) : 100;
  const hasVelocityX = snapshot.velocityX !== undefined;
  const hasVelocityZ = snapshot.velocityZ !== undefined;
  const replicatedVelocity = hasVelocityX && hasVelocityZ
    ? Math.hypot(snapshot.velocityX!, snapshot.velocityZ!)
    : undefined;
  const unitFields = [
    snapshot.gaitPhase,
    snapshot.movementBlend,
    snapshot.runBlend,
    snapshot.airProgress,
    snapshot.glideBank === undefined ? undefined : (snapshot.glideBank + 1) * 0.5,
  ];
  const sequenceFields = [
    snapshot.simulationTick,
    snapshot.anticipationSequence,
    snapshot.jumpSequence,
    snapshot.doubleJumpSequence,
    snapshot.landSequence,
    snapshot.skidSequence,
    snapshot.anticipationTick,
    snapshot.jumpTick,
    snapshot.doubleJumpTick,
    snapshot.landTick,
    snapshot.skidTick,
    snapshot.stateTransitionSequence,
    snapshot.stateTransitionTick,
  ];
  if (!isProtocolVersionAccepted(snapshot.protocolVersion)
    || !Number.isSafeInteger(snapshot.sequence)
    || snapshot.sequence <= tracker.lastSequence
    || !Number.isFinite(snapshot.sentAt)
    || !Number.isFinite(snapshot.x)
    || !Number.isFinite(snapshot.y)
    || !Number.isFinite(snapshot.z)
    || !Number.isFinite(snapshot.yaw)
    || !Number.isFinite(snapshot.speed)
    || !Number.isFinite(snapshot.verticalSpeed)
    || unitFields.some((value) => value !== undefined
      && (!Number.isFinite(value) || value < 0 || value > 1))
    || sequenceFields.some((value) => value !== undefined
      && (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff))
    || (snapshot.velocityX !== undefined
      && (!Number.isFinite(snapshot.velocityX) || Math.abs(snapshot.velocityX) > 12))
    || (snapshot.velocityZ !== undefined
      && (!Number.isFinite(snapshot.velocityZ) || Math.abs(snapshot.velocityZ) > 12))
    || hasVelocityX !== hasVelocityZ
    || (snapshot.turnLean !== undefined
      && (!Number.isFinite(snapshot.turnLean) || Math.abs(snapshot.turnLean) > 0.5))
    || (snapshot.accelerationLean !== undefined
      && (!Number.isFinite(snapshot.accelerationLean) || Math.abs(snapshot.accelerationLean) > 0.25))) {
    return correction(snapshot, authoritative, 'invalid', true);
  }
  if (!hasPlausibleMotionProgress(snapshot, tracker.lastMotion, elapsed)) {
    return correction(snapshot, authoritative, 'invalid', true);
  }

  // A 10 Hz publisher gets tolerance for scheduler jitter, but high-rate spam is dropped.
  if (tracker.lastReceivedAt > 0 && now - tracker.lastReceivedAt < 70) {
    return { accepted: false, drop: true };
  }
  if (snapshot.speed < 0
    || snapshot.speed > MAX_SPRINT_SPEED * 1.09
    || (replicatedVelocity !== undefined
      && (replicatedVelocity > MAX_SPRINT_SPEED * 1.09
        || Math.abs(replicatedVelocity - snapshot.speed) > 0.45))
    || snapshot.verticalSpeed < -20
    || snapshot.verticalSpeed > 12) {
    return correction(snapshot, authoritative, 'speed', true);
  }
  if (!isAllowedWorldXZ(snapshot.x, snapshot.z)) {
    return correction(snapshot, authoritative, 'bounds', true);
  }

  const travelled = Math.hypot(snapshot.x - authoritative.x, snapshot.z - authoritative.z);
  if (travelled > maximumHorizontalTravel(elapsed)) {
    return correction(snapshot, authoritative, 'speed', travelled > 4);
  }

  const ground = sampleBoundedTerrainHeight(snapshot.x, snapshot.z);
  const heightError = snapshot.y - ground;
  if ((snapshot.grounded && Math.abs(heightError) > 3.5)
    || (!snapshot.grounded && (heightError < -3.5 || heightError > 24))) {
    return correction(snapshot, authoritative, 'terrain', Math.abs(heightError) > 8);
  }
  return { accepted: true };
}
