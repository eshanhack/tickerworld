import { Camera, Group, Object3D, Vector3 } from 'three';
import type { AssetState, AssetSymbol, GameSystem } from '../types';
import { Monument, type MonumentOptions } from './Monument';

export interface MonumentSystemOptions {
  parent: Object3D;
  camera: Camera;
  fontUrl?: string;
}

export interface NearestMonument {
  monument: Monument;
  distance: number;
}

export class MonumentSystem implements GameSystem {
  readonly root = new Group();

  private readonly monuments = new Set<Monument>();
  private camera: Camera;
  private readonly fontUrl?: string;
  private visible = true;
  private disposed = false;
  private nightFactor = 0;

  constructor(options: MonumentSystemOptions) {
    this.camera = options.camera;
    this.fontUrl = options.fontUrl;
    this.root.name = 'tickerworld-monuments';
    options.parent.add(this.root);
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

  setCamera(camera: Camera): void {
    this.camera = camera;
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
    for (const monument of this.monuments) {
      monument.dispose();
    }
    this.monuments.clear();
    this.root.removeFromParent();
    this.root.clear();
  }
}
