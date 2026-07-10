import {
  BoxGeometry,
  Camera,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
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
import { SparklePool } from './SparklePool';

export type MonumentKind = 'grand' | 'echo';

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
  green: 0x70b883,
  red: 0xc96c63,
  teal: 0x5f9b91,
  bush: 0x789b72,
  flower: 0xe6a3a8,
  lamp: 0xffd487,
} as const;

const CHART_WIDTH = 13.8;
const CHART_HEIGHT = 5.15;
const SHUNT_DURATION_SECONDS = 0.58;
const tempObject = new Object3D();
const tempCameraPosition = new Vector3();
const tempBillboardPosition = new Vector3();
const tempMonumentPosition = new Vector3();

interface LampBulb {
  readonly mesh: Mesh<SphereGeometry, MeshStandardMaterial>;
  readonly phase: number;
}

export class Monument {
  readonly root = new Group();
  readonly symbol: AssetSymbol;
  readonly kind: MonumentKind;
  readonly discoverable: boolean;
  readonly bodyInstances: InstancedMesh<RoundedBoxGeometry, MeshStandardMaterial>;
  readonly wickInstances: InstancedMesh<CylinderGeometry, MeshStandardMaterial>;

  private readonly chartGroup = new Group();
  private readonly billboardGroup = new Group();
  private readonly symbolText = new Text();
  private readonly priceText = new Text();
  private readonly sparkles = new SparklePool(24);
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
  private readonly creamColor = new Color(COLORS.cream);
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
    const bodyMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.02,
      vertexColors: true,
      emissive: COLORS.cream,
      emissiveIntensity: 0,
    });
    this.bodyInstances = new InstancedMesh(bodyGeometry, bodyMaterial, MONUMENT_CANDLE_COUNT);
    this.bodyInstances.name = `${this.symbol}-candle-bodies`;
    this.bodyInstances.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bodyInstances.count = 0;
    this.bodyInstances.castShadow = true;
    this.bodyInstances.receiveShadow = true;
    this.bodyInstances.frustumCulled = false;

    const wickGeometry = new CylinderGeometry(0.055, 0.055, 1, 7);
    const wickMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      vertexColors: true,
      emissive: COLORS.cream,
      emissiveIntensity: 0,
    });
    this.wickInstances = new InstancedMesh(wickGeometry, wickMaterial, MONUMENT_CANDLE_COUNT);
    this.wickInstances.name = `${this.symbol}-candle-wicks`;
    this.wickInstances.instanceMatrix.setUsage(DynamicDrawUsage);
    this.wickInstances.count = 0;
    this.wickInstances.castShadow = true;
    this.wickInstances.receiveShadow = true;
    this.wickInstances.frustumCulled = false;

    this.chartGroup.name = `${this.symbol}-chart`;
    this.chartGroup.position.set(0, 0.78, 0);
    this.chartGroup.add(this.wickInstances, this.bodyInstances, this.sparkles.points);
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

    this.buildSign(options.fontUrl);
    this.buildFurniture();
    this.buildLandscaping();

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
      this.priceText.sync();
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
      this.shuntProgress = Math.min(1, this.shuntProgress + delta / SHUNT_DURATION_SECONDS);
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

    const lower = new Mesh(new CylinderGeometry(9.7, 10, 0.42, 40), lowerMaterial);
    lower.position.y = 0.1;
    const middle = new Mesh(new CylinderGeometry(8.85, 9.15, 0.32, 40), middleMaterial);
    middle.position.y = 0.43;
    const upper = new Mesh(new CylinderGeometry(7.95, 8.2, 0.26, 40), upperMaterial);
    upper.position.y = 0.71;

    for (const layer of [lower, middle, upper]) {
      layer.receiveShadow = true;
      layer.castShadow = true;
      this.root.add(layer);
    }

    const ring = new Mesh(
      new TorusGeometry(8.36, 0.075, 6, 48),
      new MeshStandardMaterial({ color: COLORS.cream, roughness: 0.84 }),
    );
    ring.rotation.x = Math.PI * 0.5;
    ring.position.y = 0.87;
    ring.receiveShadow = true;
    this.root.add(ring);

    const stepMaterial = new MeshStandardMaterial({ color: COLORS.stoneLight, roughness: 0.9 });
    for (let i = 0; i < 3; i += 1) {
      const step = new Mesh(new BoxGeometry(3.5 + i * 0.6, 0.17, 1.1), stepMaterial);
      step.position.set(0, 0.28 - i * 0.08, 9.1 + i * 0.68);
      step.castShadow = true;
      step.receiveShadow = true;
      this.root.add(step);
    }
  }

  private buildSign(fontUrl?: string): void {
    const signMaterial = new MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 0.82 });
    const pillarGeometry = new RoundedBoxGeometry(0.7, 5.9, 0.75, 2, 0.16);
    for (const x of [-4.5, 4.5]) {
      const pillar = new Mesh(pillarGeometry, signMaterial);
      pillar.position.set(x, 3.48, -1.05);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      this.root.add(pillar);
    }
    const lintel = new Mesh(new RoundedBoxGeometry(9.7, 0.72, 0.8, 2, 0.16), signMaterial);
    lintel.position.set(0, 6.2, -1.05);
    lintel.castShadow = true;
    lintel.receiveShadow = true;
    this.root.add(lintel);

    this.symbolText.text = this.symbol;
    this.symbolText.fontSize = 1.02;
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
    this.symbolText.position.set(0, 6.23, -0.62);
    this.symbolText.sync();
    this.root.add(this.symbolText);

    const card = new Mesh(
      new RoundedBoxGeometry(1, 1, 1, 3, 0.14),
      this.priceCardMaterial,
    );
    card.scale.set(4.1, 1.02, 0.12);
    card.position.z = -0.1;
    card.castShadow = true;
    this.billboardGroup.position.set(0, 6.95, 0.2);
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
    this.priceText.sync();
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

    this.bodyInstances.count = layouts.length;
    this.wickInstances.count = layouts.length;
    layouts.forEach((layout, index) => {
      const isLatest = index === layouts.length - 1;
      const candleColor = (layout.isUp ? this.upColor : this.downColor).clone();
      if (isLatest && this.pulseEnergy > 0) {
        candleColor.lerp(this.creamColor, Math.min(0.42, this.pulseEnergy * 0.35));
      }

      tempObject.position.set(layout.x, layout.bodyY, 0);
      tempObject.rotation.set(0, 0, 0);
      tempObject.scale.set(spacing * 0.68, layout.bodyHeight, 0.44);
      tempObject.updateMatrix();
      this.bodyInstances.setMatrixAt(index, tempObject.matrix);
      this.bodyInstances.setColorAt(index, candleColor);

      tempObject.position.set(layout.x, layout.wickY, 0);
      tempObject.scale.set(1, layout.wickHeight, 1);
      tempObject.updateMatrix();
      this.wickInstances.setMatrixAt(index, tempObject.matrix);
      this.wickInstances.setColorAt(index, candleColor);
    });

    this.bodyInstances.instanceMatrix.needsUpdate = true;
    this.wickInstances.instanceMatrix.needsUpdate = true;
    if (this.bodyInstances.instanceColor) {
      this.bodyInstances.instanceColor.needsUpdate = true;
    }
    if (this.wickInstances.instanceColor) {
      this.wickInstances.instanceColor.needsUpdate = true;
    }
  }

  private updatePulse(deltaSeconds: number): void {
    this.pulseEnergy = Math.max(0, this.pulseEnergy - deltaSeconds * 1.9);
    const color = this.pulseDirection === 'down' ? this.downColor : this.upColor;
    this.bodyInstances.material.emissive.copy(color);
    this.wickInstances.material.emissive.copy(color);
    this.bodyInstances.material.emissiveIntensity = this.pulseEnergy * 0.18;
    this.wickInstances.material.emissiveIntensity = this.pulseEnergy * 0.12;
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
