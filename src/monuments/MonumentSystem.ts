import { Camera, Group, Object3D, Raycaster, Vector2, Vector3 } from 'three';
import type { NewsItem } from '../news';
import type { AssetState, AssetSymbol, GameSystem } from '../types';
import {
  BigOrderHologramSystem,
  type BigOrderHologramEvent,
  type BigOrderHologramShowResult,
} from './BigOrderHologramSystem';
import {
  Monument,
  type MonumentChartOcclusionBounds,
  type MonumentNewsOverlayState,
  type MonumentOptions,
  type MonumentScreenViewport,
} from './Monument';

export type NewsWindowOpener = (
  url: string,
  target: '_blank',
  features: 'noopener,noreferrer',
) => unknown;

export interface MonumentSystemOptions {
  parent: Object3D;
  camera: Camera;
  fontUrl?: string;
  domElement?: HTMLElement;
  openWindow?: NewsWindowOpener;
  interactionDragThreshold?: number;
  /** Disable the built-in click listener when a shared canvas coordinator owns picking. */
  attachInteractionListeners?: boolean;
  reducedMotion?: boolean;
}

export interface NearestMonument {
  monument: Monument;
  distance: number;
}

export interface NearestNewsOverlay extends MonumentNewsOverlayState {
  readonly monument: Monument;
  readonly distance: number;
}

export interface MonumentGroundSample {
  height: number;
  surface: 'stone';
}

interface PointerGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startedAt: number;
  maxDistanceSquared: number;
}

interface NewsPickTarget {
  readonly monument: Monument;
  readonly object: Object3D;
}

export function isSafeNewsPermalink(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      hostname === 'x.com'
      || hostname.endsWith('.x.com')
      || hostname === 'twitter.com'
      || hostname.endsWith('.twitter.com')
      || hostname === 't.co'
    );
  } catch {
    return false;
  }
}

export class MonumentSystem implements GameSystem {
  readonly root = new Group();
  readonly bigOrderHolograms: BigOrderHologramSystem;

  private readonly monuments = new Set<Monument>();
  private camera: Camera;
  private readonly fontUrl?: string;
  private readonly domElement: HTMLElement | null;
  private readonly interactionDragThreshold: number;
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly projectedPoint = new Vector3();
  private readonly newsCandidateAnchor = new Vector3();
  private readonly newsResultAnchor = new Vector3();
  private newsItems: NewsItem[] = [];
  private newsItemsTimestamp = 0;
  private pointerGesture: PointerGesture | null = null;
  private visible = true;
  private disposed = false;
  private nightFactor = 0;

  constructor(options: MonumentSystemOptions) {
    this.camera = options.camera;
    this.fontUrl = options.fontUrl;
    this.domElement = options.domElement ?? null;
    this.interactionDragThreshold = Math.max(0, options.interactionDragThreshold ?? 7);
    this.root.name = 'tickerworld-monuments';
    options.parent.add(this.root);
    this.bigOrderHolograms = new BigOrderHologramSystem({
      parent: this.root,
      camera: this.camera,
      fontUrl: this.fontUrl,
      reducedMotion: options.reducedMotion,
    });
    if (options.attachInteractionListeners !== false) this.attachInteractionListeners();
  }

  add(options: MonumentOptions): Monument {
    if (this.disposed) {
      throw new Error('Cannot add a monument to a disposed MonumentSystem.');
    }
    const monument = new Monument({
      ...options,
      fontUrl: options.fontUrl ?? this.fontUrl,
    });
    monument.setNightFactor(this.nightFactor);
    if (monument.discoverable && this.newsItems.length > 0) {
      monument.setNewsItems(this.newsItems, this.newsItemsTimestamp);
    }
    monument.mount(this.root);
    this.monuments.add(monument);
    return monument;
  }

  remove(monument: Monument, dispose = true): boolean {
    if (!this.monuments.delete(monument)) {
      return false;
    }
    if (dispose) {
      monument.dispose();
    } else {
      monument.unmount();
    }
    return true;
  }

  updateAsset(state: AssetState): void {
    for (const monument of this.monuments) {
      if (monument.symbol === state.symbol) {
        monument.setAssetState(state);
      }
    }
  }

  setNewsItems(items: readonly NewsItem[], now = Date.now()): void {
    if (this.disposed) return;
    this.newsItems = [...items];
    this.newsItemsTimestamp = now;
    for (const monument of this.monuments) {
      if (monument.discoverable) monument.setNewsItems(this.newsItems, now);
    }
  }

  getNearestNewsOverlay(
    point: Vector3,
    maxDistance = 48,
  ): NearestNewsOverlay | null {
    let nearest: NearestNewsOverlay | null = null;
    for (const monument of this.monuments) {
      if (!monument.discoverable) continue;
      const distance = monument.nearestDistance(point);
      if (distance > maxDistance || (nearest && distance >= nearest.distance)) continue;
      const state = monument.getNewsOverlayState(this.newsCandidateAnchor);
      if (!state) continue;
      this.newsResultAnchor.copy(state.candleAnchor);
      nearest = {
        ...state,
        candleAnchor: this.newsResultAnchor,
        monument,
        distance,
      };
    }
    return nearest;
  }

  /** Minimizes the current post to its pins at every grand monument. */
  dismissNewsOverlay(itemId: string): boolean {
    let dismissed = false;
    for (const monument of this.monuments) {
      if (monument.discoverable) {
        dismissed = monument.dismissNewsItem(itemId) || dismissed;
      }
    }
    return dismissed;
  }

  /** Selects one candle-linked post at every grand presentation of its market. */
  selectNewsItem(itemId: string): boolean {
    let selected = false;
    for (const monument of this.monuments) {
      if (monument.discoverable) selected = monument.selectNewsItem(itemId) || selected;
    }
    return selected;
  }

  getForSymbol(symbol: AssetSymbol): readonly Monument[] {
    return [...this.monuments].filter((monument) => monument.symbol === symbol);
  }

  getAll(): readonly Monument[] {
    return [...this.monuments];
  }

  /** Shows a qualifying order beside its grand chart. */
  showBigOrder(order: BigOrderHologramEvent): BigOrderHologramShowResult | null {
    for (const monument of this.monuments) {
      if (monument.symbol === order.symbol && monument.discoverable) {
        return this.bigOrderHolograms.show(order, monument);
      }
    }
    return null;
  }

  /** Clears active order projections before switching market rooms. */
  clearBigOrders(): void {
    this.bigOrderHolograms.clear();
  }

  getBigOrderHologramAudioPosition(target = new Vector3()): Vector3 | null {
    return this.bigOrderHolograms.getLatestWorldPosition(target);
  }

  nearestTo(
    point: Vector3,
    maxDistance = Number.POSITIVE_INFINITY,
    discoverableOnly = false,
  ): NearestMonument | null {
    let nearest: NearestMonument | null = null;
    for (const monument of this.monuments) {
      if (discoverableOnly && !monument.discoverable) {
        continue;
      }
      const distance = monument.nearestDistance(point);
      if (distance <= maxDistance && (!nearest || distance < nearest.distance)) {
        nearest = { monument, distance };
      }
    }
    return nearest;
  }

  sampleGround(x: number, z: number): MonumentGroundSample | null {
    let highest: MonumentGroundSample | null = null;
    for (const monument of this.monuments) {
      const sample = monument.sampleGround(x, z);
      if (sample && (!highest || sample.height > highest.height)) highest = sample;
    }
    return highest;
  }

  collidesCamera(x: number, y: number, z: number): boolean {
    for (const monument of this.monuments) {
      if (monument.collidesCamera(x, y, z)) return true;
    }
    return false;
  }

  getChartOcclusionBounds(
    viewport: MonumentScreenViewport,
  ): MonumentChartOcclusionBounds | null {
    for (const monument of this.monuments) {
      if (!monument.discoverable) continue;
      const bounds = monument.getChartOcclusionBounds(this.camera, viewport);
      if (bounds) return bounds;
    }
    return null;
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.bigOrderHolograms.setCamera(camera);
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.bigOrderHolograms.setReducedMotion(reducedMotion);
  }

  /** Activates the top-most candle news pin at a canvas client coordinate. */
  activateNewsAt(clientX: number, clientY: number): boolean {
    if (!this.visible || this.disposed || !this.domElement) return false;
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const targets = this.collectNewsTargets();
    if (targets.length === 0) return false;
    this.root.updateWorldMatrix(true, true);
    this.camera.updateWorldMatrix(true, false);
    this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    const owners = new Map(targets.map(({ object, monument }) => [object, monument]));
    const intersections = this.raycaster.intersectObjects(
      targets.map(({ object }) => object),
      false,
    );
    for (const intersection of intersections) {
      const monument = owners.get(intersection.object);
      if (monument && this.activateNewsObject(monument, intersection.object)) return true;
    }

    // The candle pins are deliberately tiny. Give them a restrained CSS-pixel
    // tap halo without making the visible marker or its link line any larger.
    const tapRadius = Math.max(12, this.interactionDragThreshold * 1.8);
    let nearest: NewsPickTarget | null = null;
    let nearestDistanceSquared = tapRadius * tapRadius;
    for (const target of targets) {
      if (!target.object.name.startsWith('news-pin-hit-')) continue;
      target.object.getWorldPosition(this.projectedPoint);
      this.projectedPoint.project(this.camera);
      if (this.projectedPoint.z < -1 || this.projectedPoint.z > 1) continue;
      const screenX = rect.left + (this.projectedPoint.x + 1) * 0.5 * rect.width;
      const screenY = rect.top + (1 - this.projectedPoint.y) * 0.5 * rect.height;
      const distanceSquared = (screenX - clientX) ** 2 + (screenY - clientY) ** 2;
      if (distanceSquared <= nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearest = target;
      }
    }
    return nearest ? this.activateNewsObject(nearest.monument, nearest.object) : false;
  }

  setNightFactor(factor: number): void {
    this.nightFactor = Math.min(1, Math.max(0, factor));
    for (const monument of this.monuments) {
      monument.setNightFactor(this.nightFactor);
    }
  }

  update(deltaSeconds: number, elapsedSeconds: number): void {
    if (!this.visible || this.disposed) {
      return;
    }
    for (const monument of this.monuments) {
      monument.update(deltaSeconds, elapsedSeconds, this.camera);
    }
    this.bigOrderHolograms.update(deltaSeconds, elapsedSeconds);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachInteractionListeners();
    this.pointerGesture = null;
    this.newsItems = [];
    this.bigOrderHolograms.dispose();
    for (const monument of this.monuments) {
      monument.dispose();
    }
    this.monuments.clear();
    this.root.removeFromParent();
    this.root.clear();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.disposed || event.button !== 0 || event.isPrimary === false) return;
    this.pointerGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: event.timeStamp,
      maxDistanceSquared: 0,
    };
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distanceSquared = (event.clientX - gesture.startX) ** 2
      + (event.clientY - gesture.startY) ** 2;
    gesture.maxDistanceSquared = Math.max(gesture.maxDistanceSquared, distanceSquared);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.handlePointerMove(event);
    this.pointerGesture = null;
    const elapsed = Math.max(0, event.timeStamp - gesture.startedAt);
    if (
      elapsed <= 1_000
      && gesture.maxDistanceSquared <= this.interactionDragThreshold ** 2
    ) {
      this.activateNewsAt(event.clientX, event.clientY);
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerGesture?.pointerId === event.pointerId) this.pointerGesture = null;
  };

  private attachInteractionListeners(): void {
    this.domElement?.addEventListener('pointerdown', this.handlePointerDown);
    this.domElement?.addEventListener('pointermove', this.handlePointerMove);
    this.domElement?.addEventListener('pointerup', this.handlePointerUp);
    this.domElement?.addEventListener('pointercancel', this.handlePointerCancel);
    this.domElement?.addEventListener('pointerleave', this.handlePointerCancel);
  }

  private detachInteractionListeners(): void {
    this.domElement?.removeEventListener('pointerdown', this.handlePointerDown);
    this.domElement?.removeEventListener('pointermove', this.handlePointerMove);
    this.domElement?.removeEventListener('pointerup', this.handlePointerUp);
    this.domElement?.removeEventListener('pointercancel', this.handlePointerCancel);
    this.domElement?.removeEventListener('pointerleave', this.handlePointerCancel);
  }

  private collectNewsTargets(): NewsPickTarget[] {
    const targets: NewsPickTarget[] = [];
    for (const monument of this.monuments) {
      if (!monument.discoverable) continue;
      for (const object of monument.getNewsInteractiveObjects()) {
        targets.push({ monument, object });
      }
    }
    return targets;
  }

  private activateNewsObject(monument: Monument, object: Object3D): boolean {
    const interaction = monument.resolveNewsInteraction(object);
    if (!interaction) return false;
    return monument.selectNewsItem(interaction.itemId);
  }
}
