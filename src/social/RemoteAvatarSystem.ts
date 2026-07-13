import * as THREE from 'three';
import { Text } from 'troika-three-text';
import {
  ANIMAL_KINDS,
  MAX_SPRINT_SPEED,
  REMOTE_INTERPOLATION_DELAY_MS,
  type AnimalKind,
  type ChatMessage,
  type NetPlayerState,
  type SkinId,
} from '../../shared/src/index.js';
import type { GameSystem } from '../types';
import { resolveAnimalAppearance } from '../player/animalAppearance';
import { animalMotionProfile } from '../player/animalProfiles';
import {
  clipSpeech,
  interpolateRemotePose,
  socialLabelOpacity,
  type RemotePose,
  type ScreenBounds,
} from './avatarMath';

const MAX_REMOTE_PLAYERS = 49;
// The sacred chart overlay begins at render order 40. Social labels render
// immediately beneath it so they can never paint over candles or price UI.
const LABEL_RENDER_ORDER = 38;
const BUBBLE_RENDER_ORDER = 39;
const SPEECH_LIFETIME_MS = 5_000;
const SAMPLE_LIMIT = 6;
const HIDDEN_SCALE = new THREE.Vector3(0, 0, 0);

interface AnimalProfile {
  readonly body: number;
  readonly cream: number;
  readonly bodyScale: readonly [number, number, number];
  readonly headScale: readonly [number, number, number];
  readonly earScale: readonly [number, number, number];
  readonly tailScale: readonly [number, number, number];
  readonly height: number;
}

const ANIMAL_PROFILES: Readonly<Record<AnimalKind, AnimalProfile>> = {
  fox: {
    body: 0xc9795c, cream: 0xffe7c0, bodyScale: [0.72, 0.58, 1.02],
    headScale: [0.5, 0.48, 0.54], earScale: [0.18, 0.34, 0.18], tailScale: [0.25, 0.25, 0.95], height: 1.72,
  },
  penguin: {
    body: 0x526a78, cream: 0xfff1cf, bodyScale: [0.67, 0.82, 0.63],
    headScale: [0.49, 0.49, 0.47], earScale: [0.01, 0.01, 0.01], tailScale: [0.14, 0.12, 0.28], height: 1.72,
  },
  frog: {
    body: 0x79ad79, cream: 0xe7efbd, bodyScale: [0.75, 0.53, 0.75],
    headScale: [0.58, 0.42, 0.52], earScale: [0.18, 0.18, 0.18], tailScale: [0.01, 0.01, 0.01], height: 1.5,
  },
  duck: {
    body: 0xe2b95f, cream: 0xffedb1, bodyScale: [0.67, 0.61, 0.79],
    headScale: [0.49, 0.48, 0.47], earScale: [0.01, 0.01, 0.01], tailScale: [0.2, 0.16, 0.32], height: 1.6,
  },
  bear: {
    body: 0x9b765e, cream: 0xe9cfa9, bodyScale: [0.82, 0.72, 0.84],
    headScale: [0.56, 0.52, 0.52], earScale: [0.2, 0.15, 0.2], tailScale: [0.15, 0.15, 0.18], height: 1.75,
  },
  rabbit: {
    body: 0xc0a5c8, cream: 0xf5e5ed, bodyScale: [0.64, 0.59, 0.83],
    headScale: [0.48, 0.48, 0.49], earScale: [0.17, 0.58, 0.17], tailScale: [0.2, 0.2, 0.2], height: 1.73,
  },
  cat: {
    body: 0xb88671, cream: 0xf4d7bd, bodyScale: [0.65, 0.57, 0.87],
    headScale: [0.48, 0.46, 0.48], earScale: [0.17, 0.29, 0.17], tailScale: [0.14, 0.14, 0.88], height: 1.66,
  },
  axolotl: {
    body: 0xd99aa8, cream: 0xf5ced5, bodyScale: [0.67, 0.51, 0.91],
    headScale: [0.57, 0.43, 0.51], earScale: [0.28, 0.13, 0.12], tailScale: [0.17, 0.25, 0.72], height: 1.5,
  },
  saylor: {
    body: 0x263a59, cream: 0xe4b18e, bodyScale: [0.44, 0.73, 0.29],
    headScale: [0.34, 0.4, 0.33], earScale: [0, 0, 0], tailScale: [0, 0, 0], height: 2.12,
  },
};

interface TimedRemoteState {
  readonly at: number;
  readonly state: NetPlayerState;
}

interface RemoteSlot {
  readonly index: number;
  actorId: string;
  animal: AnimalKind;
  skin: SkinId;
  premium: boolean;
  username: string | null;
  readonly samples: TimedRemoteState[];
  readonly nameplate: Text;
  readonly speech: Text;
  speechExpiresAt: number;
  gaitPhase: number;
  active: boolean;
  rendered: boolean;
  lastSourceUpdate: number;
}

interface PartPool {
  readonly mesh: THREE.InstancedMesh;
  readonly geometry: THREE.BufferGeometry;
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
  readonly localPosition?: () => Readonly<THREE.Vector3>;
  /**
   * Opts the local player into the same camera-facing, chart-aware nameplate
   * treatment as remote players. The label remains hidden until a username is
   * saved, so anonymous play keeps the original clean silhouette.
   */
  readonly localNameplate?: {
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

function titleAnimal(animal: AnimalKind): string {
  if (animal === 'saylor') return 'Michael Saylor';
  return `${animal.charAt(0).toUpperCase()}${animal.slice(1)}`;
}

function validAnimal(value: AnimalKind): AnimalKind {
  return ANIMAL_KINDS.includes(value) ? value : 'fox';
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

function createPool(
  geometry: THREE.BufferGeometry,
  material: THREE.MeshStandardMaterial,
  capacity: number,
  name: string,
): PartPool {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Allocate the instanced colour attribute before the material is ever
  // compiled. Creating it lazily when the first remote joins can leave an
  // already-compiled shader without USE_INSTANCING_COLOR, rendering every
  // remote solid black until a later material recompile.
  const initialColor = new THREE.Color(0xffffff);
  for (let index = 0; index < capacity; index += 1) mesh.setColorAt(index, initialColor);
  if (mesh.instanceColor) {
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return { mesh, geometry };
}

export class RemoteAvatarSystem implements GameSystem {
  readonly root = new THREE.Group();

  private readonly camera: THREE.Camera;
  private readonly capacity: number;
  private readonly interpolationDelayMs: number;
  private readonly cullDistanceSquared: number;
  private readonly localPosition: () => Readonly<THREE.Vector3>;
  private readonly viewport: () => RemoteAvatarViewport;
  private readonly occlusionBounds: () => readonly ScreenBounds[];
  private readonly now: () => number;
  private readonly slots: RemoteSlot[] = [];
  private readonly slotByActor = new Map<string, RemoteSlot>();
  private readonly blocked = new Set<string>();
  private readonly pendingSpeech = new Map<string, { text: string; expiresAt: number }>();
  private readonly localNameplate?: Text;
  private readonly localAnimal?: () => AnimalKind;
  private localUsername: string | null = null;
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.84,
    metalness: 0,
    // InstancedMesh.instanceColor is enabled independently by Three. Enabling
    // vertexColors here also asks for a missing per-vertex `color` attribute;
    // WebGL supplies zeroes for it and multiplies every pastel instance black.
    vertexColors: false,
    flatShading: true,
  });
  private readonly body: PartPool;
  private readonly head: PartPool;
  private readonly earLeft: PartPool;
  private readonly earRight: PartPool;
  private readonly legFrontLeft: PartPool;
  private readonly legFrontRight: PartPool;
  private readonly legHindLeft: PartPool;
  private readonly legHindRight: PartPool;
  private readonly tail: PartPool;
  private readonly crest: PartPool;
  private readonly allPools: readonly PartPool[];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly rootMatrix = new THREE.Matrix4();
  private readonly localMatrix = new THREE.Matrix4();
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly localQuaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly localScale = new THREE.Vector3();
  private readonly screenPoint = new THREE.Vector3();
  private readonly cameraPoint = new THREE.Vector3();
  private visible = true;
  private labelsVisible = true;
  private disposed = false;

  constructor(options: RemoteAvatarSystemOptions) {
    this.camera = options.camera;
    this.capacity = Math.max(1, Math.min(MAX_REMOTE_PLAYERS, Math.floor(options.maxPlayers ?? MAX_REMOTE_PLAYERS)));
    this.interpolationDelayMs = Math.max(0, options.interpolationDelayMs ?? REMOTE_INTERPOLATION_DELAY_MS);
    const cullDistance = Math.max(8, options.cullDistance ?? 68);
    this.cullDistanceSquared = cullDistance * cullDistance;
    this.localPosition = options.localPosition ?? (() => this.camera.position);
    this.viewport = options.viewport ?? (() => ({ left: 0, top: 0, width: innerWidth, height: innerHeight }));
    this.occlusionBounds = options.occlusionBounds ?? (() => []);
    this.now = options.now ?? (() => performance.now());
    this.root.name = 'tickerworld-remote-avatars';

    const sphere = new THREE.SphereGeometry(1, 7, 5);
    const legGeometry = new THREE.CapsuleGeometry(0.5, 0.75, 2, 5);
    const earGeometry = new THREE.ConeGeometry(0.5, 1, 5);
    const tailGeometry = new THREE.CapsuleGeometry(0.5, 1.15, 2, 5);
    this.body = createPool(sphere, this.material, this.capacity, 'remote-body-pool');
    this.head = createPool(sphere, this.material, this.capacity, 'remote-head-pool');
    this.earLeft = createPool(earGeometry, this.material, this.capacity, 'remote-left-ear-pool');
    this.earRight = createPool(earGeometry, this.material, this.capacity, 'remote-right-ear-pool');
    this.legFrontLeft = createPool(legGeometry, this.material, this.capacity, 'remote-front-left-leg-pool');
    this.legFrontRight = createPool(legGeometry, this.material, this.capacity, 'remote-front-right-leg-pool');
    this.legHindLeft = createPool(legGeometry, this.material, this.capacity, 'remote-hind-left-leg-pool');
    this.legHindRight = createPool(legGeometry, this.material, this.capacity, 'remote-hind-right-leg-pool');
    this.tail = createPool(tailGeometry, this.material, this.capacity, 'remote-tail-pool');
    this.crest = createPool(earGeometry, this.material, this.capacity, 'remote-crest-pool');
    this.allPools = [
      this.body, this.head, this.earLeft, this.earRight,
      this.legFrontLeft, this.legFrontRight, this.legHindLeft, this.legHindRight,
      this.tail, this.crest,
    ];
    for (const pool of this.allPools) this.root.add(pool.mesh);

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
        premium: false,
        username: null,
        samples: [],
        nameplate,
        speech,
        speechExpiresAt: 0,
        gaitPhase: 0,
        active: false,
        rendered: false,
        lastSourceUpdate: Number.NEGATIVE_INFINITY,
      });
      this.hideMatrices(index);
    }
    if (options.localNameplate) {
      this.localAnimal = options.localNameplate.animal;
      this.localUsername = options.localNameplate.username?.trim() || null;
      const nameplate = new Text();
      nameplate.name = 'local-player-nameplate';
      configureLabel(nameplate, options.fontUrl, false);
      this.localNameplate = nameplate;
      this.root.add(nameplate);
      this.renderLocalUsername();
    }
    this.flushMatrices();
    options.parent.add(this.root);
  }

  /** Updates the local label immediately; networking is deliberately optional. */
  setLocalUsername(username: string | null): void {
    if (!this.localNameplate || this.disposed) return;
    this.localUsername = username?.trim() || null;
    this.renderLocalUsername();
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
    const expiresAt = this.now() + SPEECH_LIFETIME_MS;
    const text = clipSpeech(message.text);
    const slot = this.slotByActor.get(message.actorId);
    if (!slot) {
      this.pendingSpeech.set(message.actorId, { text, expiresAt });
      return;
    }
    this.setSlotSpeech(slot, text, expiresAt);
  }

  pickAt(clientX: number, clientY: number, domElement: HTMLElement): NetPlayerState | null {
    if (this.disposed || !this.visible) return null;
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([this.head.mesh, this.body.mesh], false);
    for (const hit of hits) {
      if (hit.instanceId === undefined) continue;
      const slot = this.slots[hit.instanceId];
      if (!slot?.active || !slot.rendered || this.blocked.has(slot.actorId)) continue;
      return slot.samples[slot.samples.length - 1]?.state ?? null;
    }
    return null;
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
      const distanceSquared = (pose.x - local.x) ** 2 + (pose.z - local.z) ** 2;
      const shouldRender = distanceSquared <= this.cullDistanceSquared;
      slot.rendered = shouldRender;
      slot.nameplate.visible = shouldRender && this.labelsVisible;
      slot.speech.visible = shouldRender && this.labelsVisible && slot.speechExpiresAt > now;
      if (!shouldRender) {
        this.hideMatrices(slot.index);
        continue;
      }
      slot.gaitPhase += Math.max(0, deltaSeconds)
        * (2.4 + Math.min(8, pose.speed) * 1.18)
        * animalMotionProfile(slot.animal).gaitScale;
      this.writeAvatar(slot, pose, occlusions);
      if (slot.speechExpiresAt <= now && slot.speech.text) {
        slot.speech.text = '';
        this.syncText(slot.speech);
      }
    }
    this.writeLocalNameplate(occlusions);
    this.flushMatrices();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  /** Keeps staged captures private without removing the connected avatars. */
  setLabelsVisible(visible: boolean): void {
    this.labelsVisible = visible;
    if (visible) return;
    if (this.localNameplate) this.localNameplate.visible = false;
    for (const slot of this.slots) {
      slot.nameplate.visible = false;
      slot.speech.visible = false;
    }
  }

  getDebugStats(): RemoteAvatarDebugStats {
    return {
      active: this.slots.filter((slot) => slot.active).length,
      rendered: this.slots.filter((slot) => slot.rendered).length,
      capacity: this.capacity,
      drawCalls: this.allPools.length,
      geometries: new Set(this.allPools.map((pool) => pool.geometry)).size,
      materials: 1,
      labels: this.slots.length * 2 + (this.localNameplate ? 1 : 0),
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
      slot.samples.length = 0;
    }
    this.localNameplate?.dispose();
    this.localNameplate?.removeFromParent();
    const geometries = new Set(this.allPools.map((pool) => pool.geometry));
    for (const geometry of geometries) geometry.dispose();
    this.material.dispose();
    this.slotByActor.clear();
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
    slot.lastSourceUpdate = Number.NEGATIVE_INFINITY;
    slot.gaitPhase = 0;
    slot.samples.length = 0;
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
    slot.actorId = '';
    slot.samples.length = 0;
    slot.nameplate.visible = false;
    slot.speech.visible = false;
    slot.speech.text = '';
    slot.speechExpiresAt = 0;
    this.hideMatrices(slot.index);
  }

  private setSlotSpeech(slot: RemoteSlot, text: string, expiresAt: number): void {
    slot.speech.text = text;
    slot.speechExpiresAt = expiresAt;
    this.syncText(slot.speech);
  }

  private applyAppearance(slot: RemoteSlot): void {
    const profile = ANIMAL_PROFILES[slot.animal];
    const appearance = resolveAnimalAppearance(slot.animal, slot.skin);
    slot.premium = appearance.premium;
    const bodyColor = new THREE.Color(appearance.palette.primary ?? profile.body);
    const creamColor = new THREE.Color(appearance.palette.secondary ?? profile.cream);
    const tailColor = new THREE.Color(appearance.palette.highlight ?? appearance.palette.primary);
    if (slot.animal === 'saylor') {
      const hairColor = new THREE.Color(appearance.palette.dark);
      const accentColor = new THREE.Color(appearance.palette.accent);
      this.body.mesh.setColorAt(slot.index, bodyColor);
      this.head.mesh.setColorAt(slot.index, creamColor);
      this.earLeft.mesh.setColorAt(slot.index, hairColor);
      this.earRight.mesh.setColorAt(slot.index, hairColor);
      this.legFrontLeft.mesh.setColorAt(slot.index, bodyColor);
      this.legFrontRight.mesh.setColorAt(slot.index, bodyColor);
      this.legHindLeft.mesh.setColorAt(slot.index, bodyColor);
      this.legHindRight.mesh.setColorAt(slot.index, bodyColor);
      this.tail.mesh.setColorAt(slot.index, hairColor);
      this.crest.mesh.setColorAt(slot.index, accentColor);
    } else {
      this.body.mesh.setColorAt(slot.index, bodyColor);
      this.head.mesh.setColorAt(slot.index, bodyColor);
      this.earLeft.mesh.setColorAt(slot.index, bodyColor);
      this.earRight.mesh.setColorAt(slot.index, bodyColor);
      this.legFrontLeft.mesh.setColorAt(slot.index, creamColor);
      this.legFrontRight.mesh.setColorAt(slot.index, creamColor);
      this.legHindLeft.mesh.setColorAt(slot.index, creamColor);
      this.legHindRight.mesh.setColorAt(slot.index, creamColor);
      this.tail.mesh.setColorAt(slot.index, tailColor);
      this.crest.mesh.setColorAt(slot.index, tailColor);
    }
    for (const pool of this.allPools) {
      if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    }
    const suffix = slot.actorId.replace(/[^A-Za-z0-9]/g, '').slice(-3).toUpperCase();
    slot.nameplate.text = slot.username ?? `${titleAnimal(slot.animal)}${suffix ? ` · ${suffix}` : ''}`;
    this.syncText(slot.nameplate);
  }

  private renderLocalUsername(): void {
    const nameplate = this.localNameplate;
    if (!nameplate) return;
    nameplate.text = this.localUsername ?? '';
    nameplate.visible = Boolean(this.localUsername) && this.visible && this.labelsVisible;
    this.syncText(nameplate);
  }

  private writeLocalNameplate(occlusions: readonly ScreenBounds[]): void {
    const nameplate = this.localNameplate;
    if (!nameplate || !this.localUsername || !this.labelsVisible) {
      if (nameplate) nameplate.visible = false;
      return;
    }
    const local = this.localPosition();
    const animal = this.localAnimal?.() ?? 'fox';
    const profile = ANIMAL_PROFILES[validAnimal(animal)];
    const proportionalHeight = profile.height * (animalMotionProfile(animal).modelScale / 0.9);
    nameplate.visible = true;
    nameplate.position.set(local.x, local.y + proportionalHeight + 0.28, local.z);
    nameplate.quaternion.copy(this.camera.quaternion);
    this.setTextOpacity(nameplate, this.labelOpacity(nameplate.position, 2.6, occlusions));
  }

  private writeAvatar(slot: RemoteSlot, pose: RemotePose, occlusions: readonly ScreenBounds[]): void {
    const profile = ANIMAL_PROFILES[slot.animal];
    this.position.set(pose.x, pose.y, pose.z);
    this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, pose.yaw);
    this.scale.setScalar(animalMotionProfile(slot.animal).modelScale);
    this.rootMatrix.compose(this.position, this.quaternion, this.scale);
    const bob = pose.grounded ? Math.sin(slot.gaitPhase * 2) * Math.min(0.06, pose.speed * 0.009) : 0.07;
    const movement = Math.min(1, pose.speed / MAX_SPRINT_SPEED);
    const swing = Math.sin(slot.gaitPhase) * movement;
    const opposite = Math.sin(slot.gaitPhase + Math.PI) * movement;
    const legLift = Math.abs(Math.sin(slot.gaitPhase)) * 0.13 * movement;

    if (slot.animal === 'saylor') {
      const airborne = pose.grounded ? 0 : 1;
      const humanBob = pose.grounded ? bob * 0.42 : 0.055;
      const leftLift = Math.max(0, Math.sin(slot.gaitPhase)) * 0.11 * movement;
      const rightLift = Math.max(0, Math.sin(slot.gaitPhase + Math.PI)) * 0.11 * movement;
      this.writePart(this.body.mesh, slot.index, [0, 1.22 + humanBob, 0], [0.025 - airborne * 0.08, 0, 0], profile.bodyScale);
      this.writePart(this.head.mesh, slot.index, [0, 2.03 + humanBob, -0.035], [-0.025, 0, 0], profile.headScale);
      // The front-leg pools become suit sleeves and counter-swing naturally
      // against the two visible legs. This keeps the original fixed draw-call
      // budget while giving the public-figure tribute a true biped silhouette.
      this.writePart(this.legFrontLeft.mesh, slot.index, [-0.5, 1.22 + humanBob, 0], [opposite * 0.72 - airborne * 0.55, 0, -0.035], [0.14, 0.57, 0.14]);
      this.writePart(this.legFrontRight.mesh, slot.index, [0.5, 1.22 + humanBob, 0], [swing * 0.72 - airborne * 0.55, 0, 0.035], [0.14, 0.57, 0.14]);
      this.writePart(this.legHindLeft.mesh, slot.index, [-0.22, 0.49 + leftLift, 0.03], [swing * 0.56 + airborne * 0.25, 0, 0], [0.17, 0.64, 0.17]);
      this.writePart(this.legHindRight.mesh, slot.index, [0.22, 0.49 + rightLift, 0.03], [opposite * 0.56 + airborne * 0.25, 0, 0], [0.17, 0.64, 0.17]);
      this.hidePart(this.earLeft.mesh, slot.index);
      this.hidePart(this.earRight.mesh, slot.index);
      this.hidePart(this.tail.mesh, slot.index);
      // The existing crest cone becomes the orange tie/pin on the front of
      // the suit. It is intentionally visible for the base Saylor character,
      // independent of the legacy premium-crest flag.
      this.writePart(this.crest.mesh, slot.index, [0, 1.39 + humanBob, -0.31], [0, 0, Math.PI], [0.115, 0.27, 0.07]);
    } else {
      this.writePart(this.body.mesh, slot.index, [0, 1.02 + bob, 0], [0, 0, 0], profile.bodyScale);
      this.writePart(this.head.mesh, slot.index, [0, 1.36 + profile.height * 0.13 + bob, -0.62], [0.03, 0, 0], profile.headScale);
      this.writePart(this.earLeft.mesh, slot.index, [-0.25, 1.74 + bob, -0.65], [0, 0, -0.08], profile.earScale);
      this.writePart(this.earRight.mesh, slot.index, [0.25, 1.74 + bob, -0.65], [0, 0, 0.08], profile.earScale);
      this.writePart(this.legFrontLeft.mesh, slot.index, [-0.34, 0.48 + legLift, -0.45], [swing * 0.5, 0, 0], [0.19, 0.43, 0.19]);
      this.writePart(this.legFrontRight.mesh, slot.index, [0.34, 0.48, -0.45], [opposite * 0.5, 0, 0], [0.19, 0.43, 0.19]);
      this.writePart(this.legHindLeft.mesh, slot.index, [-0.34, 0.48, 0.45], [opposite * 0.5, 0, 0], [0.2, 0.45, 0.2]);
      this.writePart(this.legHindRight.mesh, slot.index, [0.34, 0.48 + legLift, 0.45], [swing * 0.5, 0, 0], [0.2, 0.45, 0.2]);
      this.writePart(this.tail.mesh, slot.index, [0, 1.05 + bob, 0.78], [0.72, 0, 0], profile.tailScale);
      if (slot.premium) {
        this.writePart(this.crest.mesh, slot.index, [0, 1.96 + bob, -0.6], [0, 0, Math.PI], [0.15, 0.18, 0.15]);
      } else {
        this.hidePart(this.crest.mesh, slot.index);
      }
    }

    const labelY = pose.y
      + profile.height * (animalMotionProfile(slot.animal).modelScale / 0.9)
      + 0.28;
    slot.nameplate.position.set(pose.x, labelY, pose.z);
    slot.nameplate.quaternion.copy(this.camera.quaternion);
    slot.speech.position.set(pose.x, labelY + 0.42, pose.z);
    slot.speech.quaternion.copy(this.camera.quaternion);
    const opacity = this.labelOpacity(slot.nameplate.position, slot.speech.visible ? 3.2 : 2.6, occlusions);
    this.setTextOpacity(slot.nameplate, opacity);
    this.setTextOpacity(slot.speech, opacity);
  }

  private writePart(
    mesh: THREE.InstancedMesh,
    index: number,
    position: readonly [number, number, number],
    rotation: readonly [number, number, number],
    scale: readonly [number, number, number],
  ): void {
    this.position.set(position[0], position[1], position[2]);
    this.localQuaternion.setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]));
    this.localScale.set(scale[0], scale[1], scale[2]);
    this.localMatrix.compose(this.position, this.localQuaternion, this.localScale);
    this.worldMatrix.multiplyMatrices(this.rootMatrix, this.localMatrix);
    mesh.setMatrixAt(index, this.worldMatrix);
  }

  private hidePart(mesh: THREE.InstancedMesh, index: number): void {
    this.localMatrix.compose(this.position.set(0, -1_000, 0), this.localQuaternion.identity(), HIDDEN_SCALE);
    mesh.setMatrixAt(index, this.localMatrix);
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
    // Troika also syncs lazily before its first render. The guard keeps the
    // pooled renderer usable in SSR and deterministic resource tests.
    if (typeof self !== 'undefined') text.sync();
  }

  private hideMatrices(index: number): void {
    this.localMatrix.compose(this.position.set(0, -1_000, 0), this.localQuaternion.identity(), HIDDEN_SCALE);
    for (const pool of this.allPools) pool.mesh.setMatrixAt(index, this.localMatrix);
  }

  private flushMatrices(): void {
    for (const pool of this.allPools) pool.mesh.instanceMatrix.needsUpdate = true;
  }
}
