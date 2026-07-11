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
    grounded: amount < 0.5 ? from.grounded : to.grounded,
    gait: amount < 0.5 ? from.gait : to.gait,
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
