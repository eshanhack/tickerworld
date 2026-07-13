import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Text } from 'troika-three-text';
import type { GameSystem, SurfaceKind } from '../types';

export const PARKOUR_PARK_CENTER = Object.freeze({ x: 51.2, z: 1.8 });
export const PARKOUR_PARK_BOUNDS = Object.freeze({
  left: 28,
  right: 74.3,
  bottom: -1.8,
  top: 5.4,
});
export const PARKOUR_MAX_STEP_UP = 0.5;
export const PARKOUR_FAIL_DELAY_SECONDS = 0.12;
export const PARKOUR_COURSE_IDS = [
  'parkour-start',
  'parkour-ramp-up',
  'parkour-low-platform',
  'parkour-stone-1',
  'parkour-stone-2',
  'parkour-stone-3',
  'parkour-checkpoint-a',
  'parkour-balance-beam-a',
  'parkour-mid-platform',
  'parkour-ring-step',
  'parkour-ramp-high',
  'parkour-high-platform',
  'parkour-balance-beam-b',
  'parkour-checkpoint-b',
  'parkour-ramp-down',
  'parkour-finish',
] as const;
export const PARKOUR_CHECKPOINT_IDS = ['parkour-checkpoint-a', 'parkour-checkpoint-b'] as const;
export const PARKOUR_FINISH_CHECKPOINT_ID = 'parkour-checkpoint-b';

export type ParkourSurfaceShape = 'rect' | 'circle' | 'ramp';
export type ParkourSurfaceRole = 'start' | 'checkpoint' | 'finish';
export type ParkourPalette = 'teal' | 'rose' | 'lavender' | 'gold' | 'cream' | 'sage';

export interface ParkourSurfaceDescriptor {
  readonly id: string;
  readonly shape: ParkourSurfaceShape;
  readonly x: number;
  readonly z: number;
  /** Rect/ramp length along local X. */
  readonly width: number;
  /** Rect/ramp width along local Z. */
  readonly depth: number;
  readonly radius: number;
  readonly yaw: number;
  readonly elevation: number;
  readonly endElevation: number;
  readonly palette: ParkourPalette;
  readonly role?: ParkourSurfaceRole;
}

export interface ParkourArchDescriptor {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly openingWidth: number;
  readonly pillarHeight: number;
  readonly baseSurfaceId: string;
  readonly label?: string;
}

export interface ParkourHoopDescriptor {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly radius: number;
  readonly heightOffset: number;
  readonly baseSurfaceId: string;
}

export interface ParkourParkLayout {
  readonly surfaces: readonly ParkourSurfaceDescriptor[];
  readonly arches: readonly ParkourArchDescriptor[];
  readonly hoops: readonly ParkourHoopDescriptor[];
  readonly courseIds: readonly string[];
}

export interface ParkourGroundSample {
  readonly height: number;
  readonly surface: SurfaceKind;
  readonly surfaceId: string;
  readonly role?: ParkourSurfaceRole;
}

export interface ParkourRespawnPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly checkpointId: string;
}

export type ParkourEventType = 'start' | 'checkpoint' | 'finish' | 'respawn' | 'reset' | 'quit';

export interface ParkourEvent {
  readonly type: ParkourEventType;
  readonly elapsedSeconds: number;
  readonly checkpointId: string;
}

export interface ParkourPlayerProbe {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly grounded: boolean;
  readonly enabled?: boolean;
}

export interface ParkourParkSystemOptions {
  readonly parent: Object3D;
  readonly heightAt: (x: number, z: number) => number;
  readonly fontUrl?: string;
  readonly reducedMotion?: boolean;
  readonly onEvent?: (event: ParkourEvent) => void;
  /** Returning false resets timing but lets an online authoritative player walk back. */
  readonly onRespawnRequested?: (point: ParkourRespawnPoint) => boolean;
}

export interface ParkourParkDebugStats {
  readonly surfaces: number;
  readonly arches: number;
  readonly hoops: number;
  readonly active: boolean;
  readonly checkpointId: string;
  readonly elapsedSeconds: number;
  readonly bestSeconds: number | null;
}

interface ResolvedSurface {
  readonly descriptor: ParkourSurfaceDescriptor;
  readonly lowHeight: number;
  readonly highHeight: number;
  readonly bottomHeight: number;
}

interface CircularSolid {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly bottom: number;
  readonly top: number;
}

interface RectangularSolid {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly yaw: number;
  readonly bottom: number;
  readonly top: number;
}

interface MarkerRing {
  readonly mesh: Mesh<TorusGeometry, MeshStandardMaterial>;
  readonly baseScale: number;
  readonly phase: number;
}

interface MagicOrb {
  readonly mesh: Mesh<SphereGeometry, MeshStandardMaterial>;
  readonly center: Vector3;
  readonly phase: number;
  readonly radius: number;
}

const PLAYER_COLLISION_RADIUS = 0.28;
const CAMERA_SOLID_MARGIN = 0.16;
const COURSE_YAW = 0;
const FINISH_ORB_COUNT = 5;

const PALETTE_COLORS: Readonly<Record<ParkourPalette, number>> = {
  teal: 0x7fc5b8,
  rose: 0xe7a4aa,
  lavender: 0xb9afe0,
  gold: 0xe8c276,
  cream: 0xffedc9,
  sage: 0x98bd8f,
};

const CYBERPUNK_PALETTE_COLORS: Readonly<Record<ParkourPalette, number>> = {
  teal: 0x45e7dc,
  rose: 0xff5ca8,
  lavender: 0x9d7dff,
  gold: 0xffc857,
  cream: 0xc8f5ff,
  sage: 0x55c8ff,
};

const DESERT_PALETTE_COLORS: Readonly<Record<ParkourPalette, number>> = {
  teal: 0x55aaa0,
  rose: 0xc97758,
  lavender: 0x887994,
  gold: 0xe0a24e,
  cream: 0xf0d29b,
  sage: 0x7d945e,
};

export type ParkourVisualTheme = 'park' | 'cyberpunk' | 'desert';

function surface(
  id: string,
  shape: ParkourSurfaceShape,
  x: number,
  z: number,
  width: number,
  depth: number,
  elevation: number,
  palette: ParkourPalette,
  options: {
    readonly radius?: number;
    readonly endElevation?: number;
    readonly role?: ParkourSurfaceRole;
  } = {},
): ParkourSurfaceDescriptor {
  return {
    id,
    shape,
    x,
    z,
    width,
    depth,
    radius: options.radius ?? 0,
    yaw: COURSE_YAW,
    elevation,
    endElevation: options.endElevation ?? elevation,
    palette,
    ...(options.role ? { role: options.role } : {}),
  };
}

/** Fixed clearing between the AVAX and ETH roads, deterministic in every world. */
export function createParkourParkLayout(): ParkourParkLayout {
  const surfaces: ParkourSurfaceDescriptor[] = [
    surface('parkour-start', 'rect', 30, 2, 4, 4, 0.18, 'teal', { role: 'start' }),
    surface('parkour-ramp-up', 'ramp', 33, 2, 4.8, 3, 0.18, 'sage', { endElevation: 0.72 }),
    surface('parkour-low-platform', 'rect', 36, 2, 3.2, 3.4, 0.72, 'lavender'),
    surface('parkour-stone-1', 'circle', 39, 0.8, 2.2, 2.2, 0.95, 'rose', { radius: 1.1 }),
    surface('parkour-stone-2', 'circle', 41.6, 3.1, 2.1, 2.1, 1.2, 'gold', { radius: 1.05 }),
    surface('parkour-stone-3', 'circle', 44.2, 1.1, 2, 2, 1.48, 'teal', { radius: 1 }),
    surface('parkour-checkpoint-a', 'rect', 47, 2.2, 3.4, 3.4, 1.7, 'rose', { role: 'checkpoint' }),
    surface('parkour-balance-beam-a', 'rect', 50, 3.4, 4.4, 1.05, 1.82, 'gold'),
    surface('parkour-mid-platform', 'rect', 52.8, 3.4, 3.2, 3.2, 1.95, 'lavender'),
    surface('parkour-ring-step', 'circle', 55.2, 1.2, 2.3, 2.3, 2.12, 'teal', { radius: 1.15 }),
    surface('parkour-ramp-high', 'ramp', 57.9, 0.4, 4.4, 2.4, 2.12, 'sage', { endElevation: 2.62 }),
    surface('parkour-high-platform', 'rect', 60.6, 0.4, 3.2, 3.2, 2.62, 'lavender'),
    surface('parkour-balance-beam-b', 'rect', 63.5, 1.8, 4.6, 0.95, 2.72, 'gold'),
    surface('parkour-checkpoint-b', 'rect', 66, 2.5, 3.4, 3.4, 2.55, 'rose', { role: 'checkpoint' }),
    surface('parkour-ramp-down', 'ramp', 69, 2.5, 5, 2.4, 2.55, 'sage', { endElevation: 0.32 }),
    surface('parkour-finish', 'rect', 72.3, 2.5, 4, 4, 0.18, 'teal', { role: 'finish' }),
  ];
  const arches: ParkourArchDescriptor[] = [
    {
      id: 'parkour-start-arch',
      x: 30,
      z: 2,
      yaw: COURSE_YAW,
      openingWidth: 3.15,
      pillarHeight: 1.75,
      baseSurfaceId: 'parkour-start',
      label: 'PARKOUR\nSTART  ↑',
    },
    {
      id: 'parkour-checkpoint-arch',
      x: 47,
      z: 2.2,
      yaw: COURSE_YAW,
      openingWidth: 2.8,
      pillarHeight: 1.6,
      baseSurfaceId: 'parkour-checkpoint-a',
      label: 'CHECKPOINT  1 / 2',
    },
    {
      id: 'parkour-checkpoint-b-arch',
      x: 66,
      z: 2.5,
      yaw: COURSE_YAW,
      openingWidth: 2.8,
      pillarHeight: 1.7,
      baseSurfaceId: 'parkour-checkpoint-b',
      label: 'CHECKPOINT  2 / 2',
    },
    {
      id: 'parkour-finish-arch',
      x: 72.3,
      z: 2.5,
      yaw: COURSE_YAW,
      openingWidth: 3.2,
      pillarHeight: 1.8,
      baseSurfaceId: 'parkour-finish',
      label: '✦  FINISH  ✦',
    },
  ];
  const hoops: ParkourHoopDescriptor[] = [
    {
      id: 'parkour-midair-hoop-a',
      x: 55.2,
      z: 1.2,
      yaw: COURSE_YAW,
      radius: 1.18,
      heightOffset: 1.38,
      baseSurfaceId: 'parkour-ring-step',
    },
    {
      id: 'parkour-midair-hoop-b',
      x: 63.5,
      z: 1.8,
      yaw: COURSE_YAW,
      radius: 1.12,
      heightOffset: 1.42,
      baseSurfaceId: 'parkour-balance-beam-b',
    },
  ];
  return { surfaces, arches, hoops, courseIds: [...PARKOUR_COURSE_IDS] };
}

export function isInsideParkourPropExclusion(x: number, z: number, margin = 1.6): boolean {
  return x >= PARKOUR_PARK_BOUNDS.left - margin
    && x <= PARKOUR_PARK_BOUNDS.right + margin
    && z >= PARKOUR_PARK_BOUNDS.bottom - margin
    && z <= PARKOUR_PARK_BOUNDS.top + margin;
}

export function parkourLandingRadius(descriptor: ParkourSurfaceDescriptor): number {
  return descriptor.shape === 'circle'
    ? descriptor.radius
    : Math.min(descriptor.width, descriptor.depth) * 0.5;
}

export function parkourEdgeGap(
  first: ParkourSurfaceDescriptor,
  second: ParkourSurfaceDescriptor,
): number {
  return Math.max(
    0,
    Math.hypot(first.x - second.x, first.z - second.z)
      - parkourLandingRadius(first)
      - parkourLandingRadius(second),
  );
}

function finiteHeight(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function localCoordinates(
  descriptor: Pick<ParkourSurfaceDescriptor, 'x' | 'z' | 'yaw'>,
  x: number,
  z: number,
): { x: number; z: number } {
  const dx = x - descriptor.x;
  const dz = z - descriptor.z;
  const cosine = Math.cos(descriptor.yaw);
  const sine = Math.sin(descriptor.yaw);
  return {
    x: dx * cosine - dz * sine,
    z: dx * sine + dz * cosine,
  };
}

function worldCoordinates(
  descriptor: Pick<ParkourSurfaceDescriptor, 'x' | 'z' | 'yaw'>,
  localX: number,
  localZ: number,
): { x: number; z: number } {
  const cosine = Math.cos(descriptor.yaw);
  const sine = Math.sin(descriptor.yaw);
  return {
    x: descriptor.x + localX * cosine + localZ * sine,
    z: descriptor.z - localX * sine + localZ * cosine,
  };
}

function containsSurface(
  descriptor: ParkourSurfaceDescriptor,
  x: number,
  z: number,
  margin = 0,
): boolean {
  const local = localCoordinates(descriptor, x, z);
  if (descriptor.shape === 'circle') {
    return Math.hypot(local.x, local.z) <= descriptor.radius + margin;
  }
  return Math.abs(local.x) <= descriptor.width * 0.5 + margin
    && Math.abs(local.z) <= descriptor.depth * 0.5 + margin;
}

function containsRect(solid: RectangularSolid, x: number, z: number, margin = 0): boolean {
  const local = localCoordinates(solid, x, z);
  return Math.abs(local.x) <= solid.width * 0.5 + margin
    && Math.abs(local.z) <= solid.depth * 0.5 + margin;
}

export class ParkourParkSystem implements GameSystem {
  public readonly root = new Group();
  public readonly layout: ParkourParkLayout;

  private readonly heightAt: ParkourParkSystemOptions['heightAt'];
  private readonly onEvent?: ParkourParkSystemOptions['onEvent'];
  private readonly onRespawnRequested?: ParkourParkSystemOptions['onRespawnRequested'];
  private readonly surfaces: readonly ResolvedSurface[];
  private readonly surfaceById = new Map<string, ResolvedSurface>();
  private readonly circularSolids: CircularSolid[] = [];
  private readonly rectangularSolids: RectangularSolid[] = [];
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private readonly texts = new Set<Text>();
  private readonly paletteMaterials = new Map<ParkourPalette, MeshStandardMaterial>();
  private readonly markerRings: MarkerRing[] = [];
  private readonly magicOrbs: MagicOrb[] = [];
  private readonly unitRoundedBox = this.trackGeometry(new RoundedBoxGeometry(1, 1, 1, 2, 0.12));
  private readonly unitBox = this.trackGeometry(new BoxGeometry(1, 1, 1));
  private readonly unitStone = this.trackGeometry(new CylinderGeometry(1, 1, 1, 16));
  private readonly unitPillar = this.trackGeometry(new CylinderGeometry(1, 1, 1, 10));
  private readonly unitArch = this.trackGeometry(new TorusGeometry(1, 0.11, 7, 28, Math.PI));
  private readonly unitRing = this.trackGeometry(new TorusGeometry(1, 0.055, 6, 30));
  private readonly unitOrb = this.trackGeometry(new SphereGeometry(1, 8, 6));
  private readonly accentMaterial = this.trackMaterial(new MeshStandardMaterial({
    color: 0xffedc9,
    emissive: 0xd7a65f,
    emissiveIntensity: 0.14,
    roughness: 0.62,
    flatShading: true,
  }));
  private probe: ParkourPlayerProbe = { x: 0, y: 0, z: 0, grounded: false, enabled: false };
  private visible = true;
  private reducedMotion: boolean;
  private disposed = false;
  private active = false;
  private elapsedSeconds = 0;
  private bestSeconds: number | null = null;
  private checkpointId = 'parkour-start';
  private checkpointProgress = 0;
  private lastRole: ParkourSurfaceRole | null = null;
  private startSuppressedUntilExit = false;
  private failElapsed = 0;
  private respawnCooldown = 0;
  private visualTheme: ParkourVisualTheme = 'park';

  public constructor(options: ParkourParkSystemOptions) {
    this.heightAt = options.heightAt;
    this.onEvent = options.onEvent;
    this.onRespawnRequested = options.onRespawnRequested;
    this.reducedMotion = options.reducedMotion ?? false;
    this.layout = createParkourParkLayout();
    this.root.name = 'tickerworld-parkour-park';
    this.surfaces = this.layout.surfaces.map((descriptor) => this.resolveSurface(descriptor));
    for (const resolved of this.surfaces) this.surfaceById.set(resolved.descriptor.id, resolved);
    this.buildSurfaces();
    this.buildArches(options.fontUrl);
    this.buildHoops();
    this.buildFinishMagic();
    options.parent.add(this.root);
  }

  public setPlayerProbe(probe: ParkourPlayerProbe): void {
    this.probe = {
      x: finiteHeight(probe.x),
      y: finiteHeight(probe.y),
      z: finiteHeight(probe.z),
      grounded: probe.grounded === true,
      enabled: probe.enabled !== false,
    };
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  /** Rethemes the existing course without rebuilding any collision geometry. */
  public setCyberpunkTheme(enabled: boolean): void {
    this.setVisualTheme(enabled ? 'cyberpunk' : 'park');
  }

  /** Rethemes presentation only; course layout, collision and timing remain identical. */
  public setVisualTheme(theme: ParkourVisualTheme): void {
    if (this.visualTheme === theme) return;
    this.visualTheme = theme;
    for (const [palette, material] of this.paletteMaterials) {
      const color = theme === 'cyberpunk'
        ? CYBERPUNK_PALETTE_COLORS[palette]
        : theme === 'desert'
          ? DESERT_PALETTE_COLORS[palette]
          : PALETTE_COLORS[palette];
      material.color.setHex(color);
      material.emissive.setHex(color);
      material.emissiveIntensity = theme === 'cyberpunk' ? 0.28 : theme === 'desert' ? 0.08 : 0.055;
      material.roughness = theme === 'cyberpunk' ? 0.48 : theme === 'desert' ? 0.9 : 0.78;
      material.metalness = theme === 'cyberpunk' ? 0.16 : 0.01;
    }
  }

  public resetRun(): void {
    this.active = false;
    this.elapsedSeconds = 0;
    this.checkpointId = 'parkour-start';
    this.checkpointProgress = 0;
    this.lastRole = null;
    this.startSuppressedUntilExit = false;
    this.failElapsed = 0;
    this.respawnCooldown = 0;
  }

  /** Cancels timing in-place. It deliberately never asks Game to teleport. */
  public quitRun(): boolean {
    if (!this.active || this.disposed) return false;
    this.active = false;
    this.elapsedSeconds = 0;
    this.checkpointId = 'parkour-start';
    this.checkpointProgress = 0;
    // Suppress START by footprint, not grounded contact: jumping vertically
    // after Quit must not silently create a new run on landing.
    this.startSuppressedUntilExit = this.sampleGround(this.probe.x, this.probe.z)?.role === 'start';
    this.lastRole = null;
    this.failElapsed = 0;
    this.respawnCooldown = 0;
    this.emit('quit');
    return true;
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
    if (!visible) {
      this.failElapsed = 0;
      this.lastRole = null;
    }
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.disposed) return;
    const delta = Math.max(0, Math.min(0.1, finiteHeight(deltaSeconds)));
    const elapsed = finiteHeight(elapsedSeconds);
    this.animate(elapsed);
    if (!this.visible || this.probe.enabled === false) return;

    this.respawnCooldown = Math.max(0, this.respawnCooldown - delta);
    if (this.active) this.elapsedSeconds += delta;
    const sample = this.sampleGround(this.probe.x, this.probe.z);
    const standing = Boolean(
      sample
      && this.probe.grounded
      && Math.abs(this.probe.y - sample.height) <= 0.62,
    );
    const role = standing ? sample?.role ?? null : null;
    const insideStartFootprint = sample?.role === 'start';
    if (this.startSuppressedUntilExit && !insideStartFootprint) {
      this.startSuppressedUntilExit = false;
    }

    if (role === 'start' && !this.startSuppressedUntilExit && this.lastRole !== 'start') {
      this.active = true;
      this.elapsedSeconds = 0;
      this.checkpointId = 'parkour-start';
      this.checkpointProgress = 0;
      this.emit('start');
    } else if (role === 'checkpoint'
      && this.active
      && sample?.surfaceId === 'parkour-checkpoint-a'
      && this.checkpointProgress === 0) {
      this.checkpointId = 'parkour-checkpoint-a';
      this.checkpointProgress = 1;
      this.emit('checkpoint');
    } else if (role === 'checkpoint'
      && this.active
      && sample?.surfaceId === 'parkour-checkpoint-b'
      && this.checkpointProgress === 1) {
      this.checkpointId = 'parkour-checkpoint-b';
      this.checkpointProgress = 2;
      this.emit('checkpoint');
    } else if (role === 'finish'
      && this.active
      && this.checkpointProgress === 2
      && this.lastRole !== 'finish') {
      this.active = false;
      this.bestSeconds = this.bestSeconds === null
        ? this.elapsedSeconds
        : Math.min(this.bestSeconds, this.elapsedSeconds);
      this.emit('finish');
    }
    this.lastRole = role;

    if (this.active
      && this.respawnCooldown <= 0
      && this.probe.grounded
      && !sample) {
      this.failElapsed += delta;
      if (this.failElapsed >= PARKOUR_FAIL_DELAY_SECONDS) this.requestRespawn();
    } else {
      this.failElapsed = 0;
    }
  }

  public sampleGround(x: number, z: number): ParkourGroundSample | null {
    if (this.disposed || !this.visible || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    let highest: ParkourGroundSample | null = null;
    for (const surface of this.surfaces) {
      if (!containsSurface(surface.descriptor, x, z)) continue;
      const height = this.surfaceHeight(surface, x, z);
      if (!highest || height > highest.height) {
        highest = {
          height,
          surface: 'stone',
          surfaceId: surface.descriptor.id,
          ...(surface.descriptor.role ? { role: surface.descriptor.role } : {}),
        };
      }
    }
    return highest;
  }

  public resolveHorizontal(
    previousX: number,
    previousZ: number,
    proposedX: number,
    proposedZ: number,
    playerY: number,
  ): { x: number; z: number } {
    if (this.disposed || !this.visible) return { x: proposedX, z: proposedZ };
    const safePreviousX = finiteHeight(previousX);
    const safePreviousZ = finiteHeight(previousZ);
    const safeProposedX = finiteHeight(proposedX, safePreviousX);
    const safeProposedZ = finiteHeight(proposedZ, safePreviousZ);
    const safeY = finiteHeight(playerY, Number.NEGATIVE_INFINITY);
    if (this.canOccupy(safeProposedX, safeProposedZ, safeY)) {
      return { x: safeProposedX, z: safeProposedZ };
    }
    if (this.canOccupy(safeProposedX, safePreviousZ, safeY)) {
      return { x: safeProposedX, z: safePreviousZ };
    }
    if (this.canOccupy(safePreviousX, safeProposedZ, safeY)) {
      return { x: safePreviousX, z: safeProposedZ };
    }
    return { x: safePreviousX, z: safePreviousZ };
  }

  public collidesCamera(x: number, y: number, z: number): boolean {
    if (this.disposed || !this.visible) return false;
    for (const surface of this.surfaces) {
      if (!containsSurface(surface.descriptor, x, z, CAMERA_SOLID_MARGIN)) continue;
      const top = this.surfaceHeight(surface, x, z);
      if (y >= surface.bottomHeight - 0.35 && y <= top + 0.28) return true;
    }
    for (const solid of this.circularSolids) {
      if (Math.hypot(x - solid.x, z - solid.z) <= solid.radius + CAMERA_SOLID_MARGIN
        && y >= solid.bottom - 0.2 && y <= solid.top + 0.2) return true;
    }
    return this.rectangularSolids.some((solid) => (
      containsRect(solid, x, z, CAMERA_SOLID_MARGIN)
      && y >= solid.bottom - 0.2
      && y <= solid.top + 0.2
    ));
  }

  public getRespawnPoint(checkpointId = this.checkpointId): ParkourRespawnPoint {
    const checkpoint = this.surfaceById.get(checkpointId)
      ?? this.surfaceById.get('parkour-start')!;
    return {
      x: checkpoint.descriptor.x,
      y: this.surfaceHeight(checkpoint, checkpoint.descriptor.x, checkpoint.descriptor.z) + 0.04,
      z: checkpoint.descriptor.z,
      yaw: -Math.PI * 0.5,
      checkpointId: checkpoint.descriptor.id,
    };
  }

  public getDebugStats(): ParkourParkDebugStats {
    return {
      surfaces: this.surfaces.length,
      arches: this.layout.arches.length,
      hoops: this.layout.hoops.length,
      active: this.active,
      checkpointId: this.checkpointId,
      elapsedSeconds: this.elapsedSeconds,
      bestSeconds: this.bestSeconds,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const text of this.texts) text.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.texts.clear();
    this.geometries.clear();
    this.materials.clear();
    this.paletteMaterials.clear();
    this.markerRings.length = 0;
    this.magicOrbs.length = 0;
    this.circularSolids.length = 0;
    this.rectangularSolids.length = 0;
    this.root.clear();
  }

  private resolveSurface(descriptor: ParkourSurfaceDescriptor): ResolvedSurface {
    if (descriptor.shape === 'ramp') {
      const low = worldCoordinates(descriptor, -descriptor.width * 0.5, 0);
      const high = worldCoordinates(descriptor, descriptor.width * 0.5, 0);
      const lowTerrain = finiteHeight(this.heightAt(low.x, low.z));
      const highTerrain = finiteHeight(this.heightAt(high.x, high.z), lowTerrain);
      const centerTerrain = finiteHeight(this.heightAt(descriptor.x, descriptor.z), lowTerrain);
      return {
        descriptor,
        lowHeight: lowTerrain + descriptor.elevation,
        highHeight: highTerrain + descriptor.endElevation,
        bottomHeight: Math.min(lowTerrain, highTerrain, centerTerrain) - 0.12,
      };
    }
    const terrain = finiteHeight(this.heightAt(descriptor.x, descriptor.z));
    const top = terrain + descriptor.elevation;
    return {
      descriptor,
      lowHeight: top,
      highHeight: top,
      bottomHeight: terrain - 0.12,
    };
  }

  private surfaceHeight(surface: ResolvedSurface, x: number, z: number): number {
    if (surface.descriptor.shape !== 'ramp') return surface.highHeight;
    const local = localCoordinates(surface.descriptor, x, z);
    const progress = Math.max(0, Math.min(1, local.x / surface.descriptor.width + 0.5));
    return surface.lowHeight + (surface.highHeight - surface.lowHeight) * progress;
  }

  private canOccupy(x: number, z: number, playerY: number): boolean {
    const sample = this.sampleGround(x, z);
    if (sample && sample.height > playerY + PARKOUR_MAX_STEP_UP) return false;
    for (const solid of this.circularSolids) {
      if (playerY >= solid.bottom - 0.2
        && playerY <= solid.top + 0.25
        && Math.hypot(x - solid.x, z - solid.z) <= solid.radius + PLAYER_COLLISION_RADIUS) return false;
    }
    return !this.rectangularSolids.some((solid) => (
      playerY >= solid.bottom - 0.2
      && playerY <= solid.top + 0.25
      && containsRect(solid, x, z, PLAYER_COLLISION_RADIUS)
    ));
  }

  private requestRespawn(): void {
    const point = this.getRespawnPoint();
    const accepted = this.onRespawnRequested?.(point) ?? false;
    this.failElapsed = 0;
    this.respawnCooldown = 1;
    this.lastRole = null;
    if (accepted) {
      this.emit('respawn');
    } else {
      this.active = false;
      this.checkpointId = 'parkour-start';
      this.checkpointProgress = 0;
      this.emit('reset');
    }
  }

  private emit(type: ParkourEventType): void {
    this.onEvent?.({
      type,
      elapsedSeconds: this.elapsedSeconds,
      checkpointId: this.checkpointId,
    });
  }

  private buildSurfaces(): void {
    for (const surface of this.surfaces) {
      const { descriptor } = surface;
      const material = this.materialFor(descriptor.palette);
      let mesh: Mesh;
      let accent: Mesh;
      if (descriptor.shape === 'circle') {
        const height = Math.max(0.16, surface.highHeight - surface.bottomHeight);
        mesh = new Mesh(this.unitStone, material);
        mesh.scale.set(descriptor.radius, height, descriptor.radius);
        mesh.position.set(descriptor.x, surface.bottomHeight + height * 0.5, descriptor.z);
        accent = new Mesh(this.unitStone, this.accentMaterial);
        accent.scale.set(descriptor.radius * 0.7, 0.035, descriptor.radius * 0.7);
        accent.position.set(descriptor.x, surface.highHeight + 0.018, descriptor.z);
      } else if (descriptor.shape === 'ramp') {
        const rise = surface.highHeight - surface.lowHeight;
        const slope = Math.atan2(rise, descriptor.width);
        const slopeLength = Math.hypot(descriptor.width, rise);
        mesh = new Mesh(this.unitBox, material);
        mesh.scale.set(slopeLength, 0.24, descriptor.depth);
        mesh.rotation.set(0, descriptor.yaw, slope);
        mesh.position.set(
          descriptor.x,
          (surface.lowHeight + surface.highHeight) * 0.5 - Math.cos(slope) * 0.12,
          descriptor.z,
        );
        accent = new Mesh(this.unitBox, this.accentMaterial);
        accent.scale.set(slopeLength * 0.84, 0.035, descriptor.depth * 0.72);
        accent.rotation.copy(mesh.rotation);
        accent.position.set(
          descriptor.x,
          (surface.lowHeight + surface.highHeight) * 0.5 + Math.cos(slope) * 0.022,
          descriptor.z,
        );
      } else {
        const height = Math.max(0.16, surface.highHeight - surface.bottomHeight);
        mesh = new Mesh(this.unitRoundedBox, material);
        mesh.scale.set(descriptor.width, height, descriptor.depth);
        mesh.rotation.y = descriptor.yaw;
        mesh.position.set(descriptor.x, surface.bottomHeight + height * 0.5, descriptor.z);
        accent = new Mesh(this.unitRoundedBox, this.accentMaterial);
        accent.scale.set(descriptor.width * 0.78, 0.035, descriptor.depth * 0.72);
        accent.rotation.y = descriptor.yaw;
        accent.position.set(descriptor.x, surface.highHeight + 0.018, descriptor.z);
      }
      mesh.name = `${descriptor.id}-solid`;
      accent.name = `${descriptor.id}-top-inset`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      accent.receiveShadow = true;
      this.root.add(mesh, accent);

      if (descriptor.role === 'start' || descriptor.role === 'finish') {
        const ring = new Mesh(this.unitRing, material);
        ring.name = `${descriptor.id}-marker-ring`;
        ring.rotation.x = Math.PI * 0.5;
        ring.position.set(descriptor.x, surface.highHeight + 0.08, descriptor.z);
        ring.scale.setScalar(descriptor.role === 'finish' ? 1.48 : 1.34);
        ring.castShadow = true;
        this.root.add(ring);
        this.markerRings.push({
          mesh: ring,
          baseScale: descriptor.role === 'finish' ? 1.48 : 1.34,
          phase: descriptor.role === 'finish' ? 1.8 : 0.2,
        });
      }
    }
  }

  private buildArches(fontUrl?: string): void {
    for (const descriptor of this.layout.arches) {
      const baseSurface = this.surfaceById.get(descriptor.baseSurfaceId);
      if (!baseSurface) continue;
      const baseHeight = this.surfaceHeight(baseSurface, descriptor.x, descriptor.z);
      const group = new Group();
      group.name = descriptor.id;
      group.position.set(descriptor.x, 0, descriptor.z);
      group.rotation.y = descriptor.yaw;
      const radius = descriptor.openingWidth * 0.5;
      const pillarRadius = 0.17;
      const archMaterial = this.materialFor(descriptor.id.includes('finish') ? 'gold' : 'cream');

      for (const side of [-1, 1]) {
        const pillar = new Mesh(this.unitPillar, archMaterial);
        pillar.name = `${descriptor.id}-pillar-${side < 0 ? 'left' : 'right'}`;
        pillar.scale.set(pillarRadius, descriptor.pillarHeight, pillarRadius);
        pillar.position.set(0, baseHeight + descriptor.pillarHeight * 0.5, side * radius);
        pillar.castShadow = true;
        group.add(pillar);
        const world = worldCoordinates(
          { x: descriptor.x, z: descriptor.z, yaw: descriptor.yaw },
          0,
          side * radius,
        );
        this.circularSolids.push({
          x: world.x,
          z: world.z,
          radius: pillarRadius,
          bottom: baseHeight,
          top: baseHeight + descriptor.pillarHeight,
        });
      }

      const arch = new Mesh(this.unitArch, archMaterial);
      arch.name = `${descriptor.id}-curve`;
      arch.rotation.y = Math.PI * 0.5;
      arch.scale.setScalar(radius);
      arch.position.y = baseHeight + descriptor.pillarHeight;
      arch.castShadow = true;
      group.add(arch);
      this.rectangularSolids.push({
        x: descriptor.x,
        z: descriptor.z,
        width: 0.46,
        depth: descriptor.openingWidth + 0.45,
        yaw: descriptor.yaw,
        bottom: baseHeight + descriptor.pillarHeight - 0.2,
        top: baseHeight + descriptor.pillarHeight + radius + 0.25,
      });

      if (descriptor.label) {
        const board = new Mesh(this.unitRoundedBox, archMaterial);
        board.name = `${descriptor.id}-label-board`;
        board.scale.set(0.14, descriptor.id.includes('checkpoint') ? 0.6 : 0.86, Math.min(3.35, descriptor.openingWidth + 0.18));
        board.position.set(-0.08, baseHeight + descriptor.pillarHeight + radius + 0.55, 0);
        board.castShadow = true;
        group.add(board);
        const text = new Text();
        text.name = `${descriptor.id}-label`;
        text.text = descriptor.label;
        text.fontSize = descriptor.id.includes('checkpoint') ? 0.23 : 0.32;
        text.color = 0x31373d;
        text.anchorX = 'center';
        text.anchorY = 'middle';
        text.textAlign = 'center';
        text.lineHeight = 1.08;
        text.maxWidth = Math.min(3, descriptor.openingWidth - 0.18);
        text.rotation.y = -Math.PI * 0.5;
        text.position.set(-0.16, board.position.y, 0);
        text.depthOffset = -2;
        text.renderOrder = 2;
        if (fontUrl) text.font = fontUrl;
        if (typeof self !== 'undefined') text.sync();
        group.add(text);
        this.texts.add(text);
      }
      this.root.add(group);
    }
  }

  private buildFinishMagic(): void {
    const finish = this.surfaceById.get('parkour-finish');
    if (!finish) return;
    const height = finish.highHeight + 1.15;
    const material = this.materialFor('gold');
    for (let index = 0; index < FINISH_ORB_COUNT; index += 1) {
      const orb = new Mesh(this.unitOrb, material);
      orb.name = `parkour-finish-orb-${index + 1}`;
      const phase = index / FINISH_ORB_COUNT * Math.PI * 2;
      const radius = 1.35 + (index % 2) * 0.22;
      orb.scale.setScalar(0.11 + (index % 3) * 0.018);
      orb.position.set(
        finish.descriptor.x,
        height,
        finish.descriptor.z,
      );
      orb.castShadow = true;
      this.root.add(orb);
      this.magicOrbs.push({
        mesh: orb,
        center: new Vector3(finish.descriptor.x, height, finish.descriptor.z),
        phase,
        radius,
      });
    }
  }

  private buildHoops(): void {
    this.layout.hoops.forEach((descriptor, index) => {
      const base = this.surfaceById.get(descriptor.baseSurfaceId);
      if (!base) return;
      const hoop = new Mesh(this.unitRing, this.materialFor('cream'));
      hoop.name = descriptor.id;
      hoop.rotation.y = Math.PI * 0.5 + descriptor.yaw;
      hoop.scale.setScalar(descriptor.radius);
      hoop.position.set(
        descriptor.x,
        this.surfaceHeight(base, descriptor.x, descriptor.z) + descriptor.heightOffset,
        descriptor.z,
      );
      hoop.castShadow = true;
      this.root.add(hoop);
      this.markerRings.push({ mesh: hoop, baseScale: descriptor.radius, phase: 2.7 + index * 1.3 });
    });
  }

  private animate(elapsed: number): void {
    const motion = this.reducedMotion ? 0.18 : 1;
    for (const ring of this.markerRings) {
      const pulse = ring.baseScale * (1 + Math.sin(elapsed * 1.65 + ring.phase) * 0.045 * motion);
      ring.mesh.scale.setScalar(pulse);
      ring.mesh.rotation.z = elapsed * 0.22 * motion + ring.phase;
    }
    for (const orb of this.magicOrbs) {
      const angle = elapsed * 0.55 * motion + orb.phase;
      orb.mesh.position.set(
        orb.center.x + Math.cos(angle) * orb.radius,
        orb.center.y + Math.sin(elapsed * 1.15 + orb.phase) * 0.22 * motion,
        orb.center.z + Math.sin(angle) * orb.radius,
      );
    }
  }

  private materialFor(palette: ParkourPalette): MeshStandardMaterial {
    const existing = this.paletteMaterials.get(palette);
    if (existing) return existing;
    const color = this.visualTheme === 'cyberpunk'
      ? CYBERPUNK_PALETTE_COLORS[palette]
      : this.visualTheme === 'desert'
        ? DESERT_PALETTE_COLORS[palette]
        : PALETTE_COLORS[palette];
    const material = this.trackMaterial(new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: this.visualTheme === 'cyberpunk' ? 0.28 : this.visualTheme === 'desert' ? 0.08 : 0.055,
      roughness: this.visualTheme === 'cyberpunk' ? 0.48 : this.visualTheme === 'desert' ? 0.9 : 0.78,
      metalness: this.visualTheme === 'cyberpunk' ? 0.16 : 0.01,
      flatShading: true,
    }));
    this.paletteMaterials.set(palette, material);
    return material;
  }

  private trackGeometry<T extends BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private trackMaterial<T extends Material>(material: T): T {
    this.materials.add(material);
    return material;
  }
}
