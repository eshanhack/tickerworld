import type { NewsItem, NewsLink } from '../news';
import type { AssetSymbol } from '../types';

export interface NewsOverlayPoint {
  readonly x: number;
  readonly y: number;
}

export interface NewsOverlayViewState {
  readonly symbol: AssetSymbol;
  readonly item: NewsItem;
  /** Viewport-relative CSS pixels for the selected candle close. */
  readonly anchor: NewsOverlayPoint;
  readonly dismissed?: boolean;
}

export interface NewsOverlayViewOptions {
  onDismiss: (itemId: string) => void;
  onInteractionChange?: (active: boolean) => void;
}

export interface NewsOverlayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface NewsOverlayBounds {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly padding?: number;
  readonly insets?: NewsOverlayInsets;
}

export interface NewsOverlayInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const DEFAULT_CARD_WIDTH = 360;
const DEFAULT_CARD_HEIGHT = 250;
const VIEWPORT_PADDING = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampNewsOverlayPosition(
  point: NewsOverlayPoint,
  bounds: NewsOverlayBounds,
): NewsOverlayPoint {
  const padding = Math.max(0, bounds.padding ?? VIEWPORT_PADDING);
  const insets = bounds.insets ?? { top: padding, right: padding, bottom: padding, left: padding };
  const left = Math.max(0, insets.left);
  const right = Math.max(0, insets.right);
  const top = Math.max(0, insets.top);
  const bottom = Math.max(0, insets.bottom);
  const maxX = Math.max(left, bounds.viewportWidth - bounds.cardWidth - right);
  const maxY = Math.max(top, bounds.viewportHeight - bounds.cardHeight - bottom);
  return {
    x: clamp(point.x, left, maxX),
    y: clamp(point.y, top, maxY),
  };
}

function closestCardEdge(anchor: NewsOverlayPoint, rect: NewsOverlayRect): NewsOverlayPoint {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const withinX = anchor.x >= rect.left && anchor.x <= right;
  const withinY = anchor.y >= rect.top && anchor.y <= bottom;

  if (withinX && withinY) {
    const edges = [
      { distance: anchor.x - rect.left, point: { x: rect.left, y: anchor.y } },
      { distance: right - anchor.x, point: { x: right, y: anchor.y } },
      { distance: anchor.y - rect.top, point: { x: anchor.x, y: rect.top } },
      { distance: bottom - anchor.y, point: { x: anchor.x, y: bottom } },
    ];
    edges.sort((a, b) => a.distance - b.distance);
    return edges[0]!.point;
  }

  if (withinX) return { x: anchor.x, y: anchor.y < rect.top ? rect.top : bottom };
  if (withinY) return { x: anchor.x < rect.left ? rect.left : right, y: anchor.y };
  return {
    x: anchor.x < rect.left ? rect.left : right,
    y: anchor.y < rect.top ? rect.top : bottom,
  };
}

export function createNewsConnectorPath(
  anchor: NewsOverlayPoint,
  card: NewsOverlayRect,
): string {
  const edge = closestCardEdge(anchor, card);
  const deltaX = anchor.x - edge.x;
  const deltaY = anchor.y - edge.y;
  const distance = Math.hypot(deltaX, deltaY);
  const bend = clamp(distance * 0.34, 22, 108);
  let controlOne: NewsOverlayPoint;
  let controlTwo: NewsOverlayPoint;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    const direction = Math.sign(deltaX) || 1;
    controlOne = { x: edge.x + bend * direction, y: edge.y };
    controlTwo = { x: anchor.x - bend * 0.58 * direction, y: anchor.y };
  } else {
    const direction = Math.sign(deltaY) || 1;
    controlOne = { x: edge.x, y: edge.y + bend * direction };
    controlTwo = { x: anchor.x, y: anchor.y - bend * 0.58 * direction };
  }
  return `M ${edge.x.toFixed(1)} ${edge.y.toFixed(1)} C ${controlOne.x.toFixed(1)} ${controlOne.y.toFixed(1)}, ${controlTwo.x.toFixed(1)} ${controlTwo.y.toFixed(1)}, ${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)}`;
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Prevents a compromised feed from labelling an off-domain URL as an X post. */
export function safeXPostUrl(value: string | null): string | null {
  const href = safeExternalUrl(value);
  if (!href) return null;
  const url = new URL(href);
  const hostname = url.hostname.toLowerCase();
  return url.protocol === 'https:' && (
    hostname === 'x.com'
    || hostname.endsWith('.x.com')
    || hostname === 'twitter.com'
    || hostname.endsWith('.twitter.com')
    || hostname === 't.co'
  ) ? url.href : null;
}

function createExternalLink(href: string, className?: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (className) link.className = className;
  return link;
}

function validTextLinks(item: NewsItem): NewsLink[] {
  if (item.demo) return [];
  let cursor = 0;
  return [...item.links]
    .sort((a, b) => a.start - b.start)
    .filter((link) => {
      const valid = link.start >= cursor
        && link.end > link.start
        && link.end <= item.text.length
        && safeExternalUrl(link.href) !== null;
      if (valid) cursor = link.end;
      return valid;
    });
}

/** A single session-scoped, draggable HTML presentation for chart news. */
export class NewsOverlayView {
  readonly root: HTMLDivElement;

  private readonly connector: SVGPathElement;
  private readonly safeAreaProbe: HTMLElement;
  private readonly card: HTMLElement;
  private readonly header: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly avatar: HTMLElement;
  private readonly author: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly source: HTMLElement;
  private readonly body: HTMLElement;
  private readonly timestamp: HTMLTimeElement;
  private readonly context: HTMLElement;
  private readonly permalink: HTMLElement;
  private readonly onDismiss: (itemId: string) => void;
  private readonly onInteractionChange?: (active: boolean) => void;
  private state: NewsOverlayViewState | null = null;
  private renderedItem: NewsItem | null = null;
  private renderedSymbol: AssetSymbol | null = null;
  private position: NewsOverlayPoint = { x: 0, y: 0 };
  private normalizedPosition: NewsOverlayPoint | null = null;
  private cardWidth = DEFAULT_CARD_WIDTH;
  private cardHeight = DEFAULT_CARD_HEIGHT;
  private cachedSafeAreaInsets: NewsOverlayInsets = {
    top: VIEWPORT_PADDING,
    right: VIEWPORT_PADDING,
    bottom: VIEWPORT_PADDING,
    left: VIEWPORT_PADDING,
  };
  private dragPointer: number | null = null;
  private dragOffset: NewsOverlayPoint = { x: 0, y: 0 };
  private disposed = false;

  constructor(parent: HTMLElement, options: NewsOverlayViewOptions) {
    this.onDismiss = options.onDismiss;
    this.onInteractionChange = options.onInteractionChange;
    this.root = document.createElement('div');
    this.root.className = 'news-overlay-layer';
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `
      <span class="news-safe-area-probe" aria-hidden="true" data-news-safe-area></span>
      <svg class="news-overlay-connector" aria-hidden="true">
        <path data-news-connector></path>
      </svg>
      <article class="news-overlay-card" aria-labelledby="news-overlay-author" aria-describedby="news-overlay-body" data-news-card>
        <button class="news-overlay-close" type="button" aria-label="Minimize this post to its candle pin" data-news-close>×</button>
        <header class="news-overlay-header" data-news-drag>
          <span class="news-overlay-avatar" aria-hidden="true" data-news-avatar></span>
          <span class="news-overlay-identity">
            <span class="news-overlay-author" id="news-overlay-author" data-news-author></span>
            <span class="news-overlay-handle" data-news-handle></span>
          </span>
          <span class="news-overlay-source" data-news-source></span>
        </header>
        <div class="news-overlay-scroll">
          <p class="news-overlay-body" id="news-overlay-body" data-news-body></p>
          <footer class="news-overlay-footer">
            <span data-news-context></span>
            <span aria-hidden="true">·</span>
            <time data-news-time></time>
            <span aria-hidden="true">·</span>
            <span data-news-permalink></span>
          </footer>
        </div>
      </article>
    `;
    parent.append(this.root);

    this.safeAreaProbe = this.required('[data-news-safe-area]');
    this.connector = this.required<SVGPathElement>('[data-news-connector]');
    this.card = this.required('[data-news-card]');
    this.header = this.required('[data-news-drag]');
    this.closeButton = this.required<HTMLButtonElement>('[data-news-close]');
    this.avatar = this.required('[data-news-avatar]');
    this.author = this.required('[data-news-author]');
    this.handle = this.required('[data-news-handle]');
    this.source = this.required('[data-news-source]');
    this.body = this.required('[data-news-body]');
    this.timestamp = this.required<HTMLTimeElement>('[data-news-time]');
    this.context = this.required('[data-news-context]');
    this.permalink = this.required('[data-news-permalink]');
    this.refreshMeasurements();

    this.closeButton.addEventListener('click', this.close);
    this.header.addEventListener('pointerdown', this.startDrag);
    this.header.addEventListener('pointermove', this.moveDrag);
    this.header.addEventListener('pointerup', this.endDrag);
    this.header.addEventListener('pointercancel', this.endDrag);
    this.header.addEventListener('lostpointercapture', this.endDrag);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel']) {
      this.root.addEventListener(type, this.stopCameraInput);
    }
    this.root.addEventListener('pointerdown', this.beginInteraction);
    this.root.addEventListener('pointerup', this.finishInteraction);
    this.root.addEventListener('pointercancel', this.finishInteraction);
    window.addEventListener('resize', this.resize);
    window.addEventListener('blur', this.finishInteraction);
  }

  setState(state: NewsOverlayViewState | null): void {
    if (this.disposed) return;
    this.state = state;
    const visible = state !== null && state.dismissed !== true;
    const wasHidden = this.root.hidden;
    this.root.hidden = !visible;
    this.root.setAttribute('aria-hidden', String(!visible));
    if (!visible || !state) return;

    const needsRender = this.renderedItem !== state.item || this.renderedSymbol !== state.symbol;
    if (needsRender) {
      this.renderedItem = state.item;
      this.renderedSymbol = state.symbol;
      this.renderItem(state.item, state.symbol);
    }
    if (wasHidden || needsRender) this.refreshMeasurements();
    this.layoutCard();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeButton.removeEventListener('click', this.close);
    this.header.removeEventListener('pointerdown', this.startDrag);
    this.header.removeEventListener('pointermove', this.moveDrag);
    this.header.removeEventListener('pointerup', this.endDrag);
    this.header.removeEventListener('pointercancel', this.endDrag);
    this.header.removeEventListener('lostpointercapture', this.endDrag);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel']) {
      this.root.removeEventListener(type, this.stopCameraInput);
    }
    this.root.removeEventListener('pointerdown', this.beginInteraction);
    this.root.removeEventListener('pointerup', this.finishInteraction);
    this.root.removeEventListener('pointercancel', this.finishInteraction);
    this.onInteractionChange?.(false);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('blur', this.finishInteraction);
    this.root.remove();
    this.state = null;
    this.renderedItem = null;
    this.renderedSymbol = null;
  }

  private renderItem(item: NewsItem, symbol: AssetSymbol): void {
    const handle = item.authorHandle.replace(/^@/, '');
    const profileUrl = item.demo || !handle
      ? null
      : safeExternalUrl(`https://x.com/${encodeURIComponent(handle)}`);
    const authorContent = document.createElement(profileUrl ? 'a' : 'span');
    authorContent.textContent = item.authorName;
    if (authorContent instanceof HTMLAnchorElement && profileUrl) {
      authorContent.href = profileUrl;
      authorContent.target = '_blank';
      authorContent.rel = 'noopener noreferrer';
      authorContent.setAttribute('aria-label', `${item.authorName} on X`);
    }
    this.author.replaceChildren(authorContent);
    this.handle.textContent = handle ? `@${handle}` : '';

    this.avatar.replaceChildren();
    const avatarUrl = safeExternalUrl(item.authorAvatarUrl);
    if (avatarUrl) {
      const image = document.createElement('img');
      image.src = avatarUrl;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      this.avatar.append(image);
    } else {
      this.avatar.textContent = item.authorName.trim().slice(0, 1).toUpperCase() || 'X';
    }

    this.source.classList.toggle('is-demo', item.demo);
    if (item.demo) {
      this.source.textContent = 'FICTIONAL DEMO';
    } else {
      this.source.innerHTML = `
        <svg class="news-x-mark" role="img" aria-label="X" viewBox="0 0 24 24">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"></path>
        </svg>`;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const link of validTextLinks(item)) {
      fragment.append(document.createTextNode(item.text.slice(cursor, link.start)));
      const href = safeExternalUrl(link.href);
      if (!href) continue;
      const anchor = createExternalLink(href, `news-entity-link is-${link.kind}`);
      anchor.textContent = item.text.slice(link.start, link.end);
      anchor.setAttribute('aria-label', `${link.label} (opens in a new tab)`);
      fragment.append(anchor);
      cursor = link.end;
    }
    fragment.append(document.createTextNode(item.text.slice(cursor)));
    this.body.replaceChildren(fragment);

    const date = new Date(item.createdAt);
    this.context.textContent = item.scope === 'global'
      ? 'GLOBAL · posted during this candle'
      : `${item.scope} world`;
    this.timestamp.dateTime = date.toISOString();
    this.timestamp.textContent = date.toLocaleString([], {
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    });
    const permalink = safeXPostUrl(item.permalink);
    if (permalink) {
      const link = createExternalLink(permalink, 'news-permalink');
      link.textContent = 'View post on X ↗';
      link.setAttribute('aria-label', 'View the original post on X (opens in a new tab)');
      this.permalink.replaceChildren(link);
    } else {
      this.permalink.textContent = `${symbol} · simulated headline`;
    }
  }

  private layoutCard(): void {
    const state = this.state;
    if (!state || this.root.hidden) return;
    const cardWidth = this.cardWidth;
    const cardHeight = this.cardHeight;
    const insets = this.safeAreaInsets();
    const bounds = {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      cardWidth,
      cardHeight,
      insets,
    };
    const maxX = Math.max(insets.left, window.innerWidth - cardWidth - insets.right);
    const maxY = Math.max(insets.top, window.innerHeight - cardHeight - insets.bottom);

    if (!this.normalizedPosition) {
      this.position = clampNewsOverlayPosition({
        x: maxX,
        // The CSS-provided bottom inset already reserves the complete footer
        // and touch-control zone. Dock directly against that safe boundary so
        // the card does not waste a second clearance gap on short screens.
        y: maxY,
      }, bounds);
      this.storeNormalizedPosition(cardWidth, cardHeight);
    } else if (this.dragPointer === null) {
      this.position = clampNewsOverlayPosition({
        x: insets.left + this.normalizedPosition.x * Math.max(0, maxX - insets.left),
        y: insets.top + this.normalizedPosition.y * Math.max(0, maxY - insets.top),
      }, bounds);
    }
    this.applyPosition(cardWidth, cardHeight);
  }

  private applyPosition(cardWidth = this.cardWidth, cardHeight = this.cardHeight): void {
    this.card.style.transform = `translate3d(${this.position.x}px, ${this.position.y}px, 0)`;
    const state = this.state;
    if (!state) return;
    this.connector.setAttribute('d', createNewsConnectorPath(state.anchor, {
      left: this.position.x,
      top: this.position.y,
      width: cardWidth,
      height: cardHeight,
    }));
  }

  private storeNormalizedPosition(cardWidth: number, cardHeight: number): void {
    const insets = this.safeAreaInsets();
    const maxX = Math.max(insets.left, window.innerWidth - cardWidth - insets.right);
    const maxY = Math.max(insets.top, window.innerHeight - cardHeight - insets.bottom);
    this.normalizedPosition = {
      x: maxX === insets.left ? 0 : clamp((this.position.x - insets.left) / (maxX - insets.left), 0, 1),
      y: maxY === insets.top ? 0 : clamp((this.position.y - insets.top) / (maxY - insets.top), 0, 1),
    };
  }

  private safeAreaInsets(): NewsOverlayInsets {
    return this.cachedSafeAreaInsets;
  }

  private refreshMeasurements(): void {
    if (!this.root.hidden) {
      this.cardWidth = this.card.offsetWidth || DEFAULT_CARD_WIDTH;
      this.cardHeight = this.card.offsetHeight || DEFAULT_CARD_HEIGHT;
    }
    const style = getComputedStyle(this.safeAreaProbe);
    const read = (value: string): number => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? Math.max(VIEWPORT_PADDING, parsed) : VIEWPORT_PADDING;
    };
    this.cachedSafeAreaInsets = {
      top: read(style.paddingTop),
      right: read(style.paddingRight),
      bottom: read(style.paddingBottom),
      left: read(style.paddingLeft),
    };
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Tickerworld news overlay is missing ${selector}`);
    return element;
  }

  private readonly stopCameraInput = (event: Event): void => {
    event.stopPropagation();
  };

  private readonly beginInteraction = (): void => this.onInteractionChange?.(true);
  private readonly finishInteraction = (): void => this.onInteractionChange?.(false);

  private readonly close = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const itemId = this.state?.item.id;
    if (!itemId) return;
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    this.onInteractionChange?.(false);
    this.onDismiss(itemId);
  };

  private readonly startDrag = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const target = event.target as Element | null;
    if (target?.closest('a, button')) return;
    event.preventDefault();
    event.stopPropagation();
    this.dragPointer = event.pointerId;
    this.dragOffset = {
      x: event.clientX - this.position.x,
      y: event.clientY - this.position.y,
    };
    this.header.setPointerCapture(event.pointerId);
    this.card.classList.add('is-dragging');
  };

  private readonly moveDrag = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointer) return;
    event.preventDefault();
    event.stopPropagation();
    const cardWidth = this.cardWidth;
    const cardHeight = this.cardHeight;
    this.position = clampNewsOverlayPosition({
      x: event.clientX - this.dragOffset.x,
      y: event.clientY - this.dragOffset.y,
    }, {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      cardWidth,
      cardHeight,
      insets: this.safeAreaInsets(),
    });
    this.storeNormalizedPosition(cardWidth, cardHeight);
    this.applyPosition(cardWidth, cardHeight);
  };

  private readonly endDrag = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointer) return;
    event.preventDefault();
    event.stopPropagation();
    this.dragPointer = null;
    if (this.header.hasPointerCapture(event.pointerId)) this.header.releasePointerCapture(event.pointerId);
    this.card.classList.remove('is-dragging');
    this.onInteractionChange?.(false);
    const cardWidth = this.cardWidth;
    const cardHeight = this.cardHeight;
    this.storeNormalizedPosition(cardWidth, cardHeight);
  };

  private readonly resize = (): void => {
    this.refreshMeasurements();
    this.layoutCard();
  };
}
