import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  SphereGeometry,
} from 'three';
import type { TickDirection } from '../types';
import { priceToChartY, type PriceRange } from './chartMath';

interface TickBead {
  active: boolean;
  age: number;
  readonly duration: number;
  price: number;
  direction: TickDirection;
}

const COLORS = {
  up: new Color(0x9fe3b2),
  down: new Color(0xf5aaa4),
  flat: new Color(0xffedc4),
} as const;

const tempObject = new Object3D();

/** A fixed-size, allocation-free trail driven only by received market ticks. */
export class TickTrailPool {
  readonly mesh: InstancedMesh<SphereGeometry, MeshBasicMaterial>;

  private readonly beads: TickBead[];
  private cursor = 0;
  private disposed = false;

  constructor(readonly capacity = 12) {
    const geometry = new SphereGeometry(1, 7, 5);
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new InstancedMesh(geometry, material, Math.max(1, capacity));
    this.mesh.name = 'live-market-tick-trail';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.beads = Array.from({ length: Math.max(1, capacity) }, () => ({
      active: false,
      age: 0,
      duration: 0.92,
      price: 0,
      direction: 'flat' as const,
    }));
  }

  get activeCount(): number {
    return this.beads.reduce((count, bead) => count + Number(bead.active), 0);
  }

  emit(price: number, direction: TickDirection): boolean {
    if (this.disposed || !Number.isFinite(price)) {
      return false;
    }
    const bead = this.beads[this.cursor];
    if (!bead) {
      return false;
    }
    bead.active = true;
    bead.age = 0;
    bead.price = price;
    bead.direction = direction;
    this.cursor = (this.cursor + 1) % this.beads.length;
    return true;
  }

  update(
    deltaSeconds: number,
    range: PriceRange,
    chartHeight: number,
    markerX: number,
  ): void {
    if (this.disposed) {
      return;
    }
    const delta = Math.min(0.1, Math.max(0, deltaSeconds));
    let instanceIndex = 0;

    for (const bead of this.beads) {
      if (!bead.active) {
        continue;
      }
      bead.age += delta;
      const progress = bead.age / bead.duration;
      if (progress >= 1) {
        bead.active = false;
        continue;
      }

      const fade = 1 - progress;
      const scale = (0.055 + Math.sin(progress * Math.PI) * 0.07) * Math.min(1, fade * 4);
      tempObject.position.set(
        markerX - 0.16 - progress * 2.35,
        priceToChartY(bead.price, range, chartHeight),
        0.08 + Math.sin(progress * Math.PI) * 0.08,
      );
      tempObject.rotation.set(0, 0, 0);
      tempObject.scale.setScalar(scale);
      tempObject.updateMatrix();
      this.mesh.setMatrixAt(instanceIndex, tempObject.matrix);
      this.mesh.setColorAt(instanceIndex, COLORS[bead.direction]);
      instanceIndex += 1;
    }

    this.mesh.count = instanceIndex;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const bead of this.beads) {
      bead.active = false;
    }
    this.mesh.count = 0;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
