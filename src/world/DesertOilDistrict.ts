import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import {
  DEX_FIELD_PORTAL_RADIUS,
  MARKET_SLUGS,
  PORTAL_RADIUS,
  createSpawnAssignments,
} from '../../shared/src/index.js';
import { GRAND_MONUMENTS } from '../config';
import type { AssetSymbol } from '../types';
import { createRandom } from './random';
import { PARKOUR_PARK_BOUNDS } from './ParkourParkSystem';
import { OIL_DESERT_PALETTE, isOilDesertSymbol } from './oilDesertTheme';

const DISTRICT_RADIUS = 82;
const PLAZA_CLEAR_RADIUS = 29;
const ROAD_HALF_WIDTH = 5.4;
const PORTAL_CLEAR_RADIUS = 7.2;
const SPAWN_CLEAR_RADIUS = 2.2;
const DUNE_COUNT = 12;
const FORMATION_COUNT = 10;
const PALM_COUNT = 16;
const SCRUB_COUNT = 32;
const OASIS_COUNT = 2;
const PUMPJACK_COUNT = 2;
const LANTERN_COUNT = 12;
const DUST_COUNT = 30;
const LIGHT_COUNT = 4;

const UNIT_SCALE = new Vector3(1, 1, 1);
const UP = new Vector3(0, 1, 0);
const INSTANCE_POSITION = new Vector3();
const INSTANCE_SCALE = new Vector3();
const INSTANCE_ROTATION = new Quaternion();
const INSTANCE_TILT = new Quaternion();
const INSTANCE_MATRIX = new Matrix4();
const TILT_AXIS = new Vector3(0, 0, 1);

interface XZ {
  readonly x: number;
  readonly z: number;
}

export interface DesertOilDistrictEnvironment {
  /** 0 in bright daylight, 1 at full night. */
  readonly nightFactor: number;
  readonly playerPosition?: Readonly<{ x: number; y: number; z: number }>;
}

export interface DesertOilDistrictOptions {
  readonly parent: Object3D;
  readonly heightAt: (x: number, z: number) => number;
  readonly seed?: string;
  readonly activeMarket?: AssetSymbol;
  readonly reducedMotion?: boolean;
}

export interface DesertDuneDescriptor extends XZ {
  readonly id: string;
  readonly y: number;
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly height: number;
  readonly yaw: number;
}

export interface DesertFormationDescriptor extends XZ {
  readonly id: string;
  readonly y: number;
  readonly radius: number;
  readonly height: number;
  readonly yaw: number;
}

export interface DesertPalmDescriptor extends XZ {
  readonly id: string;
  readonly y: number;
  readonly height: number;
  readonly yaw: number;
}

export interface DesertOasisDescriptor extends XZ {
  readonly id: string;
  readonly y: number;
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly yaw: number;
}

export interface DesertPumpjackDescriptor extends XZ {
  readonly id: string;
  readonly y: number;
  readonly yaw: number;
  readonly phase: number;
  readonly radius: number;
  readonly height: number;
}

export interface DesertOilLayout {
  readonly dunes: readonly DesertDuneDescriptor[];
  readonly formations: readonly DesertFormationDescriptor[];
  readonly palms: readonly DesertPalmDescriptor[];
  readonly scrub: readonly Readonly<XZ & { id: string; y: number; scale: number; yaw: number }>[];
  readonly oases: readonly DesertOasisDescriptor[];
  readonly pumpjacks: readonly DesertPumpjackDescriptor[];
  readonly lanterns: readonly Readonly<XZ & { id: string; y: number }>[];
}

export interface DesertOilDistrictStats {
  readonly active: boolean;
  readonly dunes: number;
  readonly formations: number;
  readonly palms: number;
  readonly scrub: number;
  readonly oases: number;
  readonly pumpjacks: number;
  readonly lanterns: number;
  readonly dustParticles: number;
  readonly activePointLights: number;
  readonly pooledDrawCalls: number;
}

const ROAD_DIRECTIONS = GRAND_MONUMENTS
  .filter(({ symbol }) => symbol !== 'BTC')
  .map(({ x, z }) => {
    const length = Math.hypot(x, z) || 1;
    return { x: x / length, z: z / length };
  });

const WTI_PORTALS = GRAND_MONUMENTS
  .filter(({ symbol }) => symbol !== 'BTC')
  .map(({ symbol, x, z }) => {
    const length = Math.hypot(x, z) || 1;
    const radius = symbol === 'PUMP' || symbol === 'ANSEM' || symbol === 'SHFL'
      ? DEX_FIELD_PORTAL_RADIUS
      : PORTAL_RADIUS;
    return { x: x / length * radius, z: z / length * radius };
  });

/**
 * Every point the authoritative allocator may use when a player first joins
 * WTI or arrives from any other market. Keeping this data sourced from shared
 * spawn logic prevents client scenery from drifting into server spawn grids.
 */
export const WTI_SPAWN_PROTECTION_POINTS: readonly XZ[] = Object.freeze([
  ...createSpawnAssignments('wti').map(({ x, z }) => ({ x, z })),
  ...MARKET_SLUGS
    .filter((market) => market !== 'wti')
    .flatMap((market) => createSpawnAssignments('wti', market).map(({ x, z }) => ({ x, z }))),
  // Direct solo entry and the deterministic local parkour-QA start.
  { x: 0, z: -18 },
  { x: 30, z: 2 },
]);

function distanceToRoad(x: number, z: number, direction: XZ): number {
  const along = x * direction.x + z * direction.z;
  if (along <= 0 || along >= DISTRICT_RADIUS + 3) return Number.POSITIVE_INFINITY;
  return Math.abs(x * -direction.z + z * direction.x);
}

/** Shared deterministic exclusion used by layout generation and tests. */
export function isDesertOilProtectedPoint(x: number, z: number, margin = 0): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(margin)) return true;
  const safeMargin = Math.max(0, margin);
  if (Math.hypot(x, z) < PLAZA_CLEAR_RADIUS + safeMargin) return true;
  if (
    x >= PARKOUR_PARK_BOUNDS.left - safeMargin
    && x <= PARKOUR_PARK_BOUNDS.right + safeMargin
    && z >= PARKOUR_PARK_BOUNDS.bottom - safeMargin
    && z <= PARKOUR_PARK_BOUNDS.top + safeMargin
  ) return true;
  if (ROAD_DIRECTIONS.some((direction) => (
    distanceToRoad(x, z, direction) < ROAD_HALF_WIDTH + safeMargin
  ))) return true;
  if (WTI_PORTALS.some((portal) => (
    Math.hypot(x - portal.x, z - portal.z) < PORTAL_CLEAR_RADIUS + safeMargin
  ))) return true;
  return WTI_SPAWN_PROTECTION_POINTS.some((spawn) => (
    Math.hypot(x - spawn.x, z - spawn.z) < SPAWN_CLEAR_RADIUS + safeMargin
  ));
}

function overlaps(
  candidate: XZ,
  radius: number,
  occupied: readonly Readonly<XZ & { radius: number }>[],
  spacing = 1.4,
): boolean {
  return occupied.some((other) => (
    Math.hypot(candidate.x - other.x, candidate.z - other.z) < radius + other.radius + spacing
  ));
}

function candidateAt(random: () => number, minRadius: number, maxRadius: number): XZ {
  const angle = random() * Math.PI * 2;
  const radius = minRadius + Math.sqrt(random()) * (maxRadius - minRadius);
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

/** Pure deterministic WTI layout; no Three.js allocations. */
export function createDesertOilLayout(
  seed: string,
  heightAt: (x: number, z: number) => number,
): DesertOilLayout {
  const random = createRandom(`${seed}:wti-desert-v1`);
  const occupied: Array<XZ & { radius: number }> = [];
  const formations: DesertFormationDescriptor[] = [];
  const pumpjacks: DesertPumpjackDescriptor[] = [];
  const oases: DesertOasisDescriptor[] = [];

  for (let attempt = 0; attempt < 1_200 && formations.length < FORMATION_COUNT; attempt += 1) {
    const point = candidateAt(random, 38, 76);
    const radius = 2.2 + random() * 2.4;
    if (Math.hypot(point.x, point.z) + radius > DISTRICT_RADIUS) continue;
    if (isDesertOilProtectedPoint(point.x, point.z, radius + 1.1)) continue;
    if (overlaps(point, radius, occupied, 2.4)) continue;
    const height = 3.4 + random() * 6.8;
    formations.push({
      id: `wti-sandstone-${formations.length + 1}`,
      ...point,
      y: heightAt(point.x, point.z),
      radius,
      height,
      yaw: random() * Math.PI * 2,
    });
    occupied.push({ ...point, radius });
  }

  for (let attempt = 0; attempt < 700 && pumpjacks.length < PUMPJACK_COUNT; attempt += 1) {
    const point = candidateAt(random, 42, 70);
    const radius = 3.3;
    if (isDesertOilProtectedPoint(point.x, point.z, radius + 1.4)) continue;
    if (overlaps(point, radius, occupied, 3.2)) continue;
    pumpjacks.push({
      id: `wti-pumpjack-${pumpjacks.length + 1}`,
      ...point,
      y: heightAt(point.x, point.z),
      yaw: Math.atan2(-point.x, -point.z),
      phase: random() * Math.PI * 2,
      radius,
      height: 4.8,
    });
    occupied.push({ ...point, radius });
  }

  for (let attempt = 0; attempt < 700 && oases.length < OASIS_COUNT; attempt += 1) {
    const point = candidateAt(random, 42, 72);
    const radiusX = 3.2 + random() * 1.5;
    const radiusZ = 2.4 + random() * 1.1;
    const radius = Math.max(radiusX, radiusZ);
    if (isDesertOilProtectedPoint(point.x, point.z, radius + 2.2)) continue;
    if (overlaps(point, radius, occupied, 4.5)) continue;
    oases.push({
      id: `wti-oasis-${oases.length + 1}`,
      ...point,
      y: heightAt(point.x, point.z) + 0.035,
      radiusX,
      radiusZ,
      yaw: random() * Math.PI * 2,
    });
    occupied.push({ ...point, radius });
  }

  const palms: DesertPalmDescriptor[] = [];
  for (const oasis of oases) {
    for (let attempt = 0; attempt < 80 && palms.length < PALM_COUNT; attempt += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.max(oasis.radiusX, oasis.radiusZ) + 1.1 + random() * 4.8;
      const x = oasis.x + Math.cos(angle) * radius;
      const z = oasis.z + Math.sin(angle) * radius;
      if (Math.hypot(x, z) > DISTRICT_RADIUS - 2) continue;
      if (isDesertOilProtectedPoint(x, z, 1.2)) continue;
      if (palms.some((palm) => Math.hypot(x - palm.x, z - palm.z) < 2.4)) continue;
      palms.push({
        id: `wti-palm-${palms.length + 1}`,
        x,
        y: heightAt(x, z),
        z,
        height: 3.8 + random() * 2.8,
        yaw: random() * Math.PI * 2,
      });
    }
  }

  const scrub: Array<XZ & { id: string; y: number; scale: number; yaw: number }> = [];
  for (let attempt = 0; attempt < 1_000 && scrub.length < SCRUB_COUNT; attempt += 1) {
    const point = candidateAt(random, 32, 80);
    const scale = 0.35 + random() * 0.55;
    if (isDesertOilProtectedPoint(point.x, point.z, scale + 0.35)) continue;
    if (overlaps(point, scale, occupied, 0.8)) continue;
    if (scrub.some((item) => Math.hypot(point.x - item.x, point.z - item.z) < 1.3)) continue;
    scrub.push({
      id: `wti-scrub-${scrub.length + 1}`,
      ...point,
      y: heightAt(point.x, point.z),
      scale,
      yaw: random() * Math.PI * 2,
    });
  }

  const dunes: DesertDuneDescriptor[] = [];
  for (let attempt = 0; attempt < 800 && dunes.length < DUNE_COUNT; attempt += 1) {
    const point = candidateAt(random, 37, 76);
    const radiusX = 4.2 + random() * 3.1;
    const radiusZ = 2.7 + random() * 2.1;
    const footprint = Math.max(radiusX, radiusZ);
    if (Math.hypot(point.x, point.z) + footprint > DISTRICT_RADIUS) continue;
    // Dunes are decorative rather than collidable, so their entire rendered
    // ellipse must stay clear of roads, portals, parkour and spawn grids.
    if (isDesertOilProtectedPoint(point.x, point.z, footprint + 0.35)) continue;
    dunes.push({
      id: `wti-dune-${dunes.length + 1}`,
      ...point,
      y: heightAt(point.x, point.z) - 0.52,
      radiusX,
      radiusZ,
      height: 0.72 + random() * 0.72,
      yaw: random() * Math.PI * 2,
    });
  }

  const lanterns: Array<XZ & { id: string; y: number }> = [];
  for (let attempt = 0; attempt < 800 && lanterns.length < LANTERN_COUNT; attempt += 1) {
    const point = candidateAt(random, 32, 78);
    if (isDesertOilProtectedPoint(point.x, point.z, 0.75)) continue;
    if (overlaps(point, 0.4, occupied, 1.6)) continue;
    if (lanterns.some((item) => Math.hypot(point.x - item.x, point.z - item.z) < 5.2)) continue;
    lanterns.push({
      id: `wti-lantern-${lanterns.length + 1}`,
      ...point,
      y: heightAt(point.x, point.z),
    });
  }

  return { dunes, formations, palms, scrub, oases, pumpjacks, lanterns };
}

function setInstance(
  mesh: InstancedMesh,
  index: number,
  position: Vector3,
  scale: Vector3,
  yaw = 0,
  tilt = 0,
): void {
  INSTANCE_ROTATION.setFromAxisAngle(UP, yaw);
  if (tilt !== 0) INSTANCE_ROTATION.multiply(INSTANCE_TILT.setFromAxisAngle(TILT_AXIS, tilt));
  mesh.setMatrixAt(index, INSTANCE_MATRIX.compose(position, INSTANCE_ROTATION, scale));
}

function setInstanceValues(
  mesh: InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  yaw = 0,
  tilt = 0,
): void {
  setInstance(
    mesh,
    index,
    INSTANCE_POSITION.set(x, y, z),
    INSTANCE_SCALE.set(scaleX, scaleY, scaleZ),
    yaw,
    tilt,
  );
}

/** Allocation-bounded desert set dressing used only while WTI is active. */
export class DesertOilDistrict {
  public readonly root = new Group();
  public readonly layout: DesertOilLayout;

  private readonly materials = new Set<Material>();
  private readonly geometries = new Set<BufferGeometry>();
  private readonly heightAt: DesertOilDistrictOptions['heightAt'];
  private readonly duneMaterial: MeshStandardMaterial;
  private readonly sandstoneMaterial: MeshStandardMaterial;
  private readonly sandstoneLightMaterial: MeshStandardMaterial;
  private readonly palmMaterial: MeshStandardMaterial;
  private readonly scrubMaterial: MeshStandardMaterial;
  private readonly waterMaterial: MeshStandardMaterial;
  private readonly oilMaterial: MeshStandardMaterial;
  private readonly oilAccentMaterial: MeshStandardMaterial;
  private readonly lanternMaterial: MeshStandardMaterial;
  private readonly dustMaterial: PointsMaterial;
  private readonly pumpjackBoxes: InstancedMesh;
  private readonly pumpjackHeads: InstancedMesh;
  private readonly dustPositions = new Float32Array(DUST_COUNT * 3);
  private readonly dust: Points;
  private readonly dustPhases: readonly number[];
  private readonly rankedLanterns: Array<{
    readonly lantern: DesertOilLayout['lanterns'][number];
    readonly index: number;
    distance: number;
  }>;
  private readonly pooledLights: PointLight[] = [];
  private active = false;
  private reducedMotion: boolean;
  private disposed = false;

  public constructor(options: DesertOilDistrictOptions) {
    this.heightAt = options.heightAt;
    this.reducedMotion = options.reducedMotion ?? false;
    this.layout = createDesertOilLayout(options.seed ?? 'tickerworld-v1', options.heightAt);
    this.rankedLanterns = this.layout.lanterns.map((lantern, index) => ({
      lantern,
      index,
      distance: index,
    }));
    this.root.name = 'tickerworld-wti-desert-district';
    this.root.visible = false;

    this.duneMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.sandLight,
      roughness: 1,
      flatShading: true,
    }));
    this.sandstoneMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.sandstone,
      roughness: 0.96,
      flatShading: true,
    }));
    this.sandstoneLightMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.sandstoneLight,
      roughness: 0.94,
      flatShading: true,
    }));
    this.palmMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.palm,
      roughness: 0.92,
      flatShading: true,
    }));
    this.scrubMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.scrub,
      roughness: 1,
      flatShading: true,
    }));
    this.waterMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.oasis,
      emissive: 0x234f4c,
      emissiveIntensity: 0.1,
      transparent: true,
      opacity: 0.84,
      roughness: 0.22,
      metalness: 0.04,
      depthWrite: false,
      side: DoubleSide,
    }));
    this.oilMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.oilDark,
      roughness: 0.62,
      metalness: 0.34,
      flatShading: true,
    }));
    this.oilAccentMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: OIL_DESERT_PALETTE.oilAccent,
      emissive: 0x7b3d20,
      emissiveIntensity: 0.08,
      roughness: 0.55,
      metalness: 0.18,
      flatShading: true,
    }));
    this.lanternMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: 0xffdc9b,
      emissive: 0xffa24d,
      emissiveIntensity: 0.6,
      roughness: 0.42,
    }));

    this.buildLandscape();
    const pumpBoxGeometry = this.trackGeometry(new BoxGeometry(1, 1, 1));
    const pumpHeadGeometry = this.trackGeometry(new CylinderGeometry(0.36, 0.5, 1.25, 8));
    this.pumpjackBoxes = new InstancedMesh(
      pumpBoxGeometry,
      this.oilMaterial,
      Math.max(1, PUMPJACK_COUNT * 4),
    );
    this.pumpjackBoxes.name = 'wti-pumpjack-frames';
    this.pumpjackBoxes.count = this.layout.pumpjacks.length * 4;
    this.pumpjackBoxes.castShadow = true;
    this.pumpjackHeads = new InstancedMesh(
      pumpHeadGeometry,
      this.oilAccentMaterial,
      Math.max(1, PUMPJACK_COUNT),
    );
    this.pumpjackHeads.name = 'wti-pumpjack-heads';
    this.pumpjackHeads.count = this.layout.pumpjacks.length;
    this.pumpjackHeads.castShadow = true;
    this.root.add(this.pumpjackBoxes, this.pumpjackHeads);
    this.updatePumpjacks(0);

    const dustGeometry = this.trackGeometry(new BufferGeometry());
    const dustAttribute = new BufferAttribute(this.dustPositions, 3);
    dustAttribute.setUsage(DynamicDrawUsage);
    dustGeometry.setAttribute('position', dustAttribute);
    this.dustMaterial = this.trackMaterial(new PointsMaterial({
      color: OIL_DESERT_PALETTE.sandLight,
      size: 0.34,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    this.dust = new Points(dustGeometry, this.dustMaterial);
    this.dust.name = 'wti-desert-dust';
    this.dust.frustumCulled = false;
    this.dustPhases = Array.from({ length: DUST_COUNT }, (_, index) => index * 1.731);
    this.root.add(this.dust);

    for (let index = 0; index < LIGHT_COUNT; index += 1) {
      const light = new PointLight(0xffa85a, 0, 18, 2);
      light.name = `WtiDesertLight${index + 1}`;
      light.visible = false;
      this.pooledLights.push(light);
      this.root.add(light);
    }

    options.parent.add(this.root);
    if (options.activeMarket) this.setActiveMarket(options.activeMarket);
  }

  public setActiveMarket(symbol: AssetSymbol): void {
    if (this.disposed) return;
    this.active = isOilDesertSymbol(symbol);
    this.root.visible = this.active;
    if (!this.active) for (const light of this.pooledLights) light.visible = false;
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  public update(
    _deltaSeconds: number,
    elapsedSeconds: number,
    environment: DesertOilDistrictEnvironment,
  ): void {
    if (!this.active || this.disposed) return;
    const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    const night = Math.max(0, Math.min(1, environment.nightFactor));
    this.updatePumpjacks(elapsed);
    this.updateDust(elapsed, night, environment.playerPosition);

    this.lanternMaterial.emissiveIntensity = 0.35 + night * 2.15;
    this.waterMaterial.emissiveIntensity = 0.08 + night * 0.22;
    this.duneMaterial.emissive.setHex(OIL_DESERT_PALETTE.skyNight);
    this.duneMaterial.emissiveIntensity = night * 0.055;
    this.sandstoneMaterial.emissive.setHex(0x33243b);
    this.sandstoneMaterial.emissiveIntensity = night * 0.045;

    const player = environment.playerPosition;
    for (const ranked of this.rankedLanterns) {
      ranked.distance = player
        ? Math.hypot(player.x - ranked.lantern.x, player.z - ranked.lantern.z)
        : ranked.index;
    }
    this.rankedLanterns.sort((a, b) => a.distance - b.distance);
    for (let index = 0; index < this.pooledLights.length; index += 1) {
      const light = this.pooledLights[index]!;
      const selected = this.rankedLanterns[index];
      light.visible = Boolean(selected && selected.distance < 42 && night > 0.08);
      light.intensity = light.visible ? 0.15 + night * 3.25 : 0;
      if (selected) light.position.set(selected.lantern.x, selected.lantern.y + 2.35, selected.lantern.z);
    }
  }

  public collidesPlayer(x: number, z: number, radius = 0.7): boolean {
    if (!this.active || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    return this.layout.formations.some((formation) => (
      Math.hypot(x - formation.x, z - formation.z) < formation.radius + radius
    )) || this.layout.pumpjacks.some((pumpjack) => (
      Math.hypot(x - pumpjack.x, z - pumpjack.z) < pumpjack.radius + radius
    ));
  }

  public resolveHorizontal(
    x: number,
    z: number,
    radius: number,
    previousX: number,
    previousZ: number,
  ): Readonly<XZ> {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return {
        x: Number.isFinite(previousX) ? previousX : 0,
        z: Number.isFinite(previousZ) ? previousZ : 0,
      };
    }
    if (!this.collidesPlayer(x, z, radius)) return { x, z };
    if (!this.collidesPlayer(x, previousZ, radius)) return { x, z: previousZ };
    if (!this.collidesPlayer(previousX, z, radius)) return { x: previousX, z };
    return { x: previousX, z: previousZ };
  }

  public collidesCamera(x: number, y: number, z: number, radius = 0.42): boolean {
    if (!this.active || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return false;
    }
    return this.layout.formations.some((formation) => (
      y >= formation.y - radius
      && y <= formation.y + formation.height + radius
      && Math.hypot(x - formation.x, z - formation.z) < formation.radius + radius
    )) || this.layout.pumpjacks.some((pumpjack) => (
      y >= pumpjack.y - radius
      && y <= pumpjack.y + pumpjack.height + radius
      && Math.hypot(x - pumpjack.x, z - pumpjack.z) < pumpjack.radius + radius
    ));
  }

  public getDebugStats(): DesertOilDistrictStats {
    const pooledDrawCalls = this.root.children.filter((child) => (
      child.visible && (child instanceof InstancedMesh || child instanceof Points)
    )).length;
    return {
      active: this.active,
      dunes: this.layout.dunes.length,
      formations: this.layout.formations.length,
      palms: this.layout.palms.length,
      scrub: this.layout.scrub.length,
      oases: this.layout.oases.length,
      pumpjacks: this.layout.pumpjacks.length,
      lanterns: this.layout.lanterns.length,
      dustParticles: this.active ? DUST_COUNT : 0,
      activePointLights: this.pooledLights.filter((light) => light.visible).length,
      pooledDrawCalls: this.active ? pooledDrawCalls : 0,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.pooledLights.length = 0;
    this.root.clear();
  }

  private buildLandscape(): void {
    const duneGeometry = this.trackGeometry(new SphereGeometry(1, 12, 6));
    const dunes = new InstancedMesh(duneGeometry, this.duneMaterial, Math.max(1, DUNE_COUNT));
    dunes.name = 'wti-desert-dunes';
    dunes.count = this.layout.dunes.length;
    dunes.receiveShadow = true;
    this.layout.dunes.forEach((dune, index) => {
      setInstance(
        dunes,
        index,
        new Vector3(dune.x, dune.y, dune.z),
        new Vector3(dune.radiusX, dune.height, dune.radiusZ),
        dune.yaw,
      );
    });
    dunes.instanceMatrix.needsUpdate = true;

    const formationGeometry = this.trackGeometry(new IcosahedronGeometry(1, 1));
    const formations = new InstancedMesh(
      formationGeometry,
      this.sandstoneMaterial,
      Math.max(1, FORMATION_COUNT * 2),
    );
    formations.name = 'wti-sandstone-formations';
    formations.count = this.layout.formations.length * 2;
    formations.castShadow = true;
    formations.receiveShadow = true;
    this.layout.formations.forEach((formation, index) => {
      setInstance(
        formations,
        index * 2,
        new Vector3(formation.x, formation.y + formation.height * 0.42, formation.z),
        new Vector3(formation.radius, formation.height * 0.5, formation.radius * 0.76),
        formation.yaw,
      );
      setInstance(
        formations,
        index * 2 + 1,
        new Vector3(
          formation.x + Math.cos(formation.yaw) * formation.radius * 0.42,
          formation.y + formation.height * 0.76,
          formation.z + Math.sin(formation.yaw) * formation.radius * 0.42,
        ),
        new Vector3(formation.radius * 0.66, formation.height * 0.32, formation.radius * 0.58),
        formation.yaw + 0.38,
      );
    });
    formations.instanceMatrix.needsUpdate = true;

    const trunkGeometry = this.trackGeometry(new CylinderGeometry(0.12, 0.22, 1, 7));
    const trunks = new InstancedMesh(trunkGeometry, this.sandstoneLightMaterial, Math.max(1, PALM_COUNT));
    trunks.name = 'wti-oasis-palm-trunks';
    trunks.count = this.layout.palms.length;
    trunks.castShadow = true;
    const crownGeometry = this.trackGeometry(new ConeGeometry(1, 1, 6));
    const crowns = new InstancedMesh(crownGeometry, this.palmMaterial, Math.max(1, PALM_COUNT * 2));
    crowns.name = 'wti-oasis-palm-crowns';
    crowns.count = this.layout.palms.length * 2;
    crowns.castShadow = true;
    this.layout.palms.forEach((palm, index) => {
      setInstance(
        trunks,
        index,
        new Vector3(palm.x, palm.y + palm.height * 0.5, palm.z),
        new Vector3(1, palm.height, 1),
        palm.yaw,
        Math.sin(palm.yaw) * 0.045,
      );
      for (let layer = 0; layer < 2; layer += 1) {
        setInstance(
          crowns,
          index * 2 + layer,
          new Vector3(palm.x, palm.y + palm.height + layer * 0.2, palm.z),
          new Vector3(1.5 - layer * 0.22, 0.54, 1.5 - layer * 0.22),
          palm.yaw + layer * Math.PI / 6,
          Math.PI,
        );
      }
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;

    const scrubGeometry = this.trackGeometry(new IcosahedronGeometry(1, 0));
    const scrub = new InstancedMesh(scrubGeometry, this.scrubMaterial, Math.max(1, SCRUB_COUNT));
    scrub.name = 'wti-desert-scrub';
    scrub.count = this.layout.scrub.length;
    this.layout.scrub.forEach((item, index) => {
      setInstance(
        scrub,
        index,
        new Vector3(item.x, item.y + item.scale * 0.36, item.z),
        new Vector3(item.scale, item.scale * 0.48, item.scale * 0.75),
        item.yaw,
      );
    });
    scrub.instanceMatrix.needsUpdate = true;

    const waterGeometry = this.trackGeometry(new CircleGeometry(1, 24));
    waterGeometry.rotateX(-Math.PI * 0.5);
    const water = new InstancedMesh(waterGeometry, this.waterMaterial, Math.max(1, OASIS_COUNT));
    water.name = 'wti-oasis-water';
    water.count = this.layout.oases.length;
    this.layout.oases.forEach((oasis, index) => {
      setInstance(
        water,
        index,
        new Vector3(oasis.x, oasis.y, oasis.z),
        new Vector3(oasis.radiusX, 1, oasis.radiusZ),
        oasis.yaw,
      );
    });
    water.instanceMatrix.needsUpdate = true;

    const poleGeometry = this.trackGeometry(new CylinderGeometry(0.055, 0.09, 2.4, 7));
    const globeGeometry = this.trackGeometry(new IcosahedronGeometry(0.25, 0));
    const poles = new InstancedMesh(poleGeometry, this.oilMaterial, Math.max(1, LANTERN_COUNT));
    const globes = new InstancedMesh(globeGeometry, this.lanternMaterial, Math.max(1, LANTERN_COUNT));
    poles.name = 'wti-desert-lantern-poles';
    globes.name = 'wti-desert-lantern-globes';
    poles.count = this.layout.lanterns.length;
    globes.count = this.layout.lanterns.length;
    this.layout.lanterns.forEach((lantern, index) => {
      setInstance(poles, index, new Vector3(lantern.x, lantern.y + 1.2, lantern.z), UNIT_SCALE);
      setInstance(globes, index, new Vector3(lantern.x, lantern.y + 2.35, lantern.z), UNIT_SCALE);
    });
    poles.instanceMatrix.needsUpdate = true;
    globes.instanceMatrix.needsUpdate = true;
    this.root.add(dunes, formations, trunks, crowns, scrub, water, poles, globes);
  }

  private updatePumpjacks(elapsedSeconds: number): void {
    const motion = this.reducedMotion ? 0.24 : 1;
    this.layout.pumpjacks.forEach((pumpjack, index) => {
      const nod = Math.sin(elapsedSeconds * 0.72 * motion + pumpjack.phase) * 0.16 * motion;
      const forwardX = Math.sin(pumpjack.yaw);
      const forwardZ = Math.cos(pumpjack.yaw);
      const lateralX = Math.cos(pumpjack.yaw);
      const lateralZ = -Math.sin(pumpjack.yaw);
      setInstanceValues(
        this.pumpjackBoxes,
        index * 4,
        pumpjack.x,
        pumpjack.y + 0.12,
        pumpjack.z,
        4.4,
        0.24,
        2.8,
        pumpjack.yaw,
      );
      for (let side = 0; side < 2; side += 1) {
        const amount = side === 0 ? -1 : 1;
        setInstanceValues(
          this.pumpjackBoxes,
          index * 4 + 1 + side,
          pumpjack.x + lateralX * amount * 0.82,
          pumpjack.y + 1.75,
          pumpjack.z + lateralZ * amount * 0.82,
          0.22,
          3.25,
          0.22,
          pumpjack.yaw,
          amount * 0.22,
        );
      }
      setInstanceValues(
        this.pumpjackBoxes,
        index * 4 + 3,
        pumpjack.x + forwardX * 0.25,
        pumpjack.y + 3.45,
        pumpjack.z + forwardZ * 0.25,
        4.25,
        0.3,
        0.38,
        pumpjack.yaw,
        nod,
      );
      setInstanceValues(
        this.pumpjackHeads,
        index,
        pumpjack.x + forwardX * 2.05,
        pumpjack.y + 3.43 - nod * 1.3,
        pumpjack.z + forwardZ * 2.05,
        1,
        1,
        1,
        pumpjack.yaw,
        Math.PI * 0.5 + nod,
      );
    });
    this.pumpjackBoxes.instanceMatrix.needsUpdate = true;
    this.pumpjackHeads.instanceMatrix.needsUpdate = true;
  }

  private updateDust(
    elapsedSeconds: number,
    nightFactor: number,
    player?: Readonly<{ x: number; y: number; z: number }>,
  ): void {
    const motion = this.reducedMotion ? 0.18 : 1;
    const centerX = player?.x ?? 0;
    const centerZ = player?.z ?? 0;
    const baseY = this.heightAt(centerX, centerZ) + 0.2;
    for (let index = 0; index < DUST_COUNT; index += 1) {
      const phase = this.dustPhases[index] ?? 0;
      const angle = phase * 2.17;
      const radius = 4 + (index % 10) * 1.65;
      const drift = elapsedSeconds * (0.28 + (index % 3) * 0.06) * motion;
      const offset = index * 3;
      this.dustPositions[offset] = centerX + Math.cos(angle) * radius + drift % 7 - 3.5;
      this.dustPositions[offset + 1] = baseY + 0.18 + (index % 5) * 0.16
        + Math.sin(elapsedSeconds * 0.4 * motion + phase) * 0.11 * motion;
      this.dustPositions[offset + 2] = centerZ + Math.sin(angle) * radius;
    }
    this.dust.geometry.getAttribute('position').needsUpdate = true;
    this.dustMaterial.opacity = (this.reducedMotion ? 0.08 : 0.18) * (1 - nightFactor * 0.72);
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
