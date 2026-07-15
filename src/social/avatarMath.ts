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

export function interpolateRemotePose(
  from: RemotePose,
  to: RemotePose,
  alpha: number,
): RemotePose {
  const amount = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 0));
  const mix = (left: number, right: number): number => left + (right - left) * amount;
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    z: mix(from.z, to.z),
    yaw: interpolateAngle(from.yaw, to.yaw, amount),
    speed: Math.max(0, mix(from.speed, to.speed)),
    verticalSpeed: mix(from.verticalSpeed, to.verticalSpeed),
    grounded: amount < 1 ? from.grounded : to.grounded,
    gait: amount < 1 ? from.gait : to.gait,
    movementState: amount < 1 ? from.movementState : to.movementState,
    gaitPhase: from.gaitPhase === undefined || to.gaitPhase === undefined
      ? (amount < 1 ? from.gaitPhase : to.gaitPhase)
      : ((from.gaitPhase + Math.atan2(
          Math.sin((to.gaitPhase - from.gaitPhase) * Math.PI * 2),
          Math.cos((to.gaitPhase - from.gaitPhase) * Math.PI * 2),
        ) / (Math.PI * 2) * amount) % 1 + 1) % 1,
    movementBlend: from.movementBlend === undefined || to.movementBlend === undefined
      ? (amount < 1 ? from.movementBlend : to.movementBlend)
      : mix(from.movementBlend, to.movementBlend),
    runBlend: from.runBlend === undefined || to.runBlend === undefined
      ? (amount < 1 ? from.runBlend : to.runBlend)
      : mix(from.runBlend, to.runBlend),
    airProgress: from.movementState === to.movementState
      && from.airProgress !== undefined
      && to.airProgress !== undefined
        ? mix(from.airProgress, to.airProgress)
        : (amount < 1 ? from.airProgress : to.airProgress),
    simulationTick: amount < 1 ? from.simulationTick : to.simulationTick,
  };
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
