import {
  BufferGeometry,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Text } from 'troika-three-text';
import type { NewsItem } from '../news';
import type { CandleLayout } from './chartMath';

const CARD_WIDTH = 5.7;
const CARD_HEIGHT = 4.4;
const CARD_X = 11.55;
const CARD_Y = 2.35;
const CARD_Z = 0.18;
const MAX_VISIBLE_ITEMS = 12;
const NEWS_LIFETIME_MS = 10 * 60 * 1_000;

const COLORS = {
  card: 0x293238,
  cardEdge: 0xffebc8,
  cream: 0xffefd0,
  muted: 0xc6c8bd,
  live: 0x8fd8a3,
  demo: 0xe4b577,
  pin: 0xf7d28d,
} as const;

export interface NewsInteraction {
  readonly action: 'select' | 'open';
  readonly itemId: string;
  readonly url?: string;
}

interface PinVisual {
  readonly root: Group;
  readonly marker: Mesh<CircleGeometry, MeshBasicMaterial>;
  readonly line: Line<BufferGeometry, LineBasicMaterial>;
}

interface EntityLinkVisual {
  readonly label: Text;
  readonly hitbox: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
}

function createText(
  name: string,
  fontUrl: string | undefined,
  size: number,
  color: number,
): Text {
  const text = new Text();
  text.name = name;
  text.fontSize = size;
  text.color = color;
  text.anchorX = 'left';
  text.anchorY = 'top';
  text.depthOffset = -4;
  text.renderOrder = 64;
  if (fontUrl) text.font = fontUrl;
  return text;
}

function syncText(text: Text): void {
  if (typeof self !== 'undefined') text.sync();
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
 * A presentation-layer news card and candle-linked pin strip. It is kept
 * independent from fetching so the same view works for live X posts and the
 * clearly-labelled fictional demo feed.
 */
export class NewsPanel {
  readonly root = new Group();

  private readonly card = new Group();
  private readonly cardBackground: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
  private readonly cardEdge: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
  private readonly avatar: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly authorText: Text;
  private readonly handleText: Text;
  private readonly bodyText: Text;
  private readonly footerText: Text;
  private readonly sourceText: Text;
  private readonly cardHitbox: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
  private readonly authorHitbox: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
  private readonly entityGroup = new Group();
  private readonly entityLinks: EntityLinkVisual[] = [];
  private readonly pins = new Map<string, PinVisual>();
  private readonly interactiveObjects: Object3D[] = [];
  private readonly textureLoader = new TextureLoader();
  private readonly tempColor = new Color();
  private items: NewsItem[] = [];
  private selectedId: string | null = null;
  private avatarTexture: Texture | null = null;
  private avatarRequest = 0;
  private disposed = false;

  constructor(private readonly fontUrl?: string) {
    this.root.name = 'grand-monument-news';

    const edgeGeometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.12);
    this.cardEdge = new Mesh(
      edgeGeometry,
      new MeshBasicMaterial({
        color: COLORS.cardEdge,
        transparent: true,
        opacity: 0.28,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.cardEdge.scale.set(CARD_WIDTH + 0.1, CARD_HEIGHT + 0.1, 0.055);
    this.cardEdge.position.z = -0.025;
    this.cardEdge.renderOrder = 60;

    this.cardBackground = new Mesh(
      new RoundedBoxGeometry(1, 1, 1, 3, 0.11),
      new MeshBasicMaterial({
        color: COLORS.card,
        transparent: true,
        opacity: 0.94,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.cardBackground.scale.set(CARD_WIDTH, CARD_HEIGHT, 0.06);
    this.cardBackground.renderOrder = 61;

    this.avatar = new Mesh(
      new CircleGeometry(0.31, 24),
      new MeshBasicMaterial({
        color: COLORS.demo,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.avatar.name = 'news-author-avatar';
    this.avatar.position.set(-2.38, 1.43, 0.075);
    this.avatar.renderOrder = 63;

    this.authorText = createText('news-author', fontUrl, 0.26, COLORS.cream);
    this.authorText.position.set(-1.98, 1.67, 0.08);
    this.authorText.fontWeight = 'bold';
    this.authorText.maxWidth = 3.3;

    this.handleText = createText('news-handle', fontUrl, 0.2, COLORS.muted);
    this.handleText.position.set(-1.98, 1.31, 0.08);
    this.handleText.maxWidth = 3.3;

    this.bodyText = createText('news-body', fontUrl, 0.205, COLORS.cream);
    this.bodyText.position.set(-2.48, 0.86, 0.08);
    this.bodyText.maxWidth = 4.96;
    this.bodyText.lineHeight = 1.25;
    this.bodyText.whiteSpace = 'normal';
    this.bodyText.overflowWrap = 'break-word';

    this.footerText = createText('news-footer', fontUrl, 0.18, COLORS.muted);
    this.footerText.position.set(-2.48, -1.9, 0.08);
    this.footerText.anchorY = 'middle';

    this.sourceText = createText('news-source', fontUrl, 0.25, COLORS.live);
    this.sourceText.anchorX = 'right';
    this.sourceText.position.set(2.45, 1.66, 0.08);
    this.sourceText.fontWeight = 'bold';

    this.cardHitbox = new Mesh(
      new RoundedBoxGeometry(1, 1, 0.02, 2, 0.1),
      new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.cardHitbox.name = 'news-card-interaction';
    this.cardHitbox.scale.set(CARD_WIDTH, CARD_HEIGHT, 1);
    this.cardHitbox.position.z = 0.12;
    this.cardHitbox.renderOrder = 65;

    this.authorHitbox = new Mesh(
      new RoundedBoxGeometry(1, 1, 0.02, 2, 0.08),
      new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.authorHitbox.name = 'news-author-interaction';
    this.authorHitbox.scale.set(4.7, 0.72, 1);
    this.authorHitbox.position.set(-0.17, 1.43, 0.14);
    this.authorHitbox.renderOrder = 66;

    this.entityGroup.name = 'news-entity-links';

    this.card.position.set(CARD_X, CARD_Y, CARD_Z);
    this.card.add(
      this.cardEdge,
      this.cardBackground,
      this.avatar,
      this.authorText,
      this.handleText,
      this.bodyText,
      this.footerText,
      this.sourceText,
      this.entityGroup,
      this.cardHitbox,
      this.authorHitbox,
    );
    this.card.visible = false;
    this.root.add(this.card);
  }

  setItems(sourceItems: readonly NewsItem[], now = Date.now()): void {
    if (this.disposed) return;
    const previousNewest = this.items[0]?.id;
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
    if (!this.selectedId || !ids.has(this.selectedId) || newestId !== previousNewest) {
      this.selectedId = newestId;
    }
    this.refreshCard();
    this.rebuildInteractiveObjects();
  }

  update(layouts: readonly CandleLayout[], now = Date.now()): void {
    if (this.disposed) return;
    const active = activeNewsItems(this.items, now);
    if (active.length !== this.items.length) {
      this.setItems(active, now);
    }

    const selected = this.items.find((item) => item.id === this.selectedId) ?? this.items[0];
    this.items.forEach((item, index) => {
      const pin = this.pins.get(item.id);
      if (!pin) return;
      const candle = findNewsCandleLayout(item, layouts);
      const remaining = Math.max(0, Math.min(1, (item.expiresAt - now) / NEWS_LIFETIME_MS));
      const opacity = 0.25 + remaining * 0.55;
      pin.root.visible = candle !== null;
      if (!candle) return;

      const sameMinuteOffset = this.items
        .slice(0, index)
        .filter((candidate) => newsMinute(candidate.createdAt) === newsMinute(item.createdAt)).length;
      const pinY = 6.2 + (index % 3) * 0.28 + sameMinuteOffset * 0.16;
      pin.marker.position.set(candle.x + sameMinuteOffset * 0.14, pinY, 0.035);
      pin.marker.scale.setScalar(item.id === selected?.id ? 1.28 : 1);
      pin.marker.material.opacity = item.id === selected?.id ? Math.min(1, opacity + 0.2) : opacity;
      pin.line.material.opacity = item.id === selected?.id ? opacity * 0.82 : opacity * 0.42;

      const startX = item.id === selected?.id
        ? CARD_X - CARD_WIDTH * 0.5
        : pin.marker.position.x;
      const startY = item.id === selected?.id ? CARD_Y : pinY - 0.05;
      setLinePositions(pin.line.geometry, startX, startY, candle.x, candle.closeY);
    });
  }

  select(itemId: string): boolean {
    if (!this.items.some((item) => item.id === itemId)) return false;
    this.selectedId = itemId;
    this.refreshCard();
    this.rebuildInteractiveObjects();
    return true;
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
    this.avatarRequest += 1;
    this.avatarTexture?.dispose();
    this.avatarTexture = null;
    this.clearEntityLinks();
    for (const text of [
      this.authorText,
      this.handleText,
      this.bodyText,
      this.footerText,
      this.sourceText,
    ]) {
      text.dispose();
    }
    for (const pin of this.pins.values()) {
      pin.marker.geometry.dispose();
      pin.marker.material.dispose();
      pin.line.geometry.dispose();
      pin.line.material.dispose();
    }
    this.pins.clear();
    this.cardBackground.geometry.dispose();
    this.cardBackground.material.dispose();
    this.cardEdge.geometry.dispose();
    this.cardEdge.material.dispose();
    this.avatar.geometry.dispose();
    this.avatar.material.dispose();
    this.cardHitbox.geometry.dispose();
    this.cardHitbox.material.dispose();
    this.authorHitbox.geometry.dispose();
    this.authorHitbox.material.dispose();
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
    return { root, marker, line };
  }

  private refreshCard(): void {
    const item = this.items.find((candidate) => candidate.id === this.selectedId) ?? this.items[0];
    this.card.visible = Boolean(item);
    if (!item) {
      this.clearEntityLinks();
      this.cardHitbox.userData.tickerworldNews = undefined;
      this.authorHitbox.userData.tickerworldNews = undefined;
      return;
    }

    this.authorText.text = item.authorName;
    this.handleText.text = item.authorHandle ? `@${item.authorHandle.replace(/^@/, '')}` : '';
    this.bodyText.text = item.text;
    const colorRanges: Record<number, number> = { 0: COLORS.cream };
    if (!item.demo) {
      for (const link of item.links) {
        if (link.start < 0 || link.end <= link.start || link.end > item.text.length) continue;
        colorRanges[link.start] = COLORS.live;
        colorRanges[link.end] = COLORS.cream;
      }
    }
    this.bodyText.colorRanges = colorRanges;
    const timestamp = new Date(item.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    this.footerText.text = item.permalink ? `${timestamp}  ·  VIEW ON X  ↗` : `${timestamp}  ·  FICTIONAL DEMO`;
    this.sourceText.text = item.demo ? 'DEMO' : 'X';
    this.sourceText.color = item.demo ? COLORS.demo : COLORS.live;
    this.cardEdge.material.color.set(item.demo ? COLORS.demo : COLORS.cardEdge);
    this.avatar.material.color.set(item.demo ? COLORS.demo : COLORS.cream);
    for (const text of [
      this.authorText,
      this.handleText,
      this.bodyText,
      this.footerText,
      this.sourceText,
    ]) syncText(text);

    this.cardHitbox.userData.tickerworldNews = item.permalink
      ? ({ action: 'open', itemId: item.id, url: item.permalink } satisfies NewsInteraction)
      : undefined;
    this.authorHitbox.userData.tickerworldNews = item.permalink && item.authorHandle
      ? ({
          action: 'open',
          itemId: item.id,
          url: `https://x.com/${encodeURIComponent(item.authorHandle.replace(/^@/, ''))}`,
        } satisfies NewsInteraction)
      : undefined;
    this.rebuildEntityLinks(item);
    this.loadAvatar(item.authorAvatarUrl);
  }

  private rebuildEntityLinks(item: NewsItem): void {
    this.clearEntityLinks();
    const links = item.demo ? [] : item.links;
    const left = -CARD_WIDTH * 0.5 + 0.37;
    const right = CARD_WIDTH * 0.5 - 0.37;
    let cursorX = left;
    let row = 0;

    for (const link of links) {
      const width = Math.min(2.25, Math.max(0.72, 0.26 + link.label.length * 0.072));
      if (cursorX > left && cursorX + width > right) {
        cursorX = left;
        row += 1;
      }
      const centerX = cursorX + width * 0.5;
      const y = -1.43 - row * 0.31;
      const hitbox = new Mesh(
        new RoundedBoxGeometry(1, 1, 0.025, 2, 0.08),
        new MeshBasicMaterial({
          color: COLORS.live,
          transparent: true,
          opacity: 0.18,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      hitbox.name = `news-entity-${link.kind}`;
      hitbox.scale.set(width, 0.245, 1);
      hitbox.position.set(centerX, y, 0.15);
      hitbox.renderOrder = 65;
      hitbox.userData.tickerworldNews = {
        action: 'open',
        itemId: item.id,
        url: link.href,
      } satisfies NewsInteraction;

      const label = createText(`news-entity-label-${link.kind}`, this.fontUrl, 0.13, COLORS.cream);
      label.text = link.label;
      label.fontSize = Math.min(0.135, Math.max(0.072, (width - 0.16) / Math.max(1, link.label.length) / 0.55));
      label.anchorX = 'center';
      label.anchorY = 'middle';
      label.position.set(centerX, y, 0.17);
      label.renderOrder = 66;
      syncText(label);
      this.entityGroup.add(hitbox, label);
      this.entityLinks.push({ label, hitbox });
      cursorX += width + 0.1;
    }

    const rowCount = links.length === 0 ? 0 : row + 1;
    const extraHeight = Math.max(0, rowCount - 1) * 0.35;
    this.cardBackground.scale.y = CARD_HEIGHT + extraHeight;
    this.cardBackground.position.y = -extraHeight * 0.5;
    this.cardEdge.scale.y = CARD_HEIGHT + 0.1 + extraHeight;
    this.cardEdge.position.y = -extraHeight * 0.5;
    this.cardHitbox.scale.y = CARD_HEIGHT + extraHeight;
    this.cardHitbox.position.y = -extraHeight * 0.5;
    this.footerText.position.y = -1.9 - Math.max(0, rowCount - 1) * 0.31;
  }

  private clearEntityLinks(): void {
    for (const visual of this.entityLinks) {
      visual.label.dispose();
      visual.hitbox.geometry.dispose();
      visual.hitbox.material.dispose();
    }
    this.entityLinks.length = 0;
    this.entityGroup.clear();
  }

  private loadAvatar(url: string | null): void {
    const request = ++this.avatarRequest;
    this.avatarTexture?.dispose();
    this.avatarTexture = null;
    this.avatar.material.map = null;
    this.avatar.material.needsUpdate = true;
    if (!url || typeof document === 'undefined') return;

    this.textureLoader.load(
      url,
      (texture) => {
        if (this.disposed || request !== this.avatarRequest) {
          texture.dispose();
          return;
        }
        texture.colorSpace = SRGBColorSpace;
        this.avatarTexture = texture;
        this.avatar.material.map = texture;
        this.avatar.material.color.copy(this.tempColor.set(0xffffff));
        this.avatar.material.needsUpdate = true;
      },
      undefined,
      () => undefined,
    );
  }

  private rebuildInteractiveObjects(): void {
    this.interactiveObjects.length = 0;
    if (this.authorHitbox.userData.tickerworldNews) this.interactiveObjects.push(this.authorHitbox);
    for (const entity of this.entityLinks) this.interactiveObjects.push(entity.hitbox);
    if (this.cardHitbox.userData.tickerworldNews) this.interactiveObjects.push(this.cardHitbox);
    for (const item of this.items) {
      const pin = this.pins.get(item.id);
      if (pin) this.interactiveObjects.push(pin.marker);
    }
  }
}
