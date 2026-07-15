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

export function validateMove(
  snapshot: MoveSnapshot,
  authoritative: AuthoritativePosition,
  tracker: MoveTracker,
  now = Date.now(),
): MoveValidation {
  const unitFields = [
    snapshot.gaitPhase,
    snapshot.movementBlend,
    snapshot.runBlend,
    snapshot.airProgress,
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
    || (snapshot.simulationTick !== undefined
      && (!Number.isSafeInteger(snapshot.simulationTick)
        || snapshot.simulationTick < 0
        || snapshot.simulationTick > 0xffff_ffff))) {
    return correction(snapshot, authoritative, 'invalid', true);
  }

  // A 10 Hz publisher gets tolerance for scheduler jitter, but high-rate spam is dropped.
  if (tracker.lastReceivedAt > 0 && now - tracker.lastReceivedAt < 70) {
    return { accepted: false, drop: true };
  }
  if (snapshot.speed < 0
    || snapshot.speed > MAX_SPRINT_SPEED * 1.09
    || snapshot.verticalSpeed < -20
    || snapshot.verticalSpeed > 12) {
    return correction(snapshot, authoritative, 'speed', true);
  }
  if (!isAllowedWorldXZ(snapshot.x, snapshot.z)) {
    return correction(snapshot, authoritative, 'bounds', true);
  }

  const elapsed = tracker.lastAcceptedAt > 0 ? now - tracker.lastAcceptedAt : 100;
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
