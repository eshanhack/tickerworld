import type { AnimalKind } from '../../shared/src/index.js';

export type AnimalAnimationStyle =
  | 'flow'
  | 'waddle'
  | 'spring'
  | 'flutter'
  | 'stomp'
  | 'bound'
  | 'prowl'
  | 'swim'
  | 'stride';

export interface AnimalMotionProfile {
  /** Overall rendered size. Contact geometry is scaled by the same amount. */
  readonly modelScale: number;
  readonly walkSpeed: number;
  readonly sprintSpeed: number;
  readonly jumpImpulse: number;
  readonly doubleJumpImpulse: number;
  readonly gravity: number;
  readonly glideGravity: number;
  readonly glideTerminalSpeed: number;
  readonly accelerationScale: number;
  readonly turnScale: number;
  readonly gaitScale: number;
  readonly animationStyle: AnimalAnimationStyle;
  /** Whole turns around local X/Y/Z during the double-jump flourish. */
  readonly doubleJumpTurns: readonly [number, number, number];
}

/**
 * Species remain under the shared network-safe ceiling while feeling
 * materially different through mass, acceleration, stride and jump.
 * Sizes are intentionally compressed from real-world ratios so every creature
 * remains readable and playable beside the same chart architecture.
 */
export const ANIMAL_MOTION_PROFILES: Readonly<Record<AnimalKind, AnimalMotionProfile>> = {
  fox: {
    modelScale: 0.9,
    walkSpeed: 4.1,
    sprintSpeed: 7.15,
    jumpImpulse: 8.65,
    doubleJumpImpulse: 8.05,
    gravity: 25.5,
    glideGravity: 4.35,
    glideTerminalSpeed: -3.15,
    accelerationScale: 1,
    turnScale: 1,
    gaitScale: 1,
    animationStyle: 'flow',
    doubleJumpTurns: [1, 0, 0],
  },
  penguin: {
    modelScale: 0.74,
    walkSpeed: 2.55,
    sprintSpeed: 4.8,
    jumpImpulse: 7.7,
    doubleJumpImpulse: 7.35,
    gravity: 25,
    glideGravity: 3.15,
    glideTerminalSpeed: -2.65,
    accelerationScale: 0.72,
    turnScale: 1.22,
    gaitScale: 0.82,
    animationStyle: 'waddle',
    doubleJumpTurns: [0, 1, 1],
  },
  frog: {
    modelScale: 0.58,
    walkSpeed: 5.45,
    sprintSpeed: 8.15,
    jumpImpulse: 10.7,
    doubleJumpImpulse: 9.65,
    gravity: 27,
    glideGravity: 4,
    glideTerminalSpeed: -3,
    accelerationScale: 1.65,
    turnScale: 1.45,
    gaitScale: 1.34,
    animationStyle: 'spring',
    doubleJumpTurns: [-2, 0, 0],
  },
  duck: {
    modelScale: 0.66,
    walkSpeed: 3.25,
    sprintSpeed: 5.6,
    jumpImpulse: 8.15,
    doubleJumpImpulse: 7.75,
    gravity: 24.5,
    glideGravity: 2.65,
    glideTerminalSpeed: -2.4,
    accelerationScale: 0.92,
    turnScale: 1.26,
    gaitScale: 0.94,
    animationStyle: 'flutter',
    doubleJumpTurns: [0, 0, -1],
  },
  bear: {
    modelScale: 1.1,
    walkSpeed: 2.3,
    sprintSpeed: 4.35,
    jumpImpulse: 7.25,
    doubleJumpImpulse: 6.95,
    gravity: 26.5,
    glideGravity: 5.1,
    glideTerminalSpeed: -3.7,
    accelerationScale: 0.55,
    turnScale: 0.78,
    gaitScale: 0.72,
    animationStyle: 'stomp',
    doubleJumpTurns: [0, 0, 1],
  },
  rabbit: {
    modelScale: 0.72,
    walkSpeed: 5.65,
    sprintSpeed: 8.4,
    jumpImpulse: 10.05,
    doubleJumpImpulse: 9.2,
    gravity: 26,
    glideGravity: 3.85,
    glideTerminalSpeed: -2.9,
    accelerationScale: 1.52,
    turnScale: 1.35,
    gaitScale: 1.24,
    animationStyle: 'bound',
    doubleJumpTurns: [2, 0, 0],
  },
  cat: {
    modelScale: 0.78,
    walkSpeed: 5.25,
    sprintSpeed: 7.95,
    jumpImpulse: 9.2,
    doubleJumpImpulse: 8.7,
    gravity: 25.5,
    glideGravity: 3.7,
    glideTerminalSpeed: -2.85,
    accelerationScale: 1.42,
    turnScale: 1.4,
    gaitScale: 1.1,
    animationStyle: 'prowl',
    doubleJumpTurns: [1, -1, 1],
  },
  axolotl: {
    modelScale: 0.64,
    walkSpeed: 3.5,
    sprintSpeed: 6,
    jumpImpulse: 8.5,
    doubleJumpImpulse: 8.15,
    gravity: 24.5,
    glideGravity: 3.05,
    glideTerminalSpeed: -2.55,
    accelerationScale: 1.05,
    turnScale: 1.25,
    gaitScale: 1.28,
    animationStyle: 'swim',
    doubleJumpTurns: [1, 1, 0],
  },
  saylor: {
    modelScale: 1,
    walkSpeed: 4.25,
    sprintSpeed: 6.85,
    jumpImpulse: 8.35,
    doubleJumpImpulse: 7.95,
    gravity: 25.5,
    glideGravity: 3.35,
    glideTerminalSpeed: -2.8,
    accelerationScale: 1.04,
    turnScale: 1.02,
    gaitScale: 0.92,
    animationStyle: 'stride',
    doubleJumpTurns: [0, 1, 0],
  },
};

export function animalMotionProfile(animal: AnimalKind): AnimalMotionProfile {
  return ANIMAL_MOTION_PROFILES[animal] ?? ANIMAL_MOTION_PROFILES.fox;
}
