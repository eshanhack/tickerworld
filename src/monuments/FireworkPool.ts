import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  NormalBlending,
  Points,
  PointsMaterial,
} from 'three';

export interface FireworkPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type FireworkDirection = 'up' | 'down';
export type FireworkTier = 'large' | 'exceptional';

export interface FireworkPoolOptions {
  readonly capacity?: number;
  readonly reducedMotion?: boolean;
  /** Injectable for deterministic QA. */
  readonly random?: () => number;
}

export interface FireworkPoolDebugStats {
  readonly capacity: number;
  readonly activeParticles: number;
  readonly pendingBursts: number;
  readonly emittedBursts: number;
  readonly emittedParticles: number;
  readonly recentBurstOrigins: readonly FireworkPosition[];
  readonly reducedMotion: boolean;
}

interface FireworkParticle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  red: number;
  green: number;
  blue: number;
  life: number;
  maxLife: number;
}

interface PendingBurst {
  remaining: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly direction: FireworkDirection;
  readonly strength: number;
}

interface BurstCue {
  readonly delay: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;
  readonly strength: number;
}

const DEFAULT_CAPACITY = 160;
const MAX_PENDING_BURSTS = 12;
const MAX_RECORDED_BURST_ORIGINS = 12;
const LARGE_SHOW: readonly BurstCue[] = [
  { delay: 0, offsetX: 0, offsetY: 0, offsetZ: 0, strength: 1.18 },
  { delay: 0.24, offsetX: 4.2, offsetY: 1.25, offsetZ: 1.8, strength: 0.98 },
  { delay: 0.52, offsetX: -4.4, offsetY: 2.2, offsetZ: -1.4, strength: 1.06 },
] as const;
const EXCEPTIONAL_SHOW: readonly BurstCue[] = [
  { delay: 0, offsetX: 0, offsetY: 0, offsetZ: 0, strength: 1.28 },
  { delay: 0.16, offsetX: -4.8, offsetY: 1.1, offsetZ: 1.6, strength: 1.08 },
  { delay: 0.32, offsetX: 5.1, offsetY: 1.8, offsetZ: -1.7, strength: 1.16 },
  { delay: 0.48, offsetX: -2.3, offsetY: 4.1, offsetZ: -3.1, strength: 1.04 },
  { delay: 0.64, offsetX: 2.8, offsetY: 4.8, offsetZ: 2.9, strength: 1.24 },
  { delay: 0.8, offsetX: -6.3, offsetY: 3.3, offsetZ: 0.2, strength: 1.12 },
  { delay: 0.96, offsetX: 6.5, offsetY: 5.5, offsetZ: 0.6, strength: 1.18 },
] as const;
const REDUCED_LARGE_SHOW: readonly BurstCue[] = [
  { delay: 0, offsetX: 0, offsetY: 0, offsetZ: 0, strength: 0.68 },
] as const;
const REDUCED_EXCEPTIONAL_SHOW: readonly BurstCue[] = [
  { delay: 0, offsetX: -1.4, offsetY: 0, offsetZ: 0, strength: 0.7 },
  { delay: 0.46, offsetX: 2.2, offsetY: 1.5, offsetZ: 0.8, strength: 0.64 },
] as const;
const UP_COLORS = [
  [0.28, 0.94, 0.47],
  [1, 0.58, 0.16],
  [1, 0.34, 0.62],
  [0.25, 0.58, 1],
] as const;
const DOWN_COLORS = [
  [0.98, 0.25, 0.25],
  [0.68, 0.3, 0.94],
  [1, 0.44, 0.12],
  [0.2, 0.76, 0.9],
] as const;

function finitePosition(position: FireworkPosition): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

/**
 * One allocation-bounded particle pool for every chart firework. Launch
 * positions use the coordinate space of whichever object owns `points`.
 * Every qualifying move emits a short pastel show. Burst cues and particles
 * both remain strictly bounded so overlapping TEST events cannot grow memory,
 * draw calls, or timers.
 */
export class FireworkPool {
  readonly points: Points<BufferGeometry, PointsMaterial>;
  readonly capacity: number;

  private readonly random: () => number;
  private readonly particles: FireworkParticle[];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly pendingBursts: PendingBurst[] = [];
  private readonly recentBurstOrigins: FireworkPosition[] = [];
  private cursor = 0;
  private emittedBursts = 0;
  private emittedParticles = 0;
  private reducedMotion: boolean;
  private disposed = false;

  constructor(options: FireworkPoolOptions = {}) {
    this.capacity = Math.max(8, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.random = options.random ?? Math.random;
    this.reducedMotion = options.reducedMotion ?? false;
    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);

    const geometry = new BufferGeometry();
    const positionAttribute = new BufferAttribute(this.positions, 3);
    const colorAttribute = new BufferAttribute(this.colors, 3);
    positionAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setDrawRange(0, 0);

    const material = new PointsMaterial({
      // Large, saturated confetti remains legible against the pale daytime sky.
      size: 1.12,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      vertexColors: true,
      blending: NormalBlending,
      toneMapped: false,
    });
    this.points = new Points(geometry, material);
    this.points.name = 'market-firework-pool';
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 8;

    this.particles = Array.from({ length: this.capacity }, () => ({
      active: false,
      x: 0,
      y: 0,
      z: 0,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      red: 1,
      green: 1,
      blue: 1,
      life: 0,
      maxLife: 0,
    }));
  }

  /** Launches a firework above a chart in the `points` parent coordinate space. */
  launch(
    position: FireworkPosition,
    direction: FireworkDirection,
    tier: FireworkTier,
  ): boolean {
    if (this.disposed || !finitePosition(position)) return false;

    const cues = this.reducedMotion
      ? tier === 'exceptional' ? REDUCED_EXCEPTIONAL_SHOW : REDUCED_LARGE_SHOW
      : tier === 'exceptional' ? EXCEPTIONAL_SHOW : LARGE_SHOW;
    const rotation = this.random() * Math.PI * 2;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    for (const cue of cues) {
      const x = position.x + cue.offsetX * cosine - cue.offsetZ * sine;
      const z = position.z + cue.offsetX * sine + cue.offsetZ * cosine;
      if (cue.delay <= 0) {
        this.emitBurst(x, position.y + cue.offsetY, z, direction, cue.strength);
      } else if (this.pendingBursts.length < MAX_PENDING_BURSTS) {
        this.pendingBursts.push({
          remaining: cue.delay,
          x,
          y: position.y + cue.offsetY,
          z,
          direction,
          strength: cue.strength,
        });
      }
    }
    return true;
  }

  setReducedMotion(reduced: boolean): void {
    if (reduced && !this.reducedMotion) this.pendingBursts.length = 0;
    this.reducedMotion = reduced;
  }

  update(deltaSeconds: number): void {
    if (this.disposed) return;
    const delta = Math.min(0.1, Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));

    for (let index = this.pendingBursts.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingBursts[index]!;
      pending.remaining -= delta;
      if (pending.remaining > 0) continue;
      this.pendingBursts.splice(index, 1);
      this.emitBurst(
        pending.x,
        pending.y,
        pending.z,
        pending.direction,
        pending.strength,
      );
    }

    const drag = Math.exp(-0.7 * delta);
    let activeCount = 0;
    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.life -= delta;
      if (particle.life <= 0) {
        particle.active = false;
        continue;
      }

      particle.velocityX *= drag;
      particle.velocityZ *= drag;
      particle.velocityY = particle.velocityY * drag - 3.25 * delta;
      particle.x += particle.velocityX * delta;
      particle.y += particle.velocityY * delta;
      particle.z += particle.velocityZ * delta;

      const progress = 1 - particle.life / particle.maxLife;
      const fade = Math.min(1, particle.life * 3.2) * (1 - progress * 0.42);
      const flicker = 0.82 + Math.sin((progress + activeCount * 0.17) * Math.PI * 9) * 0.12;
      const offset = activeCount * 3;
      this.positions[offset] = particle.x;
      this.positions[offset + 1] = particle.y;
      this.positions[offset + 2] = particle.z;
      this.colors[offset] = particle.red * fade * flicker;
      this.colors[offset + 1] = particle.green * fade * flicker;
      this.colors[offset + 2] = particle.blue * fade * flicker;
      activeCount += 1;
    }

    this.points.geometry.setDrawRange(0, activeCount);
    this.points.geometry.getAttribute('position').needsUpdate = true;
    this.points.geometry.getAttribute('color').needsUpdate = true;
    this.points.visible = activeCount > 0;
  }

  getDebugStats(): FireworkPoolDebugStats {
    return {
      capacity: this.capacity,
      activeParticles: this.particles.reduce((count, particle) => count + Number(particle.active), 0),
      pendingBursts: this.pendingBursts.length,
      emittedBursts: this.emittedBursts,
      emittedParticles: this.emittedParticles,
      recentBurstOrigins: this.recentBurstOrigins.map((origin) => ({ ...origin })),
      reducedMotion: this.reducedMotion,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingBursts.length = 0;
    this.recentBurstOrigins.length = 0;
    for (const particle of this.particles) particle.active = false;
    this.points.geometry.setDrawRange(0, 0);
    this.points.visible = false;
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }

  private emitBurst(
    x: number,
    y: number,
    z: number,
    direction: FireworkDirection,
    strength: number,
  ): void {
    const count = this.reducedMotion
      ? Math.max(4, Math.min(7, Math.round(7 * strength)))
      : Math.max(20, Math.min(32, Math.round(24 * strength)));
    const palette = direction === 'up' ? UP_COLORS : DOWN_COLORS;
    this.emittedBursts += 1;
    this.recentBurstOrigins.push({ x, y, z });
    if (this.recentBurstOrigins.length > MAX_RECORDED_BURST_ORIGINS) {
      this.recentBurstOrigins.shift();
    }

    for (let index = 0; index < count; index += 1) {
      const particle = this.nextParticle();
      const phase = index / count * Math.PI * 2 + this.random() * 0.22;
      const elevation = -0.32 + this.random() * 1.42;
      const speed = (2.8 + this.random() * 2.35) * strength;
      const horizontal = Math.cos(elevation) * speed;
      const color = palette[Math.min(palette.length - 1, Math.floor(this.random() * palette.length))]
        ?? palette[0];

      particle.active = true;
      particle.x = x;
      particle.y = y;
      particle.z = z;
      particle.velocityX = Math.cos(phase) * horizontal;
      particle.velocityY = Math.sin(elevation) * speed + 0.85 * strength;
      particle.velocityZ = Math.sin(phase) * horizontal;
      particle.red = color[0];
      particle.green = color[1];
      particle.blue = color[2];
      particle.maxLife = (this.reducedMotion ? 0.68 : 1.35) + this.random() * 0.42;
      particle.life = particle.maxLife;
      this.emittedParticles += 1;
    }
  }

  private nextParticle(): FireworkParticle {
    for (let offset = 0; offset < this.particles.length; offset += 1) {
      const index = (this.cursor + offset) % this.particles.length;
      const particle = this.particles[index];
      if (particle && !particle.active) {
        this.cursor = (index + 1) % this.particles.length;
        return particle;
      }
    }
    // At low quality, later show cues replace the oldest pooled tail instead
    // of disappearing. Capacity and one-draw-call invariants remain unchanged.
    const particle = this.particles[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.particles.length;
    return particle;
  }
}
