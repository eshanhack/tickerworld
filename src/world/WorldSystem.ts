import * as THREE from 'three';
import { WORLD_DAY_DURATION_SECONDS } from '../../shared/src/index.js';
import {
  ACTIVE_CHUNK_RADIUS,
  CHUNK_SEGMENTS,
  CHUNK_SIZE,
  GRAND_MONUMENTS,
  PALETTE,
  WORLD_SEED,
} from '../config';
import type { AssetSymbol, ChunkDescriptor, SurfaceKind } from '../types';
import { MARKET_TRADE_CONFIG, type TradeSurgeConfig } from '../trades/config';
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
import { hashCoordinates, hashSeed } from './random';
import { TerrainSampler } from './terrain';
import { rainStateAt } from './weather';
import { AmbientWorldDetails } from './AmbientWorldDetails';
import {
  getDexCyberpunkTheme,
  type DexCyberpunkTheme,
} from './dexCyberpunkTheme';
import {
  OIL_DESERT_PALETTE,
  worldEnvironmentTheme,
  type WorldEnvironmentTheme,
} from './oilDesertTheme';
import {
  SIGNATURE_WORLD_THEMES,
  isSignatureMarketSymbol,
  type SignatureWorldThemeDefinition,
} from './signatureWorldThemes';

export interface WorldPosition {
  x: number;
  z: number;
}

export type VegetationKind = 'grass' | 'shrub';

export interface VegetationContact {
  readonly kind: VegetationKind;
  /** 0 at the foliage edge and 1 at its centre. */
  readonly intensity: number;
}

export interface VegetationInteractionEvent extends VegetationContact {
  readonly x: number;
  readonly z: number;
  /** Horizontal character speed in world units per second. */
  readonly speed: number;
}

export interface WorldSystemOptions {
  activeMarket?: AssetSymbol;
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
  onThunder?: (intensity: number) => void;
  onVegetationInteraction?: (event: VegetationInteractionEvent) => void;
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
  activeLampLights: number;
  activeLampMotes: number;
  dropFlashIntensity: number;
  riseFlashIntensity: number;
  tradeSurgeIntensity: number;
  tradeSurgeDirection: 'up' | 'down';
  rainIntensity: number;
  activeRainDrops: number;
  grassInstances: number;
  shrubInstances: number;
  bendingVegetation: number;
  cloudPuffs: number;
  cloudDrawCalls: number;
  ambientFireflies: number;
  ambientPetals: number;
  ambientBirds: number;
  ambientDetailDrawCalls: number;
}

export type DropFlashTier = 'large' | 'exceptional';
export type RiseFlashTier = DropFlashTier;
export type TradeSurgeDirection = 'buy' | 'sell' | 'up' | 'down';

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

interface VegetationInstance {
  readonly kind: VegetationKind;
  readonly poolName: 'flowers' | 'bushes';
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
  readonly rotationY: number;
  readonly radius: number;
  bend: number;
  bendX: number;
  bendZ: number;
}

interface CloudPuff {
  readonly baseX: number;
  readonly baseZ: number;
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
  readonly driftX: number;
  readonly driftZ: number;
  readonly bobAmplitude: number;
  readonly bobRate: number;
  readonly shapeAmplitude: number;
  readonly shapeRate: number;
  readonly rotationRate: number;
  readonly parallax: number;
  readonly layer: 0 | 1 | 2;
  readonly phase: number;
  readonly puffIndex: number;
}

/** A complete session-relative day, dusk, night, and dawn cycle. */
export const DEFAULT_DAY_DURATION_SECONDS = WORLD_DAY_DURATION_SECONDS;
const LOAD_BUDGET = 3;
const UNLOAD_BUDGET = 4;
const LAMP_LIGHT_COUNT = 4;
const LAMP_AMBIENCE_RADIUS = 34;
const LAMP_MOTES_PER_LIGHT = 6;
const LAMP_MOTE_CAPACITY = LAMP_LIGHT_COUNT * LAMP_MOTES_PER_LIGHT;
const RAIN_DROP_CAPACITY = 144;
const RAIN_RADIUS = 19;
const RAIN_COLUMN_HEIGHT = 17;
const VEGETATION_GRID_SIZE = 5;
const VEGETATION_SOUND_COOLDOWN_SECONDS = 0.3;
const CLOUD_GROUP_COUNT = 16;
const CLOUD_PUFFS_PER_GROUP = 4;
const CLOUD_PUFF_CAPACITY = CLOUD_GROUP_COUNT * CLOUD_PUFFS_PER_GROUP;
const CLOUD_FIELD_RADIUS = 108;
const CLOUD_CENTRE_WRAP_RADIUS = CLOUD_FIELD_RADIUS - 12;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

function colorForSurface(
  surface: SurfaceKind,
  cyberTheme: DexCyberpunkTheme | null,
  environmentTheme: WorldEnvironmentTheme,
  signatureTheme: SignatureWorldThemeDefinition | null,
): THREE.Color {
  if (cyberTheme) {
    switch (surface) {
      case 'sand': return new THREE.Color(cyberTheme.palette.street);
      case 'stone': return new THREE.Color(cyberTheme.palette.ground).offsetHSL(0, -0.04, 0.09);
      case 'grass': return new THREE.Color(cyberTheme.palette.ground);
    }
  }
  if (environmentTheme === 'desert') {
    switch (surface) {
      case 'sand': return new THREE.Color(OIL_DESERT_PALETTE.road);
      case 'stone': return new THREE.Color(OIL_DESERT_PALETTE.sandLight);
      case 'grass': return new THREE.Color(OIL_DESERT_PALETTE.sand);
    }
  }
  if (signatureTheme) {
    switch (surface) {
      case 'sand': return new THREE.Color(signatureTheme.secondary).lerp(new THREE.Color(PALETTE.sand), 0.34);
      case 'stone': return new THREE.Color(signatureTheme.primary).offsetHSL(0, -0.08, 0.12);
      case 'grass': return new THREE.Color(signatureTheme.ground).lerp(new THREE.Color(PALETTE.grass), 0.28);
    }
  }
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
  private activeMarket: AssetSymbol;
  private environmentTheme: WorldEnvironmentTheme;
  private cyberpunkTheme: DexCyberpunkTheme | null;
  private signatureTheme: SignatureWorldThemeDefinition | null;
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
  private readonly onThunder?: (intensity: number) => void;
  private readonly onVegetationInteraction?: (event: VegetationInteractionEvent) => void;
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
  private readonly lampMotePoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly lampMoteMaterial: THREE.PointsMaterial;
  private readonly lampMotePositions: Float32Array;
  private readonly rainLines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly rainMaterial: THREE.LineBasicMaterial;
  private readonly rainPositions: Float32Array;
  private readonly cloudMesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly cloudMaterial: THREE.MeshLambertMaterial;
  private readonly cloudPuffs: readonly CloudPuff[];
  private readonly ambientDetails: AmbientWorldDetails;
  private readonly cloudDay = new THREE.Color(0xfff2dc);
  private readonly cloudNight = new THREE.Color(0x91a2b6);
  private readonly cloudStorm = new THREE.Color(0x74869a);
  private readonly cyberSkyTarget = new THREE.Color();
  private readonly cyberHorizonTarget = new THREE.Color();
  private readonly cyberFogTarget = new THREE.Color();
  private readonly desertSkyTarget = new THREE.Color();
  private readonly desertFogTarget = new THREE.Color();
  private readonly desertGroundTarget = new THREE.Color();
  private readonly signatureSkyTarget = new THREE.Color();
  private readonly signatureFogTarget = new THREE.Color();
  private readonly signatureGroundTarget = new THREE.Color();
  private readonly signatureSunTarget = new THREE.Color();
  private readonly desertDaySky = new THREE.Color(OIL_DESERT_PALETTE.skyDay);
  private readonly desertNightSky = new THREE.Color(OIL_DESERT_PALETTE.skyNight);
  private readonly desertHorizon = new THREE.Color(OIL_DESERT_PALETTE.horizon);
  private readonly desertSun = new THREE.Color(OIL_DESERT_PALETTE.sandLight);
  private readonly weatherSeed: number;
  private readonly previousBackground: THREE.Scene['background'];
  private readonly previousFog: THREE.Scene['fog'];
  private readonly daySky = new THREE.Color(PALETTE.skyDay);
  // Keep midnight distinctly blue while retaining enough ambient fill for
  // characters, terrain edges, and the chart to remain comfortably legible.
  private readonly nightSky = new THREE.Color(PALETTE.skyNight).lerp(this.daySky, 0.16);
  private readonly sunsetSky = new THREE.Color(0xd99178);
  private readonly daySun = new THREE.Color(0xfff0cb);
  private readonly duskSun = new THREE.Color(0xe49a70);
  private readonly dropSky = new THREE.Color(0xc85f68);
  private readonly dropFog = new THREE.Color(0xb96570);
  private readonly dropHemisphere = new THREE.Color(0xe28688);
  private readonly dropGround = new THREE.Color(0x70464d);
  private readonly dropSun = new THREE.Color(0xff8e86);
  private readonly riseSky = new THREE.Color(0x78b995);
  private readonly riseFog = new THREE.Color(0x78aa8e);
  private readonly riseHemisphere = new THREE.Color(0xa8dfb0);
  private readonly riseGround = new THREE.Color(0x426451);
  private readonly riseSun = new THREE.Color(0xcdf1b5);
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly tempTiltQuaternion = new THREE.Quaternion();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempColor = new THREE.Color();
  private readonly tempBendDirection = new THREE.Vector3();
  private readonly vegetationGrid = new Map<string, VegetationInstance[]>();
  private readonly activeVegetation = new Set<VegetationInstance>();
  private readonly previousVegetationPlayer = new THREE.Vector2();
  private activeEchoes: EchoPlacementDescriptor[] = [];
  private centerChunkX = Number.NaN;
  private centerChunkZ = Number.NaN;
  private totalPropInstances = 0;
  private daylight = 1;
  private minutesSinceMidnightValue = 12 * 60;
  private rainingValue = false;
  private rainIntensity = 0;
  private currentElapsedSeconds = 0;
  private marketFlashDirection: 'up' | 'down' = 'down';
  private marketFlashStartedAt = Number.NEGATIVE_INFINITY;
  private marketFlashDuration = 0;
  private marketFlashPeak = 0;
  private marketFlashStartIntensity = 0;
  private marketFlashIntensity = 0;
  private tradeSurgeDirection: 'up' | 'down' = 'up';
  private tradeSurgeConfig: TradeSurgeConfig = MARKET_TRADE_CONFIG.BTC.surge;
  private tradeSurgeStartedAt = Number.NEGATIVE_INFINITY;
  private tradeSurgeHoldUntil = Number.NEGATIVE_INFINITY;
  private tradeSurgeEndsAt = Number.NEGATIVE_INFINITY;
  private lastTradeSurgeStartedAt = Number.NEGATIVE_INFINITY;
  private tradeSurgeIntensity = 0;
  private tradeSurgePeak = 0;
  private readonly baselineSky = new THREE.Color();
  private readonly baselineFog = new THREE.Color();
  private readonly baselineHemisphere = new THREE.Color();
  private readonly baselineGround = new THREE.Color();
  private readonly baselineSun = new THREE.Color();
  private baselineHemisphereIntensity = 0;
  private baselineSunIntensity = 0;
  private previousWeatherElapsed: number | null = null;
  private previousVegetationElapsed: number | null = null;
  private hasPreviousVegetationPlayer = false;
  private lastVegetationSoundAt = Number.NEGATIVE_INFINITY;
  private grassInstanceCount = 0;
  private shrubInstanceCount = 0;
  private readonly firedThunder = new Set<string>();
  private reducedMotion: boolean;
  private disposed = false;

  constructor(scene: THREE.Scene, options: WorldSystemOptions = {}) {
    this.scene = scene;
    this.activeMarket = options.activeMarket ?? 'BTC';
    this.environmentTheme = worldEnvironmentTheme(this.activeMarket);
    this.cyberpunkTheme = getDexCyberpunkTheme(this.activeMarket);
    this.signatureTheme = isSignatureMarketSymbol(this.activeMarket)
      ? SIGNATURE_WORLD_THEMES[this.activeMarket]
      : null;
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
    this.dayDurationSeconds = Math.max(
      60,
      options.dayDurationSeconds ?? DEFAULT_DAY_DURATION_SECONDS,
    );
    this.reducedMotion = options.reducedMotion ?? false;
    this.onThunder = options.onThunder;
    this.onVegetationInteraction = options.onVegetationInteraction;
    this.onEchoPlacementsChanged = options.onEchoPlacementsChanged;
    this.weatherSeed = hashSeed(this.seed);
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
      roughness: this.environmentTheme === 'cyberpunk' ? 0.62 : this.environmentTheme === 'desert' ? 0.98 : 0.92,
      metalness: this.environmentTheme === 'cyberpunk' ? 0.08 : 0,
    }));
    this.lampGlobeMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: PALETTE.cream,
      emissive: PALETTE.cream,
      emissiveIntensity: 0.25,
      roughness: 0.55,
    }));

    this.pools = this.createPools();

    const cloudGeometry = this.trackGeometry(new THREE.IcosahedronGeometry(1, 1));
    this.cloudMaterial = this.trackMaterial(new THREE.MeshLambertMaterial({
      color: this.cloudDay,
      emissive: this.cloudDay,
      emissiveIntensity: 0.28,
      // Opaque low-poly puffs stay in the early depth-writing pass, so the
      // later market overlays always remain perfectly legible.
      transparent: false,
      alphaHash: false,
      opacity: 1,
      depthWrite: true,
      fog: true,
    }));
    this.cloudMesh = new THREE.InstancedMesh(
      cloudGeometry,
      this.cloudMaterial,
      CLOUD_PUFF_CAPACITY,
    );
    this.cloudMesh.name = 'AtmosphereClouds';
    this.cloudMesh.count = CLOUD_PUFF_CAPACITY;
    this.cloudMesh.frustumCulled = false;
    this.cloudMesh.castShadow = false;
    this.cloudMesh.receiveShadow = false;
    this.cloudMesh.renderOrder = -1;
    this.cloudPuffs = this.createCloudPuffs();
    this.propRoot.add(this.cloudMesh);

    this.ambientDetails = new AmbientWorldDetails({
      seed: this.seed,
      heightAt: (x, z) => this.terrain.heightAt(x, z),
      surfaceAt: (x, z) => this.terrain.surfaceAt(x, z),
    });
    this.ambientDetails.root.visible = this.environmentTheme === 'park';
    this.propRoot.add(this.ambientDetails.root);

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

    const rainGeometry = this.trackGeometry(new THREE.BufferGeometry());
    this.rainPositions = new Float32Array(RAIN_DROP_CAPACITY * 2 * 3);
    const rainPositionAttribute = new THREE.BufferAttribute(this.rainPositions, 3);
    rainPositionAttribute.setUsage(THREE.DynamicDrawUsage);
    rainGeometry.setAttribute('position', rainPositionAttribute);
    rainGeometry.setDrawRange(0, 0);
    this.rainMaterial = this.trackMaterial(new THREE.LineBasicMaterial({
      color: 0xb9d7dc,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    }));
    this.rainLines = new THREE.LineSegments(rainGeometry, this.rainMaterial);
    this.rainLines.name = 'NightRain';
    this.rainLines.frustumCulled = false;
    this.rainLines.visible = false;
    this.rainLines.renderOrder = 3;
    this.propRoot.add(this.rainLines);
    this.previousBackground = scene.background;
    this.previousFog = scene.fog;
    this.skyColor.copy(this.daySky);
    this.fog = new THREE.Fog(
      this.skyColor,
      this.chunkSize * (this.environmentTheme === 'cyberpunk' ? 1.18 : this.environmentTheme === 'desert' ? 1.32 : 1.55),
      this.chunkSize * (this.environmentTheme === 'cyberpunk' ? 3.7 : this.environmentTheme === 'desert' ? 4.15 : 4.8),
    );
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
      const light = new THREE.PointLight(0xffd487, 0, 18, 2);
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
    if (this.cyberpunkTheme) return 'stone';
    if (this.environmentTheme === 'desert') return 'sand';
    return this.terrain.surfaceAt(x, z);
  }

  /** Switches only presentation; terrain heights, weather clock and chunk seed stay untouched. */
  setActiveMarket(symbol: AssetSymbol): void {
    if (this.disposed || symbol === this.activeMarket) return;
    this.activeMarket = symbol;
    this.environmentTheme = worldEnvironmentTheme(symbol);
    this.cyberpunkTheme = getDexCyberpunkTheme(symbol);
    this.signatureTheme = isSignatureMarketSymbol(symbol)
      ? SIGNATURE_WORLD_THEMES[symbol]
      : null;
    this.ambientDetails.root.visible = this.environmentTheme === 'park';
    this.terrainMaterial.roughness = this.environmentTheme === 'cyberpunk' ? 0.62 : this.environmentTheme === 'desert' ? 0.98 : 0.92;
    this.terrainMaterial.metalness = this.environmentTheme === 'cyberpunk' ? 0.08 : 0;
    this.fog.near = this.chunkSize * (this.environmentTheme === 'cyberpunk' ? 1.18 : this.environmentTheme === 'desert' ? 1.32 : 1.55);
    this.fog.far = this.chunkSize * (this.environmentTheme === 'cyberpunk' ? 3.7 : this.environmentTheme === 'desert' ? 4.15 : 4.8);
    for (const record of this.chunks.values()) {
      const chunkX = Math.round(record.terrain.position.x / this.chunkSize);
      const chunkZ = Math.round(record.terrain.position.z / this.chunkSize);
      const previous = record.terrain.geometry;
      record.terrain.geometry = this.createTerrainGeometry(chunkX, chunkZ);
      previous.dispose();
    }
    this.rebuildSharedInstances();
  }

  getActiveEchoPlacements(): readonly EchoPlacementDescriptor[] {
    return this.activeEchoes;
  }

  get nightFactor(): number {
    return 1 - this.daylight;
  }

  get minutesSinceMidnight(): number {
    return this.minutesSinceMidnightValue;
  }

  get raining(): boolean {
    return this.rainingValue;
  }

  /** Smoothed 0..1 rain level used by the weather audio mix. */
  get rainLevel(): number {
    return this.rainIntensity;
  }

  /** Returns nearby foliage without allocating or scanning the whole world. */
  sampleVegetation(x: number, z: number): VegetationContact | null {
    let strongest: VegetationContact | null = null;
    for (const instance of this.nearbyVegetation(x, z)) {
      const distance = Math.hypot(x - instance.x, z - instance.z);
      if (distance >= instance.radius) continue;
      const intensity = clamp01(1 - distance / instance.radius);
      if (!strongest || intensity > strongest.intensity) {
        strongest = { kind: instance.kind, intensity };
      }
    }
    return strongest;
  }

  getLoadedChunkDescriptors(): readonly ChunkDescriptor[] {
    return [...this.chunks.values()].map((record) => record.layout.descriptor);
  }

  getDebugStats(): WorldDebugStats {
    const ambient = this.environmentTheme !== 'park'
      ? { fireflies: 0, petals: 0, birds: 0, drawCalls: 0 }
      : this.ambientDetails.getDebugStats();
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
      activeLampLights: this.lampLights.reduce((count, light) => count + Number(light.visible), 0),
      activeLampMotes: this.lampMotePoints.geometry.drawRange.count,
      dropFlashIntensity: this.marketFlashDirection === 'down' ? this.marketFlashIntensity : 0,
      riseFlashIntensity: this.marketFlashDirection === 'up' ? this.marketFlashIntensity : 0,
      tradeSurgeIntensity: this.tradeSurgeIntensity,
      tradeSurgeDirection: this.tradeSurgeDirection,
      rainIntensity: this.rainIntensity,
      activeRainDrops: this.rainLines.geometry.drawRange.count / 2,
      grassInstances: this.grassInstanceCount,
      shrubInstances: this.shrubInstanceCount,
      bendingVegetation: this.activeVegetation.size,
      cloudPuffs: this.cloudMesh.count,
      cloudDrawCalls: Number(this.cloudMesh.visible && this.cloudMesh.count > 0),
      ambientFireflies: ambient.fireflies,
      ambientPetals: ambient.petals,
      ambientBirds: ambient.birds,
      ambientDetailDrawCalls: ambient.drawCalls,
    };
  }

  /** Briefly composes a nearby major-drop warning over the current time of day. */
  triggerDropFlash(tier: DropFlashTier): void {
    this.triggerMarketFlash('down', tier);
  }

  /** Briefly composes a nearby major-rise celebration over the current time of day. */
  triggerRiseFlash(tier: RiseFlashTier): void {
    this.triggerMarketFlash('up', tier);
  }

  /**
   * Starts one slow, bounded market mood. Repeats during the active/cooldown
   * window can only lengthen the current hold; they never restart the attack
   * or reverse its colour, preventing a volatile tape from producing flashes.
   */
  triggerTradeSurge(
    direction: TradeSurgeDirection,
    symbol: AssetSymbol = 'BTC',
  ): boolean {
    if (this.disposed) return false;
    const now = this.currentElapsedSeconds;
    const config = MARKET_TRADE_CONFIG[symbol].surge;
    const active = now < this.tradeSurgeEndsAt;
    const coolingDown = now - this.lastTradeSurgeStartedAt < config.cooldownSeconds;
    if (active || coolingDown) {
      if (active) {
        const maximumHoldUntil = this.tradeSurgeStartedAt
          + this.tradeSurgeConfig.attackSeconds
          + this.tradeSurgeConfig.maximumHoldSeconds;
        this.tradeSurgeHoldUntil = Math.min(
          maximumHoldUntil,
          this.tradeSurgeHoldUntil + this.tradeSurgeConfig.repeatHoldExtensionSeconds,
        );
        this.tradeSurgeEndsAt = this.tradeSurgeHoldUntil + this.tradeSurgeConfig.releaseSeconds;
      }
      return false;
    }

    this.tradeSurgeConfig = config;
    this.tradeSurgeDirection = direction === 'buy' || direction === 'up' ? 'up' : 'down';
    this.tradeSurgeStartedAt = now;
    this.lastTradeSurgeStartedAt = now;
    this.tradeSurgeHoldUntil = now + config.attackSeconds + config.holdSeconds;
    this.tradeSurgeEndsAt = this.tradeSurgeHoldUntil + config.releaseSeconds;
    this.tradeSurgePeak = config.tintStrength
      * (this.reducedMotion ? config.reducedMotionStrengthMultiplier : 1);
    return true;
  }

  /** Drops all tape-scoped mood state so it cannot bleed across market worlds. */
  clearTradeSurge(): void {
    this.tradeSurgeStartedAt = Number.NEGATIVE_INFINITY;
    this.tradeSurgeHoldUntil = Number.NEGATIVE_INFINITY;
    this.tradeSurgeEndsAt = Number.NEGATIVE_INFINITY;
    this.lastTradeSurgeStartedAt = Number.NEGATIVE_INFINITY;
    this.tradeSurgeIntensity = 0;
    this.tradeSurgePeak = 0;
    this.tradeSurgeDirection = 'up';
    this.tradeSurgeConfig = MARKET_TRADE_CONFIG.BTC.surge;
  }

  private triggerMarketFlash(direction: 'up' | 'down', tier: DropFlashTier): void {
    if (this.disposed) return;
    const requestedPeak = tier === 'exceptional' ? 0.7 : 0.45;
    const requestedDuration = tier === 'exceptional' ? 1.2 : 0.9;
    const active = this.currentElapsedSeconds - this.marketFlashStartedAt < this.marketFlashDuration;
    if (active && this.reducedMotion) return;
    const peak = active ? Math.max(this.marketFlashPeak, requestedPeak) : requestedPeak;
    const duration = active ? Math.max(this.marketFlashDuration, requestedDuration) : requestedDuration;
    this.marketFlashDirection = direction;
    this.marketFlashStartIntensity = active ? this.marketFlashIntensity : 0;
    this.marketFlashPeak = this.reducedMotion ? Math.min(0.22, peak) : peak;
    this.marketFlashDuration = duration;
    this.marketFlashStartedAt = this.currentElapsedSeconds;
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (reducedMotion) this.marketFlashPeak = Math.min(this.marketFlashPeak, 0.22);
    if (reducedMotion) {
      this.tradeSurgePeak = Math.min(
        this.tradeSurgePeak,
        this.tradeSurgeConfig.tintStrength
          * this.tradeSurgeConfig.reducedMotionStrengthMultiplier,
      );
    }
  }

  update(playerPosition: WorldPosition, elapsedSeconds: number): void {
    if (this.disposed) {
      return;
    }

    // A portal may join a newly-created room whose shared clock begins before
    // the old room's. Reset only timeline-bound event bookkeeping; terrain and
    // all persistent render pools remain untouched. Small packet jitter is
    // absorbed by RoomClientSystem before it reaches this guard.
    if (elapsedSeconds < this.currentElapsedSeconds - 1) {
      this.previousWeatherElapsed = null;
      this.previousVegetationElapsed = null;
      this.firedThunder.clear();
      this.marketFlashStartedAt = Number.NEGATIVE_INFINITY;
      this.marketFlashIntensity = 0;
      this.clearTradeSurge();
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
    this.updateWeather(playerPosition, elapsedSeconds);
    this.updateClouds(elapsedSeconds);
    if (this.environmentTheme === 'park') {
      this.ambientDetails.update({
        elapsedSeconds,
        daylight: this.daylight,
        rainIntensity: this.rainIntensity,
        reducedMotion: this.reducedMotion,
      });
    }
    this.updateVegetation(playerPosition, elapsedSeconds);
  }

  private createCloudPuffs(): readonly CloudPuff[] {
    const puffs: CloudPuff[] = [];
    const offsets = [
      { x: -0.78, z: 0.08, y: 0, scale: 0.82 },
      { x: -0.08, z: -0.12, y: 0.48, scale: 1 },
      { x: 0.7, z: 0.14, y: 0.08, scale: 0.78 },
      { x: 0.16, z: 0.5, y: -0.12, scale: 0.66 },
    ] as const;
    for (let group = 0; group < CLOUD_GROUP_COUNT; group += 1) {
      const layer = (group % 3) as 0 | 1 | 2;
      const angle = hashCoordinates(this.weatherSeed, group, 1, 41_011) * Math.PI * 2;
      const radiusMin = [14, 28, 44][layer] ?? 14;
      const radiusMax = [50, 72, 92][layer] ?? 50;
      const radius = radiusMin + Math.sqrt(
        hashCoordinates(this.weatherSeed, group, 2, 41_027),
      ) * (radiusMax - radiusMin);
      const centreX = Math.cos(angle) * radius;
      const centreZ = Math.sin(angle) * radius;
      const baseScale = ([5.1, 4.45, 3.75][layer] ?? 4)
        + hashCoordinates(this.weatherSeed, group, 3, 41_039) * 1.65;
      const y = ([18.5, 24.5, 31][layer] ?? 24)
        + hashCoordinates(this.weatherSeed, group, 4, 41_053) * 3;
      const phase = hashCoordinates(this.weatherSeed, group, 6, 41_087) * Math.PI * 2;
      // The lower groups cross the viewer's sightline a little faster, giving
      // the sky readable depth without adding draw calls.
      const parallax = ([1.38, 1.03, 0.72][layer] ?? 1)
        * (0.94 + hashCoordinates(this.weatherSeed, group, 13, 41_159) * 0.12);
      const speed = (1.55 + hashCoordinates(this.weatherSeed, group, 5, 41_071) * 0.85)
        * parallax;
      const windAngle = -0.11 + hashCoordinates(this.weatherSeed, group, 7, 41_093) * 0.22;
      const driftX = Math.cos(windAngle) * speed;
      const driftZ = Math.sin(windAngle) * speed;
      const bobAmplitude = 0.24 + hashCoordinates(this.weatherSeed, group, 8, 41_099) * 0.3;
      const bobRate = 0.17 + hashCoordinates(this.weatherSeed, group, 9, 41_117) * 0.11;
      const shapeAmplitude = 0.025 + hashCoordinates(this.weatherSeed, group, 10, 41_123) * 0.025;
      const shapeRate = 0.22 + hashCoordinates(this.weatherSeed, group, 11, 41_141) * 0.13;
      const rotationRate = 0.006 + hashCoordinates(this.weatherSeed, group, 12, 41_153) * 0.007;
      offsets.forEach((offset, puffIndex) => {
        const scale = baseScale * offset.scale;
        puffs.push({
          baseX: centreX,
          baseZ: centreZ,
          offsetX: offset.x * baseScale * 1.42,
          offsetZ: offset.z * baseScale,
          y: y + offset.y,
          scaleX: scale * 1.18,
          scaleY: scale * 0.42,
          scaleZ: scale * 0.72,
          driftX,
          driftZ,
          bobAmplitude,
          bobRate,
          shapeAmplitude,
          shapeRate,
          rotationRate,
          parallax,
          layer,
          phase,
          puffIndex,
        });
      });
    }
    return puffs;
  }

  private updateClouds(elapsedSeconds: number): void {
    const motionScale = this.reducedMotion ? 0.18 : 1;
    const shapeMotionScale = this.reducedMotion ? 0.32 : 1;
    const motionTime = elapsedSeconds * motionScale;
    for (let index = 0; index < this.cloudPuffs.length; index += 1) {
      const puff = this.cloudPuffs[index];
      if (!puff) continue;
      const centreX = positiveModulo(
        puff.baseX + motionTime * puff.driftX + CLOUD_CENTRE_WRAP_RADIUS,
        CLOUD_CENTRE_WRAP_RADIUS * 2,
      ) - CLOUD_CENTRE_WRAP_RADIUS;
      const centreZ = positiveModulo(
        puff.baseZ + motionTime * puff.driftZ + CLOUD_CENTRE_WRAP_RADIUS,
        CLOUD_CENTRE_WRAP_RADIUS * 2,
      ) - CLOUD_CENTRE_WRAP_RADIUS;
      const bob = Math.sin(puff.phase + motionTime * puff.bobRate)
        * puff.bobAmplitude
        * shapeMotionScale;
      const shape = Math.sin(
        puff.phase * 1.47 + puff.puffIndex * 1.08 + motionTime * puff.shapeRate,
      ) * puff.shapeAmplitude * shapeMotionScale;
      this.tempPosition.set(
        centreX + puff.offsetX,
        puff.y + bob,
        centreZ + puff.offsetZ,
      );
      this.tempQuaternion.setFromAxisAngle(
        WORLD_UP,
        puff.phase * 0.12 + motionTime * puff.rotationRate,
      );
      this.tempScale.set(
        puff.scaleX * (1 + shape),
        puff.scaleY * (1 - shape * 0.42),
        puff.scaleZ * (1 - shape * 0.22),
      );
      this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
      this.cloudMesh.setMatrixAt(index, this.tempMatrix);
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;
    this.cloudMaterial.color.copy(this.cloudNight).lerp(this.cloudDay, this.daylight);
    if (this.cyberpunkTheme) {
      this.cloudMaterial.color.lerp(
        this.cyberHorizonTarget.setHex(this.cyberpunkTheme.palette.skyHorizon),
        0.12,
      );
    } else if (this.environmentTheme === 'desert') {
      this.cloudMaterial.color.lerp(
        this.desertSkyTarget.setHex(OIL_DESERT_PALETTE.cloud),
        0.34,
      );
    } else if (this.signatureTheme) {
      this.cloudMaterial.color.lerp(
        this.signatureSkyTarget.setHex(this.signatureTheme.secondary),
        0.1,
      );
    }
    if (this.rainIntensity > 0) {
      this.cloudMaterial.color.lerp(this.cloudStorm, this.rainIntensity * 0.72);
    }
    if (this.marketFlashIntensity > 0) {
      this.cloudMaterial.color.lerp(
        this.marketFlashDirection === 'up' ? this.riseSky : this.dropSky,
        this.marketFlashIntensity * 0.34,
      );
    }
    // Clouds are viewed from below far more often than from above. A warm,
    // restrained self-light keeps their low-poly undersides pastel instead of
    // turning into black silhouettes when the sun is behind them.
    this.cloudMaterial.emissive.copy(this.cloudMaterial.color);
    this.cloudMaterial.emissiveIntensity = 0.16 + this.daylight * 0.18;
    this.cloudMaterial.opacity = 1;
    this.cloudMesh.visible = true;
  }

  private createPools(): Record<PoolName, InstancePool> {
    const chunkCapacity = this.maxChunks;
    const trunkGeometry = this.trackGeometry(new THREE.CylinderGeometry(0.5, 0.62, 1, 6));
    const crownGeometry = this.trackGeometry(new THREE.DodecahedronGeometry(1, 0));
    const bushGeometry = this.trackGeometry(new THREE.IcosahedronGeometry(1, 1));
    const rockGeometry = this.trackGeometry(new THREE.DodecahedronGeometry(1, 0));
    const flowerGeometry = this.trackGeometry(this.createGroundFoliageGeometry());
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
      side: THREE.DoubleSide,
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
      // Wildflowers and green grass share this one pool/material. Instance
      // colour preserves their distinct look while keeping the draw budget at
      // the existing nine prop calls.
      flowers: this.createPool('Flowers', flowerGeometry, flower, chunkCapacity * 160),
      lampPosts: this.createPool('LampPosts', lampPostGeometry, lampPost, chunkCapacity * 2),
      lampGlobes: this.createPool('LampGlobes', lampGlobeGeometry, this.lampGlobeMaterial, chunkCapacity * 2),
      benches: this.createPool('Benches', benchGeometry, bench, chunkCapacity),
      ponds: this.createPool('Ponds', pondGeometry, water, chunkCapacity),
    };
  }

  private createGroundFoliageGeometry(): THREE.BufferGeometry {
    const positions: number[] = [];
    const indices: number[] = [];
    const bladeCount = 5;
    for (let blade = 0; blade < bladeCount; blade += 1) {
      const angle = blade / bladeCount * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const width = blade % 2 === 0 ? 0.15 : 0.12;
      const height = 0.78 + (blade % 3) * 0.11;
      const lean = (blade % 2 === 0 ? 1 : -1) * 0.08;
      const base = positions.length / 3;
      const points = [
        [-width, 0],
        [width, 0],
        [width * 0.62 + lean, height * 0.55],
        [lean, height],
        [-width * 0.62 + lean, height * 0.55],
      ] as const;
      for (const [side, y] of points) {
        positions.push(side * cos, y, side * sin);
      }
      indices.push(
        base, base + 1, base + 2,
        base, base + 2, base + 4,
        base + 4, base + 2, base + 3,
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
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

        const color = colorForSurface(
          this.terrain.surfaceAt(worldX, worldZ),
          this.cyberpunkTheme,
          this.environmentTheme,
          this.signatureTheme,
        );
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
    this.vegetationGrid.clear();
    this.activeVegetation.clear();
    this.grassInstanceCount = 0;
    this.shrubInstanceCount = 0;
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
    ): number | null => {
      const pool = this.pools[poolName];
      const index = counts[poolName];
      if (index >= pool.capacity) {
        return null;
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
      return index;
    };

    for (const record of this.chunks.values()) {
      if (record.layout.echo) {
        echoes.push(record.layout.echo);
      }
      if (this.environmentTheme === 'park') {
        for (const pond of record.layout.ponds) {
          write('ponds', pond.x, pond.waterLevel + 0.02, pond.z, pond.radius, pond.radius, pond.radius, 0);
        }
        for (const prop of record.layout.props) {
          this.writePropInstances(prop, write);
        }
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
    ) => number | null,
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
      case 'bush': {
        this.tempColor.set(0x77a77a).offsetHSL(
          (prop.colorVariant - 0.5) * 0.025,
          0,
          (prop.colorVariant - 0.5) * 0.08,
        );
        const index = write(
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
        if (index !== null) {
          this.registerVegetation({
            kind: 'shrub',
            poolName: 'bushes',
            index,
            x: prop.x,
            y: prop.y + 0.58 * prop.scaleY,
            z: prop.z,
            scaleX: 0.9 * prop.scaleX,
            scaleY: 0.68 * prop.scaleY,
            scaleZ: 0.9 * prop.scaleZ,
            rotationY: prop.rotationY,
            radius: 1.05 * Math.max(prop.scaleX, prop.scaleZ),
            bend: 0,
            bendX: 0,
            bendZ: 0,
          });
          this.shrubInstanceCount += 1;
        }
        break;
      }
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
      case 'grass': {
        this.tempColor.set(PALETTE.grassAlt).offsetHSL(
          (prop.colorVariant - 0.5) * 0.045,
          0.04,
          (prop.colorVariant - 0.5) * 0.1,
        );
        const index = write(
          'flowers',
          prop.x,
          prop.y + 0.025,
          prop.z,
          0.72 * prop.scaleX,
          0.72 * prop.scaleY,
          0.72 * prop.scaleZ,
          prop.rotationY,
          this.tempColor,
        );
        if (index !== null) {
          this.registerVegetation({
            kind: 'grass',
            poolName: 'flowers',
            index,
            x: prop.x,
            y: prop.y + 0.025,
            z: prop.z,
            scaleX: 0.72 * prop.scaleX,
            scaleY: 0.72 * prop.scaleY,
            scaleZ: 0.72 * prop.scaleZ,
            rotationY: prop.rotationY,
            radius: 0.64 * Math.max(prop.scaleX, prop.scaleZ),
            bend: 0,
            bendX: 0,
            bendZ: 0,
          });
          this.grassInstanceCount += 1;
        }
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

  private vegetationGridKey(x: number, z: number): string {
    return `${Math.floor(x / VEGETATION_GRID_SIZE)}:${Math.floor(z / VEGETATION_GRID_SIZE)}`;
  }

  private registerVegetation(instance: VegetationInstance): void {
    const key = this.vegetationGridKey(instance.x, instance.z);
    const cell = this.vegetationGrid.get(key);
    if (cell) cell.push(instance);
    else this.vegetationGrid.set(key, [instance]);
  }

  private nearbyVegetation(x: number, z: number): VegetationInstance[] {
    const centerX = Math.floor(x / VEGETATION_GRID_SIZE);
    const centerZ = Math.floor(z / VEGETATION_GRID_SIZE);
    const nearby: VegetationInstance[] = [];
    for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const cell = this.vegetationGrid.get(`${centerX + offsetX}:${centerZ + offsetZ}`);
        if (cell) nearby.push(...cell);
      }
    }
    return nearby;
  }

  private updateVegetation(player: WorldPosition, elapsedSeconds: number): void {
    const delta = this.previousVegetationElapsed === null
      ? 1 / 60
      : Math.min(0.1, Math.max(0, elapsedSeconds - this.previousVegetationElapsed));
    const travelled = this.hasPreviousVegetationPlayer
      ? Math.hypot(
        player.x - this.previousVegetationPlayer.x,
        player.z - this.previousVegetationPlayer.y,
      )
      : 0;
    const speed = delta > 0.0001 ? travelled / delta : 0;
    const movementX = this.hasPreviousVegetationPlayer
      ? player.x - this.previousVegetationPlayer.x
      : 0;
    const movementZ = this.hasPreviousVegetationPlayer
      ? player.z - this.previousVegetationPlayer.y
      : 0;
    this.previousVegetationElapsed = elapsedSeconds;
    this.previousVegetationPlayer.set(player.x, player.z);
    this.hasPreviousVegetationPlayer = true;

    const nearby = this.nearbyVegetation(player.x, player.z);
    const nearbySet = new Set(nearby);
    const work = new Set([...this.activeVegetation, ...nearby]);
    let strongest: VegetationInteractionEvent | null = null;
    let flowersChanged = false;
    let bushesChanged = false;

    for (const instance of work) {
      const dx = instance.x - player.x;
      const dz = instance.z - player.z;
      const distance = Math.hypot(dx, dz);
      const touching = nearbySet.has(instance) && distance < instance.radius;
      const contact = touching ? clamp01(1 - distance / instance.radius) : 0;
      const maxBend = this.reducedMotion
        ? 0.11
        : instance.kind === 'shrub' ? 0.34 : 0.5;
      const targetBend = contact * maxBend;
      const response = targetBend > instance.bend ? 16 : 5.2;
      const blend = 1 - Math.exp(-response * Math.max(delta, 1 / 240));
      instance.bend = THREE.MathUtils.lerp(instance.bend, targetBend, blend);

      if (touching) {
        const directionLength = Math.hypot(dx, dz);
        const fallbackLength = Math.hypot(movementX, movementZ);
        const targetX = directionLength > 0.001
          ? dx / directionLength
          : fallbackLength > 0.001 ? movementX / fallbackLength : 0;
        const targetZ = directionLength > 0.001
          ? dz / directionLength
          : fallbackLength > 0.001 ? movementZ / fallbackLength : 1;
        instance.bendX = THREE.MathUtils.lerp(instance.bendX, targetX, blend);
        instance.bendZ = THREE.MathUtils.lerp(instance.bendZ, targetZ, blend);
        if (!strongest || contact > strongest.intensity) {
          strongest = {
            kind: instance.kind,
            intensity: contact,
            x: instance.x,
            z: instance.z,
            speed,
          };
        }
      }

      const stillMoving = instance.bend > 0.002 || targetBend > 0.002;
      if (stillMoving) this.activeVegetation.add(instance);
      else this.activeVegetation.delete(instance);
      if (!stillMoving && instance.bend === 0) continue;

      this.tempBendDirection.set(
        instance.bendX * instance.bend,
        1,
        instance.bendZ * instance.bend,
      ).normalize();
      this.tempTiltQuaternion.setFromUnitVectors(WORLD_UP, this.tempBendDirection);
      this.tempQuaternion.setFromAxisAngle(WORLD_UP, instance.rotationY);
      this.tempTiltQuaternion.multiply(this.tempQuaternion);
      this.tempPosition.set(instance.x, instance.y, instance.z);
      this.tempScale.set(
        instance.scaleX * (1 + instance.bend * 0.05),
        instance.scaleY * (1 - instance.bend * 0.12),
        instance.scaleZ * (1 + instance.bend * 0.05),
      );
      this.tempMatrix.compose(
        this.tempPosition,
        this.tempTiltQuaternion,
        this.tempScale,
      );
      this.pools[instance.poolName].mesh.setMatrixAt(instance.index, this.tempMatrix);
      if (instance.poolName === 'flowers') flowersChanged = true;
      else bushesChanged = true;
      if (!stillMoving) instance.bend = 0;
    }

    if (flowersChanged) this.pools.flowers.mesh.instanceMatrix.needsUpdate = true;
    if (bushesChanged) this.pools.bushes.mesh.instanceMatrix.needsUpdate = true;
    if (
      strongest
      && strongest.intensity >= 0.12
      && strongest.speed >= 0.22
      && elapsedSeconds - this.lastVegetationSoundAt >= VEGETATION_SOUND_COOLDOWN_SECONDS
    ) {
      this.lastVegetationSoundAt = elapsedSeconds;
      this.onVegetationInteraction?.(strongest);
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
    this.minutesSinceMidnightValue = (12 * 60 + normalizedTime * 24 * 60) % (24 * 60);
    const phase = normalizedTime * Math.PI * 2;
    const solarAltitude = Math.cos(phase);
    this.daylight = smoothstep(-0.24, 0.3, solarAltitude);
    const twilight = (1 - Math.abs(solarAltitude))
      * smoothstep(-0.42, 0.08, solarAltitude);

    this.skyColor.copy(this.nightSky).lerp(this.daySky, this.daylight);
    this.skyColor.lerp(this.sunsetSky, twilight * 0.18);
    this.fog.color.copy(this.skyColor);
    this.hemisphereLight.color.copy(this.skyColor).lerp(this.daySky, 0.42);
    this.hemisphereLight.groundColor.set(0x565f51).lerp(new THREE.Color(0x6b765d), this.daylight);
    this.hemisphereLight.intensity = 0.44 + this.daylight * 0.64;
    this.sunLight.color.copy(this.duskSun).lerp(this.daySun, this.daylight);
    this.sunLight.intensity = 0.2 + this.daylight * 1.35;

    if (this.cyberpunkTheme) {
      const palette = this.cyberpunkTheme.palette;
      this.cyberSkyTarget.setHex(palette.skyTop);
      this.cyberHorizonTarget.setHex(palette.skyHorizon);
      this.cyberSkyTarget.lerp(this.cyberHorizonTarget, 0.18 + this.daylight * 0.28);
      this.skyColor.lerp(this.cyberSkyTarget, 0.84);
      this.cyberFogTarget.setHex(palette.fog).lerp(this.skyColor, 0.18);
      this.fog.color.lerp(this.cyberFogTarget, 0.78);
      this.hemisphereLight.color.lerp(this.cyberHorizonTarget, 0.54);
      this.hemisphereLight.groundColor.setHex(palette.ground).lerp(this.cyberFogTarget, 0.22);
      this.hemisphereLight.intensity *= 0.88;
      this.sunLight.color.lerp(this.cyberHorizonTarget, 0.22);
      this.sunLight.intensity *= 0.68;
    } else if (this.environmentTheme === 'desert') {
      this.desertSkyTarget
        .copy(this.desertNightSky)
        .lerp(this.desertDaySky, this.daylight)
        .lerp(this.desertHorizon, twilight * 0.28);
      this.skyColor.lerp(this.desertSkyTarget, 0.78);
      this.desertFogTarget.setHex(OIL_DESERT_PALETTE.fog).lerp(this.skyColor, 0.22);
      this.fog.color.lerp(this.desertFogTarget, 0.72);
      this.hemisphereLight.color.lerp(this.desertSkyTarget, 0.58);
      this.desertGroundTarget.setHex(OIL_DESERT_PALETTE.sand);
      this.hemisphereLight.groundColor.lerp(this.desertGroundTarget, 0.82);
      this.hemisphereLight.intensity *= 0.94;
      this.sunLight.color.lerp(this.desertSun, 0.42);
      this.sunLight.intensity *= 1.04;
    } else if (this.signatureTheme) {
      const theme = this.signatureTheme;
      this.signatureSkyTarget
        .setHex(theme.secondary)
        .lerp(this.skyColor, this.daylight > 0.5 ? 0.64 : 0.78);
      this.skyColor.lerp(this.signatureSkyTarget, 0.28);
      this.signatureFogTarget.setHex(theme.ground).lerp(this.skyColor, 0.72);
      this.fog.color.lerp(this.signatureFogTarget, 0.24);
      this.hemisphereLight.color.lerp(this.signatureSkyTarget, 0.2);
      this.signatureGroundTarget.setHex(theme.ground);
      this.hemisphereLight.groundColor.lerp(this.signatureGroundTarget, 0.42);
      this.signatureSunTarget.setHex(theme.accent).lerp(this.daySun, 0.62);
      this.sunLight.color.lerp(this.signatureSunTarget, 0.24);
    }

    // Capture the exact dynamic day/night baseline before any market layer.
    // The values are rebuilt every frame, so a five-second surge can cross
    // dusk without freezing the clock or accumulating colour drift.
    this.baselineSky.copy(this.skyColor);
    this.baselineFog.copy(this.fog.color);
    this.baselineHemisphere.copy(this.hemisphereLight.color);
    this.baselineGround.copy(this.hemisphereLight.groundColor);
    this.baselineSun.copy(this.sunLight.color);
    this.baselineHemisphereIntensity = this.hemisphereLight.intensity;
    this.baselineSunIntensity = this.sunLight.intensity;

    const marketFlash = this.computeMarketFlash(elapsedSeconds);
    if (marketFlash > 0) {
      const rising = this.marketFlashDirection === 'up';
      this.skyColor.lerp(rising ? this.riseSky : this.dropSky, marketFlash);
      this.fog.color.copy(this.skyColor).lerp(rising ? this.riseFog : this.dropFog, marketFlash * 0.64);
      this.hemisphereLight.color.lerp(
        rising ? this.riseHemisphere : this.dropHemisphere,
        marketFlash * 0.8,
      );
      this.hemisphereLight.groundColor.lerp(
        rising ? this.riseGround : this.dropGround,
        marketFlash * 0.48,
      );
      this.hemisphereLight.intensity += marketFlash * 0.12;
      this.sunLight.color.lerp(rising ? this.riseSun : this.dropSun, marketFlash * 0.78);
      this.sunLight.intensity += marketFlash * 0.28;
    }

    const tradeSurge = this.computeTradeSurge(elapsedSeconds);
    if (tradeSurge > 0) {
      const rising = this.tradeSurgeDirection === 'up';
      this.skyColor.lerp(rising ? this.riseSky : this.dropSky, tradeSurge);
      this.fog.color.lerp(rising ? this.riseFog : this.dropFog, tradeSurge * 0.86);
      this.hemisphereLight.color.lerp(
        rising ? this.riseHemisphere : this.dropHemisphere,
        tradeSurge,
      );
      this.hemisphereLight.groundColor.lerp(
        rising ? this.riseGround : this.dropGround,
        tradeSurge * 0.68,
      );
      this.hemisphereLight.intensity += tradeSurge * 0.06;
      this.sunLight.color.lerp(rising ? this.riseSun : this.dropSun, tradeSurge * 0.82);
      this.sunLight.intensity += tradeSurge * 0.08;
    } else if (marketFlash <= 0) {
      // Explicit restoration makes the invariant resilient to future layers:
      // inactive market presentation is bit-for-bit the day/night baseline.
      this.skyColor.copy(this.baselineSky);
      this.fog.color.copy(this.baselineFog);
      this.hemisphereLight.color.copy(this.baselineHemisphere);
      this.hemisphereLight.groundColor.copy(this.baselineGround);
      this.hemisphereLight.intensity = this.baselineHemisphereIntensity;
      this.sunLight.color.copy(this.baselineSun);
      this.sunLight.intensity = this.baselineSunIntensity;
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

  private computeMarketFlash(elapsedSeconds: number): number {
    const age = elapsedSeconds - this.marketFlashStartedAt;
    if (!Number.isFinite(age) || age < 0 || age >= this.marketFlashDuration) {
      this.marketFlashIntensity = 0;
      return 0;
    }
    const attackSeconds = this.reducedMotion ? 0.12 : 0.055;
    const attack = smoothstep(0, attackSeconds, age);
    this.marketFlashIntensity = age < attackSeconds
      ? THREE.MathUtils.lerp(this.marketFlashStartIntensity, this.marketFlashPeak, attack)
      : this.marketFlashPeak * (1 - smoothstep(attackSeconds, this.marketFlashDuration, age));
    return this.marketFlashIntensity;
  }

  private computeTradeSurge(elapsedSeconds: number): number {
    if (
      !Number.isFinite(this.tradeSurgeStartedAt)
      || elapsedSeconds < this.tradeSurgeStartedAt
      || elapsedSeconds >= this.tradeSurgeEndsAt
    ) {
      this.tradeSurgeIntensity = 0;
      return 0;
    }
    if (elapsedSeconds < this.tradeSurgeStartedAt + this.tradeSurgeConfig.attackSeconds) {
      const attack = smoothstep(
        this.tradeSurgeStartedAt,
        this.tradeSurgeStartedAt + this.tradeSurgeConfig.attackSeconds,
        elapsedSeconds,
      );
      this.tradeSurgeIntensity = this.tradeSurgePeak * attack;
      return this.tradeSurgeIntensity;
    }
    if (elapsedSeconds <= this.tradeSurgeHoldUntil) {
      this.tradeSurgeIntensity = this.tradeSurgePeak;
      return this.tradeSurgeIntensity;
    }
    const release = smoothstep(
      this.tradeSurgeHoldUntil,
      this.tradeSurgeEndsAt,
      elapsedSeconds,
    );
    this.tradeSurgeIntensity = this.tradeSurgePeak * (1 - release);
    return this.tradeSurgeIntensity;
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
      // These are real inverse-square lights. Terrain, benches, foliage, and
      // characters receive the warmth instead of a flat additive ground disc.
      light.intensity = nightStrength * 38 * shimmer;

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

    this.lampMotePoints.geometry.setDrawRange(0, moteCount);
    this.lampMotePoints.geometry.getAttribute('position').needsUpdate = true;
    this.lampMotePoints.visible = moteCount > 0;
    this.lampMoteMaterial.opacity = nightStrength * 0.5;
  }

  private updateWeather(player: WorldPosition, elapsedSeconds: number): void {
    const state = rainStateAt(this.seed, elapsedSeconds, this.dayDurationSeconds);
    // Storm windows are entirely inside deep night, while this extra gate
    // fails closed if the solar curve is retuned later.
    this.rainIntensity = this.nightFactor >= 0.72 ? state.intensity : 0;
    this.rainingValue = state.active && this.rainIntensity > 0.01;
    const dropCapacity = this.reducedMotion ? 48 : RAIN_DROP_CAPACITY;
    const dropCount = this.rainingValue
      ? Math.max(12, Math.round(dropCapacity * this.rainIntensity))
      : 0;
    // The rain field follows the player and needs only one local ground plane.
    // Sampling terrain for every streak at 60fps caused thousands of pond/LRU
    // cache operations during storms without a visible improvement.
    const rainGround = dropCount > 0 ? this.heightAt(player.x, player.z) + 0.18 : 0;

    for (let index = 0; index < dropCount; index += 1) {
      const angle = hashCoordinates(this.weatherSeed, index, 0, 13_337) * Math.PI * 2;
      const radius = Math.sqrt(hashCoordinates(this.weatherSeed, index, 0, 14_351)) * RAIN_RADIUS;
      const x = player.x + Math.cos(angle) * radius;
      const z = player.z + Math.sin(angle) * radius;
      const phase = hashCoordinates(this.weatherSeed, index, 0, 15_373) * RAIN_COLUMN_HEIGHT;
      const fall = positiveModulo(phase - elapsedSeconds * (10.5 + this.rainIntensity * 3.5), RAIN_COLUMN_HEIGHT);
      const ground = rainGround;
      const y = ground + 0.8 + fall;
      const streak = 0.62 + this.rainIntensity * 0.72;
      const offset = index * 6;
      this.rainPositions[offset] = x;
      this.rainPositions[offset + 1] = y;
      this.rainPositions[offset + 2] = z;
      this.rainPositions[offset + 3] = x - 0.035;
      this.rainPositions[offset + 4] = Math.max(ground, y - streak);
      this.rainPositions[offset + 5] = z + 0.025;
    }
    this.rainLines.geometry.setDrawRange(0, dropCount * 2);
    this.rainLines.geometry.getAttribute('position').needsUpdate = true;
    this.rainLines.visible = dropCount > 0;
    this.rainMaterial.opacity = Math.min(0.52, 0.16 + this.rainIntensity * 0.38);

    const previous = this.previousWeatherElapsed;
    if (previous !== null && elapsedSeconds >= previous && state.storm) {
      for (let index = 0; index < state.storm.thunder.length; index += 1) {
        const thunder = state.storm.thunder[index];
        if (!thunder || thunder.at <= previous || thunder.at > elapsedSeconds) continue;
        const key = `${state.storm.id}:${index}`;
        if (this.firedThunder.has(key)) continue;
        this.firedThunder.add(key);
        this.onThunder?.(thunder.intensity);
      }
    }
    this.previousWeatherElapsed = elapsedSeconds;
    if (this.firedThunder.size > 12) {
      if (!state.storm) {
        this.firedThunder.clear();
      } else {
        const keepPrefix = `${state.storm.id}:`;
        for (const key of this.firedThunder) if (!key.startsWith(keepPrefix)) this.firedThunder.delete(key);
      }
    }
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
    this.ambientDetails.dispose();
    this.scene.remove(this.root);
    for (const geometry of this.sharedGeometries) {
      geometry.dispose();
    }
    for (const material of this.sharedMaterials) {
      material.dispose();
    }
    this.sharedGeometries.clear();
    this.sharedMaterials.clear();
    this.firedThunder.clear();
    this.vegetationGrid.clear();
    this.activeVegetation.clear();
    this.grassInstanceCount = 0;
    this.shrubInstanceCount = 0;
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
