export { FoxPlayer } from './FoxPlayer';
export type {
  FootstepEvent,
  FootstepListener,
  FoxActionEvent,
  FoxActionKind,
  FoxActionListener,
  FoxLocomotionState,
  FoxMotionDebugSnapshot,
  FoxPlayerOptions,
  HeightSampler,
  HorizontalMovementResolver,
  HorizontalMovementResult,
  SurfaceSampler,
} from './FoxPlayer';
export { FoxRig, FOX_RIG_PROPORTIONS } from './FoxRig';
export type { FoxRigDebugSnapshot, FoxRigPoseInput, FoxRigRenderedPawState } from './FoxRig';
export {
  BASE_ANIMAL_PALETTES,
  PREMIUM_SKIN_ANIMAL,
  resolveAnimalAppearance,
} from './animalAppearance';
export type { AnimalAppearancePalette, AnimalAppearanceProfile } from './animalAppearance';
export { ANIMAL_MOTION_PROFILES, animalMotionProfile } from './animalProfiles';
export type { AnimalAnimationStyle, AnimalMotionProfile } from './animalProfiles';
export {
  FOX_LEG_KEYS,
  isFoxLegInContact,
  normalizeFoxGaitPhase,
  sampleFoxAirLegPose,
  sampleFoxLegMotion,
} from './foxMotion';
export type { FoxAirPose, FoxLegKey, FoxLegMotionSample } from './foxMotion';
export { PlayerInputController } from './InputController';
export type { PlayerInputControllerOptions, PlayerInputState } from './InputController';
export { ThirdPersonCamera } from './ThirdPersonCamera';
export type { CameraObstacleSampler, ThirdPersonCameraOptions } from './ThirdPersonCamera';
