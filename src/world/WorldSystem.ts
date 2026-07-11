import * as THREE from 'three';
import {
  ACTIVE_CHUNK_RADIUS,
  CHUNK_SEGMENTS,
  CHUNK_SIZE,
  GRAND_MONUMENTS,
  PALETTE,
  WORLD_SEED,
} from '../config';
import type { ChunkDescriptor, SurfaceKind } from '../types';
import {
  ECHO_GRAND_SUPPRESSION_RADIUS,
  generateChunkLayout,
  keyForChunk,
} from './layout';
import type {
  ChunkLayout,
  EchoPlacementDescriptor,
  GrandMonumentCoordinate,
  PropPlacement,
} from './layout';
import { hashCoordinates } from './random';
import { TerrainSampler } from './terrain';

export interface WorldPosition {
  x: number;
  z: number;
}

export interface WorldSystemOptions {
  seed?: string;
  chunkSize?: number;
  chunkSegments?: number;
  activeRadius?: number;
  loadBudgetPerUpdate?: number;
  unloadBudgetPerUpdate?: number;
  monuments?: readonly GrandMonumentCoordinate[];
  echoSuppressionRadius?: number;
  dayDurationSeconds?: number;
  reducedMotion?: boolean;
  onEchoPlacementsChanged?: (placements: readonly EchoPlacementDescriptor[]) => void;
}

export interface WorldDebugStats {
  loadedChunks: number;
  desiredChunks: number;
  queuedLoads: number;
  queuedUnloads: number;
  propInstances: number;
  activeEchoes: number;
  terrainDrawCalls: number;
  sharedPropDrawCalls: number;
  activeLampAuras: number;
  activeLampMotes: number;
  dropFlashIntensity: number;
}

export type DropFlashTier = 'large' | 'exceptional';

interface QueuedChunk {
  x: number;
  z: number;
  key: string;
}

interface ChunkRecord {
  terrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  layout: ChunkLayout;
}

type PoolName =
  | 'treeTrunks'
  | 'treeCrowns'
  | 'bushes'
  | 'rocks'
  | 'flowers'
  | 'lampPosts'
  | 'lampGlobes'
  | 'benches'
  | 'ponds';

interface InstancePool {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>;
  capacity: number;
}

const DAY_SECONDS = 10 * 60;
const LOAD_BUDGET = 3;
const UNLOAD_BUDGET = 4;
const LAMP_LIGHT_COUNT = 4;
const LAMP_AMBIENCE_RADIUS = 34;
const LAMP_MOTES_PER_LIGHT = 6;
const LAMP_MOTE_CAPACITY = LAMP_LIGHT_COUNT * LAMP_MOTES_PER_LIGHT;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

function colorForSurface(surface: SurfaceKind): THREE.Color {
  switch (surface) {
    case 'sand':
      return new THREE.Color(PALETTE.sand);
    case 'stone':
      return new THREE.Color(PALETTE.stone);
    case 'grass':
      return new THREE.Color(PALETTE.grass);
  }
}

/**
 * Streamed, deterministic world presentation. Terrain meshes are per chunk,
 * while every prop category shares one global instancing pool.
 */
export class WorldSystem {
  readonly terrain: TerrainSampler;
  readonly root = new THREE.Group();

  private readonly scene: THREE.Scene;
  private readonly seed: string;
  private readonly chunkSize: number;
  private readonly chunkSegments: number;
  private readonly activeRadius: number;
  private readonly maxChunks: number;
  private readonly loadBudget: number;
  private readonly unloadBudget: number;
  private readonly monuments: readonly GrandMonumentCoordinate[];
  private readonly echoSuppressionRadius: number;
  private readonly dayDurationSeconds: number;
  private readonly onEchoPlacementsChanged?: (
    placements: readonly EchoPlacementDescriptor[],
  ) => void;
  private readonly terrainRoot = new THREE.Group();
  private readonly propRoot = new THREE.Group();
  private readonly lightRoot = new THREE.Group();
  private readonly chunks = new Map<string, ChunkRecord>();
  private readonly desiredKeys = new Set<string>();
  private loadQueue: QueuedChunk[] = [];
  private unloadQueue: QueuedChunk[] = [];
  private readonly sharedGeometries = new Set<THREE.BufferGeometry>();
  private readonly sharedMaterials = new Set<THREE.Material>();
  private readonly pools: Record<PoolName, InstancePool>;
  private readonly terrainMaterial: THREE.MeshStandardMaterial;
  private readonly lampGlobeMaterial: THREE.MeshStandardMaterial;
  private readonly skyColor = new THREE.Color();
  private readonly fog: THREE.Fog;
  private readonly hemisphereLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly lampLights: THREE.PointLight[] = [];
  private readonly lampPositions: THREE.Vector3[] = [];
  private readonly lampAuraMesh: THREE.InstancedMesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly lampAuraMaterial: THREE.MeshBasicMaterial;
  private readonly lampMotePoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly lampMoteMaterial: THREE.PointsMaterial;
  private readonly lampMotePositions: Float32Array;
  private readonly previousBackground: THREE.Scene['background'];
  private readonly previousFog: THREE.Scene['fog'];
  private readonly daySky = new THREE.Color(PALETTE.skyDay);
  private readonly nightSky = new THREE.Color(PALETTE.skyNight);
  private readonly sunsetSky = new THREE.Color(0xd99178);
  private readonly daySun = new THREE.Color(0xfff0cb);
  private readonly duskSun = new THREE.Color(0xe49a70);
  private readonly dropSky = new THREE.Color(0xc85f68);
  private readonly dropFog = new THREE.Color(0xb96570);
  private readonly dropHemisphere = new THREE.Color(0xe28688);
  private readonly dropGround = new THREE.Color(0x70464d);
  private readonly dropSun = new THREE.Color(0xff8e86);
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempColor = new THREE.Color();
  private activeEchoes: EchoPlacementDescriptor[] = [];
  private centerChunkX = Number.NaN;
  private centerChunkZ = Number.NaN;
  private totalPropInstances = 0;
  private daylight = 1;
  private currentElapsedSeconds = 0;
  private dropFlashStartedAt = Number.NEGATIVE_INFINITY;
  private dropFlashDuration = 0;
  private dropFlashPeak = 0;
  private dropFlashStartIntensity = 0;
  private dropFlashIntensity = 0;
  private reducedMotion: boolean;
  private disposed = false;

  constructor(scene: THREE.Scene, options: WorldSystemOptions = {}) {
    this.scene = scene;
    this.seed = options.seed ?? WORLD_SEED;
    this.chunkSize = options.chunkSize ?? CHUNK_SIZE;
    this.chunkSegments = options.chunkSegments ?? CHUNK_SEGMENTS;
    this.activeRadius = options.activeRadius ?? ACTIVE_CHUNK_RADIUS;
    this.maxChunks = (this.activeRadius * 2 + 1) ** 2;
    this.loadBudget = Math.max(1, Math.floor(options.loadBudgetPerUpdate ?? LOAD_BUDGET));
    this.unloadBudget = Math.max(1, Math.floor(options.unloadBudgetPerUpdate ?? UNLOAD_BUDGET));
    this.monuments = options.monuments ? [...options.monuments] : [...GRAND_MONUMENTS];
    this.echoSuppressionRadius = options.echoSuppressionRadius
      ?? ECHO_GRAND_SUPPRESSION_RADIUS;
    this.dayDurationSeconds = Math.max(60, options.dayDurationSeconds ?? DAY_SECONDS);
    this.reducedMotion = options.reducedMotion ?? false;
    this.onEchoPlacementsChanged = options.onEchoPlacementsChanged;
    this.terrain = new TerrainSampler({
      seed: this.seed,
      chunkSize: this.chunkSize,
      monuments: this.monuments,
    });

    this.root.name = 'TickerworldWorld';
    this.terrainRoot.name = 'TerrainChunks';
    this.propRoot.name = 'SharedWorldProps';
    this.lightRoot.name = 'WorldLighting';
    this.root.add(this.terrainRoot, this.propRoot, this.lightRoot);

    this.terrainMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.92,
      metalness: 0,
    }));
    this.lampGlobeMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: PALETTE.cream,
      emissive: PALETTE.cream,
      emissiveIntensity: 0.25,
      roughness: 0.55,
    }));

    this.pools = this.createPools();
    const lampAuraGeometry = this.trackGeometry(new THREE.CircleGeometry(1, 24));
    lampAuraGeometry.rotateX(-Math.PI * 0.5);
    const auraColors = new Float32Array(lampAuraGeometry.getAttribute('position').count * 3);
    const auraPosition = lampAuraGeometry.getAttribute('position');
    for (let index = 0; index < auraPosition.count; index += 1) {
      const radius = Math.hypot(auraPosition.getX(index), auraPosition.getZ(index));
      const warmth = Math.max(0, 1 - radius);
      const offset = index * 3;
      auraColors[offset] = warmth;
      auraColors[offset + 1] = warmth * 0.79;
      auraColors[offset + 2] = warmth * 0.47;
    }
    lampAuraGeometry.setAttribute('color', new THREE.BufferAttribute(auraColors, 3));
    this.lampAuraMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }));
    this.lampAuraMesh = new THREE.InstancedMesh(
      lampAuraGeometry,
      this.lampAuraMaterial,
      LAMP_LIGHT_COUNT,
    );
    this.lampAuraMesh.name = 'LampGroundAuras';
    this.lampAuraMesh.count = 0;
    this.lampAuraMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lampAuraMesh.frustumCulled = false;
    this.lampAuraMesh.renderOrder = 1;
    this.propRoot.add(this.lampAuraMesh);

    const lampMoteGeometry = this.trackGeometry(new THREE.BufferGeometry());
    this.lampMotePositions = new Float32Array(LAMP_MOTE_CAPACITY * 3);
    const lampMotePositionAttribute = new THREE.BufferAttribute(this.lampMotePositions, 3);
    lampMotePositionAttribute.setUsage(THREE.DynamicDrawUsage);
    lampMoteGeometry.setAttribute('position', lampMotePositionAttribute);
    lampMoteGeometry.setDrawRange(0, 0);
    this.lampMoteMaterial = this.trackMaterial(new THREE.PointsMaterial({
      color: 0xffedb8,
      size: 0.16,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }));
    this.lampMotePoints = new THREE.Points(lampMoteGeometry, this.lampMoteMaterial);
    this.lampMotePoints.name = 'LampFireflyMotes';
    this.lampMotePoints.frustumCulled = false;
    this.lampMotePoints.visible = false;
    this.lampMotePoints.renderOrder = 2;
    this.propRoot.add(this.lampMotePoints);
    this.previousBackground = scene.background;
    this.previousFog = scene.fog;
    this.skyColor.copy(this.daySky);
    this.fog = new THREE.Fog(this.skyColor, this.chunkSize * 1.55, this.chunkSize * 4.8);
    scene.background = this.skyColor;
    scene.fog = this.fog;

    this.hemisphereLight = new THREE.HemisphereLight(PALETTE.skyDay, 0x59634f, 1.05);
    this.hemisphereLight.name = 'WorldHemisphereLight';
    this.sunLight = new THREE.DirectionalLight(this.daySun, 1.55);
    this.sunLight.name = 'WorldSun';
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    const shadowReach = this.chunkSize * (this.activeRadius + 0.4);
    this.sunLight.shadow.camera.left = -shadowReach;
    this.sunLight.shadow.camera.right = shadowReach;
    this.sunLight.shadow.camera.top = shadowReach;
    this.sunLight.shadow.camera.bottom = -shadowReach;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 260;
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.target.name = 'WorldSunTarget';
    this.lightRoot.add(this.hemisphereLight, this.sunLight, this.sunLight.target);

    for (let index = 0; index < LAMP_LIGHT_COUNT; index += 1) {
      const light = new THREE.PointLight(PALETTE.cream, 0, 19, 2);
      light.name = `PooledLampLight${index + 1}`;
      light.visible = false;
      this.lampLights.push(light);
      this.lightRoot.add(light);
    }

    scene.add(this.root);
  }

  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  surfaceAt(x: number, z: number): SurfaceKind {
    return this.terrain.surfaceAt(x, z);
  }

  getActiveEchoPlacements(): readonly EchoPlacementDescriptor[] {
    return this.activeEchoes;
  }

  get nightFactor(): number {
    return 1 - this.daylight;
  }

  getLoadedChunkDescriptors(): readonly ChunkDescriptor[] {
    return [...this.chunks.values()].map((record) => record.layout.descriptor);
  }

  getDebugStats(): WorldDebugStats {
    const propDrawCalls = Object.values(this.pools).reduce(
      (total, pool) => total + (pool.mesh.count > 0 ? 1 : 0),
      0,
    );
    return {
      loadedChunks: this.chunks.size,
      desiredChunks: this.desiredKeys.size,
      queuedLoads: this.loadQueue.length,
      queuedUnloads: this.unloadQueue.length,
      propInstances: this.totalPropInstances,
      activeEchoes: this.activeEchoes.length,
      terrainDrawCalls: this.chunks.size,
      sharedPropDrawCalls: propDrawCalls,
      activeLampAuras: this.lampAuraMesh.count,
      activeLampMotes: this.lampMotePoints.geometry.drawRange.count,
      dropFlashIntensity: this.dropFlashIntensity,
    };
  }

  /** Briefly composes a nearby major-drop warning over the current time of day. */
  triggerDropFlash(tier: DropFlashTier): void {
    if (this.disposed) return;
    const requestedPeak = tier === 'exceptional' ? 0.7 : 0.45;
    const requestedDuration = tier === 'exceptional' ? 1.2 : 0.9;
    const active = this.currentElapsedSeconds - this.dropFlashStartedAt < this.dropFlashDuration;
    if (active && this.reducedMotion) return;
    const peak = active ? Math.max(this.dropFlashPeak, requestedPeak) : requestedPeak;
    const duration = active ? Math.max(this.dropFlashDuration, requestedDuration) : requestedDuration;
    this.dropFlashStartIntensity = active ? this.dropFlashIntensity : 0;
    this.dropFlashPeak = this.reducedMotion ? Math.min(0.22, peak) : peak;
    this.dropFlashDuration = duration;
    this.dropFlashStartedAt = this.currentElapsedSeconds;
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (reducedMotion) this.dropFlashPeak = Math.min(this.dropFlashPeak, 0.22);
  }

  update(playerPosition: WorldPosition, elapsedSeconds: number): void {
    if (this.disposed) {
      return;
    }

    this.currentElapsedSeconds = elapsedSeconds;
    const chunkX = Math.floor((playerPosition.x + this.chunkSize * 0.5) / this.chunkSize);
    const chunkZ = Math.floor((playerPosition.z + this.chunkSize * 0.5) / this.chunkSize);
    if (chunkX !== this.centerChunkX || chunkZ !== this.centerChunkZ) {
      this.centerChunkX = chunkX;
      this.centerChunkZ = chunkZ;
      this.scheduleChunks(chunkX, chunkZ);
    }

    const changed = this.processChunkQueues();
    if (changed) {
      this.rebuildSharedInstances();
    }
    this.updateDayNight(playerPosition, elapsedSeconds);
    this.updateLampLights(playerPosition, elapsedSeconds);
  }

  private createPools(): Record<PoolName, InstancePool> {
    const chunkCapacity = this.maxChunks;
    const trunkGeometry = this.trackGeometry(new THREE.CylinderGeometry(0.5, 0.62, 1, 6));
    const crownGeometry = this.trackGeometry(new THREE.DodecahedronGeometry(1, 0));
    const bushGeometry = this.trackGeometry(new THREE.DodecahedronGeometry(1, 0));
    const rockGeometry = this.trackGeometry(new THREE.DodecahedronGeometry(1, 0));
    const flowerGeometry = this.trackGeometry(new THREE.OctahedronGeometry(1, 0));
    const lampPostGeometry = this.trackGeometry(new THREE.CylinderGeometry(0.5, 0.58, 1, 8));
    const lampGlobeGeometry = this.trackGeometry(new THREE.SphereGeometry(0.5, 8, 6));
    const benchGeometry = this.trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    const pondGeometry = this.trackGeometry(new THREE.CircleGeometry(1, 24));
    pondGeometry.rotateX(-Math.PI * 0.5);

    const bark = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x765a45,
      flatShading: true,
      roughness: 0.95,
    }));
    const leaves = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: PALETTE.grassAlt,
      flatShading: true,
      roughness: 0.9,
    }));
    const bush = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x77a77a,
      flatShading: true,
      roughness: 0.95,
    }));
    const rock = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: PALETTE.stone,
      flatShading: true,
      roughness: 1,
    }));
    const flower = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: PALETTE.pink,
      flatShading: true,
      roughness: 0.8,
    }));
    const lampPost = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: PALETTE.stoneDark,
      flatShading: true,
      roughness: 0.85,
    }));
    const bench = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9b704e,
      flatShading: true,
      roughness: 0.92,
    }));
    const water = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x75b8bd,
      emissive: 0x274b57,
      emissiveIntensity: 0.16,
      transparent: true,
      opacity: 0.82,
      roughness: 0.28,
      metalness: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));

    return {
      treeTrunks: this.createPool('TreeTrunks', trunkGeometry, bark, chunkCapacity * 9),
      treeCrowns: this.createPool('TreeCrowns', crownGeometry, leaves, chunkCapacity * 9),
      bushes: this.createPool('Bushes', bushGeometry, bush, chunkCapacity * 8),
      rocks: this.createPool('Rocks', rockGeometry, rock, chunkCapacity * 6),
      flowers: this.createPool('Flowers', flowerGeometry, flower, chunkCapacity * 15),
      lampPosts: this.createPool('LampPosts', lampPostGeometry, lampPost, chunkCapacity * 2),
      lampGlobes: this.createPool('LampGlobes', lampGlobeGeometry, this.lampGlobeMaterial, chunkCapacity * 2),
      benches: this.createPool('Benches', benchGeometry, bench, chunkCapacity),
      ponds: this.createPool('Ponds', pondGeometry, water, chunkCapacity),
    };
  }

  private createPool(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
  ): InstancePool {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = name !== 'Flowers' && name !== 'Ponds' && name !== 'LampGlobes';
    mesh.receiveShadow = name !== 'LampGlobes';
    mesh.frustumCulled = false;
    this.propRoot.add(mesh);
    return { mesh, capacity };
  }

  private trackGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.sharedGeometries.add(geometry);
    return geometry;
  }

  private trackMaterial<T extends THREE.Material>(material: T): T {
    this.sharedMaterials.add(material);
    return material;
  }

  private scheduleChunks(centerX: number, centerZ: number): void {
    this.desiredKeys.clear();
    const requested: QueuedChunk[] = [];
    for (let z = centerZ - this.activeRadius; z <= centerZ + this.activeRadius; z += 1) {
      for (let x = centerX - this.activeRadius; x <= centerX + this.activeRadius; x += 1) {
        const key = keyForChunk(x, z);
        this.desiredKeys.add(key);
        if (!this.chunks.has(key)) {
          requested.push({ x, z, key });
        }
      }
    }
    requested.sort((a, b) => {
      const distanceA = Math.abs(a.x - centerX) + Math.abs(a.z - centerZ);
      const distanceB = Math.abs(b.x - centerX) + Math.abs(b.z - centerZ);
      return distanceA - distanceB || a.z - b.z || a.x - b.x;
    });
    this.loadQueue = requested;
    this.unloadQueue = [...this.chunks.keys()]
      .filter((key) => !this.desiredKeys.has(key))
      .map((key) => {
        const [xText, zText] = key.split(':');
        return {
          x: Number(xText),
          z: Number(zText),
          key,
        };
      });
  }

  private processChunkQueues(): boolean {
    let changed = false;
    let unloaded = 0;
    while (unloaded < this.unloadBudget && this.unloadQueue.length > 0) {
      const queued = this.unloadQueue.shift();
      if (!queued || this.desiredKeys.has(queued.key)) {
        continue;
      }
      changed = this.removeChunk(queued.key) || changed;
      unloaded += 1;
    }

    let loaded = 0;
    while (
      loaded < this.loadBudget
      && this.loadQueue.length > 0
      && this.chunks.size < this.maxChunks
    ) {
      const queued = this.loadQueue.shift();
      if (!queued || !this.desiredKeys.has(queued.key) || this.chunks.has(queued.key)) {
        continue;
      }
      this.createChunk(queued);
      loaded += 1;
      changed = true;
    }
    return changed;
  }

  private createChunk(queued: QueuedChunk): void {
    const layout = generateChunkLayout({
      seed: this.seed,
      chunkX: queued.x,
      chunkZ: queued.z,
      chunkSize: this.chunkSize,
      terrain: this.terrain,
      monuments: this.monuments,
      echoSuppressionRadius: this.echoSuppressionRadius,
    });
    const geometry = this.createTerrainGeometry(queued.x, queued.z);
    const mesh = new THREE.Mesh(geometry, this.terrainMaterial);
    mesh.name = `TerrainChunk(${queued.x},${queued.z})`;
    mesh.position.set(queued.x * this.chunkSize, 0, queued.z * this.chunkSize);
    mesh.receiveShadow = true;
    this.terrainRoot.add(mesh);
    this.chunks.set(queued.key, { terrain: mesh, layout });
  }

  private createTerrainGeometry(chunkX: number, chunkZ: number): THREE.BufferGeometry {
    const verticesPerSide = this.chunkSegments + 1;
    const vertexCount = verticesPerSide * verticesPerSide;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const indices: number[] = [];
    const step = this.chunkSize / this.chunkSegments;
    const half = this.chunkSize * 0.5;
    let pointer = 0;

    for (let zIndex = 0; zIndex <= this.chunkSegments; zIndex += 1) {
      for (let xIndex = 0; xIndex <= this.chunkSegments; xIndex += 1) {
        const localX = -half + xIndex * step;
        const localZ = -half + zIndex * step;
        const worldX = chunkX * this.chunkSize + localX;
        const worldZ = chunkZ * this.chunkSize + localZ;
        positions[pointer] = localX;
        positions[pointer + 1] = this.terrain.heightAt(worldX, worldZ);
        positions[pointer + 2] = localZ;

        const color = colorForSurface(this.terrain.surfaceAt(worldX, worldZ));
        const variation = hashCoordinates(
          this.terrain.seed,
          chunkX * this.chunkSegments + xIndex,
          chunkZ * this.chunkSegments + zIndex,
          8_191,
        );
        color.offsetHSL((variation - 0.5) * 0.018, 0, (variation - 0.5) * 0.045);
        colors[pointer] = color.r;
        colors[pointer + 1] = color.g;
        colors[pointer + 2] = color.b;
        pointer += 3;
      }
    }

    for (let zIndex = 0; zIndex < this.chunkSegments; zIndex += 1) {
      for (let xIndex = 0; xIndex < this.chunkSegments; xIndex += 1) {
        const topLeft = zIndex * verticesPerSide + xIndex;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + verticesPerSide;
        const bottomRight = bottomLeft + 1;
        indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private removeChunk(key: string): boolean {
    const record = this.chunks.get(key);
    if (!record) {
      return false;
    }
    this.terrainRoot.remove(record.terrain);
    record.terrain.geometry.dispose();
    this.chunks.delete(key);
    return true;
  }

  private rebuildSharedInstances(): void {
    const counts: Record<PoolName, number> = {
      treeTrunks: 0,
      treeCrowns: 0,
      bushes: 0,
      rocks: 0,
      flowers: 0,
      lampPosts: 0,
      lampGlobes: 0,
      benches: 0,
      ponds: 0,
    };
    this.lampPositions.length = 0;
    const echoes: EchoPlacementDescriptor[] = [];

    const write = (
      poolName: PoolName,
      x: number,
      y: number,
      z: number,
      scaleX: number,
      scaleY: number,
      scaleZ: number,
      rotationY: number,
      color?: THREE.Color,
    ): void => {
      const pool = this.pools[poolName];
      const index = counts[poolName];
      if (index >= pool.capacity) {
        return;
      }
      this.tempPosition.set(x, y, z);
      this.tempQuaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotationY);
      this.tempScale.set(scaleX, scaleY, scaleZ);
      this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
      pool.mesh.setMatrixAt(index, this.tempMatrix);
      if (color) {
        pool.mesh.setColorAt(index, color);
      }
      counts[poolName] = index + 1;
    };

    for (const record of this.chunks.values()) {
      if (record.layout.echo) {
        echoes.push(record.layout.echo);
      }
      for (const pond of record.layout.ponds) {
        write('ponds', pond.x, pond.waterLevel + 0.02, pond.z, pond.radius, pond.radius, pond.radius, 0);
      }
      for (const prop of record.layout.props) {
        this.writePropInstances(prop, write);
      }
    }

    this.totalPropInstances = 0;
    for (const [poolName, pool] of Object.entries(this.pools) as Array<[PoolName, InstancePool]>) {
      pool.mesh.count = counts[poolName];
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.mesh.instanceColor) {
        pool.mesh.instanceColor.needsUpdate = true;
      }
      this.totalPropInstances += counts[poolName];
    }
    this.updateActiveEchoes(echoes);
  }

  private writePropInstances(
    prop: PropPlacement,
    write: (
      poolName: PoolName,
      x: number,
      y: number,
      z: number,
      scaleX: number,
      scaleY: number,
      scaleZ: number,
      rotationY: number,
      color?: THREE.Color,
    ) => void,
  ): void {
    switch (prop.kind) {
      case 'tree': {
        const trunkHeight = 2.25 * prop.scaleY;
        write(
          'treeTrunks',
          prop.x,
          prop.y + trunkHeight * 0.5,
          prop.z,
          0.42 * prop.scaleX,
          trunkHeight,
          0.42 * prop.scaleZ,
          prop.rotationY,
        );
        this.tempColor.set(PALETTE.grassAlt).offsetHSL(
          (prop.colorVariant - 0.5) * 0.035,
          0,
          (prop.colorVariant - 0.5) * 0.09,
        );
        write(
          'treeCrowns',
          prop.x,
          prop.y + trunkHeight + 1.05 * prop.scaleY,
          prop.z,
          1.15 * prop.scaleX,
          1.32 * prop.scaleY,
          1.15 * prop.scaleZ,
          prop.rotationY,
          this.tempColor,
        );
        break;
      }
      case 'bush':
        this.tempColor.set(0x77a77a).offsetHSL(
          (prop.colorVariant - 0.5) * 0.025,
          0,
          (prop.colorVariant - 0.5) * 0.08,
        );
        write(
          'bushes',
          prop.x,
          prop.y + 0.58 * prop.scaleY,
          prop.z,
          0.9 * prop.scaleX,
          0.68 * prop.scaleY,
          0.9 * prop.scaleZ,
          prop.rotationY,
          this.tempColor,
        );
        break;
      case 'rock':
        this.tempColor.set(PALETTE.stone).offsetHSL(
          0,
          0,
          (prop.colorVariant - 0.5) * 0.12,
        );
        write(
          'rocks',
          prop.x,
          prop.y + 0.38 * prop.scaleY,
          prop.z,
          0.68 * prop.scaleX,
          0.44 * prop.scaleY,
          0.62 * prop.scaleZ,
          prop.rotationY,
          this.tempColor,
        );
        break;
      case 'flower': {
        const flowerColors = [PALETTE.pink, PALETTE.cream, 0xe0bd67, 0xb99bc8] as const;
        const colorIndex = Math.min(
          flowerColors.length - 1,
          Math.floor(prop.colorVariant * flowerColors.length),
        );
        this.tempColor.set(flowerColors[colorIndex] ?? PALETTE.pink);
        write(
          'flowers',
          prop.x,
          prop.y + 0.18 * prop.scaleY,
          prop.z,
          0.18 * prop.scaleX,
          0.24 * prop.scaleY,
          0.18 * prop.scaleZ,
          prop.rotationY,
          this.tempColor,
        );
        break;
      }
      case 'lamp': {
        const postHeight = 3.15 * prop.scaleY;
        write(
          'lampPosts',
          prop.x,
          prop.y + postHeight * 0.5,
          prop.z,
          0.18 * prop.scaleX,
          postHeight,
          0.18 * prop.scaleZ,
          prop.rotationY,
        );
        const globeY = prop.y + postHeight + 0.18;
        write(
          'lampGlobes',
          prop.x,
          globeY,
          prop.z,
          0.62 * prop.scaleX,
          0.62 * prop.scaleY,
          0.62 * prop.scaleZ,
          prop.rotationY,
        );
        this.lampPositions.push(new THREE.Vector3(prop.x, globeY, prop.z));
        break;
      }
      case 'bench':
        write(
          'benches',
          prop.x,
          prop.y + 0.52 * prop.scaleY,
          prop.z,
          2.45 * prop.scaleX,
          0.38 * prop.scaleY,
          0.72 * prop.scaleZ,
          prop.rotationY,
        );
        break;
    }
  }

  private updateActiveEchoes(echoes: EchoPlacementDescriptor[]): void {
    echoes.sort((a, b) => a.key.localeCompare(b.key));
    const changed = echoes.length !== this.activeEchoes.length
      || echoes.some((echo, index) => echo.key !== this.activeEchoes[index]?.key);
    if (!changed) {
      return;
    }
    this.activeEchoes = echoes;
    this.onEchoPlacementsChanged?.(this.activeEchoes);
  }

  private updateDayNight(player: WorldPosition, elapsedSeconds: number): void {
    const normalizedTime = (
      (elapsedSeconds % this.dayDurationSeconds) + this.dayDurationSeconds
    ) % this.dayDurationSeconds / this.dayDurationSeconds;
    const phase = normalizedTime * Math.PI * 2;
    const solarAltitude = Math.cos(phase);
    this.daylight = smoothstep(-0.24, 0.3, solarAltitude);
    const twilight = (1 - Math.abs(solarAltitude))
      * smoothstep(-0.42, 0.08, solarAltitude);

    this.skyColor.copy(this.nightSky).lerp(this.daySky, this.daylight);
    this.skyColor.lerp(this.sunsetSky, twilight * 0.18);
    this.fog.color.copy(this.skyColor);
    this.hemisphereLight.color.copy(this.skyColor).lerp(this.daySky, 0.42);
    this.hemisphereLight.groundColor.set(0x485044).lerp(new THREE.Color(0x6b765d), this.daylight);
    this.hemisphereLight.intensity = 0.32 + this.daylight * 0.76;
    this.sunLight.color.copy(this.duskSun).lerp(this.daySun, this.daylight);
    this.sunLight.intensity = 0.12 + this.daylight * 1.43;

    const dropFlash = this.computeDropFlash(elapsedSeconds);
    if (dropFlash > 0) {
      this.skyColor.lerp(this.dropSky, dropFlash);
      this.fog.color.copy(this.skyColor).lerp(this.dropFog, dropFlash * 0.64);
      this.hemisphereLight.color.lerp(this.dropHemisphere, dropFlash * 0.8);
      this.hemisphereLight.groundColor.lerp(this.dropGround, dropFlash * 0.48);
      this.hemisphereLight.intensity += dropFlash * 0.12;
      this.sunLight.color.lerp(this.dropSun, dropFlash * 0.78);
      this.sunLight.intensity += dropFlash * 0.28;
    }

    this.sunLight.position.set(
      player.x + Math.sin(phase) * 72,
      24 + Math.max(0, solarAltitude) * 58,
      player.z + Math.cos(phase) * 58,
    );
    this.sunLight.target.position.set(player.x, this.heightAt(player.x, player.z), player.z);
    this.sunLight.target.updateMatrixWorld();
    this.lampGlobeMaterial.emissiveIntensity = 0.25 + (1 - this.daylight) * 2.15;
  }

  private computeDropFlash(elapsedSeconds: number): number {
    const age = elapsedSeconds - this.dropFlashStartedAt;
    if (!Number.isFinite(age) || age < 0 || age >= this.dropFlashDuration) {
      this.dropFlashIntensity = 0;
      return 0;
    }
    const attackSeconds = this.reducedMotion ? 0.12 : 0.055;
    const attack = smoothstep(0, attackSeconds, age);
    this.dropFlashIntensity = age < attackSeconds
      ? THREE.MathUtils.lerp(this.dropFlashStartIntensity, this.dropFlashPeak, attack)
      : this.dropFlashPeak * (1 - smoothstep(attackSeconds, this.dropFlashDuration, age));
    return this.dropFlashIntensity;
  }

  private updateLampLights(player: WorldPosition, elapsedSeconds: number): void {
    const nearest = this.lampPositions
      .map((position) => ({
        position,
        distanceSquared: (position.x - player.x) ** 2 + (position.z - player.z) ** 2,
      }))
      .filter(({ distanceSquared }) => distanceSquared <= LAMP_AMBIENCE_RADIUS ** 2)
      .sort((a, b) => a.distanceSquared - b.distanceSquared)
      .slice(0, this.lampLights.length);
    const nightStrength = 1 - this.daylight;
    const ambienceVisible = nightStrength >= 0.05;
    let auraCount = 0;
    let moteCount = 0;

    for (let index = 0; index < this.lampLights.length; index += 1) {
      const light = this.lampLights[index];
      const nearby = nearest[index];
      if (!light) {
        continue;
      }
      if (!nearby || !ambienceVisible) {
        light.visible = false;
        light.intensity = 0;
        continue;
      }
      light.visible = true;
      light.position.copy(nearby.position);
      const shimmer = 1 + Math.sin(elapsedSeconds * 1.25 + index * 2.17) * 0.025;
      light.intensity = nightStrength * 3.25 * shimmer;

      this.tempPosition.set(
        nearby.position.x,
        this.heightAt(nearby.position.x, nearby.position.z) + 0.045,
        nearby.position.z,
      );
      this.tempQuaternion.identity();
      const auraScale = 4.6 + nightStrength * 0.85;
      this.tempScale.set(auraScale, auraScale, auraScale);
      this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
      this.lampAuraMesh.setMatrixAt(auraCount, this.tempMatrix);
      auraCount += 1;

      for (let moteIndex = 0; moteIndex < LAMP_MOTES_PER_LIGHT; moteIndex += 1) {
        const phase = elapsedSeconds * (0.32 + moteIndex * 0.027)
          + index * 2.61
          + moteIndex * 1.047;
        const radius = 0.65 + (moteIndex % 3) * 0.42;
        const offset = moteCount * 3;
        this.lampMotePositions[offset] = nearby.position.x + Math.cos(phase) * radius;
        this.lampMotePositions[offset + 1] = nearby.position.y
          - 0.58
          + Math.sin(phase * 1.7 + moteIndex) * 0.72;
        this.lampMotePositions[offset + 2] = nearby.position.z + Math.sin(phase) * radius;
        moteCount += 1;
      }
    }

    this.lampAuraMesh.count = auraCount;
    this.lampAuraMesh.instanceMatrix.needsUpdate = true;
    this.lampAuraMesh.visible = auraCount > 0;
    this.lampAuraMaterial.opacity = nightStrength * 0.2;
    this.lampMotePoints.geometry.setDrawRange(0, moteCount);
    this.lampMotePoints.geometry.getAttribute('position').needsUpdate = true;
    this.lampMotePoints.visible = moteCount > 0;
    this.lampMoteMaterial.opacity = nightStrength * 0.5;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const record of this.chunks.values()) {
      record.terrain.geometry.dispose();
    }
    this.chunks.clear();
    this.loadQueue = [];
    this.unloadQueue = [];
    this.desiredKeys.clear();
    this.activeEchoes = [];
    this.onEchoPlacementsChanged?.([]);
    this.scene.remove(this.root);
    this.lampAuraMesh.dispose();

    for (const geometry of this.sharedGeometries) {
      geometry.dispose();
    }
    for (const material of this.sharedMaterials) {
      material.dispose();
    }
    this.sharedGeometries.clear();
    this.sharedMaterials.clear();
    this.terrain.clearCache();

    if (this.scene.background === this.skyColor) {
      this.scene.background = this.previousBackground;
    }
    if (this.scene.fog === this.fog) {
      this.scene.fog = this.previousFog;
    }
    this.root.clear();
  }
}
