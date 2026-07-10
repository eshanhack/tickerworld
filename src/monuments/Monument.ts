import {
  BoxGeometry,
  BufferGeometry,
  Camera,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Text } from 'troika-three-text';
import type { AssetState, AssetSymbol, Candle, TickDirection } from '../types';
import {
  MONUMENT_CANDLE_COUNT,
  MONUMENT_SHUNT_DURATION_SECONDS,
  cloneCandle,
  computePriceRange,
  didCandleWindowRoll,
  easePriceRange,
  formatPrice,
  layoutCandles,
  selectChartCandles,
  smoothCandles,
  unusualMoveScore,
  type PriceRange,
} from './chartMath';
import { buildMedallion, type MonumentKind } from './medallions';
import {
  collidesLocalCamera,
  PLAZA_LAYERS,
  PLAZA_STEPS,
  sampleLocalStoneGround,
} from './monumentGeometry';
import { SparklePool } from './SparklePool';

export type { MonumentKind } from './medallions';

export interface MonumentPosition {
  x: number;
  y?: number;
  z: number;
}

export interface MonumentOptions {
  symbol: AssetSymbol;
  kind?: MonumentKind;
  position?: MonumentPosition | Vector3;
  scale?: number;
  fontUrl?: string;
  initialState?: AssetState;
}

const COLORS = {
  stone: 0xb8aea0,
  stoneLight: 0xd7cec0,
  stoneDark: 0x81796f,
  cream: 0xfff1cf,
  ink: 0x31373d,
  green: 0x8fd8a3,
  red: 0xefa09a,
  teal: 0x5f9b91,
  bush: 0x789b72,
  flower: 0xe6a3a8,
  lamp: 0xffd487,
} as const;

const CHART_WIDTH = 13.8;
const CHART_HEIGHT = 5.15;
const tempObject = new Object3D();
const tempCameraPosition = new Vector3();
const tempBillboardPosition = new Vector3();
const tempMonumentPosition = new Vector3();
const tempLocalPoint = new Vector3();
const tempWorldPoint = new Vector3();
const tempInverseMatrix = new Matrix4();

interface LampBulb {
  readonly mesh: Mesh<SphereGeometry, MeshStandardMaterial>;
  readonly phase: number;
}

export class Monument {
  readonly root = new Group();
  readonly symbol: AssetSymbol;
  readonly kind: MonumentKind;
  readonly discoverable: boolean;
  readonly greenBodyInstances: InstancedMesh<RoundedBoxGeometry, MeshStandardMaterial>;
  readonly redBodyInstances: InstancedMesh<RoundedBoxGeometry, MeshStandardMaterial>;
  readonly greenWickInstances: InstancedMesh<CylinderGeometry, MeshStandardMaterial>;
  readonly redWickInstances: InstancedMesh<CylinderGeometry, MeshStandardMaterial>;

  private readonly chartGroup = new Group();
  private readonly billboardGroup = new Group();
  private readonly symbolText = new Text();
  private readonly priceText = new Text();
  private readonly sparkles = new SparklePool(24);
  private readonly activeBodyHighlight: Mesh<RoundedBoxGeometry, MeshStandardMaterial>;
  private readonly activeWickHighlight: Mesh<CylinderGeometry, MeshStandardMaterial>;
  private readonly pulseRingMaterial: MeshBasicMaterial;
  private readonly pulseRing: Mesh<TorusGeometry, MeshBasicMaterial>;
  private readonly priceCardMaterial = new MeshStandardMaterial({
    color: COLORS.ink,
    emissive: COLORS.ink,
    emissiveIntensity: 0,
    roughness: 0.75,
  });
  private readonly lamps: LampBulb[] = [];
  private readonly upColor = new Color(COLORS.green);
  private readonly downColor = new Color(COLORS.red);
  private readonly targetRangeFallback: PriceRange = { min: 0, max: 1 };

  private targetCandles: Candle[] = [];
  private displayedCandles: Candle[] = [];
  private displayedRange: PriceRange = { min: 0, max: 1 };
  private targetRange: PriceRange = this.targetRangeFallback;
  private parent: Object3D | null = null;
  private active = true;
  private disposed = false;
  private shuntProgress = 1;
  private pulseEnergy = 0;
  private pulseDirection: TickDirection = 'flat';
  private lastPresentationTick = -1;
  private displayedPrice = '';
  private nightFactor = 0;

  constructor(options: MonumentOptions) {
    this.symbol = options.symbol;
    this.kind = options.kind ?? 'grand';
    this.discoverable = this.kind === 'grand';
    this.root.name = `${this.kind}-monument-${this.symbol}`;

    const position = options.position ?? { x: 0, y: 0, z: 0 };
    this.root.position.set(position.x, position.y ?? 0, position.z);
    const defaultScale = this.kind === 'echo' ? 0.6 : 1;
    this.root.scale.setScalar(options.scale ?? defaultScale);

    this.buildPlaza();

    const bodyGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.15);
    const wickGeometry = new CylinderGeometry(0.055, 0.055, 1, 7);
    const createMaterial = (color: number, roughness: number): MeshStandardMaterial => (
      new MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.08,
        roughness,
        metalness: 0.01,
      })
    );
    const createPool = <TGeometry extends BufferGeometry>(
      name: string,
      geometry: TGeometry,
      material: MeshStandardMaterial,
    ): InstancedMesh<TGeometry, MeshStandardMaterial> => {
      const pool = new InstancedMesh<TGeometry, MeshStandardMaterial>(
        geometry,
        material,
        MONUMENT_CANDLE_COUNT,
      );
      pool.name = `${this.symbol}-${name}`;
      pool.instanceMatrix.setUsage(DynamicDrawUsage);
      pool.count = 0;
      pool.castShadow = true;
      pool.receiveShadow = true;
      pool.frustumCulled = false;
      return pool;
    };

    this.greenBodyInstances = createPool(
      'green-candle-bodies',
      bodyGeometry,
      createMaterial(COLORS.green, 0.66),
    );
    this.redBodyInstances = createPool(
      'red-candle-bodies',
      bodyGeometry,
      createMaterial(COLORS.red, 0.66),
    );
    this.greenWickInstances = createPool(
      'green-candle-wicks',
      wickGeometry,
      createMaterial(COLORS.green, 0.72),
    );
    this.redWickInstances = createPool(
      'red-candle-wicks',
      wickGeometry,
      createMaterial(COLORS.red, 0.72),
    );

    const highlightMaterial = new MeshStandardMaterial({
      color: COLORS.cream,
      emissive: COLORS.cream,
      emissiveIntensity: 0.55,
      roughness: 0.52,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    this.activeBodyHighlight = new Mesh(bodyGeometry, highlightMaterial);
    this.activeBodyHighlight.name = `${this.symbol}-active-candle-highlight`;
    this.activeBodyHighlight.frustumCulled = false;
    this.activeBodyHighlight.visible = false;
    this.activeWickHighlight = new Mesh(wickGeometry, highlightMaterial.clone());
    this.activeWickHighlight.name = `${this.symbol}-active-wick-highlight`;
    this.activeWickHighlight.frustumCulled = false;
    this.activeWickHighlight.visible = false;

    this.chartGroup.name = `${this.symbol}-chart`;
    this.chartGroup.position.set(0, 0.56, 0.46);
    this.chartGroup.scale.y = 0.68;
    this.chartGroup.add(
      this.greenWickInstances,
      this.redWickInstances,
      this.greenBodyInstances,
      this.redBodyInstances,
      this.activeWickHighlight,
      this.activeBodyHighlight,
      this.sparkles.points,
    );
    this.root.add(this.chartGroup);

    this.pulseRingMaterial = new MeshBasicMaterial({
      color: COLORS.cream,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.pulseRing = new Mesh(new TorusGeometry(2.15, 0.045, 6, 42), this.pulseRingMaterial);
    this.pulseRing.position.set(0, CHART_HEIGHT * 0.5, -0.48);
    this.pulseRing.visible = false;
    this.chartGroup.add(this.pulseRing);

    this.buildShrine(options.fontUrl);
    if (this.kind === 'grand') {
      this.buildFurniture();
      this.buildLandscaping();
    }

    if (options.initialState) {
      this.setAssetState(options.initialState);
    }
  }

  mount(parent: Object3D): this {
    if (this.disposed) {
      throw new Error(`Cannot mount disposed ${this.symbol} monument.`);
    }
    if (this.parent === parent) {
      return this;
    }
    this.unmount();
    parent.add(this.root);
    this.parent = parent;
    return this;
  }

  unmount(): this {
    this.root.removeFromParent();
    this.parent = null;
    return this;
  }

  setActive(active: boolean): void {
    this.active = active;
    this.root.visible = active;
  }

  setNightFactor(factor: number): void {
    this.nightFactor = Math.min(1, Math.max(0, factor));
    for (const lamp of this.lamps) {
      lamp.mesh.material.emissiveIntensity = 0.25 + this.nightFactor * 2.5;
    }
  }

  setAssetState(state: AssetState): void {
    if (state.symbol !== this.symbol || this.disposed) {
      return;
    }

    const nextCandles = selectChartCandles(state.candles);
    const rolled = didCandleWindowRoll(this.targetCandles, nextCandles);
    if (rolled) {
      this.shuntProgress = 0;
      const displayedByTime = new Map(this.displayedCandles.map((candle) => [candle.openTime, candle]));
      this.displayedCandles = nextCandles.map((candle, index) => {
        const existing = displayedByTime.get(candle.openTime);
        if (existing) {
          return cloneCandle(existing);
        }
        if (index === nextCandles.length - 1) {
          return cloneCandle({
            ...candle,
            high: candle.open,
            low: candle.open,
            close: candle.open,
          });
        }
        return cloneCandle(candle);
      });
    } else if (this.displayedCandles.length === 0) {
      this.displayedCandles = nextCandles.map(cloneCandle);
    }

    this.targetCandles = nextCandles;
    this.targetRange = computePriceRange(this.targetCandles);
    if (this.displayedCandles.length === nextCandles.length && this.lastPresentationTick < 0) {
      this.displayedRange = { ...this.targetRange };
    }

    const formattedPrice = formatPrice(state.price);
    if (formattedPrice !== this.displayedPrice) {
      this.displayedPrice = formattedPrice;
      this.priceText.text = formattedPrice;
      if (typeof self !== 'undefined') {
        this.priceText.sync();
      }
    }

    if (state.presentationTick !== this.lastPresentationTick) {
      if (this.lastPresentationTick >= 0 && state.direction !== 'flat') {
        this.pulseDirection = state.direction;
        this.pulseEnergy = Math.max(this.pulseEnergy, 1);
        const score = unusualMoveScore(state.candles, state.previousPrice, state.price);
        if (score >= 1.7) {
          const color = state.direction === 'up' ? this.upColor : this.downColor;
          this.sparkles.burst(color, state.direction === 'up', Math.min(2, score / 2));
        }
      }
      this.lastPresentationTick = state.presentationTick;
    }
  }

  update(deltaSeconds: number, elapsedSeconds: number, camera?: Camera): void {
    if (!this.active || this.disposed) {
      return;
    }

    const delta = Math.min(0.1, Math.max(0, deltaSeconds));
    this.displayedCandles = smoothCandles(this.displayedCandles, this.targetCandles, delta);
    this.targetRange = this.targetCandles.length > 0
      ? computePriceRange(this.targetCandles)
      : this.targetRangeFallback;
    this.displayedRange = easePriceRange(this.displayedRange, this.targetRange, delta);

    if (this.shuntProgress < 1) {
      this.shuntProgress = Math.min(1, this.shuntProgress + delta / MONUMENT_SHUNT_DURATION_SECONDS);
    }
    this.updateChartInstances();
    this.updatePulse(delta);
    this.sparkles.update(delta);

    for (const lamp of this.lamps) {
      const shimmer = 1 + Math.sin(elapsedSeconds * 1.7 + lamp.phase) * 0.025 * this.nightFactor;
      lamp.mesh.scale.setScalar(shimmer);
    }

    if (camera) {
      this.updateBillboard(camera);
    }
  }

  distanceTo(point: Vector3, horizontalOnly = true): number {
    this.root.getWorldPosition(tempMonumentPosition);
    if (horizontalOnly) {
      const dx = point.x - tempMonumentPosition.x;
      const dz = point.z - tempMonumentPosition.z;
      return Math.hypot(dx, dz);
    }
    return point.distanceTo(tempMonumentPosition);
  }

  nearestDistance(point: Vector3): number {
    return this.distanceTo(point, true);
  }

  sampleGround(worldX: number, worldZ: number): { height: number; surface: 'stone' } | null {
    if (!this.active || this.disposed) {
      return null;
    }

    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(tempMonumentPosition);
    tempInverseMatrix.copy(this.root.matrixWorld).invert();
    tempLocalPoint
      .set(worldX, tempMonumentPosition.y, worldZ)
      .applyMatrix4(tempInverseMatrix);
    const sample = sampleLocalStoneGround(tempLocalPoint.x, tempLocalPoint.z);
    if (!sample) {
      return null;
    }

    tempWorldPoint
      .set(tempLocalPoint.x, sample.height, tempLocalPoint.z)
      .applyMatrix4(this.root.matrixWorld);
    return { height: tempWorldPoint.y, surface: 'stone' };
  }

  collidesCamera(worldX: number, worldY: number, worldZ: number): boolean {
    if (!this.active || this.disposed) {
      return false;
    }
    this.root.updateWorldMatrix(true, false);
    tempInverseMatrix.copy(this.root.matrixWorld).invert();
    tempLocalPoint.set(worldX, worldY, worldZ).applyMatrix4(tempInverseMatrix);
    return collidesLocalCamera(tempLocalPoint.x, tempLocalPoint.y, tempLocalPoint.z);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unmount();

    const geometries = new Set<{ dispose(): void }>();
    const materials = new Set<Material>();
    this.root.traverse((object) => {
      if (object === this.symbolText || object === this.priceText || object === this.sparkles.points) {
        return;
      }
      if (object instanceof Mesh || object instanceof InstancedMesh) {
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of objectMaterials) {
          materials.add(material);
        }
      }
    });
    for (const geometry of geometries) {
      geometry.dispose();
    }
    for (const material of materials) {
      material.dispose();
    }
    this.symbolText.dispose();
    this.priceText.dispose();
    this.sparkles.dispose();
    this.root.clear();
  }

  private buildPlaza(): void {
    const lowerMaterial = new MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 0.94 });
    const middleMaterial = new MeshStandardMaterial({ color: COLORS.stone, roughness: 0.92 });
    const upperMaterial = new MeshStandardMaterial({ color: COLORS.stoneLight, roughness: 0.9 });

    const layerMaterials = [lowerMaterial, middleMaterial, upperMaterial] as const;
    PLAZA_LAYERS.forEach((definition, index) => {
      const layer = new Mesh(
        new CylinderGeometry(definition.radius, definition.radius, definition.height, 40),
        layerMaterials[index] ?? upperMaterial,
      );
      layer.position.y = definition.centerY;
      layer.name = `${this.symbol}-plaza-tier-${index + 1}`;
      layer.receiveShadow = true;
      layer.castShadow = true;
      this.root.add(layer);
    });

    const ring = new Mesh(
      new TorusGeometry(8.36, 0.075, 6, 48),
      new MeshStandardMaterial({ color: COLORS.cream, roughness: 0.84 }),
    );
    ring.rotation.x = Math.PI * 0.5;
    ring.position.y = 0.87;
    ring.receiveShadow = true;
    this.root.add(ring);

    const stepMaterial = new MeshStandardMaterial({ color: COLORS.stoneLight, roughness: 0.9 });
    PLAZA_STEPS.forEach((definition, index) => {
      const step = new Mesh(
        new BoxGeometry(definition.width, definition.height, definition.depth),
        stepMaterial,
      );
      step.name = `${this.symbol}-plaza-step-${index + 1}`;
      step.position.set(definition.x, definition.y, definition.z);
      step.castShadow = true;
      step.receiveShadow = true;
      this.root.add(step);
    });
  }

  private buildShrine(fontUrl?: string): void {
    this.root.add(buildMedallion(this.symbol, this.kind));
    this.symbolText.text = this.symbol;
    this.symbolText.fontSize = this.kind === 'echo' || this.symbol === 'BTC' ? 0.8 : 0.98;
    this.symbolText.color = COLORS.cream;
    this.symbolText.anchorX = 'center';
    this.symbolText.anchorY = 'middle';
    this.symbolText.outlineWidth = '3%';
    this.symbolText.outlineColor = COLORS.ink;
    this.symbolText.outlineOpacity = 0.42;
    this.symbolText.depthOffset = -1;
    if (fontUrl) {
      this.symbolText.font = fontUrl;
    }
    this.symbolText.position.set(0, this.symbol === 'BTC' ? 5.98 : 7.52, -0.34);
    if (typeof self !== 'undefined') {
      this.symbolText.sync();
    }
    this.root.add(this.symbolText);

    const card = new Mesh(
      new RoundedBoxGeometry(1, 1, 1, 3, 0.14),
      this.priceCardMaterial,
    );
    card.scale.set(this.kind === 'echo' ? 3.5 : 4.25, 1.02, 0.12);
    card.position.z = -0.1;
    card.castShadow = true;
    this.billboardGroup.position.set(0, 6.82, 0.34);
    this.billboardGroup.add(card);

    this.priceText.text = '$—';
    this.priceText.fontSize = 0.58;
    this.priceText.color = COLORS.cream;
    this.priceText.anchorX = 'center';
    this.priceText.anchorY = 'middle';
    this.priceText.outlineWidth = '2%';
    this.priceText.outlineColor = COLORS.ink;
    this.priceText.outlineOpacity = 0.55;
    this.priceText.depthOffset = -2;
    if (fontUrl) {
      this.priceText.font = fontUrl;
    }
    this.priceText.position.z = 0.02;
    if (typeof self !== 'undefined') {
      this.priceText.sync();
    }
    this.billboardGroup.add(this.priceText);
    this.root.add(this.billboardGroup);
  }

  private buildFurniture(): void {
    const woodMaterial = new MeshStandardMaterial({ color: 0x9e735e, roughness: 0.88 });
    const metalMaterial = new MeshStandardMaterial({ color: COLORS.ink, roughness: 0.7 });
    const seatGeometry = new RoundedBoxGeometry(3.2, 0.25, 0.78, 2, 0.1);
    const backGeometry = new RoundedBoxGeometry(3.2, 0.72, 0.22, 2, 0.08);
    const legGeometry = new BoxGeometry(0.18, 0.72, 0.18);

    for (const side of [-1, 1]) {
      const bench = new Group();
      const seat = new Mesh(seatGeometry, woodMaterial);
      seat.position.y = 0.95;
      const back = new Mesh(backGeometry, woodMaterial);
      back.position.set(0, 1.34, -0.3);
      for (const x of [-1.15, 1.15]) {
        const leg = new Mesh(legGeometry, metalMaterial);
        leg.position.set(x, 0.58, 0);
        bench.add(leg);
      }
      bench.add(seat, back);
      bench.position.set(side * 6.35, 0, 2.6);
      bench.rotation.y = side * -0.34;
      bench.traverse((object) => {
        if (object instanceof Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      this.root.add(bench);
    }

    const poleGeometry = new CylinderGeometry(0.11, 0.16, 3.4, 8);
    const bulbGeometry = new SphereGeometry(0.34, 10, 7);
    const shadeGeometry = new ConeGeometry(0.52, 0.38, 10, 1, true);
    const bulbMaterial = new MeshStandardMaterial({
      color: COLORS.lamp,
      emissive: COLORS.lamp,
      emissiveIntensity: 0.25,
      roughness: 0.38,
    });

    const lampPositions: ReadonlyArray<readonly [number, number]> = [
      [-6.4, -4.5],
      [6.4, -4.5],
      [-7.4, 5.2],
      [7.4, 5.2],
    ];
    lampPositions.forEach(([x, z], index) => {
      const pole = new Mesh(poleGeometry, metalMaterial);
      pole.position.set(x, 2.23, z);
      pole.castShadow = true;
      const bulb = new Mesh(bulbGeometry, bulbMaterial.clone());
      bulb.position.set(x, 4.02, z);
      const shade = new Mesh(shadeGeometry, metalMaterial);
      shade.position.set(x, 4.38, z);
      shade.castShadow = true;
      this.root.add(pole, bulb, shade);
      this.lamps.push({ mesh: bulb, phase: index * 1.7 });
    });
  }

  private buildLandscaping(): void {
    const potGeometry = new CylinderGeometry(0.6, 0.48, 0.58, 10);
    const bushGeometry = new SphereGeometry(0.76, 9, 6);
    const flowerGeometry = new SphereGeometry(0.095, 6, 4);
    const potMaterial = new MeshStandardMaterial({ color: 0xb68162, roughness: 0.9 });
    const bushMaterial = new MeshStandardMaterial({ color: COLORS.bush, roughness: 0.92, flatShading: true });
    const flowerMaterial = new MeshStandardMaterial({ color: COLORS.flower, roughness: 0.8 });
    const positions: ReadonlyArray<readonly [number, number]> = [
      [-5.1, 5.7],
      [5.1, 5.7],
      [-7.1, -0.6],
      [7.1, -0.6],
    ];

    positions.forEach(([x, z], index) => {
      const pot = new Mesh(potGeometry, potMaterial);
      pot.position.set(x, 1.12, z);
      const bush = new Mesh(bushGeometry, bushMaterial);
      bush.position.set(x, 1.85, z);
      bush.scale.y = 0.84;
      const flower = new Mesh(flowerGeometry, flowerMaterial);
      const angle = index * 1.9;
      flower.position.set(x + Math.cos(angle) * 0.52, 2.25, z + Math.sin(angle) * 0.4);
      for (const mesh of [pot, bush, flower]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.root.add(mesh);
      }
    });
  }

  private updateChartInstances(): void {
    const spacing = CHART_WIDTH / MONUMENT_CANDLE_COUNT;
    const easedShunt = 1 - (1 - this.shuntProgress) ** 3;
    const xOffset = spacing * (1 - easedShunt);
    const layouts = layoutCandles(
      this.displayedCandles,
      this.displayedRange,
      CHART_WIDTH,
      CHART_HEIGHT,
      xOffset,
    );

    let greenCount = 0;
    let redCount = 0;
    this.activeBodyHighlight.visible = false;
    this.activeWickHighlight.visible = false;

    layouts.forEach((layout, index) => {
      const isLatest = index === layouts.length - 1;
      const bodyPool = layout.isUp ? this.greenBodyInstances : this.redBodyInstances;
      const wickPool = layout.isUp ? this.greenWickInstances : this.redWickInstances;
      const poolIndex = layout.isUp ? greenCount++ : redCount++;

      tempObject.position.set(layout.x, layout.bodyY, 0);
      tempObject.rotation.set(0, 0, 0);
      tempObject.scale.set(spacing * 0.68, layout.bodyHeight, 0.44);
      tempObject.updateMatrix();
      bodyPool.setMatrixAt(poolIndex, tempObject.matrix);

      tempObject.position.set(layout.x, layout.wickY, 0);
      tempObject.scale.set(1, layout.wickHeight, 1);
      tempObject.updateMatrix();
      wickPool.setMatrixAt(poolIndex, tempObject.matrix);

      if (isLatest) {
        this.activeBodyHighlight.position.set(layout.x, layout.bodyY, 0.005);
        this.activeBodyHighlight.scale.set(
          spacing * 0.76,
          layout.bodyHeight + 0.055,
          0.49,
        );
        this.activeBodyHighlight.visible = true;
        this.activeWickHighlight.position.set(layout.x, layout.wickY, 0.005);
        this.activeWickHighlight.scale.set(1.12, layout.wickHeight + 0.04, 1.12);
        this.activeWickHighlight.visible = true;
      }
    });

    this.greenBodyInstances.count = greenCount;
    this.greenWickInstances.count = greenCount;
    this.redBodyInstances.count = redCount;
    this.redWickInstances.count = redCount;
    for (const pool of [
      this.greenBodyInstances,
      this.greenWickInstances,
      this.redBodyInstances,
      this.redWickInstances,
    ]) {
      pool.instanceMatrix.needsUpdate = true;
    }
  }

  private updatePulse(deltaSeconds: number): void {
    this.pulseEnergy = Math.max(0, this.pulseEnergy - deltaSeconds * 1.9);
    const color = this.pulseDirection === 'down' ? this.downColor : this.upColor;
    this.greenBodyInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.08;
    this.greenWickInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.05;
    this.redBodyInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.08;
    this.redWickInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.05;
    this.activeBodyHighlight.material.opacity = 0.2 + this.pulseEnergy * 0.22;
    this.activeWickHighlight.material.opacity = 0.18 + this.pulseEnergy * 0.18;
    this.priceCardMaterial.emissive.copy(color);
    this.priceCardMaterial.emissiveIntensity = this.pulseEnergy * 0.15;

    if (this.pulseEnergy > 0.01) {
      this.pulseRing.visible = true;
      this.pulseRingMaterial.color.copy(color);
      this.pulseRingMaterial.opacity = this.pulseEnergy * 0.32;
      this.pulseRing.scale.setScalar(1 + (1 - this.pulseEnergy) * 0.38);
    } else {
      this.pulseRing.visible = false;
      this.pulseRingMaterial.opacity = 0;
    }
  }

  private updateBillboard(camera: Camera): void {
    camera.getWorldPosition(tempCameraPosition);
    this.billboardGroup.getWorldPosition(tempBillboardPosition);
    this.billboardGroup.lookAt(
      tempCameraPosition.x,
      tempBillboardPosition.y,
      tempCameraPosition.z,
    );
  }
}
