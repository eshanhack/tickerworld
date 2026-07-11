import { Camera, Group, Object3D, Raycaster, Vector2, Vector3 } from 'three';
import type { NewsItem } from '../news';
import type { AssetState, AssetSymbol, GameSystem } from '../types';
import { Monument, type MonumentOptions } from './Monument';

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
}

export interface NearestMonument {
  monument: Monument;
  distance: number;
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

  private readonly monuments = new Set<Monument>();
  private camera: Camera;
  private readonly fontUrl?: string;
  private readonly domElement: HTMLElement | null;
  private readonly openWindow: NewsWindowOpener | null;
  private readonly interactionDragThreshold: number;
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly projectedPoint = new Vector3();
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
    this.openWindow = options.openWindow ?? (
      typeof window === 'undefined'
        ? null
        : (url, target, features) => window.open(url, target, features)
    );
    this.interactionDragThreshold = Math.max(0, options.interactionDragThreshold ?? 7);
    this.root.name = 'tickerworld-monuments';
    options.parent.add(this.root);
    this.attachInteractionListeners();
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

  getForSymbol(symbol: AssetSymbol): readonly Monument[] {
    return [...this.monuments].filter((monument) => monument.symbol === symbol);
  }

  getAll(): readonly Monument[] {
    return [...this.monuments];
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

  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  /** Activates the top-most news card/pin at a canvas client coordinate. */
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
    if (interaction.action === 'select') return monument.selectNewsItem(interaction.itemId);
    if (!interaction.url || !isSafeNewsPermalink(interaction.url)) return false;
    this.openWindow?.(interaction.url, '_blank', 'noopener,noreferrer');
    return true;
  }
}
