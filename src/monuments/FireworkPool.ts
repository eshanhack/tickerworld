import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
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
  active: boolean;
  delay: number;
  x: number;
  y: number;
  z: number;
  direction: FireworkDirection;
  strength: number;
}

const DEFAULT_CAPACITY = 160;
const MAX_PENDING_BURSTS = 8;
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
 * Large moves emit one pastel bloom; exceptional moves queue two more staggered
 * blooms without allocating more geometry, materials, or WebGL draw calls.
 */
export class FireworkPool {
  readonly points: Points<BufferGeometry, PointsMaterial>;
  readonly capacity: number;

  private readonly random: () => number;
  private readonly particles: FireworkParticle[];
  private readonly pendingBursts: PendingBurst[];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private cursor = 0;
  private emittedBursts = 0;
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
      size: 0.43,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      vertexColors: true,
      blending: AdditiveBlending,
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
    this.pendingBursts = Array.from({ length: MAX_PENDING_BURSTS }, () => ({
      active: false,
      delay: 0,
      x: 0,
      y: 0,
      z: 0,
      direction: 'up' as const,
      strength: 1,
    }));
  }

  /** Launches a firework above a chart in the `points` parent coordinate space. */
  launch(
    position: FireworkPosition,
    direction: FireworkDirection,
    tier: FireworkTier,
  ): boolean {
    if (this.disposed || !finitePosition(position)) return false;

    const reduced = this.reducedMotion;
    this.emitBurst(position.x, position.y, position.z, direction, reduced ? 0.48 : 1);
    if (tier === 'exceptional' && !reduced) {
      this.queueBurst(position, direction, 0.2, -1.45, 0.7, 0.92);
      this.queueBurst(position, direction, 0.42, 1.5, 1.15, 1.08);
    }
    return true;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      for (const pending of this.pendingBursts) pending.active = false;
    }
  }

  update(deltaSeconds: number): void {
    if (this.disposed) return;
    const delta = Math.min(0.1, Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));

    for (const pending of this.pendingBursts) {
      if (!pending.active) continue;
      pending.delay -= delta;
      if (pending.delay <= 0) {
        this.emitBurst(
          pending.x,
          pending.y,
          pending.z,
          pending.direction,
          pending.strength,
        );
        pending.active = false;
      }
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
      pendingBursts: this.pendingBursts.reduce((count, burst) => count + Number(burst.active), 0),
      emittedBursts: this.emittedBursts,
      reducedMotion: this.reducedMotion,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const particle of this.particles) particle.active = false;
    for (const pending of this.pendingBursts) pending.active = false;
    this.points.geometry.setDrawRange(0, 0);
    this.points.visible = false;
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }

  private queueBurst(
    position: FireworkPosition,
    direction: FireworkDirection,
    delay: number,
    offsetX: number,
    offsetY: number,
    strength: number,
  ): void {
    const pending = this.pendingBursts.find((candidate) => !candidate.active);
    if (!pending) return;
    pending.active = true;
    pending.delay = delay;
    pending.x = position.x + offsetX;
    pending.y = position.y + offsetY;
    pending.z = position.z + (this.random() - 0.5) * 1.4;
    pending.direction = direction;
    pending.strength = strength;
  }

  private emitBurst(
    x: number,
    y: number,
    z: number,
    direction: FireworkDirection,
    strength: number,
  ): void {
    const count = this.reducedMotion
      ? 8
      : Math.max(18, Math.min(30, Math.round(23 * strength)));
    const palette = direction === 'up' ? UP_COLORS : DOWN_COLORS;
    this.emittedBursts += 1;

    for (let index = 0; index < count; index += 1) {
      const particle = this.nextParticle();
      if (!particle) break;
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
    }
  }

  private nextParticle(): FireworkParticle | null {
    for (let offset = 0; offset < this.particles.length; offset += 1) {
      const index = (this.cursor + offset) % this.particles.length;
      const particle = this.particles[index];
      if (particle && !particle.active) {
        this.cursor = (index + 1) % this.particles.length;
        return particle;
      }
    }
    return null;
  }
}
