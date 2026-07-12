import * as THREE from 'three';
import type { GameSystem } from '../types';
import type { EmoteKind, ServerEmoteMessage } from './emotes';

type EffectKind = EmoteKind | 'arrival';

export interface EmoteAnchor {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface EmoteVisualSystemOptions {
  readonly parent: THREE.Object3D;
  readonly resolveActor: (actorId: string) => EmoteAnchor | null;
  readonly now?: () => number;
  readonly maxEffects?: number;
  readonly particlesPerEffect?: number;
  readonly reducedMotion?: boolean;
}

interface Effect {
  actorId: string;
  kind: EffectKind;
  nonce: string;
  startedAt: number;
  durationMs: number;
  seed: number;
  active: boolean;
  anchor: THREE.Vector3;
}

const COLORS: Record<EffectKind, readonly [number, number]> = {
  wave: [0x8ac7d8, 0xfff1cf],
  'sparkle-heart': [0xf0a8ba, 0xffe6bf],
  cheer: [0xf2c86c, 0x8ed1a2],
  spin: [0xbda7e7, 0x8ac7d8],
  gasp: [0xffd589, 0xf3a1a9],
  'curl-nap': [0xaeb7e5, 0xe8d7f4],
  arrival: [0xffe5a8, 0x9edbc5],
};

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function duration(kind: EffectKind, reducedMotion: boolean): number {
  const normal = kind === 'curl-nap' ? 3_400 : kind === 'arrival' ? 1_050 : 1_650;
  return reducedMotion ? Math.min(800, normal * 0.55) : normal;
}

function localParticle(
  kind: EffectKind,
  index: number,
  count: number,
  progress: number,
  seed: number,
  target: THREE.Vector3,
): number {
  const phase = ((seed % 997) / 997) * Math.PI * 2;
  const ratio = index / Math.max(1, count);
  const angle = ratio * Math.PI * 2 + phase;
  let scale = Math.sin(Math.PI * progress);
  switch (kind) {
    case 'wave': {
      const arc = ratio * Math.PI * 1.35 - Math.PI * 0.68;
      target.set(Math.sin(arc) * 0.72, 1.35 + Math.cos(arc) * 0.42 + progress * 0.35, 0.05);
      break;
    }
    case 'sparkle-heart': {
      const t = angle;
      target.set(
        Math.sin(t) ** 3 * 0.055,
        1.55 + (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * 0.045,
        Math.sin(progress * Math.PI) * 0.18,
      );
      scale *= 1.18;
      break;
    }
    case 'cheer': {
      const radius = 0.18 + progress * (0.75 + (index % 3) * 0.13);
      target.set(Math.cos(angle) * radius, 1.15 + Math.sin(angle) * radius + progress * 0.45, Math.sin(angle * 2) * 0.25);
      break;
    }
    case 'spin': {
      const radius = 0.72 + Math.sin(progress * Math.PI) * 0.25;
      const spin = angle + progress * Math.PI * 4;
      target.set(Math.cos(spin) * radius, 0.75 + ratio * 0.8, Math.sin(spin) * radius);
      break;
    }
    case 'gasp': {
      const radius = 0.15 + progress * 0.78;
      target.set(Math.cos(angle) * radius, 1.45 + Math.sin(angle) * radius, Math.sin(angle + phase) * 0.16);
      scale *= 1.3;
      break;
    }
    case 'curl-nap': {
      const rise = progress * 1.15 + ratio * 0.4;
      target.set(0.42 + Math.cos(angle + progress * 2.2) * 0.28, 0.72 + rise, 0.18 + Math.sin(angle) * 0.18);
      scale *= 0.82;
      break;
    }
    case 'arrival': {
      const radius = 0.12 + progress * 0.92;
      target.set(Math.cos(angle) * radius, 0.25 + Math.sin(progress * Math.PI) * 0.55, Math.sin(angle) * radius);
      scale *= 1.25;
      break;
    }
  }
  return Math.max(0, scale);
}

export class EmoteVisualSystem implements GameSystem {
  readonly root = new THREE.Group();

  private readonly resolveActor: (actorId: string) => EmoteAnchor | null;
  private readonly now: () => number;
  private readonly maxEffects: number;
  private readonly particlesPerEffect: number;
  private readonly effects: Effect[];
  private readonly knownActors = new Set<string>();
  private readonly blockedActors = new Set<string>();
  private readonly seen = new Map<string, number>();
  private readonly geometry = new THREE.SphereGeometry(0.065, 5, 4);
  private readonly material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.88, depthWrite: false });
  private readonly particles: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly cream = new THREE.Color(0xfff1cf);
  private reducedMotion: boolean;
  private visible = true;
  private disposed = false;

  constructor(options: EmoteVisualSystemOptions) {
    this.resolveActor = options.resolveActor;
    this.now = options.now ?? (() => performance.now());
    this.maxEffects = Math.max(2, Math.min(24, Math.floor(options.maxEffects ?? 16)));
    this.particlesPerEffect = Math.max(6, Math.min(18, Math.floor(options.particlesPerEffect ?? 10)));
    this.reducedMotion = options.reducedMotion ?? false;
    this.effects = Array.from({ length: this.maxEffects }, () => ({
      actorId: '', kind: 'arrival', nonce: '', startedAt: 0, durationMs: 1, seed: 0,
      active: false, anchor: new THREE.Vector3(),
    }));
    this.particles = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      this.maxEffects * this.particlesPerEffect,
    );
    this.particles.name = 'tickerworld-emote-particles';
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 37;
    this.root.name = 'tickerworld-emote-visuals';
    this.root.add(this.particles);
    this.hideAll();
    options.parent.add(this.root);
  }

  trigger(event: Pick<ServerEmoteMessage, 'actorId' | 'kind' | 'nonce'>, now = this.now()): boolean {
    if (this.disposed || this.blockedActors.has(event.actorId)) return false;
    const key = `${event.actorId}:${event.nonce}`;
    const seenUntil = this.seen.get(key) ?? 0;
    if (seenUntil > now) return false;
    this.seen.set(key, now + 12_000);
    return this.start(event.actorId, event.kind, event.nonce, now);
  }

  setActors(actorIds: readonly string[], now = this.now()): void {
    const next = new Set(actorIds.filter((actorId) => !this.blockedActors.has(actorId)));
    for (const actorId of next) {
      if (!this.knownActors.has(actorId)) this.start(actorId, 'arrival', `arrival-${Math.floor(now)}`, now);
    }
    this.knownActors.clear();
    for (const actorId of next) this.knownActors.add(actorId);
  }

  setBlockedActors(actorIds: ReadonlySet<string>): void {
    this.blockedActors.clear();
    for (const actorId of actorIds) this.blockedActors.add(actorId);
    let dirty = false;
    for (let index = 0; index < this.effects.length; index += 1) {
      const effect = this.effects[index]!;
      if (!effect.active || !this.blockedActors.has(effect.actorId)) continue;
      effect.active = false;
      this.hideEffect(index * this.particlesPerEffect);
      dirty = true;
    }
    for (const actorId of this.blockedActors) this.knownActors.delete(actorId);
    if (dirty) this.particles.instanceMatrix.needsUpdate = true;
  }

  setReducedMotion(value: boolean): void { this.reducedMotion = value; }

  update(): void {
    if (this.disposed || !this.visible) return;
    const now = this.now();
    let dirty = false;
    for (let effectIndex = 0; effectIndex < this.effects.length; effectIndex += 1) {
      const effect = this.effects[effectIndex]!;
      const baseIndex = effectIndex * this.particlesPerEffect;
      if (!effect.active) continue;
      const progress = (now - effect.startedAt) / effect.durationMs;
      if (progress >= 1 || progress < 0) {
        effect.active = false;
        this.hideEffect(baseIndex);
        dirty = true;
        continue;
      }
      const anchor = this.resolveActor(effect.actorId);
      if (anchor) effect.anchor.set(anchor.x, anchor.y, anchor.z);
      const colors = COLORS[effect.kind];
      for (let particleIndex = 0; particleIndex < this.particlesPerEffect; particleIndex += 1) {
        const amount = localParticle(
          effect.kind,
          particleIndex,
          this.particlesPerEffect,
          progress,
          effect.seed,
          this.local,
        );
        this.position.copy(effect.anchor).add(this.local);
        const size = 0.55 + amount * (0.85 + (particleIndex % 3) * 0.14);
        this.scale.setScalar(size);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        const instance = baseIndex + particleIndex;
        this.particles.setMatrixAt(instance, this.matrix);
        this.color.setHex(colors[particleIndex % 2]!).lerp(this.cream, progress * 0.42);
        this.particles.setColorAt(instance, this.color);
      }
      dirty = true;
    }
    if (dirty) {
      this.particles.instanceMatrix.needsUpdate = true;
      if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
    }
    for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
  }

  setVisible(value: boolean): void {
    this.visible = value;
    this.root.visible = value;
  }

  getDebugStats(): { active: number; capacity: number; instances: number; drawCalls: number } {
    return {
      active: this.effects.filter((effect) => effect.active).length,
      capacity: this.maxEffects,
      instances: this.maxEffects * this.particlesPerEffect,
      drawCalls: 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.knownActors.clear();
    this.blockedActors.clear();
    this.seen.clear();
  }

  private start(actorId: string, kind: EffectKind, nonce: string, now: number): boolean {
    const anchor = this.resolveActor(actorId);
    if (!anchor) return false;
    const effect = this.effects.find((candidate) => !candidate.active)
      ?? this.effects.reduce((oldest, candidate) => candidate.startedAt < oldest.startedAt ? candidate : oldest);
    effect.actorId = actorId;
    effect.kind = kind;
    effect.nonce = nonce;
    effect.startedAt = now;
    effect.durationMs = duration(kind, this.reducedMotion);
    effect.seed = hash(`${actorId}:${nonce}:${kind}`);
    effect.anchor.set(anchor.x, anchor.y, anchor.z);
    effect.active = true;
    return true;
  }

  private hideAll(): void {
    for (let index = 0; index < this.maxEffects * this.particlesPerEffect; index += 1) {
      this.matrix.makeScale(0, 0, 0);
      this.particles.setMatrixAt(index, this.matrix);
    }
    this.particles.instanceMatrix.needsUpdate = true;
  }

  private hideEffect(baseIndex: number): void {
    for (let index = 0; index < this.particlesPerEffect; index += 1) {
      this.matrix.makeScale(0, 0, 0);
      this.particles.setMatrixAt(baseIndex + index, this.matrix);
    }
  }
}
