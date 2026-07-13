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
  Points,
  PointLight,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Text } from 'troika-three-text';
import type { NewsItem } from '../news';
import type { AssetState, AssetSymbol, Candle, FeedMode, TickDirection } from '../types';
import {
  MONUMENT_CANDLE_COUNT,
  MONUMENT_SHUNT_DURATION_SECONDS,
  cloneCandle,
  computePriceRange,
  didCandleWindowRoll,
  easePriceRange,
  formatPrice,
  layoutCandles,
  priceToChartY,
  selectChartCandles,
  smoothCandles,
  stepCriticallyDampedSpring,
  unusualMoveScore,
  type CandleLayout,
  type PriceRange,
  type SpringScalar,
} from './chartMath';
import { buildMedallion, type MonumentKind } from './medallions';
import {
  collidesLocalMedallionCamera,
  collidesLocalStaticCamera,
  MEDALLION_CENTER,
  PLAZA_LAYERS,
  PLAZA_STEPS,
  sampleLocalStoneGround,
} from './monumentGeometry';
import { SparklePool } from './SparklePool';
import { TickTrailPool } from './TickTrailPool';
import { HorizonBadgePanel } from './HorizonBadgePanel';
import { MONUMENT_MARKET_LABEL_LAYOUT } from './marketLabelLayout';
import {
  NewsPanel,
  type NewsInteraction,
  type NewsPanelSelection,
} from './NewsPanel';

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

export interface MonumentNewsOverlayState extends NewsPanelSelection {
  readonly symbol: AssetSymbol;
  readonly candleAnchor: Vector3;
}

export interface MonumentScreenViewport {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface MonumentChartOcclusionBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** Positive camera-space distance to the chart plane. */
  readonly depth: number;
}

/** Shared semantic colours for candles and live-order projections. */
export const MONUMENT_CANDLE_COLORS = Object.freeze({
  up: 0x8fd8a3,
  down: 0xefa09a,
} as const);

const COLORS = {
  stone: 0xb8aea0,
  stoneLight: 0xd7cec0,
  stoneDark: 0x81796f,
  cream: 0xfff1cf,
  ink: 0x31373d,
  green: MONUMENT_CANDLE_COLORS.up,
  red: MONUMENT_CANDLE_COLORS.down,
  teal: 0x5f9b91,
  bush: 0x789b72,
  flower: 0xe6a3a8,
  lamp: 0xffd487,
} as const;

export const MONUMENT_CHART_WIDTH = 14.4;
export const MONUMENT_CHART_HEIGHT = 5.75;
/** Pivot-relative offset that preserves the chart's original root-local z=3.15. */
export const MONUMENT_PRESENTATION_FORWARD_OFFSET = 3.15 - MEDALLION_CENTER.z;
export const MONUMENT_OVERLAY_RENDER_ORDER = 40;
const CHART_WIDTH = MONUMENT_CHART_WIDTH;
const CHART_HEIGHT = MONUMENT_CHART_HEIGHT;
const LIVE_MARKER_X = CHART_WIDTH * 0.5 + 0.42;
const tempObject = new Object3D();
const tempCameraPosition = new Vector3();
const tempMonumentPosition = new Vector3();
const tempLocalPoint = new Vector3();
const tempWorldPoint = new Vector3();
const tempInverseMatrix = new Matrix4();
const PRESENTATION_FACING_RESPONSE = 7.5;

interface LampBulb {
  readonly mesh: Mesh<SphereGeometry, MeshStandardMaterial>;
  readonly light: PointLight;
  readonly phase: number;
}

interface ActiveChartSpring {
  readonly openTime: number;
  bodyY: SpringScalar;
  bodyHeight: SpringScalar;
  wickY: SpringScalar;
  wickHeight: SpringScalar;
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
  readonly livePriceGuide: Mesh<BoxGeometry, MeshBasicMaterial>;
  readonly livePriceMarker: Mesh<SphereGeometry, MeshStandardMaterial>;

  private readonly presentationGroup = new Group();
  private readonly chartGroup = new Group();
  private readonly billboardGroup = new Group();
  private medallionGroup: Group | null = null;
  private readonly symbolText = new Text();
  private readonly priceText = new Text();
  private readonly sparkles = new SparklePool(24);
  private readonly tickTrail = new TickTrailPool(12);
  private readonly horizonPanel: HorizonBadgePanel | null;
  private readonly newsPanel: NewsPanel | null;
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
  private readonly flatColor = new Color(COLORS.cream);
  private readonly targetRangeFallback: PriceRange = { min: 0, max: 1 };
  private readonly occlusionCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private readonly occlusionCenter = new Vector3();

  private targetCandles: Candle[] = [];
  private displayedCandles: Candle[] = [];
  private displayedRange: PriceRange = { min: 0, max: 1 };
  private targetRange: PriceRange = this.targetRangeFallback;
  private parent: Object3D | null = null;
  private active = true;
  private disposed = false;
  private shuntProgress = 1;
  private pulseEnergy = 0;
  private markerTickEnergy = 0;
  private pulseDirection: TickDirection = 'flat';
  private lastPresentationTick = -1;
  private displayedPrice = '';
  private targetLivePrice: number | null = null;
  private displayedLivePrice: number | null = null;
  private livePriceVelocity = 0;
  private activeChartSpring: ActiveChartSpring | null = null;
  private nightFactor = 0;
  private feedMode: FeedMode = 'connecting';
  private facingInitialized = false;

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
    this.presentationGroup.name = `${this.symbol}-facing-presentation`;
    this.presentationGroup.position.set(MEDALLION_CENTER.x, 0, MEDALLION_CENTER.z);
    this.root.add(this.presentationGroup);

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
    this.greenWickInstances.renderOrder = 1;
    this.redWickInstances.renderOrder = 1;
    this.greenBodyInstances.renderOrder = 2;
    this.redBodyInstances.renderOrder = 2;

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
    this.activeBodyHighlight.renderOrder = 4;
    this.activeWickHighlight = new Mesh(wickGeometry, highlightMaterial.clone());
    this.activeWickHighlight.name = `${this.symbol}-active-wick-highlight`;
    this.activeWickHighlight.frustumCulled = false;
    this.activeWickHighlight.visible = false;
    this.activeWickHighlight.renderOrder = 3;

    this.livePriceGuide = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({
        color: COLORS.cream,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.livePriceGuide.name = `${this.symbol}-live-price-guide`;
    this.livePriceGuide.scale.set(CHART_WIDTH + 0.36, 0.04, 0.03);
    this.livePriceGuide.position.z = -0.065;
    this.livePriceGuide.visible = false;

    this.livePriceMarker = new Mesh(
      new SphereGeometry(0.16, 10, 7),
      new MeshStandardMaterial({
        color: COLORS.cream,
        emissive: COLORS.cream,
        emissiveIntensity: 0.65,
        roughness: 0.42,
      }),
    );
    this.livePriceMarker.name = `${this.symbol}-live-price-marker`;
    this.livePriceMarker.position.set(LIVE_MARKER_X, CHART_HEIGHT * 0.5, 0.045);
    this.livePriceMarker.visible = false;
    this.livePriceMarker.frustumCulled = false;
    this.livePriceMarker.renderOrder = 5;
    this.tickTrail.mesh.renderOrder = 5;
    this.sparkles.points.renderOrder = 6;

    this.chartGroup.name = `${this.symbol}-chart`;
    this.chartGroup.position.set(
      -MEDALLION_CENTER.x,
      0.9,
      MONUMENT_PRESENTATION_FORWARD_OFFSET,
    );
    this.chartGroup.add(
      this.livePriceGuide,
      this.greenWickInstances,
      this.redWickInstances,
      this.greenBodyInstances,
      this.redBodyInstances,
      this.activeWickHighlight,
      this.activeBodyHighlight,
      this.tickTrail.mesh,
      this.livePriceMarker,
      this.sparkles.points,
    );
    this.presentationGroup.add(this.chartGroup);

    this.pulseRingMaterial = new MeshBasicMaterial({
      color: COLORS.cream,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.pulseRing = new Mesh(new TorusGeometry(0.28, 0.026, 6, 28), this.pulseRingMaterial);
    this.pulseRing.position.set(LIVE_MARKER_X, CHART_HEIGHT * 0.5, 0.025);
    this.pulseRing.visible = false;
    this.pulseRing.renderOrder = 5;
    this.chartGroup.add(this.pulseRing);

    this.horizonPanel = this.kind === 'grand' ? new HorizonBadgePanel(options.fontUrl) : null;
    this.newsPanel = this.kind === 'grand' ? new NewsPanel(options.fontUrl) : null;
    if (this.newsPanel) this.chartGroup.add(this.newsPanel.root);
    this.buildShrine(options.fontUrl);
    this.configurePresentationOverlay(this.chartGroup, MONUMENT_OVERLAY_RENDER_ORDER);
    this.configurePresentationOverlay(this.billboardGroup, MONUMENT_OVERLAY_RENDER_ORDER + 1);
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
      lamp.light.visible = this.nightFactor > 0.025;
      lamp.light.intensity = this.nightFactor * this.nightFactor * 32;
    }
  }

  setNewsItems(items: readonly NewsItem[], now = Date.now()): void {
    if (this.disposed) return;
    this.newsPanel?.setItems(items, now);
  }

  getNewsInteractiveObjects(): readonly Object3D[] {
    if (!this.active || this.disposed || !this.newsPanel) return [];
    return this.newsPanel.getInteractiveObjects().filter((object) => {
      let current: Object3D | null = object;
      while (current) {
        if (!current.visible) return false;
        if (current === this.root) return true;
        current = current.parent;
      }
      return false;
    });
  }

  resolveNewsInteraction(object: Object3D | null): NewsInteraction | null {
    if (!this.active || this.disposed) return null;
    return this.newsPanel?.resolveInteraction(object) ?? null;
  }

  selectNewsItem(itemId: string): boolean {
    if (!this.active || this.disposed) return false;
    return this.newsPanel?.select(itemId) ?? false;
  }

  dismissNewsItem(itemId?: string): boolean {
    if (!this.active || this.disposed) return false;
    return this.newsPanel?.dismiss(itemId) ?? false;
  }

  getNewsOverlayState(target = new Vector3()): MonumentNewsOverlayState | null {
    if (!this.active || this.disposed || !this.newsPanel) return null;
    const selection = this.newsPanel.getSelection();
    const localAnchor = this.newsPanel.getSelectedCandleAnchor(target);
    if (!selection || !localAnchor) return null;
    this.chartGroup.localToWorld(localAnchor);
    return {
      symbol: this.symbol,
      item: selection.item,
      dismissed: selection.dismissed,
      candleAnchor: localAnchor,
    };
  }

  /** Returns a presentation-aware world point above the live chart marker. */
  getFireworkOrigin(target = new Vector3()): Vector3 {
    const liveY = this.livePriceMarker.visible
      ? this.livePriceMarker.position.y
      : CHART_HEIGHT * 0.5;
    target.set(
      // Centre the show over the price plaque instead of firing from the far
      // right live-marker edge, where portals and HUD could hide it.
      0,
      // Start just over the plaque so the first bloom is visible from the
      // default ground camera; particle velocity carries later blooms upward.
      Math.max(liveY + 2.2, CHART_HEIGHT + 1.25),
      1.5,
    );
    return this.chartGroup.localToWorld(target);
  }

  /**
   * Presentation-aware positions for pooled order projections. The primary
   * slot sits just in front of the chart's upper lane, so the first big trade
   * is visible from the spawn framing. The two smaller overflow slots form a
   * compact high band inside the chart perimeter. Keeping that band above the
   * chat/news safe areas avoids a valid market event looking absent simply
   * because it landed under a screen overlay or outside a narrow viewport.
   */
  getBigOrderHologramAnchor(slot: number, target = new Vector3()): Vector3 {
    switch (((Math.floor(slot) % 3) + 3) % 3) {
      case 0:
        // The primary callout stays centred over the upper candle lane. Keep
        // it beneath the top safe area: a whale-sized billboard otherwise
        // puts its title above the viewport in the default spawn camera.
        target.set(0, 3.15, MONUMENT_PRESENTATION_FORWARD_OFFSET + 0.72);
        break;
      case 1:
        target.set(-5.05, 3.55, MONUMENT_PRESENTATION_FORWARD_OFFSET + 0.56);
        break;
      default:
        target.set(5.05, 3.55, MONUMENT_PRESENTATION_FORWARD_OFFSET + 0.56);
        break;
    }
    return this.presentationGroup.localToWorld(target);
  }

  /** Camera-projected chart/price bounds used only by social overlay fading. */
  getChartOcclusionBounds(
    camera: Camera,
    viewport: MonumentScreenViewport,
  ): MonumentChartOcclusionBounds | null {
    if (!this.active || this.disposed || viewport.width <= 0 || viewport.height <= 0) return null;
    this.presentationGroup.updateWorldMatrix(true, true);
    camera.updateWorldMatrix(true, false);

    const minX = -CHART_WIDTH * 0.5 - 0.55;
    const maxX = CHART_WIDTH * 0.5 + 0.95;
    const minY = 0.72;
    const maxY = 9.15;
    const localZ = MONUMENT_PRESENTATION_FORWARD_OFFSET;
    const coordinates = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] as const;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < coordinates.length; index += 1) {
      const [x, y] = coordinates[index]!;
      const corner = this.occlusionCorners[index]!;
      corner.set(x, y, localZ).applyMatrix4(this.presentationGroup.matrixWorld);
      if (tempWorldPoint.copy(corner).applyMatrix4(camera.matrixWorldInverse).z >= 0) return null;
      corner.project(camera);
      const screenX = viewport.left + (corner.x + 1) * 0.5 * viewport.width;
      const screenY = viewport.top + (1 - corner.y) * 0.5 * viewport.height;
      left = Math.min(left, screenX);
      right = Math.max(right, screenX);
      top = Math.min(top, screenY);
      bottom = Math.max(bottom, screenY);
    }

    this.occlusionCenter
      .set((minX + maxX) * 0.5, (minY + maxY) * 0.5, localZ)
      .applyMatrix4(this.presentationGroup.matrixWorld)
      .applyMatrix4(camera.matrixWorldInverse);
    return { left, top, right, bottom, depth: Math.max(0, -this.occlusionCenter.z) };
  }

  setAssetState(state: AssetState): void {
    if (state.symbol !== this.symbol || this.disposed) {
      return;
    }

    this.feedMode = state.mode;
    this.horizonPanel?.setChanges(state.horizonChanges);
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
    const latestClose = nextCandles.at(-1)?.close;
    this.targetLivePrice = latestClose !== undefined && Number.isFinite(latestClose)
      ? latestClose
      : null;
    if (this.displayedLivePrice === null && this.targetLivePrice !== null) {
      this.displayedLivePrice = this.targetLivePrice;
      this.livePriceVelocity = 0;
    }
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
      this.pulseDirection = state.direction;
      this.pulseEnergy = Math.max(this.pulseEnergy, state.direction === 'flat' ? 0.68 : 1);
      this.markerTickEnergy = 1;
      if (this.targetLivePrice !== null) {
        this.tickTrail.emit(this.targetLivePrice, state.direction);
      }
      if (this.lastPresentationTick >= 0 && state.direction !== 'flat') {
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
    const candleLayouts = this.updateChartInstances(delta);
    this.updatePulse(delta, elapsedSeconds);
    this.updateLivePrice(delta, elapsedSeconds);
    this.tickTrail.update(delta, this.displayedRange, CHART_HEIGHT, LIVE_MARKER_X);
    this.sparkles.update(delta);
    this.horizonPanel?.update(elapsedSeconds, Date.now(), this.feedMode);
    this.newsPanel?.update(candleLayouts, Date.now());

    for (const lamp of this.lamps) {
      const shimmer = 1 + Math.sin(elapsedSeconds * 1.7 + lamp.phase) * 0.025 * this.nightFactor;
      lamp.mesh.scale.setScalar(shimmer);
      lamp.light.intensity = this.nightFactor * this.nightFactor * 32 * shimmer;
    }

    if (camera) {
      this.updateBillboard(camera, delta);
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
    this.root.updateWorldMatrix(true, true);
    tempInverseMatrix.copy(this.root.matrixWorld).invert();
    tempLocalPoint.set(worldX, worldY, worldZ).applyMatrix4(tempInverseMatrix);
    if (collidesLocalStaticCamera(tempLocalPoint.x, tempLocalPoint.y, tempLocalPoint.z)) {
      return true;
    }

    // The crest turns independently of the fixed plinth and plaza. Probe it
    // in its current rotated local space so camera collision follows what is
    // actually visible instead of lingering at the shrine's initial heading.
    if (!this.medallionGroup) {
      return false;
    }
    tempInverseMatrix.copy(this.medallionGroup.matrixWorld).invert();
    tempLocalPoint.set(worldX, worldY, worldZ).applyMatrix4(tempInverseMatrix);
    return collidesLocalMedallionCamera(tempLocalPoint.x, tempLocalPoint.y, tempLocalPoint.z);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unmount();

    if (this.horizonPanel) {
      this.horizonPanel.root.removeFromParent();
      this.horizonPanel.dispose();
    }
    if (this.newsPanel) {
      this.newsPanel.root.removeFromParent();
      this.newsPanel.dispose();
    }

    const geometries = new Set<{ dispose(): void }>();
    const materials = new Set<Material>();
    this.root.traverse((object) => {
      if (
        object === this.symbolText
        || object === this.priceText
        || object === this.sparkles.points
        || object === this.tickTrail.mesh
      ) {
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
    this.tickTrail.dispose();
    this.root.clear();
  }

  get activeTickBeadCount(): number {
    return this.tickTrail.activeCount;
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
    const medallion = buildMedallion(this.symbol, this.kind);
    this.medallionGroup = medallion;
    const plinth = medallion.getObjectByName(`${this.symbol.toLowerCase()}-medallion-plinth`);
    if (plinth) {
      plinth.removeFromParent();
      this.root.add(plinth);
    }
    // Medallion geometry is authored in monument-local coordinates. Offset it
    // into the facing pivot without changing its initial world placement. The
    // heavy plinth stays fixed, while only the crest turns toward the player.
    medallion.position.set(-MEDALLION_CENTER.x, 0, -MEDALLION_CENTER.z);
    this.presentationGroup.add(medallion);
    const card = new Mesh(
      new RoundedBoxGeometry(1, 1, 1, 3, 0.14),
      this.priceCardMaterial,
    );
    card.name = `${this.symbol}-price-card`;
    card.scale.set(
      this.kind === 'echo'
        ? MONUMENT_MARKET_LABEL_LAYOUT.echoCardWidth
        : MONUMENT_MARKET_LABEL_LAYOUT.grandCardWidth,
      this.kind === 'echo'
        ? MONUMENT_MARKET_LABEL_LAYOUT.echoCardHeight
        : MONUMENT_MARKET_LABEL_LAYOUT.grandCardHeight,
      0.12,
    );
    card.position.z = -0.1;
    card.castShadow = true;
    this.billboardGroup.name = `${this.symbol}-market-ui`;
    this.billboardGroup.position.set(
      -MEDALLION_CENTER.x,
      MONUMENT_MARKET_LABEL_LAYOUT.centerY,
      MONUMENT_PRESENTATION_FORWARD_OFFSET,
    );
    this.billboardGroup.add(card);

    this.symbolText.name = `${this.symbol}-symbol-label`;
    this.symbolText.text = this.symbol;
    this.symbolText.fontSize = this.kind === 'echo'
      ? MONUMENT_MARKET_LABEL_LAYOUT.echoSymbolFontSize
      : MONUMENT_MARKET_LABEL_LAYOUT.symbolFontSize;
    this.symbolText.color = COLORS.cream;
    this.symbolText.anchorX = 'center';
    this.symbolText.anchorY = 'middle';
    this.symbolText.textAlign = 'center';
    this.symbolText.whiteSpace = 'nowrap';
    this.symbolText.outlineWidth = '2%';
    this.symbolText.outlineColor = COLORS.ink;
    this.symbolText.outlineOpacity = 0.48;
    this.symbolText.depthOffset = -2;
    this.symbolText.renderOrder = 4;
    if (fontUrl) this.symbolText.font = fontUrl;
    this.symbolText.position.set(0, MONUMENT_MARKET_LABEL_LAYOUT.symbolY, 0.02);
    if (typeof self !== 'undefined') this.symbolText.sync();
    this.billboardGroup.add(this.symbolText);

    this.priceText.name = `${this.symbol}-price-text`;
    this.priceText.text = '$—';
    this.priceText.fontSize = this.kind === 'echo'
      ? MONUMENT_MARKET_LABEL_LAYOUT.echoPriceFontSize
      : MONUMENT_MARKET_LABEL_LAYOUT.priceFontSize;
    this.priceText.color = COLORS.cream;
    this.priceText.anchorX = 'center';
    this.priceText.anchorY = 'middle';
    this.priceText.textAlign = 'center';
    this.priceText.whiteSpace = 'nowrap';
    this.priceText.outlineWidth = '2%';
    this.priceText.outlineColor = COLORS.ink;
    this.priceText.outlineOpacity = 0.55;
    this.priceText.depthOffset = -2;
    this.priceText.renderOrder = 4;
    if (fontUrl) {
      this.priceText.font = fontUrl;
    }
    this.priceText.position.set(0, MONUMENT_MARKET_LABEL_LAYOUT.priceY, 0.02);
    if (typeof self !== 'undefined') {
      this.priceText.sync();
    }
    this.billboardGroup.add(this.priceText);
    if (this.horizonPanel) this.billboardGroup.add(this.horizonPanel.root);
    this.presentationGroup.add(this.billboardGroup);
  }

  private buildFurniture(): void {
    const woodMaterial = new MeshStandardMaterial({ color: 0x9e735e, roughness: 0.88 });
    const metalMaterial = new MeshStandardMaterial({ color: COLORS.ink, roughness: 0.7 });
    const seatGeometry = new RoundedBoxGeometry(3.2, 0.25, 0.78, 2, 0.1);
    const backGeometry = new RoundedBoxGeometry(3.2, 0.72, 0.22, 2, 0.08);
    const legGeometry = new BoxGeometry(0.18, 0.72, 0.18);

    for (const side of [-1, 1]) {
      const bench = new Group();
      bench.name = `${this.symbol}-bench-${side < 0 ? 'left' : 'right'}`;
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
      bench.position.set(side * 6.95, 0, 0.35);
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
      [-8.4, 4.8],
      [8.4, 4.8],
    ];
    lampPositions.forEach(([x, z], index) => {
      const pole = new Mesh(poleGeometry, metalMaterial);
      pole.name = `${this.symbol}-lamp-pole-${index + 1}`;
      pole.position.set(x, 2.23, z);
      pole.castShadow = true;
      const bulb = new Mesh(bulbGeometry, bulbMaterial.clone());
      bulb.name = `${this.symbol}-lamp-bulb-${index + 1}`;
      bulb.position.set(x, 4.02, z);
      const shade = new Mesh(shadeGeometry, metalMaterial);
      shade.name = `${this.symbol}-lamp-shade-${index + 1}`;
      shade.position.set(x, 4.38, z);
      shade.castShadow = true;
      const light = new PointLight(COLORS.lamp, 0, 13, 2);
      light.name = `${this.symbol}-lamp-light-${index + 1}`;
      light.position.copy(bulb.position);
      light.visible = false;
      this.root.add(pole, bulb, shade, light);
      this.lamps.push({ mesh: bulb, light, phase: index * 1.7 });
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
      [-6.15, 2.0],
      [6.15, 2.0],
      [-7.1, -0.6],
      [7.1, -0.6],
    ];

    positions.forEach(([x, z], index) => {
      const pot = new Mesh(potGeometry, potMaterial);
      pot.name = `${this.symbol}-planter-${index + 1}`;
      pot.position.set(x, 1.12, z);
      const bush = new Mesh(bushGeometry, bushMaterial);
      bush.name = `${this.symbol}-bush-${index + 1}`;
      bush.position.set(x, 1.85, z);
      bush.scale.y = 0.84;
      const flower = new Mesh(flowerGeometry, flowerMaterial);
      flower.name = `${this.symbol}-flower-${index + 1}`;
      const angle = index * 1.9;
      flower.position.set(x + Math.cos(angle) * 0.52, 2.25, z + Math.sin(angle) * 0.4);
      for (const mesh of [pot, bush, flower]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.root.add(mesh);
      }
    });
  }

  /**
   * The market display is a magical HUD-like projection in the 3D world. It
   * keeps its familiar scale and position, but always draws over plaza props
   * that cross its sightline while the shrine turns toward the camera.
   */
  private configurePresentationOverlay(root: Object3D, renderOrder: number): void {
    root.traverse((object) => {
      object.renderOrder += renderOrder;
      if (!(object instanceof Mesh) && !(object instanceof Points)) {
        return;
      }
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of objectMaterials) {
        material.depthTest = false;
        material.depthWrite = false;
        material.needsUpdate = true;
      }
    });
  }

  private updateChartInstances(deltaSeconds: number): CandleLayout[] {
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
    const targetLayouts = layoutCandles(
      this.targetCandles,
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
      const targetLayout = isLatest ? targetLayouts.at(-1) : undefined;
      const visualLayout = targetLayout
        ? this.stepActiveChartSpring(targetLayout, deltaSeconds)
        : layout;
      const bodyPool = visualLayout.isUp ? this.greenBodyInstances : this.redBodyInstances;
      const wickPool = visualLayout.isUp ? this.greenWickInstances : this.redWickInstances;
      const poolIndex = visualLayout.isUp ? greenCount++ : redCount++;
      const activeSwell = isLatest ? 1 + this.markerTickEnergy * 0.1 : 1;

      tempObject.position.set(layout.x, visualLayout.bodyY, 0);
      tempObject.rotation.set(0, 0, 0);
      tempObject.scale.set(spacing * 0.68 * activeSwell, visualLayout.bodyHeight, 0.44 * activeSwell);
      tempObject.updateMatrix();
      bodyPool.setMatrixAt(poolIndex, tempObject.matrix);

      tempObject.position.set(layout.x, visualLayout.wickY, 0);
      tempObject.scale.set(1 + (activeSwell - 1) * 0.35, visualLayout.wickHeight, 1);
      tempObject.updateMatrix();
      wickPool.setMatrixAt(poolIndex, tempObject.matrix);

      if (isLatest) {
        this.activeBodyHighlight.position.set(layout.x, visualLayout.bodyY, 0.005);
        this.activeBodyHighlight.scale.set(
          spacing * 0.76 * activeSwell,
          visualLayout.bodyHeight + 0.055,
          0.49 * activeSwell,
        );
        this.activeBodyHighlight.visible = true;
        this.activeWickHighlight.position.set(layout.x, visualLayout.wickY, 0.005);
        this.activeWickHighlight.scale.set(1.12, visualLayout.wickHeight + 0.04, 1.12);
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
    return layouts;
  }

  private updatePulse(deltaSeconds: number, elapsedSeconds: number): void {
    this.pulseEnergy = Math.max(0, this.pulseEnergy - deltaSeconds * 1.9);
    this.markerTickEnergy = Math.max(0, this.markerTickEnergy - deltaSeconds * 1.45);
    const color = this.pulseDirection === 'down'
      ? this.downColor
      : this.pulseDirection === 'up'
        ? this.upColor
        : this.flatColor;
    this.greenBodyInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.08;
    this.greenWickInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.05;
    this.redBodyInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.08;
    this.redWickInstances.material.emissiveIntensity = 0.08 + this.pulseEnergy * 0.05;
    this.activeBodyHighlight.material.opacity = 0.2 + this.pulseEnergy * 0.22;
    this.activeWickHighlight.material.opacity = 0.18 + this.pulseEnergy * 0.18;
    this.priceCardMaterial.emissive.copy(color);
    this.priceCardMaterial.emissiveIntensity = this.pulseEnergy * 0.15;
    this.livePriceMarker.material.color.copy(color);
    this.livePriceMarker.material.emissive.copy(color);
    this.livePriceMarker.material.emissiveIntensity = 0.5 + this.markerTickEnergy * 1.15;
    const breathing = 1 + Math.sin(elapsedSeconds * 4.2) * 0.08;
    this.livePriceMarker.scale.setScalar(breathing + this.markerTickEnergy * 0.24);
    this.livePriceGuide.material.color.copy(color);
    this.livePriceGuide.material.opacity = 0.15 + this.markerTickEnergy * 0.2;

    if (this.pulseEnergy > 0.01) {
      this.pulseRing.visible = true;
      this.pulseRingMaterial.color.copy(color);
      this.pulseRingMaterial.opacity = this.pulseEnergy * 0.52;
      this.pulseRing.scale.setScalar(1 + (1 - this.pulseEnergy) * 1.7);
    } else {
      this.pulseRing.visible = false;
      this.pulseRingMaterial.opacity = 0;
    }
  }

  private stepActiveChartSpring(target: CandleLayout, deltaSeconds: number): CandleLayout {
    if (!this.activeChartSpring || this.activeChartSpring.openTime !== target.candle.openTime) {
      this.activeChartSpring = {
        openTime: target.candle.openTime,
        bodyY: { value: target.bodyY, velocity: 0 },
        bodyHeight: { value: target.bodyHeight, velocity: 0 },
        wickY: { value: target.wickY, velocity: 0 },
        wickHeight: { value: target.wickHeight, velocity: 0 },
      };
    } else {
      this.activeChartSpring.bodyY = stepCriticallyDampedSpring(
        this.activeChartSpring.bodyY,
        target.bodyY,
        deltaSeconds,
        0.19,
      );
      this.activeChartSpring.bodyHeight = stepCriticallyDampedSpring(
        this.activeChartSpring.bodyHeight,
        target.bodyHeight,
        deltaSeconds,
        0.19,
      );
      this.activeChartSpring.wickY = stepCriticallyDampedSpring(
        this.activeChartSpring.wickY,
        target.wickY,
        deltaSeconds,
        0.22,
      );
      this.activeChartSpring.wickHeight = stepCriticallyDampedSpring(
        this.activeChartSpring.wickHeight,
        target.wickHeight,
        deltaSeconds,
        0.22,
      );
    }

    return {
      ...target,
      bodyY: this.activeChartSpring.bodyY.value,
      bodyHeight: this.activeChartSpring.bodyHeight.value,
      wickY: this.activeChartSpring.wickY.value,
      wickHeight: this.activeChartSpring.wickHeight.value,
    };
  }

  private updateLivePrice(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.targetLivePrice === null) {
      this.livePriceGuide.visible = false;
      this.livePriceMarker.visible = false;
      this.pulseRing.visible = false;
      return;
    }

    if (this.displayedLivePrice === null) {
      this.displayedLivePrice = this.targetLivePrice;
      this.livePriceVelocity = 0;
    } else {
      const next = stepCriticallyDampedSpring(
        { value: this.displayedLivePrice, velocity: this.livePriceVelocity },
        this.targetLivePrice,
        deltaSeconds,
        0.18,
      );
      this.displayedLivePrice = next.value;
      this.livePriceVelocity = next.velocity;
    }

    const y = priceToChartY(this.displayedLivePrice, this.displayedRange, CHART_HEIGHT);
    this.livePriceGuide.position.y = y;
    this.livePriceMarker.position.y = y;
    this.pulseRing.position.y = y;
    this.livePriceGuide.visible = true;
    this.livePriceMarker.visible = true;
    if (this.pulseEnergy > 0.01) {
      this.pulseRing.visible = true;
    }

    // A barely perceptible guide shimmer keeps the live lane legible without
    // suggesting any price movement between actual feed presentations.
    this.livePriceGuide.scale.y = 0.04 * (1 + Math.sin(elapsedSeconds * 2.4) * 0.1);
  }

  private updateBillboard(camera: Camera, deltaSeconds: number): void {
    camera.getWorldPosition(tempCameraPosition);
    this.root.updateWorldMatrix(true, false);
    tempInverseMatrix.copy(this.root.matrixWorld).invert();
    tempLocalPoint.copy(tempCameraPosition).applyMatrix4(tempInverseMatrix);

    const targetYaw = Math.atan2(
      tempLocalPoint.x - this.presentationGroup.position.x,
      tempLocalPoint.z - this.presentationGroup.position.z,
    );
    if (!this.facingInitialized) {
      this.presentationGroup.rotation.y = targetYaw;
      this.facingInitialized = true;
    } else {
      const difference = Math.atan2(
        Math.sin(targetYaw - this.presentationGroup.rotation.y),
        Math.cos(targetYaw - this.presentationGroup.rotation.y),
      );
      const blend = 1 - Math.exp(-PRESENTATION_FACING_RESPONSE * deltaSeconds);
      this.presentationGroup.rotation.y += difference * blend;
    }

    // The whole shrine presentation shares a yaw-only pivot. Keeping the
    // nested UI neutral prevents double-facing and any pitch/roll tilt.
    this.presentationGroup.rotation.x = 0;
    this.presentationGroup.rotation.z = 0;
    this.billboardGroup.rotation.set(0, 0, 0);
  }
}
