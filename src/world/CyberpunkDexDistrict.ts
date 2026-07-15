import {
  BoxGeometry,
  BufferGeometry,
  BufferAttribute,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { Text } from 'troika-three-text';
import { createPortalRoutes } from '../../shared/src/index.js';
import type { AssetSymbol } from '../types';
import { createRandom } from './random';
import { PARKOUR_PARK_BOUNDS } from './ParkourParkSystem';
import {
  DEX_CYBERPUNK_SYMBOLS,
  DEX_CYBERPUNK_THEMES,
  dexCyberpunkGlowAt,
  isDexCyberpunkSymbol,
} from './dexCyberpunkTheme';

export const DEX_CYBERPUNK_MARKETS = DEX_CYBERPUNK_SYMBOLS;
export type DexCyberpunkMarket = (typeof DEX_CYBERPUNK_MARKETS)[number];

const DISTRICT_RADIUS = 82;
const PLAZA_CLEAR_RADIUS = 29;
const ROAD_HALF_WIDTH = 5.4;
const PORTAL_CLEAR_RADIUS = 7.2;
const BUILDING_COUNT = 18;
const SIGN_COUNT = 6;
const VENT_COUNT = 7;
const LANTERN_COUNT = 14;
const STEAM_PER_VENT = 4;
const STEAM_COUNT = VENT_COUNT * STEAM_PER_VENT;
const POOLED_LIGHT_COUNT = 4;

const UNIT_Y = new Vector3(0, 1, 0);
const UNIT_SCALE = new Vector3(1, 1, 1);
export interface CyberpunkDistrictEnvironment {
  /** 0 in bright daylight, 1 at full night. */
  readonly nightFactor: number;
  readonly rainIntensity?: number;
  readonly playerPosition?: Readonly<{ x: number; y: number; z: number }>;
}

export interface CyberpunkDexDistrictOptions {
  readonly parent: Object3D;
  readonly seed?: string;
  readonly heightAt: (x: number, z: number) => number;
  readonly fontUrl?: string;
  readonly activeMarket?: AssetSymbol;
  readonly reducedMotion?: boolean;
}

export interface CyberpunkBuildingDescriptor {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly yaw: number;
  readonly palette: number;
}

export interface CyberpunkSignDescriptor {
  readonly id: string;
  readonly buildingId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export interface CyberpunkDexLayout {
  readonly buildings: readonly CyberpunkBuildingDescriptor[];
  readonly signs: readonly CyberpunkSignDescriptor[];
  readonly vents: readonly Readonly<{ x: number; y: number; z: number }>[];
  readonly lanterns: readonly Readonly<{ x: number; y: number; z: number }>[];
}

export interface CyberpunkDexDistrictStats {
  readonly active: boolean;
  readonly market: DexCyberpunkMarket | null;
  readonly buildings: number;
  readonly signs: number;
  readonly vents: number;
  readonly lanterns: number;
  readonly steamParticles: number;
  readonly activePointLights: number;
  readonly pooledDrawCalls: number;
}

const PALETTES = [
  { body: 0x172139, trim: 0x26375b, neon: 0x61e7dd, accent: 0xef77c8 },
  { body: 0x211d38, trim: 0x3b315c, neon: 0xc786ff, accent: 0x7bf0bf },
  { body: 0x182b34, trim: 0x294956, neon: 0xff8db0, accent: 0x72ccff },
] as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function distanceToRoad(x: number, z: number, dx: number, dz: number): number {
  const along = x * dx + z * dz;
  if (along <= 0 || along >= DISTRICT_RADIUS + 4) return Number.POSITIVE_INFINITY;
  return Math.abs(x * -dz + z * dx);
}

function canonicalRoadDirections(): readonly Readonly<{
  x: number;
  z: number;
  portalRadius: number;
}>[] {
  return createPortalRoutes('btc').map((route) => {
    const length = Math.hypot(route.x, route.z) || 1;
    return {
      x: route.x / length,
      z: route.z / length,
      portalRadius: length,
    };
  });
}

const ROAD_DIRECTIONS = canonicalRoadDirections();

/** Shared pure guard used both by generation and integration-level prop exclusion. */
export function isDexDistrictProtectedPoint(x: number, z: number, margin = 0): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return true;
  if (Math.hypot(x, z) < PLAZA_CLEAR_RADIUS + margin) return true;
  if (
    x >= PARKOUR_PARK_BOUNDS.left - margin
    && x <= PARKOUR_PARK_BOUNDS.right + margin
    && z >= PARKOUR_PARK_BOUNDS.bottom - margin
    && z <= PARKOUR_PARK_BOUNDS.top + margin
  ) return true;
  return ROAD_DIRECTIONS.some((direction) => {
    if (distanceToRoad(x, z, direction.x, direction.z) < ROAD_HALF_WIDTH + margin) return true;
    const portalX = direction.x * direction.portalRadius;
    const portalZ = direction.z * direction.portalRadius;
    return Math.hypot(x - portalX, z - portalZ) < PORTAL_CLEAR_RADIUS + margin;
  });
}

export function isDexCyberpunkMarket(symbol: AssetSymbol): symbol is DexCyberpunkMarket {
  return isDexCyberpunkSymbol(symbol);
}

function overlapsBuilding(
  candidate: Pick<CyberpunkBuildingDescriptor, 'x' | 'z' | 'width' | 'depth'>,
  existing: readonly CyberpunkBuildingDescriptor[],
): boolean {
  const candidateRadius = Math.hypot(candidate.width, candidate.depth) * 0.5;
  return existing.some((building) => Math.hypot(candidate.x - building.x, candidate.z - building.z)
    < candidateRadius + Math.hypot(building.width, building.depth) * 0.5 + 2.2);
}

/** Deterministic layout shared by runtime and tests; no Three.js allocations. */
export function createCyberpunkDexLayout(
  seed: string,
  heightAt: (x: number, z: number) => number,
): CyberpunkDexLayout {
  const random = createRandom(`${seed}:dex-cyberpunk-v1`);
  const buildings: CyberpunkBuildingDescriptor[] = [];
  for (let attempt = 0; attempt < 900 && buildings.length < BUILDING_COUNT; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 38 + Math.sqrt(random()) * 39;
    const width = 4.8 + random() * 4.2;
    const depth = 4.8 + random() * 4.2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const footprintRadius = Math.hypot(width, depth) * 0.5;
    if (radius + footprintRadius > DISTRICT_RADIUS) continue;
    if (isDexDistrictProtectedPoint(x, z, footprintRadius + 1.25)) continue;
    const candidate = { x, z, width, depth };
    if (overlapsBuilding(candidate, buildings)) continue;
    const height = 8 + random() * 16;
    buildings.push({
      id: `dex-building-${buildings.length + 1}`,
      x,
      y: heightAt(x, z),
      z,
      width,
      depth,
      height,
      // Each facade addresses the central pedestrian space without copying a real building.
      yaw: Math.atan2(x, z) + Math.PI,
      palette: Math.min(PALETTES.length - 1, Math.floor(random() * PALETTES.length)),
    });
  }

  const signBuildings = [...buildings]
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, SIGN_COUNT);
  const signs = signBuildings.map((building, index) => {
    const towardOrigin = Math.atan2(-building.x, -building.z);
    const normalX = Math.sin(towardOrigin);
    const normalZ = Math.cos(towardOrigin);
    return {
      id: `dex-sign-${index + 1}`,
      buildingId: building.id,
      x: building.x + normalX * (Math.max(building.width, building.depth) * 0.5 + 0.08),
      y: building.y + Math.min(building.height - 1.4, 4.8 + index * 0.72),
      z: building.z + normalZ * (Math.max(building.width, building.depth) * 0.5 + 0.08),
      yaw: towardOrigin,
    };
  });

  const utilityBuildings = buildings.slice(SIGN_COUNT, SIGN_COUNT + Math.max(VENT_COUNT, 7));
  const vents = utilityBuildings.slice(0, VENT_COUNT).map((building, index) => ({
    x: building.x + Math.cos(building.yaw) * (1.1 + (index % 2) * 0.55),
    y: building.y + building.height + 0.24,
    z: building.z - Math.sin(building.yaw) * (0.8 + (index % 3) * 0.35),
  }));

  const lanterns: Array<{ x: number; y: number; z: number }> = [];
  for (let attempt = 0; attempt < 360 && lanterns.length < LANTERN_COUNT; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 32 + random() * 47;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (isDexDistrictProtectedPoint(x, z, 1.2)) continue;
    if (buildings.some((building) => Math.hypot(x - building.x, z - building.z)
      < Math.hypot(building.width, building.depth) * 0.5 + 2)) continue;
    if (lanterns.some((lantern) => Math.hypot(x - lantern.x, z - lantern.z) < 5.2)) continue;
    lanterns.push({ x, y: heightAt(x, z), z });
  }
  return { buildings, signs, vents, lanterns };
}

function setInstance(
  mesh: InstancedMesh,
  index: number,
  position: Vector3,
  scale: Vector3,
  yaw = 0,
): void {
  const quaternion = new Quaternion().setFromAxisAngle(UNIT_Y, yaw);
  mesh.setMatrixAt(index, new Matrix4().compose(position, quaternion, scale));
}

/**
 * Allocation-bounded original neon district for the three DEX worlds. It is
 * deliberately inspired by a lively Tokyo night district rather than any
 * identifiable street, business, logo, or copyrighted sign.
 */
export class CyberpunkDexDistrict {
  public readonly root = new Group();
  public readonly layout: CyberpunkDexLayout;

  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private readonly texts: Text[] = [];
  private readonly bodyMaterials: MeshStandardMaterial[];
  private readonly trimMaterial: MeshStandardMaterial;
  private readonly windowMaterial: MeshStandardMaterial;
  private readonly wetMaterial: MeshStandardMaterial;
  private readonly signBoardMaterial: MeshStandardMaterial;
  private readonly lanternMaterial: MeshStandardMaterial;
  private readonly steamMaterial: PointsMaterial;
  private readonly steamPositions = new Float32Array(STEAM_COUNT * 3);
  private readonly steam: Points<BufferGeometry, PointsMaterial>;
  private readonly steamPhases: readonly number[];
  private readonly pooledLights: PointLight[] = [];
  private readonly signTexts: Text[] = [];
  private activeMarket: DexCyberpunkMarket | null = null;
  private reducedMotion: boolean;
  private disposed = false;

  public constructor(options: CyberpunkDexDistrictOptions) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.root.name = 'tickerworld-dex-cyberpunk-district';
    this.root.visible = false;
    this.layout = createCyberpunkDexLayout(options.seed ?? 'tickerworld-v1', options.heightAt);

    this.bodyMaterials = PALETTES.map((palette) => this.trackMaterial(new MeshStandardMaterial({
      color: palette.body,
      emissive: palette.trim,
      emissiveIntensity: 0.05,
      roughness: 0.72,
      metalness: 0.18,
      flatShading: true,
    })));
    this.trimMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: 0x31405c,
      emissive: 0x5b71a1,
      emissiveIntensity: 0.12,
      roughness: 0.52,
      metalness: 0.28,
    }));
    this.windowMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: 0x8ce6e1,
      emissive: 0x53dcd2,
      emissiveIntensity: 1.1,
      roughness: 0.24,
      metalness: 0.12,
      toneMapped: false,
    }));
    this.wetMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: 0x263041,
      emissive: 0x17213b,
      emissiveIntensity: 0.08,
      roughness: 0.26,
      metalness: 0.5,
    }));
    this.signBoardMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: 0x261f3f,
      emissive: 0xef63bd,
      emissiveIntensity: 0.85,
      roughness: 0.38,
      metalness: 0.18,
    }));
    this.lanternMaterial = this.trackMaterial(new MeshStandardMaterial({
      color: 0xffc9dd,
      emissive: 0xff6ac1,
      emissiveIntensity: 1,
      roughness: 0.38,
      toneMapped: false,
    }));

    this.buildArchitecture();
    this.buildSigns(options.fontUrl);
    this.buildUtilities();

    const steamGeometry = this.trackGeometry(new BufferGeometry());
    const positions = new BufferAttribute(this.steamPositions, 3);
    positions.setUsage(DynamicDrawUsage);
    steamGeometry.setAttribute('position', positions);
    this.steamMaterial = this.trackMaterial(new PointsMaterial({
      color: 0xb7d9df,
      size: 0.46,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    this.steam = new Points(steamGeometry, this.steamMaterial);
    this.steam.name = 'dex-rooftop-steam';
    this.steam.frustumCulled = false;
    this.steamPhases = Array.from({ length: STEAM_COUNT }, (_, index) => index * 0.731);
    this.root.add(this.steam);

    for (let index = 0; index < POOLED_LIGHT_COUNT; index += 1) {
      const light = new PointLight(index % 2 === 0 ? 0xff70c4 : 0x63e7df, 0, 15, 2);
      light.name = `DexPooledLight${index + 1}`;
      light.visible = false;
      this.pooledLights.push(light);
      this.root.add(light);
    }
    options.parent.add(this.root);
    if (options.activeMarket) this.setActiveMarket(options.activeMarket);
  }

  public setActiveMarket(symbol: AssetSymbol): void {
    if (this.disposed) return;
    const market = isDexCyberpunkMarket(symbol) ? symbol : null;
    this.activeMarket = market;
    this.root.visible = market !== null;
    if (market) this.applyTheme(market);
    if (!market) for (const light of this.pooledLights) light.visible = false;
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  public update(
    _deltaSeconds: number,
    elapsedSeconds: number,
    environment: CyberpunkDistrictEnvironment,
  ): void {
    if (this.disposed || !this.activeMarket) return;
    const night = clamp01(environment.nightFactor);
    const rain = clamp01(environment.rainIntensity ?? 0);
    const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    const glow = dexCyberpunkGlowAt(night);

    for (const material of this.bodyMaterials) {
      material.emissiveIntensity = 0.1 + glow.neon * 0.2;
    }
    this.trimMaterial.emissiveIntensity = 0.14 + glow.neon * 0.28;
    this.windowMaterial.emissiveIntensity = 0.72 + glow.windows * 1.55;
    this.signBoardMaterial.emissiveIntensity = 0.52 + glow.neon * 1.3;
    this.lanternMaterial.emissiveIntensity = 0.46 + glow.neon * 1.55;
    this.wetMaterial.roughness = 0.34 - rain * 0.18;
    this.wetMaterial.emissiveIntensity = 0.03 + glow.puddleReflection * 0.17 + rain * 0.06;
    this.steamMaterial.opacity = 0.14 + night * 0.24 + rain * 0.08;
    const motion = this.reducedMotion ? 0.22 : 1;
    for (let index = 0; index < STEAM_COUNT; index += 1) {
      const ventIndex = index % Math.max(1, this.layout.vents.length);
      const vent = this.layout.vents[ventIndex];
      if (!vent) continue;
      const phase = this.steamPhases[index] ?? 0;
      const lane = Math.floor(index / Math.max(1, this.layout.vents.length));
      const time = elapsed * (0.18 + lane * 0.035) * motion + phase;
      const lift = ((time % 1.8) / 1.8) * (2.4 + lane * 0.4);
      const offset = index * 3;
      this.steamPositions[offset] = vent.x + Math.sin(time * 2.3) * 0.22 * motion;
      this.steamPositions[offset + 1] = vent.y + 0.2 + lift;
      this.steamPositions[offset + 2] = vent.z + Math.cos(time * 1.9) * 0.18 * motion;
    }
    this.steam.geometry.getAttribute('position').needsUpdate = true;

    const player = environment.playerPosition;
    const ranked = this.layout.lanterns.map((lantern, index) => ({
      lantern,
      index,
      distance: player ? Math.hypot(player.x - lantern.x, player.z - lantern.z) : index,
    })).sort((a, b) => a.distance - b.distance);
    for (let index = 0; index < this.pooledLights.length; index += 1) {
      const light = this.pooledLights[index]!;
      const selected = ranked[index];
      const inRange = selected && selected.distance < 42;
      light.visible = night > 0.08 && Boolean(inRange);
      light.intensity = light.visible ? (0.08 + glow.streetBounce * 3.1) : 0;
      if (selected) light.position.set(selected.lantern.x, selected.lantern.y + 2.55, selected.lantern.z);
    }
  }

  public collidesPlayer(x: number, z: number, radius = 0.7): boolean {
    if (!this.activeMarket || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    return this.layout.buildings.some((building) => this.containsFootprint(building, x, z, radius));
  }

  /** Conservative axis-separated resolver that preserves sliding along facades. */
  public resolveHorizontal(
    x: number,
    z: number,
    radius: number,
    previousX: number,
    previousZ: number,
  ): Readonly<{ x: number; z: number }> {
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
    if (!this.activeMarket || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return false;
    }
    return this.layout.buildings.some((building) => (
      y >= building.y - radius
      && y <= building.y + building.height + radius
      && this.containsFootprint(building, x, z, radius)
    ));
  }

  public getDebugStats(): CyberpunkDexDistrictStats {
    const visiblePools = this.root.children.filter((child) => child.visible && (
      child instanceof InstancedMesh || child instanceof Points || child instanceof LineSegments
    )).length;
    return {
      active: this.activeMarket !== null,
      market: this.activeMarket,
      buildings: this.layout.buildings.length,
      signs: this.layout.signs.length,
      vents: this.layout.vents.length,
      lanterns: this.layout.lanterns.length,
      steamParticles: this.activeMarket ? STEAM_COUNT : 0,
      activePointLights: this.pooledLights.filter((light) => light.visible).length,
      pooledDrawCalls: this.activeMarket ? visiblePools + this.signTexts.length : 0,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const text of this.texts) text.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.texts.length = 0;
    this.signTexts.length = 0;
    this.geometries.clear();
    this.materials.clear();
    this.pooledLights.length = 0;
    this.root.clear();
  }

  private buildArchitecture(): void {
    const box = this.trackGeometry(new BoxGeometry(1, 1, 1));
    const buildingPools = this.bodyMaterials.map((material, palette) => {
      const count = this.layout.buildings.filter((building) => building.palette === palette).length;
      const mesh = new InstancedMesh(box, material, Math.max(1, count));
      mesh.name = `dex-buildings-${palette + 1}`;
      mesh.count = count;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    });
    const wetPads = new InstancedMesh(box, this.wetMaterial, Math.max(1, this.layout.buildings.length));
    wetPads.name = 'dex-wet-sidewalks';
    wetPads.count = this.layout.buildings.length;
    wetPads.receiveShadow = true;
    const roofTrim = new InstancedMesh(box, this.trimMaterial, Math.max(1, this.layout.buildings.length));
    roofTrim.name = 'dex-roof-trim';
    roofTrim.count = this.layout.buildings.length;
    const windowsPerBuilding = 8;
    const windowPanels = new InstancedMesh(
      box,
      this.windowMaterial,
      Math.max(1, this.layout.buildings.length * windowsPerBuilding),
    );
    windowPanels.name = 'dex-emissive-windows';
    windowPanels.count = this.layout.buildings.length * windowsPerBuilding;
    const neonStrips = new InstancedMesh(
      box,
      this.lanternMaterial,
      Math.max(1, this.layout.buildings.length * 2),
    );
    neonStrips.name = 'dex-facade-neon-strips';
    neonStrips.count = this.layout.buildings.length * 2;
    const paletteCounts = new Array<number>(this.bodyMaterials.length).fill(0);
    this.layout.buildings.forEach((building, index) => {
      const palette = Math.min(this.bodyMaterials.length - 1, building.palette);
      const poolIndex = paletteCounts[palette] ?? 0;
      paletteCounts[palette] = poolIndex + 1;
      const position = new Vector3(building.x, building.y + building.height * 0.5, building.z);
      setInstance(
        buildingPools[palette]!,
        poolIndex,
        position,
        new Vector3(building.width, building.height, building.depth),
        building.yaw,
      );
      setInstance(
        wetPads,
        index,
        new Vector3(building.x, building.y + 0.035, building.z),
        new Vector3(building.width + 2.2, 0.07, building.depth + 2.2),
        building.yaw,
      );
      setInstance(
        roofTrim,
        index,
        new Vector3(building.x, building.y + building.height + 0.18, building.z),
        new Vector3(building.width + 0.28, 0.36, building.depth + 0.28),
        building.yaw,
      );
      const frontX = Math.sin(building.yaw) * (building.depth * 0.5 + 0.035);
      const frontZ = Math.cos(building.yaw) * (building.depth * 0.5 + 0.035);
      const lateralX = Math.cos(building.yaw);
      const lateralZ = -Math.sin(building.yaw);
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          const side = column === 0 ? -1 : 1;
          setInstance(
            windowPanels,
            index * windowsPerBuilding + row * 2 + column,
            new Vector3(
              building.x + frontX + lateralX * building.width * 0.23 * side,
              building.y + building.height * (0.22 + row * 0.19),
              building.z + frontZ + lateralZ * building.width * 0.23 * side,
            ),
            new Vector3(Math.max(0.85, building.width * 0.32), 0.55, 0.08),
            building.yaw,
          );
        }
      }
      for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        const side = sideIndex === 0 ? -1 : 1;
        setInstance(
          neonStrips,
          index * 2 + sideIndex,
          new Vector3(
            building.x + frontX + lateralX * building.width * 0.43 * side,
            building.y + building.height * 0.5,
            building.z + frontZ + lateralZ * building.width * 0.43 * side,
          ),
          new Vector3(0.11, building.height * 0.82, 0.1),
          building.yaw,
        );
      }
    });
    for (const pool of buildingPools) pool.instanceMatrix.needsUpdate = true;
    wetPads.instanceMatrix.needsUpdate = true;
    roofTrim.instanceMatrix.needsUpdate = true;
    windowPanels.instanceMatrix.needsUpdate = true;
    neonStrips.instanceMatrix.needsUpdate = true;
    this.root.add(...buildingPools, wetPads, roofTrim, windowPanels, neonStrips);

    const cablePositions: number[] = [];
    for (let index = 0; index + 1 < this.layout.buildings.length; index += 2) {
      const from = this.layout.buildings[index];
      const to = this.layout.buildings[index + 1];
      if (!from || !to || Math.hypot(from.x - to.x, from.z - to.z) > 34) continue;
      const fromY = from.y + from.height * 0.82;
      const toY = to.y + to.height * 0.82;
      cablePositions.push(
        from.x, fromY, from.z,
        (from.x + to.x) * 0.5, Math.min(fromY, toY) - 1.1, (from.z + to.z) * 0.5,
        (from.x + to.x) * 0.5, Math.min(fromY, toY) - 1.1, (from.z + to.z) * 0.5,
        to.x, toY, to.z,
      );
    }
    const cableGeometry = this.trackGeometry(new BufferGeometry());
    cableGeometry.setAttribute('position', new BufferAttribute(new Float32Array(cablePositions), 3));
    const cableMaterial = this.trackMaterial(new LineBasicMaterial({ color: 0x17202d }));
    const cables = new LineSegments(cableGeometry, cableMaterial);
    cables.name = 'dex-utility-cables';
    this.root.add(cables);
  }

  private buildSigns(fontUrl?: string): void {
    const boardGeometry = this.trackGeometry(new BoxGeometry(3.7, 1.05, 0.13));
    this.layout.signs.forEach((descriptor, index) => {
      const board = new Mesh(boardGeometry, this.signBoardMaterial);
      board.name = descriptor.id;
      board.position.set(descriptor.x, descriptor.y, descriptor.z);
      board.rotation.y = descriptor.yaw;
      this.root.add(board);

      const text = new Text();
      text.name = `${descriptor.id}-copy`;
      text.text = DEX_CYBERPUNK_THEMES.PUMP.signText[index] ?? 'NIGHT MARKET';
      text.fontSize = 0.36;
      text.fontWeight = 'bold';
      text.color = index % 2 === 0 ? 0x8ffcf0 : 0xffa3dc;
      text.anchorX = 'center';
      text.anchorY = 'middle';
      text.textAlign = 'center';
      text.maxWidth = 3.35;
      text.outlineWidth = '2%';
      text.outlineColor = 0x17172a;
      text.position.set(descriptor.x, descriptor.y, descriptor.z);
      text.rotation.y = descriptor.yaw;
      text.translateZ(0.075);
      if (fontUrl) text.font = fontUrl;
      if (typeof self !== 'undefined') text.sync();
      this.texts.push(text);
      this.signTexts.push(text);
      this.root.add(text);
    });
  }

  private buildUtilities(): void {
    const ventGeometry = this.trackGeometry(new CylinderGeometry(0.34, 0.42, 0.5, 8));
    const vents = new InstancedMesh(ventGeometry, this.trimMaterial, Math.max(1, this.layout.vents.length));
    vents.name = 'dex-rooftop-vents';
    vents.count = this.layout.vents.length;
    this.layout.vents.forEach((vent, index) => {
      setInstance(vents, index, new Vector3(vent.x, vent.y, vent.z), UNIT_SCALE);
    });
    vents.instanceMatrix.needsUpdate = true;

    const poleGeometry = this.trackGeometry(new CylinderGeometry(0.055, 0.085, 2.6, 7));
    const globeGeometry = this.trackGeometry(new BoxGeometry(0.32, 0.42, 0.2));
    const poles = new InstancedMesh(poleGeometry, this.trimMaterial, Math.max(1, this.layout.lanterns.length));
    const globes = new InstancedMesh(globeGeometry, this.lanternMaterial, Math.max(1, this.layout.lanterns.length));
    poles.name = 'dex-lantern-poles';
    globes.name = 'dex-lantern-globes';
    poles.count = this.layout.lanterns.length;
    globes.count = this.layout.lanterns.length;
    this.layout.lanterns.forEach((lantern, index) => {
      setInstance(poles, index, new Vector3(lantern.x, lantern.y + 1.3, lantern.z), UNIT_SCALE);
      setInstance(globes, index, new Vector3(lantern.x, lantern.y + 2.55, lantern.z), UNIT_SCALE);
    });
    poles.instanceMatrix.needsUpdate = true;
    globes.instanceMatrix.needsUpdate = true;
    this.root.add(vents, poles, globes);
  }

  private applyTheme(market: DexCyberpunkMarket): void {
    const theme = DEX_CYBERPUNK_THEMES[market];
    const copy = theme.signText;
    this.signTexts.forEach((text, index) => {
      text.text = copy[index] ?? `${market} NIGHT`;
      text.color = index % 3 === 0
        ? theme.palette.neonAccent
        : index % 2 === 0
          ? theme.palette.neonSecondary
          : theme.palette.neonPrimary;
      if (typeof self !== 'undefined') text.sync();
    });
    const facadeColors = [
      theme.palette.facade,
      theme.palette.facadeAlt,
      theme.palette.ground,
    ];
    this.bodyMaterials.forEach((material, index) => {
      material.color.setHex(facadeColors[index] ?? theme.palette.facade);
      material.emissive.setHex(theme.palette.skyTop);
    });
    this.trimMaterial.color.setHex(theme.palette.facadeAlt);
    this.trimMaterial.emissive.setHex(theme.palette.neonSecondary);
    this.windowMaterial.color.setHex(theme.palette.window);
    this.windowMaterial.emissive.setHex(theme.palette.neonSecondary);
    this.wetMaterial.color.setHex(theme.palette.street);
    this.wetMaterial.emissive.setHex(theme.palette.skyTop);
    this.signBoardMaterial.color.setHex(theme.palette.facade);
    this.signBoardMaterial.emissive.setHex(theme.palette.neonPrimary);
    this.lanternMaterial.color.setHex(theme.palette.window);
    this.lanternMaterial.emissive.setHex(theme.palette.neonPrimary);
    this.pooledLights.forEach((light, index) => {
      light.color.setHex(index % 2 === 0
        ? theme.palette.neonPrimary
        : theme.palette.neonSecondary);
    });
  }

  private containsFootprint(
    building: CyberpunkBuildingDescriptor,
    x: number,
    z: number,
    margin: number,
  ): boolean {
    const cosine = Math.cos(building.yaw);
    const sine = Math.sin(building.yaw);
    const dx = x - building.x;
    const dz = z - building.z;
    const localX = dx * cosine + dz * sine;
    const localZ = -dx * sine + dz * cosine;
    return Math.abs(localX) < building.width * 0.5 + margin
      && Math.abs(localZ) < building.depth * 0.5 + margin;
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
