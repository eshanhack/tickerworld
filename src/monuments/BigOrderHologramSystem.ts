import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Camera,
  ConeGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import { Text } from 'troika-three-text';
import {
  MARKET_TRADE_CONFIG,
  classifyTradeTier,
  type TradeHologramConfig,
} from '../trades/config';
import type { AggregatedOrder, TradeSide, TradeTier } from '../trades/types';
import type { AssetSymbol } from '../types';
import {
  MONUMENT_CANDLE_COLORS,
  MONUMENT_OVERLAY_RENDER_ORDER,
} from './Monument';

export type BigOrderHologramTier = 'big' | 'whale';

/**
 * Deliberately structural so a full AggregatedOrder can be passed without an
 * adapter, while deterministic tests and debug tools can provide only the
 * fields that affect presentation.
 */
export interface BigOrderHologramEvent {
  readonly symbol: AssetSymbol;
  readonly side: TradeSide;
  readonly tier: TradeTier;
  readonly notionalUsd: number;
  readonly simulated?: boolean;
  readonly endedAt?: number;
}

interface SignificantHologramEvent extends Omit<BigOrderHologramEvent, 'tier'> {
  readonly tier: BigOrderHologramTier;
}

export interface BigOrderHologramAnchorProvider {
  getBigOrderHologramAnchor(slot: number, target?: Vector3): Vector3;
}

export interface BigOrderHologramSystemOptions {
  readonly parent: Object3D;
  readonly camera: Camera;
  readonly fontUrl?: string;
  readonly reducedMotion?: boolean;
}

export interface BigOrderHologramSlotDebugState {
  readonly index: number;
  readonly active: boolean;
  readonly side: TradeSide | null;
  readonly tier: BigOrderHologramTier | null;
  readonly notionalUsd: number;
  readonly simulated: boolean;
  readonly title: string;
  readonly amount: string;
}

export interface BigOrderHologramDebugStats {
  readonly visible: number;
  readonly capacity: number;
  readonly activeDissolveParticles: number;
  readonly coalescedEvents: number;
  readonly preemptedEvents: number;
  readonly droppedEvents: number;
  readonly slots: readonly BigOrderHologramSlotDebugState[];
}

export interface BigOrderHologramShowResult {
  /** True only when a fresh pooled projection appeared. */
  readonly materialized: boolean;
  /** True when coalesced notional crossed the configured whale threshold. */
  readonly promotedToWhale: boolean;
  /** The effective tier after any same-side coalescing. */
  readonly tier: BigOrderHologramTier;
}

interface HologramSlot {
  readonly index: number;
  readonly root: Group;
  readonly title: Text;
  readonly amount: Text;
  readonly simulatedMark: Text;
  readonly crown: Group;
  readonly backplateMaterial: MeshBasicMaterial;
  readonly beamMaterial: MeshBasicMaterial;
  readonly scanlineMaterial: MeshBasicMaterial;
  readonly anchorPoint: Vector3;
  active: boolean;
  side: TradeSide;
  tier: BigOrderHologramTier;
  symbol: AssetSymbol;
  notionalUsd: number;
  simulated: boolean;
  spawnedAt: number;
  holdUntil: number;
  expiresAt: number;
  lastOrderAt: number;
  anchor: BigOrderHologramAnchorProvider | null;
}

interface DissolveParticle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  life: number;
  maxLife: number;
}

const EMPTY_SIDE: TradeSide = 'buy';
const EMPTY_TIER: BigOrderHologramTier = 'big';
// Monument charts deliberately render as a depth-test-free presentation
// overlay. Order projections are presentation too: rendering below that layer
// made an otherwise valid projection disappear whenever the chart crossed its
// screen-space position. Keep this above the chart, while anchors preserve a
// clear physical gutter around the candles.
const HOLOGRAM_RENDER_ORDER = MONUMENT_OVERLAY_RENDER_ORDER + 16;
const HOLOGRAM_OUTLINE_COLOR = 0x24283b;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const amount = clamp01(value);
  return amount * amount * (3 - 2 * amount);
}

function materializeScale(progress: number): number {
  const amount = clamp01(progress);
  const back = 1.70158;
  const shifted = amount - 1;
  return 1 + (back + 1) * shifted ** 3 + back * shifted ** 2;
}

export function formatHologramNotional(value: number): string {
  const finite = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (finite >= 1_000_000_000) return `$${(finite / 1_000_000_000).toFixed(2)}B`;
  if (finite >= 1_000_000) return `$${(finite / 1_000_000).toFixed(finite >= 10_000_000 ? 1 : 2)}M`;
  if (finite >= 1_000) return `$${Math.round(finite / 1_000)}K`;
  return `$${Math.round(finite)}`;
}

class HologramDissolvePool {
  readonly points: Points<BufferGeometry, PointsMaterial>;

  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly particles: DissolveParticle[];
  private cursor = 0;
  private activeCount = 0;

  constructor(capacity: number) {
    const safeCapacity = Math.max(1, Math.floor(capacity));
    this.positions = new Float32Array(safeCapacity * 3);
    this.colors = new Float32Array(safeCapacity * 3);
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(this.positions, 3);
    const color = new BufferAttribute(this.colors, 3);
    position.setUsage(DynamicDrawUsage);
    color.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('color', color);
    geometry.setDrawRange(0, 0);
    const material = new PointsMaterial({
      size: 0.17,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.72,
      vertexColors: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.points = new Points(geometry, material);
    this.points.name = 'big-order-hologram-dissolve-pool';
    this.points.visible = false;
    this.points.frustumCulled = false;
    this.points.renderOrder = 18;
    this.particles = Array.from({ length: safeCapacity }, () => ({
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      r: 1,
      g: 1,
      b: 1,
      life: 0,
      maxLife: 0,
    }));
  }

  emit(origin: Vector3, color: number, requestedCount: number, sequence: number): void {
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    const count = Math.max(1, Math.min(this.particles.length, Math.floor(requestedCount)));
    for (let index = 0; index < count; index += 1) {
      const particle = this.nextParticle();
      const phase = (sequence * 2.399963 + index * 1.713) % (Math.PI * 2);
      const radial = 0.28 + (index % 5) * 0.12;
      particle.active = true;
      particle.x = origin.x + Math.cos(phase) * radial;
      particle.y = origin.y - 0.38 + (index % 4) * 0.25;
      particle.z = origin.z + Math.sin(phase) * radial * 0.35;
      particle.vx = Math.cos(phase) * (0.18 + (index % 3) * 0.08);
      particle.vy = 0.28 + (index % 5) * 0.08;
      particle.vz = Math.sin(phase) * (0.12 + (index % 2) * 0.06);
      particle.r = r;
      particle.g = g;
      particle.b = b;
      particle.maxLife = 0.62 + (index % 4) * 0.08;
      particle.life = particle.maxLife;
    }
  }

  update(deltaSeconds: number): void {
    const delta = Math.max(0, Math.min(0.1, deltaSeconds));
    let visible = 0;
    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.life -= delta;
      if (particle.life <= 0) {
        particle.active = false;
        continue;
      }
      particle.vy -= delta * 0.22;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.z += particle.vz * delta;
      const fade = clamp01(particle.life / Math.max(0.001, particle.maxLife));
      const offset = visible * 3;
      this.positions[offset] = particle.x;
      this.positions[offset + 1] = particle.y;
      this.positions[offset + 2] = particle.z;
      this.colors[offset] = particle.r * fade;
      this.colors[offset + 1] = particle.g * fade;
      this.colors[offset + 2] = particle.b * fade;
      visible += 1;
    }
    this.activeCount = visible;
    this.points.geometry.setDrawRange(0, visible);
    this.points.geometry.getAttribute('position').needsUpdate = true;
    this.points.geometry.getAttribute('color').needsUpdate = true;
    this.points.visible = visible > 0;
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  clear(): void {
    for (const particle of this.particles) particle.active = false;
    this.activeCount = 0;
    this.points.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose(): void {
    this.clear();
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }

  private nextParticle(): DissolveParticle {
    for (let offset = 0; offset < this.particles.length; offset += 1) {
      const index = (this.cursor + offset) % this.particles.length;
      const candidate = this.particles[index]!;
      if (!candidate.active) {
        this.cursor = (index + 1) % this.particles.length;
        return candidate;
      }
    }
    const candidate = this.particles[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.particles.length;
    return candidate;
  }
}

/**
 * Three allocation-bounded projection slots shared by every monument. Text,
 * projection beams, scanlines and dissolve particles are all created once.
 */
export class BigOrderHologramSystem {
  readonly root = new Group();

  private camera: Camera;
  private readonly slots: HologramSlot[];
  private readonly dissolvePool: HologramDissolvePool;
  private readonly scanlineGeometry = new BoxGeometry(1, 0.025, 0.012);
  private readonly beamGeometry = new ConeGeometry(0.88, 3.75, 10, 1, true);
  private readonly backplateGeometry = new BoxGeometry(4.25, 1.82, 0.018);
  private readonly crownBaseGeometry = new BoxGeometry(0.68, 0.12, 0.09);
  private readonly crownPointGeometry = new ConeGeometry(0.13, 0.34, 5);
  private currentElapsedSeconds = 0;
  private sequence = 0;
  private coalescedEvents = 0;
  private preemptedEvents = 0;
  private droppedEvents = 0;
  private latestSlotIndex = -1;
  private reducedMotion: boolean;
  private disposed = false;

  constructor(options: BigOrderHologramSystemOptions) {
    this.camera = options.camera;
    this.reducedMotion = options.reducedMotion ?? false;
    this.root.name = 'big-order-holograms';
    const hologramConfig = MARKET_TRADE_CONFIG.BTC.hologram;
    this.dissolvePool = new HologramDissolvePool(hologramConfig.dissolveCapacity);
    this.slots = Array.from(
      { length: hologramConfig.maxVisible },
      (_, index) => this.createSlot(index, options.fontUrl),
    );
    for (const slot of this.slots) this.root.add(slot.root);
    this.root.add(this.dissolvePool.points);
    options.parent.add(this.root);
  }

  show(
    order: BigOrderHologramEvent | AggregatedOrder,
    anchor: BigOrderHologramAnchorProvider,
  ): BigOrderHologramShowResult | null {
    if (
      this.disposed
      || (order.tier !== 'big' && order.tier !== 'whale')
      || !Number.isFinite(order.notionalUsd)
      || order.notionalUsd <= 0
    ) return null;
    const significantOrder = order as SignificantHologramEvent;

    const config = MARKET_TRADE_CONFIG[significantOrder.symbol].hologram;
    let matching: HologramSlot | undefined;
    for (const candidate of this.slots) {
      if (
        candidate.active
        && candidate.symbol === significantOrder.symbol
        && candidate.side === significantOrder.side
        && this.currentElapsedSeconds - candidate.lastOrderAt <= config.coalesceSeconds
      ) {
        matching = candidate;
        break;
      }
    }
    if (matching) {
      matching.notionalUsd += significantOrder.notionalUsd;
      matching.simulated = matching.simulated || Boolean(significantOrder.simulated);
      matching.lastOrderAt = this.currentElapsedSeconds;
      matching.holdUntil = Math.max(
        matching.holdUntil,
        this.currentElapsedSeconds + config.holdSeconds,
      );
      matching.expiresAt = matching.holdUntil + config.dissolveSeconds;
      const accumulatedTier = classifyTradeTier(matching.symbol, matching.notionalUsd);
      const promotedToWhale = matching.tier !== 'whale'
        && (significantOrder.tier === 'whale' || accumulatedTier === 'whale');
      if (promotedToWhale) matching.tier = 'whale';
      matching.anchor = anchor;
      this.refreshSlotContent(matching);
      this.coalescedEvents += 1;
      return {
        materialized: false,
        promotedToWhale,
        tier: matching.tier,
      };
    }

    let slot: HologramSlot | undefined;
    for (const candidate of this.slots) {
      if (!candidate.active) {
        slot = candidate;
        break;
      }
    }
    if (!slot) slot = this.preemptionCandidate(significantOrder);
    if (!slot) {
      this.droppedEvents += 1;
      return null;
    }
    if (slot.active) {
      this.emitDissolve(slot);
      this.preemptedEvents += 1;
    }
    this.activateSlot(slot, significantOrder, anchor, config);
    this.latestSlotIndex = slot.index;
    return {
      materialized: true,
      promotedToWhale: false,
      tier: slot.tier,
    };
  }

  /** Position of the most recently materialised projection, for its shimmer cue. */
  getLatestWorldPosition(target = new Vector3()): Vector3 | null {
    const slot = this.slots[this.latestSlotIndex];
    return slot?.active ? target.copy(slot.root.position) : null;
  }

  update(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.disposed) return;
    this.currentElapsedSeconds = Number.isFinite(elapsedSeconds)
      ? Math.max(this.currentElapsedSeconds, elapsedSeconds)
      : this.currentElapsedSeconds;
    const delta = Math.max(0, Math.min(0.1, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
    this.dissolvePool.update(delta);
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const config = MARKET_TRADE_CONFIG[slot.symbol].hologram;
      if (this.currentElapsedSeconds >= slot.expiresAt) {
        this.emitDissolve(slot);
        this.deactivateSlot(slot);
        continue;
      }

      slot.anchor?.getBigOrderHologramAnchor(slot.index, slot.anchorPoint);
      slot.root.position.copy(slot.anchorPoint);
      slot.root.quaternion.copy(this.camera.quaternion);
      const age = Math.max(0, this.currentElapsedSeconds - slot.spawnedAt);
      const materialized = clamp01(age / Math.max(0.001, config.materializeSeconds));
      const dissolve = this.currentElapsedSeconds > slot.holdUntil
        ? 1 - smoothstep(
          (this.currentElapsedSeconds - slot.holdUntil) / Math.max(0.001, config.dissolveSeconds),
        )
        : 1;
      const scaleIn = this.reducedMotion ? smoothstep(materialized) : materializeScale(materialized);
      const tierScale = slot.tier === 'whale' ? config.whaleScale : config.bigScale;
      // Both shoulder cards are intentionally smaller than the primary one.
      // Scaling only slot two left a full-sized first overflow plate able to
      // clip beyond the chart frame on a real camera view.
      const slotScale = slot.index === 0 ? 1 : config.overflowScale;
      slot.root.scale.setScalar(Math.max(0.001, scaleIn * tierScale * slotScale));
      const bob = this.reducedMotion
        ? 0
        : Math.sin(this.currentElapsedSeconds * 1.35 + slot.index * 1.7) * 0.09;
      slot.root.position.y += bob;
      if (!this.reducedMotion) {
        slot.root.rotateY(Math.sin(this.currentElapsedSeconds * 0.42 + slot.index) * 0.025);
      }
      const openingFlicker = !this.reducedMotion && age < 0.18
        ? 0.84 + (Math.floor(age / 0.045) % 2) * 0.16
        : 0.96 + Math.sin(this.currentElapsedSeconds * 8.4 + slot.index) * 0.025;
      this.setSlotOpacity(slot, dissolve * openingFlicker);
      slot.scanlineMaterial.opacity *= 0.68 + 0.22 * Math.sin(this.currentElapsedSeconds * 5.2);
    }
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  /** Clears all market-scoped presentation without reallocating the pool. */
  clear(): void {
    if (this.disposed) return;
    for (const slot of this.slots) this.deactivateSlot(slot);
    this.dissolvePool.clear();
    this.latestSlotIndex = -1;
  }

  getDebugStats(): BigOrderHologramDebugStats {
    return {
      visible: this.slots.reduce((count, slot) => count + Number(slot.active), 0),
      capacity: this.slots.length,
      activeDissolveParticles: this.dissolvePool.getActiveCount(),
      coalescedEvents: this.coalescedEvents,
      preemptedEvents: this.preemptedEvents,
      droppedEvents: this.droppedEvents,
      slots: this.slots.map((slot) => ({
        index: slot.index,
        active: slot.active,
        side: slot.active ? slot.side : null,
        tier: slot.active ? slot.tier : null,
        notionalUsd: slot.active ? slot.notionalUsd : 0,
        simulated: slot.active && slot.simulated,
        title: slot.title.text,
        amount: slot.amount.text,
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      slot.title.dispose();
      slot.amount.dispose();
      slot.simulatedMark.dispose();
      slot.backplateMaterial.dispose();
      slot.beamMaterial.dispose();
      slot.scanlineMaterial.dispose();
      const crownMaterial = (slot.crown.children[0] as Mesh | undefined)?.material;
      if (crownMaterial instanceof MeshBasicMaterial) crownMaterial.dispose();
      slot.root.removeFromParent();
      slot.root.clear();
      slot.active = false;
    }
    this.dissolvePool.dispose();
    this.scanlineGeometry.dispose();
    this.beamGeometry.dispose();
    this.backplateGeometry.dispose();
    this.crownBaseGeometry.dispose();
    this.crownPointGeometry.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }

  private createSlot(index: number, fontUrl?: string): HologramSlot {
    const root = new Group();
    root.name = `big-order-hologram-${index + 1}`;
    root.visible = false;
    root.renderOrder = HOLOGRAM_RENDER_ORDER;

    // A softly coloured backing makes the pastel type readable against bright
    // sky, stone, and the shrine itself. It is one pooled primitive per slot.
    const backplateMaterial = new MeshBasicMaterial({
      // A neutral dark plate gives both pastel directions enough contrast;
      // the beam, scanlines and type retain their directional colour.
      color: HOLOGRAM_OUTLINE_COLOR,
      transparent: true,
      opacity: 0,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const backplate = new Mesh(this.backplateGeometry, backplateMaterial);
    backplate.name = `big-order-backplate-${index + 1}`;
    backplate.position.z = -0.08;
    backplate.renderOrder = HOLOGRAM_RENDER_ORDER;
    root.add(backplate);

    const title = this.createText('BIG BUY', 0.92, 0.58, fontUrl);
    title.name = `big-order-title-${index + 1}`;
    const amount = this.createText('$0', 0.62, -0.12, fontUrl);
    amount.name = `big-order-amount-${index + 1}`;
    const simulatedMark = this.createText('SIM', 0.18, -0.48, fontUrl);
    simulatedMark.name = `big-order-simulated-${index + 1}`;
    simulatedMark.color = 0xfff1cf;
    simulatedMark.outlineWidth = '3%';
    simulatedMark.visible = false;
    root.add(title, amount, simulatedMark);

    const beamMaterial = new MeshBasicMaterial({
      color: MONUMENT_CANDLE_COLORS.up,
      transparent: true,
      opacity: 0,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const beam = new Mesh(this.beamGeometry, beamMaterial);
    beam.name = `big-order-projection-beam-${index + 1}`;
    beam.position.set(0, -2.28, -0.11);
    beam.renderOrder = HOLOGRAM_RENDER_ORDER + 1;
    root.add(beam);

    const scanlineMaterial = new MeshBasicMaterial({
      color: MONUMENT_CANDLE_COLORS.up,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    for (let line = 0; line < 4; line += 1) {
      const scanline = new Mesh(this.scanlineGeometry, scanlineMaterial);
      scanline.name = `big-order-scanline-${index + 1}-${line + 1}`;
      scanline.scale.x = 3.6 - line * 0.34;
      scanline.position.set(0, 0.62 - line * 0.38, -0.04);
      scanline.renderOrder = HOLOGRAM_RENDER_ORDER + 2;
      root.add(scanline);
    }

    const crownMaterial = new MeshBasicMaterial({
      color: 0xfff1cf,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const crown = new Group();
    crown.name = `whale-order-crown-${index + 1}`;
    crown.position.y = 1.18;
    crown.renderOrder = HOLOGRAM_RENDER_ORDER + 5;
    const crownBase = new Mesh(this.crownBaseGeometry, crownMaterial);
    crownBase.renderOrder = HOLOGRAM_RENDER_ORDER + 5;
    crown.add(crownBase);
    for (const x of [-0.24, 0, 0.24]) {
      const point = new Mesh(this.crownPointGeometry, crownMaterial);
      point.position.set(x, 0.21 + (x === 0 ? 0.08 : 0), 0);
      point.renderOrder = HOLOGRAM_RENDER_ORDER + 5;
      crown.add(point);
    }
    crown.visible = false;
    root.add(crown);

    // Billboard matrices change each frame to face the camera. Explicitly
    // opt the tiny pooled card subtree out of stale bounding-sphere culling,
    // which can otherwise reject an otherwise valid order card near the
    // edge of a turning shrine presentation.
    root.traverse((object) => {
      object.frustumCulled = false;
    });

    return {
      index,
      root,
      title,
      amount,
      simulatedMark,
      crown,
      backplateMaterial,
      beamMaterial,
      scanlineMaterial,
      anchorPoint: new Vector3(),
      active: false,
      side: EMPTY_SIDE,
      tier: EMPTY_TIER,
      symbol: 'BTC',
      notionalUsd: 0,
      simulated: false,
      spawnedAt: 0,
      holdUntil: 0,
      expiresAt: 0,
      lastOrderAt: Number.NEGATIVE_INFINITY,
      anchor: null,
    };
  }

  private createText(value: string, size: number, y: number, fontUrl?: string): Text {
    const text = new Text();
    text.text = value;
    text.fontSize = size;
    text.color = MONUMENT_CANDLE_COLORS.up;
    text.anchorX = 'center';
    text.anchorY = 'middle';
    text.textAlign = 'center';
    text.whiteSpace = 'nowrap';
    text.outlineWidth = '9%';
    text.outlineColor = HOLOGRAM_OUTLINE_COLOR;
    text.outlineOpacity = 0.58;
    text.depthOffset = -3;
    text.renderOrder = HOLOGRAM_RENDER_ORDER + 4;
    text.position.set(0, y, 0);
    if (fontUrl) text.font = fontUrl;
    return text;
  }

  private preemptionCandidate(order: SignificantHologramEvent): HologramSlot | undefined {
    if (order.tier === 'whale') {
      let oldestNonWhale: HologramSlot | undefined;
      let oldest = this.slots[0];
      for (const slot of this.slots) {
        if (!oldest || slot.spawnedAt < oldest.spawnedAt) oldest = slot;
        if (
          slot.tier !== 'whale'
          && (!oldestNonWhale || slot.spawnedAt < oldestNonWhale.spawnedAt)
        ) oldestNonWhale = slot;
      }
      return oldestNonWhale ?? oldest;
    }
    let smallest = this.slots[0];
    if (!smallest) return undefined;
    for (const slot of this.slots) {
      if (slot.notionalUsd < smallest.notionalUsd) smallest = slot;
    }
    return order.notionalUsd > smallest.notionalUsd ? smallest : undefined;
  }

  private activateSlot(
    slot: HologramSlot,
    order: SignificantHologramEvent,
    anchor: BigOrderHologramAnchorProvider,
    config: TradeHologramConfig,
  ): void {
    slot.active = true;
    slot.side = order.side;
    slot.tier = order.tier;
    slot.symbol = order.symbol;
    slot.notionalUsd = order.notionalUsd;
    slot.simulated = Boolean(order.simulated);
    slot.spawnedAt = this.currentElapsedSeconds;
    slot.holdUntil = this.currentElapsedSeconds + config.materializeSeconds + config.holdSeconds;
    slot.expiresAt = slot.holdUntil + config.dissolveSeconds;
    slot.lastOrderAt = this.currentElapsedSeconds;
    slot.anchor = anchor;
    anchor.getBigOrderHologramAnchor(slot.index, slot.anchorPoint);
    slot.root.position.copy(slot.anchorPoint);
    slot.root.scale.setScalar(0.001);
    slot.root.visible = true;
    this.refreshSlotContent(slot);
    this.setSlotOpacity(slot, 0);
    this.sequence += 1;
  }

  private refreshSlotContent(slot: HologramSlot): void {
    const color = slot.side === 'buy'
      ? MONUMENT_CANDLE_COLORS.up
      : MONUMENT_CANDLE_COLORS.down;
    slot.title.text = `BIG ${slot.side === 'buy' ? 'BUY' : 'SELL'}`;
    slot.amount.text = formatHologramNotional(slot.notionalUsd);
    slot.title.color = color;
    slot.title.outlineColor = HOLOGRAM_OUTLINE_COLOR;
    slot.amount.color = color;
    slot.amount.outlineColor = HOLOGRAM_OUTLINE_COLOR;
    slot.beamMaterial.color.setHex(color);
    slot.scanlineMaterial.color.setHex(color);
    slot.crown.visible = slot.tier === 'whale';
    slot.simulatedMark.visible = slot.simulated;
    if (typeof self !== 'undefined') {
      slot.title.sync();
      slot.amount.sync();
      if (slot.simulated) slot.simulatedMark.sync();
    }
  }

  private setSlotOpacity(slot: HologramSlot, opacity: number): void {
    const visible = clamp01(opacity);
    this.setTextOpacity(slot.title, visible * 0.98);
    slot.title.outlineOpacity = visible * 0.72;
    this.setTextOpacity(slot.amount, visible * 0.96);
    slot.amount.outlineOpacity = visible * 0.64;
    this.setTextOpacity(slot.simulatedMark, visible * 0.82);
    slot.simulatedMark.outlineOpacity = visible * 0.5;
    slot.backplateMaterial.opacity = visible * (slot.tier === 'whale' ? 0.72 : 0.62);
    slot.beamMaterial.opacity = visible * (slot.tier === 'whale' ? 0.21 : 0.15);
    slot.scanlineMaterial.opacity = visible * (slot.tier === 'whale' ? 0.38 : 0.29);
    const crownMaterial = (slot.crown.children[0] as Mesh | undefined)?.material;
    if (crownMaterial instanceof MeshBasicMaterial) crownMaterial.opacity = visible * 0.76;
  }

  private setTextOpacity(text: Text, opacity: number): void {
    const material = text.material as Material;
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    material.opacity = opacity;
  }

  private emitDissolve(slot: HologramSlot): void {
    const color = slot.side === 'buy'
      ? MONUMENT_CANDLE_COLORS.up
      : MONUMENT_CANDLE_COLORS.down;
    const config = MARKET_TRADE_CONFIG[slot.symbol].hologram;
    const count = this.reducedMotion
      ? Math.max(3, Math.round(config.dissolveParticles * 0.34))
      : config.dissolveParticles;
    this.dissolvePool.emit(slot.root.position, color, count, this.sequence + slot.index);
  }

  private deactivateSlot(slot: HologramSlot): void {
    slot.active = false;
    slot.root.visible = false;
    slot.anchor = null;
    slot.notionalUsd = 0;
    slot.simulated = false;
    slot.simulatedMark.visible = false;
    slot.crown.visible = false;
  }
}
