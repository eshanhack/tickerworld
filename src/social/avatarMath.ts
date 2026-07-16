import type { NetPlayerState } from '../../shared/src/index.js';

export interface RemotePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly speed: number;
  readonly verticalSpeed: number;
  readonly grounded: boolean;
  readonly gait: NetPlayerState['gait'];
  readonly movementState?: NetPlayerState['movementState'];
  readonly gaitPhase?: number;
  readonly movementBlend?: number;
  readonly runBlend?: number;
  readonly airProgress?: number;
  readonly simulationTick?: number;
  readonly velocityX?: number;
  readonly velocityZ?: number;
  readonly turnLean?: number;
  readonly accelerationLean?: number;
  readonly glideBank?: number;
  readonly anticipationSequence?: number;
  readonly jumpSequence?: number;
  readonly doubleJumpSequence?: number;
  readonly landSequence?: number;
  readonly skidSequence?: number;
  readonly anticipationTick?: number;
  readonly jumpTick?: number;
  readonly doubleJumpTick?: number;
  readonly landTick?: number;
  readonly skidTick?: number;
  readonly landingTier?: 'soft' | 'heavy';
  readonly stateTransitionSequence?: number;
  readonly stateTransitionTick?: number;
}

export type WritableRemotePose = {
  -readonly [Key in keyof RemotePose]: RemotePose[Key];
};

export function createRemotePose(): WritableRemotePose {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    speed: 0,
    verticalSpeed: 0,
    grounded: true,
    gait: 'idle',
  };
}

export interface ScreenBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly depth?: number;
}

export function interpolateAngle(from: number, to: number, alpha: number): number {
  const amount = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 0));
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + difference * amount;
}

function mixNumber(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

function progressForSimulationTick(
  fromTick: number | undefined,
  usableTickSpan: number | null,
  tick: number | undefined,
): number | null {
  if (tick === undefined || fromTick === undefined || usableTickSpan === null) return null;
  const offset = (tick - fromTick) >>> 0;
  return offset <= usableTickSpan ? offset / usableTickSpan : null;
}

function interpolateOptionalNumber(
  left: number | undefined,
  right: number | undefined,
  useRight: boolean,
  amount: number,
): number | undefined {
  if (left === undefined || right === undefined) return useRight ? right : left;
  return mixNumber(left, right, amount);
}

function selectEventSequence(
  left: number | undefined,
  right: number | undefined,
  rightTick: number | undefined,
  stateProgress: number,
  amount: number,
  fromTick: number | undefined,
  usableTickSpan: number | null,
): number | undefined {
  if (left === right) return left;
  const eventProgress = progressForSimulationTick(fromTick, usableTickSpan, rightTick)
    ?? stateProgress;
  return amount >= eventProgress ? right : left;
}

export function interpolateRemotePose(
  from: RemotePose,
  to: RemotePose,
  alpha: number,
  output: WritableRemotePose = createRemotePose(),
): RemotePose {
  const amount = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 0));
  const tickSpan = from.simulationTick === undefined || to.simulationTick === undefined
    ? null
    : (to.simulationTick - from.simulationTick) >>> 0;
  const usableTickSpan = tickSpan !== null && tickSpan > 0 && tickSpan <= 600 ? tickSpan : null;
  const stateProgress = from.stateTransitionSequence !== to.stateTransitionSequence
    ? progressForSimulationTick(from.simulationTick, usableTickSpan, to.stateTransitionTick) ?? 0.65
    : 0.65;
  const useToState = amount >= stateProgress;
  const anticipationSequence = selectEventSequence(
    from.anticipationSequence,
    to.anticipationSequence,
    to.anticipationTick,
    stateProgress,
    amount,
    from.simulationTick,
    usableTickSpan,
  );
  const jumpSequence = selectEventSequence(
    from.jumpSequence,
    to.jumpSequence,
    to.jumpTick,
    stateProgress,
    amount,
    from.simulationTick,
    usableTickSpan,
  );
  const doubleJumpSequence = selectEventSequence(
    from.doubleJumpSequence,
    to.doubleJumpSequence,
    to.doubleJumpTick,
    stateProgress,
    amount,
    from.simulationTick,
    usableTickSpan,
  );
  const landSequence = selectEventSequence(
    from.landSequence,
    to.landSequence,
    to.landTick,
    stateProgress,
    amount,
    from.simulationTick,
    usableTickSpan,
  );
  const skidSequence = selectEventSequence(
    from.skidSequence,
    to.skidSequence,
    to.skidTick,
    stateProgress,
    amount,
    from.simulationTick,
    usableTickSpan,
  );
  const simulationTick = from.simulationTick !== undefined && usableTickSpan !== null
    ? (from.simulationTick + Math.round(usableTickSpan * amount)) >>> 0
    : (useToState ? to.simulationTick : from.simulationTick);
  output.x = mixNumber(from.x, to.x, amount);
  output.y = mixNumber(from.y, to.y, amount);
  output.z = mixNumber(from.z, to.z, amount);
  output.yaw = interpolateAngle(from.yaw, to.yaw, amount);
  output.speed = Math.max(0, mixNumber(from.speed, to.speed, amount));
  output.verticalSpeed = mixNumber(from.verticalSpeed, to.verticalSpeed, amount);
  output.grounded = useToState ? to.grounded : from.grounded;
  output.gait = useToState ? to.gait : from.gait;
  output.movementState = useToState ? to.movementState : from.movementState;
  output.gaitPhase = from.gaitPhase === undefined || to.gaitPhase === undefined
      ? (useToState ? to.gaitPhase : from.gaitPhase)
      : ((from.gaitPhase + Math.atan2(
          Math.sin((to.gaitPhase - from.gaitPhase) * Math.PI * 2),
          Math.cos((to.gaitPhase - from.gaitPhase) * Math.PI * 2),
        ) / (Math.PI * 2) * amount) % 1 + 1) % 1;
  output.movementBlend = from.movementBlend === undefined || to.movementBlend === undefined
      ? (useToState ? to.movementBlend : from.movementBlend)
      : mixNumber(from.movementBlend, to.movementBlend, amount);
  output.runBlend = from.runBlend === undefined || to.runBlend === undefined
      ? (useToState ? to.runBlend : from.runBlend)
      : mixNumber(from.runBlend, to.runBlend, amount);
  output.airProgress = from.movementState === to.movementState
      && from.airProgress !== undefined
      && to.airProgress !== undefined
        ? mixNumber(from.airProgress, to.airProgress, amount)
        : (useToState ? to.airProgress : from.airProgress);
  output.simulationTick = simulationTick;
  output.velocityX = interpolateOptionalNumber(from.velocityX, to.velocityX, useToState, amount);
  output.velocityZ = interpolateOptionalNumber(from.velocityZ, to.velocityZ, useToState, amount);
  output.turnLean = interpolateOptionalNumber(from.turnLean, to.turnLean, useToState, amount);
  output.accelerationLean = interpolateOptionalNumber(
    from.accelerationLean,
    to.accelerationLean,
    useToState,
    amount,
  );
  output.glideBank = interpolateOptionalNumber(from.glideBank, to.glideBank, useToState, amount);
  output.anticipationSequence = anticipationSequence;
  output.jumpSequence = jumpSequence;
  output.doubleJumpSequence = doubleJumpSequence;
  output.landSequence = landSequence;
  output.skidSequence = skidSequence;
  output.anticipationTick = anticipationSequence === to.anticipationSequence
      ? to.anticipationTick
      : from.anticipationTick;
  output.jumpTick = jumpSequence === to.jumpSequence ? to.jumpTick : from.jumpTick;
  output.doubleJumpTick = doubleJumpSequence === to.doubleJumpSequence
      ? to.doubleJumpTick
      : from.doubleJumpTick;
  output.landTick = landSequence === to.landSequence ? to.landTick : from.landTick;
  output.skidTick = skidSequence === to.skidSequence ? to.skidTick : from.skidTick;
  output.landingTier = landSequence === to.landSequence ? to.landingTier : from.landingTier;
  output.stateTransitionSequence = useToState
      ? to.stateTransitionSequence
      : from.stateTransitionSequence;
  output.stateTransitionTick = useToState ? to.stateTransitionTick : from.stateTransitionTick;
  return output;
}

export function clipSpeech(text: string, maximum = 90): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximum) return normalized;
  if (maximum <= 1) return '…'.slice(0, Math.max(0, maximum));
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

export function boundsOverlap(left: ScreenBounds, right: ScreenBounds): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

export function socialLabelOpacity(
  label: ScreenBounds,
  occlusionBounds: readonly ScreenBounds[],
): number {
  const occluded = occlusionBounds.some((bounds) => {
    if (!boundsOverlap(label, bounds)) return false;
    if (label.depth === undefined || bounds.depth === undefined) return true;
    if (!Number.isFinite(label.depth) || !Number.isFinite(bounds.depth)) return false;
    return label.depth < bounds.depth;
  });
  return occluded ? 0.05 : 1;
}
