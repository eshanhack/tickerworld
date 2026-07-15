import * as THREE from 'three';
import { Text } from 'troika-three-text';
import {
  ANIMAL_KINDS,
  REMOTE_INTERPOLATION_DELAY_MS,
  type AnimalKind,
  type ChatMessage,
  type NetPlayerState,
  type SkinId,
} from '../../shared/src/index.js';
import type { GameSystem } from '../types';
import { animalMotionProfile } from '../player/animalProfiles';
import { FoxRig } from '../player/FoxRig';
import type { FoxAirPose } from '../player/foxMotion';
import {
  clipSpeech,
  interpolateRemotePose,
  socialLabelOpacity,
  type RemotePose,
  type ScreenBounds,
} from './avatarMath';

const MAX_REMOTE_PLAYERS = 49;
const MAX_PARTS_PER_AVATAR = 64;
const MAX_BATCHED_PARTS = MAX_REMOTE_PLAYERS * MAX_PARTS_PER_AVATAR;
// The batch stores one canonical copy of every low-poly part used by all nine
// creatures. These bounds deliberately leave headroom for future accessories.
const MAX_BATCH_VERTICES = 220_000;
const MAX_BATCH_INDICES = 660_000;
const LABEL_RENDER_ORDER = 38;
const BUBBLE_RENDER_ORDER = 39;
const SPEECH_LIFETIME_MS = 5_000;
const SAMPLE_LIMIT = 6;
const DOUBLE_POSE_SECONDS = 0.46;
const LAND_RECOVERY_SECONDS = 0.22;

/** Existing label placement is retained while the rendered model is upgraded. */
const ANIMAL_LABEL_HEIGHTS: Readonly<Record<AnimalKind, number>> = {
  fox: 1.72,
  penguin: 1.72,
  frog: 1.5,
  duck: 1.6,
  bear: 1.75,
  rabbit: 1.73,
  cat: 1.66,
  axolotl: 1.5,
  saylor: 2.12,
};

interface TimedRemoteState {
  readonly at: number;
  readonly state: NetPlayerState;
}

interface RenderPart {
  readonly instanceId: number;
  readonly mesh: THREE.Mesh;
}

interface RemoteSlot {
  readonly index: number;
  actorId: string;
  animal: AnimalKind;
  skin: SkinId;
  username: string | null;
  readonly samples: TimedRemoteState[];
  readonly nameplate: Text;
  readonly speech: Text;
  visual: CanonicalRemoteVisual | null;
  parts: RenderPart[];
  speechExpiresAt: number;
  active: boolean;
  rendered: boolean;
  detailVisible: boolean;
  lastSourceUpdate: number;
  lastPose: RemotePose | null;
}

export interface RemoteAvatarViewport {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface RemoteAvatarSystemOptions {
  readonly parent: THREE.Object3D;
  readonly camera: THREE.Camera;
  readonly fontUrl?: string;
  readonly maxPlayers?: number;
  readonly interpolationDelayMs?: number;
  readonly cullDistance?: number;
  /**
   * @deprecated Visible remote players always use the canonical full rig.
   * Kept for protocol/deployment overlap with older callers.
   */
  readonly detailDistance?: number;
  readonly localPosition?: () => Readonly<THREE.Vector3>;
  /** Optional terrain sampler used to plant the articulated remote fox rig. */
  readonly heightAt?: (x: number, z: number) => number;
  readonly localNameplate?: {
    readonly actorId?: string;
    readonly animal: () => AnimalKind;
    readonly username?: string | null;
  };
  readonly viewport?: () => RemoteAvatarViewport;
  readonly occlusionBounds?: () => readonly ScreenBounds[];
  readonly now?: () => number;
}

export interface RemoteAvatarDebugStats {
  readonly active: number;
  readonly rendered: number;
  /** Rendered creatures using the complete canonical species rig. */
  readonly detailed: number;
  readonly capacity: number;
  readonly drawCalls: number;
  readonly geometries: number;
  readonly materials: number;
  readonly labels: number;
}

function copyPose(state: NetPlayerState): RemotePose {
  return {
    x: state.x,
    y: state.y,
    z: state.z,
    yaw: state.yaw,
    speed: state.speed,
    verticalSpeed: state.verticalSpeed,
    grounded: state.grounded,
    gait: state.gait,
  };
}

function validAnimal(value: AnimalKind): AnimalKind {
  return ANIMAL_KINDS.includes(value) ? value : 'fox';
}

function titleAnimal(animal: AnimalKind): string {
  if (animal === 'saylor') return 'Michael Saylor';
  return `${animal.charAt(0).toUpperCase()}${animal.slice(1)}`;
}

function sampleSlot(slot: RemoteSlot, targetTime: number): RemotePose | null {
  const samples = slot.samples;
  if (samples.length === 0) return null;
  if (samples.length === 1 || targetTime <= samples[0]!.at) return copyPose(samples[0]!.state);
  const latest = samples[samples.length - 1]!;
  if (targetTime >= latest.at) return copyPose(latest.state);
  for (let index = 1; index < samples.length; index += 1) {
    const right = samples[index]!;
    if (right.at < targetTime) continue;
    const left = samples[index - 1]!;
    const span = Math.max(1, right.at - left.at);
    return interpolateRemotePose(copyPose(left.state), copyPose(right.state), (targetTime - left.at) / span);
  }
  return copyPose(latest.state);
}

function configureLabel(text: Text, fontUrl: string | undefined, bubble: boolean): void {
  text.font = fontUrl ?? null;
  text.fontSize = bubble ? 0.23 : 0.21;
  text.color = 0x31373d;
  text.anchorX = 'center';
  text.anchorY = 'bottom';
  text.textAlign = 'center';
  text.maxWidth = bubble ? 3.2 : 2.6;
  text.lineHeight = 1.2;
  text.whiteSpace = 'normal';
  text.overflowWrap = 'break-word';
  text.outlineColor = 0xfff1cf;
  text.outlineWidth = bubble ? '18%' : '10%';
  text.outlineOpacity = 0.96;
  text.depthOffset = -1;
  text.renderOrder = bubble ? BUBBLE_RENDER_ORDER : LABEL_RENDER_ORDER;
  text.frustumCulled = false;
  text.visible = false;
}

function damp(current: number, target: number, response: number, deltaSeconds: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-response * deltaSeconds));
}

function materialColor(material: THREE.Material | THREE.Material[]): THREE.Color {
  const first = Array.isArray(material) ? material[0] : material;
  if (first && 'color' in first && first.color instanceof THREE.Color) return first.color;
  return new THREE.Color(0xffffff);
}

function isEffectivelyVisible(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function objectPath(object: THREE.Object3D, root: THREE.Object3D): string {
  const parts: string[] = [];
  let current: THREE.Object3D | null = object;
  while (current && current !== root) {
    const index = current.parent?.children.indexOf(current) ?? 0;
    parts.push(`${current.name || current.type}:${index}`);
    current = current.parent;
  }
  return parts.reverse().join('/');
}

/**
 * An off-scene copy of the exact local FoxRig hierarchy. It is used only as a
 * deterministic pose solver; its meshes are emitted into one BatchedMesh.
 */
class CanonicalRemoteVisual {
  readonly group = new THREE.Group();
  readonly headingPivot = new THREE.Group();
  readonly aerialPivot = new THREE.Group();
  readonly rig = new FoxRig();
  private movementBlend = 0;
  private runBlend = 0;
  private gaitPhase = 0;
  private elapsed = 0;
  private previousGrounded = true;
  private previousVerticalSpeed = 0;
  private doubleRemaining = 0;
  private landingRemaining = 0;
  private disposed = false;

  constructor(animal: AnimalKind, skin: SkinId) {
    this.group.name = 'CanonicalRemoteCharacter';
    this.headingPivot.name = 'RemoteHeadingPivot';
    this.aerialPivot.name = 'RemoteAerialPivot';
    this.aerialPivot.add(this.rig.root);
    this.headingPivot.add(this.aerialPivot);
    this.group.add(this.headingPivot);
    this.setAppearance(animal, skin);
  }

  setAppearance(animal: AnimalKind, skin: SkinId): void {
    this.rig.setAnimal(animal, skin);
    this.rig.root.scale.setScalar(animalMotionProfile(animal).modelScale);
    this.group.updateMatrixWorld(true);
  }

  meshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    this.rig.root.traverse((object) => {
      if (object instanceof THREE.Mesh && isEffectivelyVisible(object, this.rig.root)) meshes.push(object);
    });
    return meshes;
  }

  geometryKey(animal: AnimalKind, mesh: THREE.Mesh): string {
    return `${animal}:${objectPath(mesh, this.rig.root)}`;
  }

  update(
    pose: RemotePose,
    deltaSeconds: number,
    heightAt: (x: number, z: number) => number,
  ): void {
    const delta = THREE.MathUtils.clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.05);
    const profile = animalMotionProfile(this.rig.animal);
    this.elapsed += delta;
    const movementTarget = THREE.MathUtils.smoothstep(Math.max(0, pose.speed), 0.06, 0.72);
    const runTarget = THREE.MathUtils.smoothstep(
      Math.max(0, pose.speed),
      profile.walkSpeed * 0.9,
      profile.sprintSpeed * 0.9,
    );
    this.movementBlend = damp(this.movementBlend, movementTarget, 7.2, delta);
    this.runBlend = damp(this.runBlend, runTarget, pose.gait === 'run' ? 3.8 : 5, delta);
    const gaitRadiansPerMetre = THREE.MathUtils.lerp(1.82, 2.08, this.runBlend) * profile.gaitScale;
    this.gaitPhase = (this.gaitPhase + Math.max(0, pose.speed) * delta * gaitRadiansPerMetre) % (Math.PI * 2);

    if (!pose.grounded
      && !this.previousGrounded
      && pose.verticalSpeed > 4
      && pose.verticalSpeed - this.previousVerticalSpeed > 3.2) {
      // A second upward impulse while already airborne is the network-visible
      // signature of a double jump. This restores the species flourish without
      // requiring a breaking protocol change during server/client skew.
      this.doubleRemaining = DOUBLE_POSE_SECONDS;
    }
    if (pose.grounded && !this.previousGrounded) this.landingRemaining = LAND_RECOVERY_SECONDS;
    this.doubleRemaining = Math.max(0, this.doubleRemaining - delta);
    this.landingRemaining = Math.max(0, this.landingRemaining - delta);

    let airPose: FoxAirPose = 'grounded';
    let airProgress = 1;
    if (pose.grounded) {
      if (this.landingRemaining > 0) {
        airPose = 'land';
        airProgress = 1 - this.landingRemaining / LAND_RECOVERY_SECONDS;
      }
    } else if (this.doubleRemaining > 0) {
      airPose = 'double';
      airProgress = 1 - this.doubleRemaining / DOUBLE_POSE_SECONDS;
    } else if (pose.gait === 'glide') {
      airPose = 'glide';
      airProgress = 1;
    } else if (pose.verticalSpeed > 1.15) {
      airPose = 'rise';
      airProgress = THREE.MathUtils.clamp(1 - pose.verticalSpeed / profile.jumpImpulse, 0, 1);
    } else if (pose.verticalSpeed > -1.2) {
      airPose = 'apex';
      airProgress = THREE.MathUtils.clamp((1.15 - pose.verticalSpeed) / 2.35, 0, 1);
    } else {
      airPose = 'fall';
      airProgress = THREE.MathUtils.clamp(Math.abs(pose.verticalSpeed) / 9, 0, 1);
    }

    this.group.position.set(pose.x, pose.y, pose.z);
    this.headingPivot.rotation.y = pose.yaw;
    if (airPose === 'double') {
      const eased = airProgress * airProgress * (3 - 2 * airProgress);
      const [turnX, turnY, turnZ] = profile.doubleJumpTurns;
      const angle = Math.PI * 2 * eased;
      this.aerialPivot.rotation.set(turnX * angle, turnY * angle, turnZ * angle);
      const squash = Math.sin(airProgress * Math.PI) * 0.075;
      this.aerialPivot.scale.set(1 + squash, 1 - squash * 0.7, 1 + squash);
    } else {
      this.aerialPivot.rotation.set(0, 0, 0);
      this.aerialPivot.scale.set(1, 1, 1);
    }

    // The same terrain samples used for the local character keep remote paws
    // from clipping on the gently rolling ground. Species attachment rigs use
    // their own authored contacts, while the fox's articulated chain plants.
    const sin = Math.sin(pose.yaw);
    const cos = Math.cos(pose.yaw);
    const sample = (side: number, forward: number): number => {
      const x = pose.x + side * cos - forward * sin;
      const z = pose.z + side * sin + forward * cos;
      const height = heightAt(x, z);
      return Number.isFinite(height) ? height - pose.y : 0;
    };
    const frontLeft = sample(-0.31, -0.72);
    const frontRight = sample(0.31, -0.72);
    const hindLeft = sample(-0.31, 0.47);
    const hindRight = sample(0.31, 0.47);
    const front = (frontLeft + frontRight) * 0.5;
    const hind = (hindLeft + hindRight) * 0.5;
    const left = (frontLeft + hindLeft) * 0.5;
    const right = (frontRight + hindRight) * 0.5;

    this.rig.updatePose({
      deltaSeconds: delta,
      elapsedSeconds: this.elapsed,
      gaitPhase: this.gaitPhase,
      movementBlend: this.movementBlend,
      runBlend: this.runBlend,
      airPose,
      airBlend: airPose === 'grounded' ? 0 : 1,
      airProgress,
      groundPitch: THREE.MathUtils.clamp(Math.atan2(front - hind, 1.04), -0.34, 0.34),
      groundRoll: THREE.MathUtils.clamp(Math.atan2(right - left, 0.58), -0.3, 0.3),
      pawGroundOffsets: { frontLeft, frontRight, hindLeft, hindRight },
    });
    this.group.updateMatrixWorld(true);
    this.previousGrounded = pose.grounded;
    this.previousVerticalSpeed = pose.verticalSpeed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
      else materials.add(object.material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.group.clear();
  }
}

export class RemoteAvatarSystem implements GameSystem {
  readonly root = new THREE.Group();

  private readonly camera: THREE.Camera;
  private readonly capacity: number;
  private readonly interpolationDelayMs: number;
  private readonly cullDistanceSquared: number;
  private readonly localPosition: () => Readonly<THREE.Vector3>;
  private readonly heightAt: (x: number, z: number) => number;
  private readonly viewport: () => RemoteAvatarViewport;
  private readonly occlusionBounds: () => readonly ScreenBounds[];
  private readonly now: () => number;
  private readonly slots: RemoteSlot[] = [];
  private readonly slotByActor = new Map<string, RemoteSlot>();
  private readonly blocked = new Set<string>();
  private readonly pendingSpeech = new Map<string, { text: string; expiresAt: number }>();
  private readonly geometryByKey = new Map<string, number>();
  private readonly slotByInstance = new Map<number, RemoteSlot>();
  private readonly batchMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });
  private readonly batch = new THREE.BatchedMesh(
    MAX_BATCHED_PARTS,
    MAX_BATCH_VERTICES,
    MAX_BATCH_INDICES,
    this.batchMaterial,
  );
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly screenPoint = new THREE.Vector3();
  private readonly cameraPoint = new THREE.Vector3();
  private readonly localNameplate?: Text;
  private readonly localSpeech?: Text;
  private readonly localAnimal?: () => AnimalKind;
  private localActorId: string | null = null;
  private localUsername: string | null = null;
  private localSpeechExpiresAt = 0;
  private visible = true;
  private remotePlayersVisible = true;
  private labelsVisible = true;
  private disposed = false;

  constructor(options: RemoteAvatarSystemOptions) {
    this.camera = options.camera;
    this.capacity = Math.max(1, Math.min(MAX_REMOTE_PLAYERS, Math.floor(options.maxPlayers ?? MAX_REMOTE_PLAYERS)));
    this.interpolationDelayMs = Math.max(0, options.interpolationDelayMs ?? REMOTE_INTERPOLATION_DELAY_MS);
    const cullDistance = Math.max(8, options.cullDistance ?? 68);
    this.cullDistanceSquared = cullDistance * cullDistance;
    this.localPosition = options.localPosition ?? (() => this.camera.position);
    this.heightAt = options.heightAt ?? (() => 0);
    this.viewport = options.viewport ?? (() => ({ left: 0, top: 0, width: innerWidth, height: innerHeight }));
    this.occlusionBounds = options.occlusionBounds ?? (() => []);
    this.now = options.now ?? (() => performance.now());
    this.root.name = 'tickerworld-remote-avatars';
    this.batch.name = 'remote-canonical-avatar-batch';
    this.batch.castShadow = true;
    this.batch.receiveShadow = true;
    this.batch.perObjectFrustumCulled = true;
    this.batch.sortObjects = false;
    this.batch.frustumCulled = false;
    this.root.add(this.batch);

    for (let index = 0; index < this.capacity; index += 1) {
      const nameplate = new Text();
      const speech = new Text();
      configureLabel(nameplate, options.fontUrl, false);
      configureLabel(speech, options.fontUrl, true);
      this.root.add(nameplate, speech);
      this.slots.push({
        index,
        actorId: '',
        animal: 'fox',
        skin: 'base',
        username: null,
        samples: [],
        nameplate,
        speech,
        visual: null,
        parts: [],
        speechExpiresAt: 0,
        active: false,
        rendered: false,
        detailVisible: false,
        lastSourceUpdate: Number.NEGATIVE_INFINITY,
        lastPose: null,
      });
    }

    if (options.localNameplate) {
      this.localAnimal = options.localNameplate.animal;
      this.localActorId = options.localNameplate.actorId?.trim() || null;
      this.localUsername = options.localNameplate.username?.trim() || null;
      const nameplate = new Text();
      nameplate.name = 'local-player-nameplate';
      configureLabel(nameplate, options.fontUrl, false);
      const speech = new Text();
      speech.name = 'local-player-speech';
      configureLabel(speech, options.fontUrl, true);
      this.localNameplate = nameplate;
      this.localSpeech = speech;
      this.root.add(nameplate, speech);
      this.renderLocalUsername();
    }
    options.parent.add(this.root);
  }

  setLocalUsername(username: string | null): void {
    if (!this.localNameplate || this.disposed) return;
    this.localUsername = username?.trim() || null;
    this.renderLocalUsername();
  }

  setLocalActorId(actorId: string): void {
    const next = actorId.trim() || null;
    if (next === this.localActorId) return;
    this.localActorId = next;
    this.localSpeechExpiresAt = 0;
    if (this.localSpeech?.text) {
      this.localSpeech.text = '';
      this.localSpeech.visible = false;
      this.syncText(this.localSpeech);
    }
  }

  setPlayers(players: readonly NetPlayerState[], receivedAt = this.now()): void {
    if (this.disposed) return;
    const local = this.localPosition();
    const candidates = players
      .filter((player) => !this.blocked.has(player.actorId))
      .filter((player) => Number.isFinite(player.x) && Number.isFinite(player.y) && Number.isFinite(player.z))
      .sort((left, right) => (
        (left.x - local.x) ** 2 + (left.z - local.z) ** 2
        - ((right.x - local.x) ** 2 + (right.z - local.z) ** 2)
      ))
      .slice(0, this.capacity);
    const activeIds = new Set(candidates.map((player) => player.actorId));
    for (const slot of this.slots) {
      if (slot.active && !activeIds.has(slot.actorId)) this.releaseSlot(slot);
    }
    for (const state of candidates) {
      const existing = this.slotByActor.get(state.actorId);
      const slot = existing ?? this.claimSlot(state.actorId);
      if (!slot) continue;
      const animal = validAnimal(state.animal);
      const changedAppearance = !existing
        || slot.animal !== animal
        || slot.skin !== state.skin
        || slot.username !== state.username;
      slot.animal = animal;
      slot.skin = state.skin;
      slot.username = state.username;
      if (changedAppearance) this.applyAppearance(slot);
      if (state.updatedAt !== slot.lastSourceUpdate || slot.samples.length === 0) {
        slot.samples.push({ at: receivedAt, state: { ...state, animal } });
        if (slot.samples.length > SAMPLE_LIMIT) slot.samples.splice(0, slot.samples.length - SAMPLE_LIMIT);
        slot.lastSourceUpdate = state.updatedAt;
      }
    }
  }

  setBlockedActors(actorIds: ReadonlySet<string>): void {
    this.blocked.clear();
    for (const actorId of actorIds) this.blocked.add(actorId);
    for (const slot of this.slots) {
      if (slot.active && this.blocked.has(slot.actorId)) this.releaseSlot(slot);
    }
  }

  showSpeech(message: Pick<ChatMessage, 'actorId' | 'text'>): void {
    if (this.disposed || this.blocked.has(message.actorId)) return;
    if (this.localActorId && message.actorId === this.localActorId) {
      this.showLocalSpeech(message.text);
      return;
    }
    const expiresAt = this.now() + SPEECH_LIFETIME_MS;
    const text = clipSpeech(message.text);
    const slot = this.slotByActor.get(message.actorId);
    if (!slot) {
      this.pendingSpeech.set(message.actorId, { text, expiresAt });
      return;
    }
    this.setSlotSpeech(slot, text, expiresAt);
  }

  showLocalSpeech(text: string): void {
    if (this.disposed || !this.localSpeech) return;
    this.localSpeech.text = clipSpeech(text);
    this.localSpeechExpiresAt = this.now() + SPEECH_LIFETIME_MS;
    this.syncText(this.localSpeech);
  }

  pickAt(clientX: number, clientY: number, domElement: HTMLElement): NetPlayerState | null {
    if (this.disposed || !this.visible || !this.remotePlayersVisible) return null;
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.batch, false);
    for (const hit of hits) {
      if (hit.batchId === undefined) continue;
      const slot = this.slotByInstance.get(hit.batchId);
      if (!slot?.active || !slot.rendered || this.blocked.has(slot.actorId)) continue;
      return slot.samples[slot.samples.length - 1]?.state ?? null;
    }

    let nearest: { state: NetPlayerState; distanceSquared: number } | null = null;
    for (const slot of this.slots) {
      if (!slot.active || !slot.rendered || this.blocked.has(slot.actorId)) continue;
      const state = slot.samples[slot.samples.length - 1]?.state;
      const pose = slot.lastPose;
      if (!state || !pose) continue;
      const height = this.labelHeight(slot.animal);
      this.screenPoint.set(pose.x, pose.y + height * 0.58, pose.z).project(this.camera);
      if (this.screenPoint.z < -1 || this.screenPoint.z > 1) continue;
      const screenX = rect.left + (this.screenPoint.x + 1) * rect.width * 0.5;
      const screenY = rect.top + (1 - this.screenPoint.y) * rect.height * 0.5;
      const distanceSquared = (clientX - screenX) ** 2 + (clientY - screenY) ** 2;
      const hitRadius = slot.animal === 'frog' ? 44 : 38;
      if (distanceSquared > hitRadius ** 2) continue;
      if (!nearest || distanceSquared < nearest.distanceSquared) nearest = { state, distanceSquared };
    }
    return nearest?.state ?? null;
  }

  update(deltaSeconds: number): void {
    if (this.disposed || !this.visible) return;
    const now = this.now();
    const targetTime = now - this.interpolationDelayMs;
    const local = this.localPosition();
    const occlusions = this.occlusionBounds();
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const pose = sampleSlot(slot, targetTime);
      if (!pose) continue;
      slot.lastPose = pose;
      const distanceSquared = (pose.x - local.x) ** 2 + (pose.z - local.z) ** 2;
      const shouldRender = this.remotePlayersVisible && distanceSquared <= this.cullDistanceSquared;
      slot.rendered = shouldRender;
      slot.detailVisible = shouldRender;
      slot.nameplate.visible = shouldRender && this.labelsVisible;
      slot.speech.visible = shouldRender && this.labelsVisible && slot.speechExpiresAt > now;
      this.setSlotPartsVisible(slot, shouldRender);
      if (!shouldRender || !slot.visual) continue;
      slot.visual.update(pose, deltaSeconds, this.heightAt);
      for (const part of slot.parts) this.batch.setMatrixAt(part.instanceId, part.mesh.matrixWorld);
      this.writeRemoteLabels(slot, pose, occlusions);
      if (slot.speechExpiresAt <= now && slot.speech.text) {
        slot.speech.text = '';
        this.syncText(slot.speech);
      }
    }
    this.writeLocalLabels(now, occlusions);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  setRemotePlayersVisible(visible: boolean): void {
    if (this.remotePlayersVisible === visible) return;
    this.remotePlayersVisible = visible;
    if (visible) return;
    for (const slot of this.slots) {
      slot.rendered = false;
      slot.detailVisible = false;
      slot.nameplate.visible = false;
      slot.speech.visible = false;
      this.setSlotPartsVisible(slot, false);
    }
  }

  setLabelsVisible(visible: boolean): void {
    this.labelsVisible = visible;
    if (visible) return;
    if (this.localNameplate) this.localNameplate.visible = false;
    if (this.localSpeech) this.localSpeech.visible = false;
    for (const slot of this.slots) {
      slot.nameplate.visible = false;
      slot.speech.visible = false;
    }
  }

  /** QA/test hook: returns the same canonical hierarchy used to emit the batch. */
  getActorRenderRoot(actorId: string): THREE.Object3D | null {
    return this.slotByActor.get(actorId)?.visual?.group ?? null;
  }

  getDebugStats(): RemoteAvatarDebugStats {
    return {
      active: this.slots.filter((slot) => slot.active).length,
      rendered: this.slots.filter((slot) => slot.rendered).length,
      detailed: this.slots.filter((slot) => slot.detailVisible).length,
      capacity: this.capacity,
      drawCalls: this.slots.some((slot) => slot.rendered) ? 1 : 0,
      geometries: this.geometryByKey.size,
      materials: 1,
      labels: this.slots.length * 2 + (this.localNameplate ? 2 : 0),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      slot.nameplate.dispose();
      slot.speech.dispose();
      slot.nameplate.removeFromParent();
      slot.speech.removeFromParent();
      slot.visual?.dispose();
      slot.visual = null;
      slot.samples.length = 0;
      slot.parts.length = 0;
    }
    this.localNameplate?.dispose();
    this.localNameplate?.removeFromParent();
    this.localSpeech?.dispose();
    this.localSpeech?.removeFromParent();
    this.batch.dispose();
    this.batchMaterial.dispose();
    this.slotByActor.clear();
    this.slotByInstance.clear();
    this.geometryByKey.clear();
    this.blocked.clear();
    this.pendingSpeech.clear();
    this.root.removeFromParent();
    this.root.clear();
  }

  private claimSlot(actorId: string): RemoteSlot | null {
    const slot = this.slots.find((candidate) => !candidate.active);
    if (!slot) return null;
    slot.actorId = actorId;
    slot.active = true;
    slot.rendered = false;
    slot.detailVisible = false;
    slot.lastSourceUpdate = Number.NEGATIVE_INFINITY;
    slot.lastPose = null;
    slot.samples.length = 0;
    if (!slot.visual) slot.visual = new CanonicalRemoteVisual(slot.animal, slot.skin);
    this.slotByActor.set(actorId, slot);
    const pending = this.pendingSpeech.get(actorId);
    if (pending && pending.expiresAt > this.now()) this.setSlotSpeech(slot, pending.text, pending.expiresAt);
    this.pendingSpeech.delete(actorId);
    return slot;
  }

  private releaseSlot(slot: RemoteSlot): void {
    this.slotByActor.delete(slot.actorId);
    slot.active = false;
    slot.rendered = false;
    slot.detailVisible = false;
    slot.actorId = '';
    slot.samples.length = 0;
    slot.lastPose = null;
    slot.nameplate.visible = false;
    slot.speech.visible = false;
    slot.speech.text = '';
    slot.speechExpiresAt = 0;
    this.setSlotPartsVisible(slot, false);
  }

  private setSlotSpeech(slot: RemoteSlot, text: string, expiresAt: number): void {
    slot.speech.text = text;
    slot.speechExpiresAt = expiresAt;
    this.syncText(slot.speech);
  }

  private applyAppearance(slot: RemoteSlot): void {
    if (!slot.visual) slot.visual = new CanonicalRemoteVisual(slot.animal, slot.skin);
    else slot.visual.setAppearance(slot.animal, slot.skin);
    this.rebuildSlotParts(slot);
    const suffix = slot.actorId.replace(/[^A-Za-z0-9]/g, '').slice(-3).toUpperCase();
    slot.nameplate.text = slot.username ?? `${titleAnimal(slot.animal)}${suffix ? ` · ${suffix}` : ''}`;
    this.syncText(slot.nameplate);
  }

  private rebuildSlotParts(slot: RemoteSlot): void {
    for (const part of slot.parts) {
      this.slotByInstance.delete(part.instanceId);
      this.batch.deleteInstance(part.instanceId);
    }
    slot.parts = [];
    const visual = slot.visual;
    if (!visual) return;
    for (const mesh of visual.meshes()) {
      const key = visual.geometryKey(slot.animal, mesh);
      let geometryId = this.geometryByKey.get(key);
      if (geometryId === undefined) {
        geometryId = this.batch.addGeometry(mesh.geometry);
        this.geometryByKey.set(key, geometryId);
      }
      const instanceId = this.batch.addInstance(geometryId);
      this.batch.setColorAt(instanceId, materialColor(mesh.material));
      this.batch.setVisibleAt(instanceId, false);
      this.slotByInstance.set(instanceId, slot);
      slot.parts.push({ instanceId, mesh });
    }
    if (slot.parts.length > MAX_PARTS_PER_AVATAR) {
      throw new Error(`Canonical ${slot.animal} rig exceeds the remote batch budget.`);
    }
  }

  private setSlotPartsVisible(slot: RemoteSlot, visible: boolean): void {
    for (const part of slot.parts) this.batch.setVisibleAt(part.instanceId, visible);
  }

  private renderLocalUsername(): void {
    const nameplate = this.localNameplate;
    if (!nameplate) return;
    nameplate.text = this.localUsername ?? '';
    nameplate.visible = Boolean(this.localUsername) && this.visible && this.labelsVisible;
    this.syncText(nameplate);
  }

  private writeRemoteLabels(
    slot: RemoteSlot,
    pose: RemotePose,
    occlusions: readonly ScreenBounds[],
  ): void {
    const labelY = pose.y + this.labelHeight(slot.animal) + 0.28;
    slot.nameplate.position.set(pose.x, labelY, pose.z);
    slot.nameplate.quaternion.copy(this.camera.quaternion);
    slot.speech.position.set(pose.x, labelY + 0.42, pose.z);
    slot.speech.quaternion.copy(this.camera.quaternion);
    const opacity = this.labelOpacity(slot.nameplate.position, slot.speech.visible ? 3.2 : 2.6, occlusions);
    this.setTextOpacity(slot.nameplate, opacity);
    this.setTextOpacity(slot.speech, slot.speech.visible ? Math.max(0.72, opacity) : opacity);
  }

  private writeLocalLabels(now: number, occlusions: readonly ScreenBounds[]): void {
    const nameplate = this.localNameplate;
    const speech = this.localSpeech;
    if (!nameplate || !speech || !this.labelsVisible) {
      if (nameplate) nameplate.visible = false;
      if (speech) speech.visible = false;
      return;
    }
    const local = this.localPosition();
    const animal = validAnimal(this.localAnimal?.() ?? 'fox');
    const labelY = local.y + this.labelHeight(animal) + 0.28;
    nameplate.visible = Boolean(this.localUsername);
    nameplate.position.set(local.x, labelY, local.z);
    nameplate.quaternion.copy(this.camera.quaternion);
    speech.visible = this.localSpeechExpiresAt > now;
    speech.position.set(local.x, labelY + 0.42, local.z);
    speech.quaternion.copy(this.camera.quaternion);
    const opacity = this.labelOpacity(nameplate.position, speech.visible ? 3.2 : 2.6, occlusions);
    this.setTextOpacity(nameplate, opacity);
    this.setTextOpacity(speech, speech.visible ? Math.max(0.72, opacity) : opacity);
    if (this.localSpeechExpiresAt <= now && speech.text) {
      speech.text = '';
      this.syncText(speech);
    }
  }

  private labelHeight(animal: AnimalKind): number {
    return ANIMAL_LABEL_HEIGHTS[animal] * (animalMotionProfile(animal).modelScale / 0.9);
  }

  private labelOpacity(worldPosition: THREE.Vector3, widthWorld: number, occlusions: readonly ScreenBounds[]): number {
    if (occlusions.length === 0) return 1;
    const viewport = this.viewport();
    if (viewport.width <= 0 || viewport.height <= 0) return 1;
    this.screenPoint.copy(worldPosition).project(this.camera);
    this.cameraPoint.copy(worldPosition).applyMatrix4(this.camera.matrixWorldInverse);
    if (this.screenPoint.z < -1 || this.screenPoint.z > 1 || this.cameraPoint.z >= 0) return 1;
    const centerX = viewport.left + (this.screenPoint.x + 1) * viewport.width * 0.5;
    const centerY = viewport.top + (1 - this.screenPoint.y) * viewport.height * 0.5;
    const pixelsPerWorld = viewport.height / Math.max(1, -this.cameraPoint.z * 0.9);
    const halfWidth = Math.max(24, widthWorld * pixelsPerWorld * 0.5);
    const height = Math.max(18, 0.36 * pixelsPerWorld);
    return socialLabelOpacity({
      left: centerX - halfWidth,
      right: centerX + halfWidth,
      top: centerY - height,
      bottom: centerY + 3,
      depth: -this.cameraPoint.z,
    }, occlusions);
  }

  private setTextOpacity(text: Text, opacity: number): void {
    text.outlineOpacity = opacity * 0.96;
    const material = text.material as THREE.Material;
    material.transparent = true;
    material.opacity = opacity;
  }

  private syncText(text: Text): void {
    if (typeof self !== 'undefined') text.sync();
  }
}
