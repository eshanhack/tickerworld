import type { Camera } from 'three';
import type { AssetSymbol, SurfaceKind, TickDirection } from '../types';

export type AudioEngineStatus =
  | 'locked'
  | 'unlocking'
  | 'ready'
  | 'suspended'
  | 'unavailable'
  | 'resume-failed'
  | 'disposed';

export interface AudioPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** One audible chart monument. Grand and echo monuments use distinct ids. */
export interface MonumentAudioSource {
  readonly id: string;
  readonly symbol: AssetSymbol;
  readonly position: AudioPosition;
  /** Per-monument trim, normally left at 1. */
  readonly gain?: number;
}

export interface AudioListenerPose {
  readonly position: AudioPosition;
  readonly forward: AudioPosition;
  readonly up?: AudioPosition;
}

export type AudioListenerInput = Camera | AudioListenerPose;

export interface AudioEngineState {
  readonly status: AudioEngineStatus;
  readonly available: boolean;
  readonly unlocked: boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly reason?: string;
}

export interface AssetAudioProfile {
  readonly frequency: number;
  readonly accent: number;
}

export interface AudioEngineOptions {
  /** Primarily useful for tests or embedded web views. */
  readonly contextFactory?: () => AudioContext;
  readonly storage?: Storage | null;
  readonly random?: () => number;
}

export interface AudioEnvironment {
  /** 0 is warm daylight and 1 is the warmest night mix. */
  readonly nightFactor: number;
}

export type AudioStateListener = (state: AudioEngineState) => void;

export interface TickSoundOptions {
  readonly direction: TickDirection;
  /** Absolute fractional price move. For example, 0.001 means 0.1%. */
  readonly moveRatio?: number;
}

export interface FootstepSoundOptions {
  readonly surface: SurfaceKind;
  readonly sprinting?: boolean;
  readonly side?: 'left' | 'right';
}

export type JumpSoundKind = 'jump' | 'double-jump';
