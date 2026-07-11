import {
  BufferGeometry,
  CircleGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { NewsItem } from '../news';
import type { CandleLayout } from './chartMath';

const MAX_VISIBLE_ITEMS = 12;
const NEWS_LIFETIME_MS = 10 * 60 * 1_000;

const COLORS = {
  live: 0x8fd8a3,
  demo: 0xe4b577,
  pin: 0xf7d28d,
} as const;

export interface NewsInteraction {
  readonly action: 'select';
  readonly itemId: string;
}

export interface NewsPanelSelection {
  readonly item: NewsItem;
  readonly dismissed: boolean;
}

interface PinVisual {
  readonly root: Group;
  readonly marker: Mesh<CircleGeometry, MeshBasicMaterial>;
  readonly line: Line<BufferGeometry, LineBasicMaterial>;
  readonly candleAnchor: Vector3;
  hasCandleAnchor: boolean;
}

function setLinePositions(
  geometry: BufferGeometry,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  const positions = geometry.getAttribute('position');
  if (positions instanceof Float32BufferAttribute && positions.count === 2) {
    positions.setXYZ(0, startX, startY, 0.015);
    positions.setXYZ(1, endX, endY, 0.015);
    positions.needsUpdate = true;
    geometry.computeBoundingSphere();
    return;
  }
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([startX, startY, 0.015, endX, endY, 0.015], 3),
  );
}

export function newsMinute(createdAt: number): number {
  return Math.floor(createdAt / 60_000) * 60_000;
}

export function findNewsCandleLayout(
  item: Pick<NewsItem, 'createdAt'>,
  layouts: readonly CandleLayout[],
): CandleLayout | null {
  const minute = newsMinute(item.createdAt);
  return layouts.find((layout) => layout.candle.openTime === minute) ?? null;
}

export function activeNewsItems(
  items: readonly NewsItem[],
  now: number,
  maxItems = MAX_VISIBLE_ITEMS,
): NewsItem[] {
  return items
    .filter((item) => item.createdAt <= now && now < Math.min(item.expiresAt, item.createdAt + NEWS_LIFETIME_MS))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, maxItems));
}

/**
 * Keeps the small, candle-linked world markers only. The full post is rendered
 * once in the DOM by NewsOverlayView, so it never occludes chart geometry.
 */
export class NewsPanel {
  readonly root = new Group();

  private readonly pins = new Map<string, PinVisual>();
  private readonly interactiveObjects: Object3D[] = [];
  private items: NewsItem[] = [];
  private selectedId: string | null = null;
  private dismissedId: string | null = null;
  private disposed = false;

  constructor(_fontUrl?: string) {
    this.root.name = 'grand-monument-news';
  }

  setItems(sourceItems: readonly NewsItem[], now = Date.now()): void {
    if (this.disposed) return;
    const previousNewest = this.items[0] ?? null;
    const previousIds = new Set(this.items.map((item) => item.id));
    const selectionWasDismissed = this.selectedId !== null && this.dismissedId === this.selectedId;
    this.items = activeNewsItems(sourceItems, now);
    const ids = new Set(this.items.map((item) => item.id));

    for (const [id, pin] of this.pins) {
      if (ids.has(id)) continue;
      pin.root.removeFromParent();
      pin.marker.geometry.dispose();
      pin.marker.material.dispose();
      pin.line.geometry.dispose();
      pin.line.material.dispose();
      this.pins.delete(id);
    }

    for (const item of this.items) {
      if (!this.pins.has(item.id)) this.pins.set(item.id, this.createPin(item));
    }

    const newestId = this.items[0]?.id ?? null;
    const genuinelyNewNewest = newestId !== null
      && previousNewest !== null
      && !previousIds.has(newestId)
      && (this.items[0]?.createdAt ?? 0) > previousNewest.createdAt;
    if (genuinelyNewNewest) {
      this.selectedId = newestId;
      this.dismissedId = null;
    } else if (!this.selectedId || !ids.has(this.selectedId)) {
      this.selectedId = newestId;
      this.dismissedId = selectionWasDismissed ? newestId : null;
    }
    if (!newestId) {
      this.selectedId = null;
      this.dismissedId = null;
    }
    this.rebuildInteractiveObjects();
  }

  update(layouts: readonly CandleLayout[], now = Date.now()): void {
    if (this.disposed) return;
    const active = activeNewsItems(this.items, now);
    if (active.length !== this.items.length) this.setItems(active, now);

    const selected = this.items.find((item) => item.id === this.selectedId) ?? this.items[0];
    this.items.forEach((item, index) => {
      const pin = this.pins.get(item.id);
      if (!pin) return;
      const candle = findNewsCandleLayout(item, layouts);
      const remaining = Math.max(0, Math.min(1, (item.expiresAt - now) / NEWS_LIFETIME_MS));
      const opacity = 0.25 + remaining * 0.55;
      pin.root.visible = candle !== null;
      pin.hasCandleAnchor = candle !== null;
      if (!candle) return;

      const sameMinuteOffset = this.items
        .slice(0, index)
        .filter((candidate) => newsMinute(candidate.createdAt) === newsMinute(item.createdAt)).length;
      const pinY = 6.2 + (index % 3) * 0.28 + sameMinuteOffset * 0.16;
      const pinX = candle.x + sameMinuteOffset * 0.14;
      pin.marker.position.set(pinX, pinY, 0.035);
      pin.marker.scale.setScalar(item.id === selected?.id ? 1.28 : 1);
      pin.marker.material.opacity = item.id === selected?.id ? Math.min(1, opacity + 0.2) : opacity;
      pin.line.material.opacity = item.id === selected?.id ? opacity * 0.82 : opacity * 0.42;
      setLinePositions(pin.line.geometry, pinX, pinY - 0.05, candle.x, candle.closeY);

      pin.candleAnchor.set(candle.x, candle.closeY, 0.04);
    });
  }

  select(itemId: string): boolean {
    if (!this.items.some((item) => item.id === itemId)) return false;
    this.selectedId = itemId;
    this.dismissedId = null;
    return true;
  }

  dismiss(itemId = this.selectedId): boolean {
    if (!itemId || itemId !== this.selectedId) return false;
    this.dismissedId = itemId;
    return true;
  }

  getSelection(): NewsPanelSelection | null {
    const item = this.items.find((candidate) => candidate.id === this.selectedId) ?? null;
    return item ? { item, dismissed: this.dismissedId === item.id } : null;
  }

  getSelectedCandleAnchor(target = new Vector3()): Vector3 | null {
    const pin = this.selectedId ? this.pins.get(this.selectedId) : null;
    return pin?.hasCandleAnchor ? target.copy(pin.candleAnchor) : null;
  }

  resolveInteraction(object: Object3D | null): NewsInteraction | null {
    let current = object;
    while (current) {
      const interaction = current.userData.tickerworldNews as NewsInteraction | undefined;
      if (interaction) return interaction;
      current = current.parent;
    }
    return null;
  }

  getInteractiveObjects(): readonly Object3D[] {
    return this.interactiveObjects;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pin of this.pins.values()) {
      pin.marker.geometry.dispose();
      pin.marker.material.dispose();
      pin.line.geometry.dispose();
      pin.line.material.dispose();
    }
    this.pins.clear();
    this.interactiveObjects.length = 0;
    this.root.clear();
  }

  private createPin(item: NewsItem): PinVisual {
    const root = new Group();
    root.name = `news-pin-${item.id}`;
    const marker = new Mesh(
      new CircleGeometry(0.13, 12),
      new MeshBasicMaterial({
        color: item.demo ? COLORS.demo : COLORS.pin,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    marker.name = `news-pin-hit-${item.id}`;
    marker.renderOrder = 63;
    marker.userData.tickerworldNews = {
      action: 'select',
      itemId: item.id,
    } satisfies NewsInteraction;

    const line = new Line(
      new BufferGeometry(),
      new LineBasicMaterial({
        color: item.demo ? COLORS.demo : COLORS.pin,
        transparent: true,
        opacity: 0.35,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    line.name = `news-candle-link-${item.id}`;
    line.renderOrder = 62;
    setLinePositions(line.geometry, 0, 0, 0, 0);
    root.add(line, marker);
    this.root.add(root);
    return {
      root,
      marker,
      line,
      candleAnchor: new Vector3(),
      hasCandleAnchor: false,
    };
  }

  private rebuildInteractiveObjects(): void {
    this.interactiveObjects.length = 0;
    for (const item of this.items) {
      const pin = this.pins.get(item.id);
      if (pin) this.interactiveObjects.push(pin.marker);
    }
  }
}
