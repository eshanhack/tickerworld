import { Group, Line, Mesh, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyHorizonChanges } from '../src/markets';
import {
  MONUMENT_CHART_HEIGHT,
  Monument,
} from '../src/monuments/Monument';
import {
  MonumentSystem,
  isSafeNewsPermalink,
} from '../src/monuments/MonumentSystem';
import type { NewsItem } from '../src/news';
import type { AssetState, Candle } from '../src/types';

const VIEWPORT_SIZE = 800;

class FakeInteractionSurface {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: VIEWPORT_SIZE,
      bottom: VIEWPORT_SIZE,
      width: VIEWPORT_SIZE,
      height: VIEWPORT_SIZE,
      toJSON: () => ({}),
    };
  }

  dispatch(type: string, init: Partial<PointerEvent>): void {
    const event = {
      type,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      button: 0,
      isPrimary: true,
      timeStamp: 0,
      ...init,
    } as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

function candle(openTime: number, close: number, closed = true): Candle {
  return {
    openTime,
    open: close - 0.2,
    high: close + 0.4,
    low: close - 0.5,
    close,
    closed,
  };
}

function state(candles: readonly Candle[], presentationTick = 1): AssetState {
  const price = candles.at(-1)?.close ?? null;
  return {
    symbol: 'BTC',
    instrument: 'BTC',
    provider: 'hyperliquid',
    candles,
    price,
    previousPrice: price,
    direction: 'up',
    mode: 'live',
    updatedAt: Date.now(),
    presentationTick,
    updateKind: 'trade',
    horizonChanges: createEmptyHorizonChanges(),
  };
}

function newsItem(id: string, createdAt: number, permalink: string | null): NewsItem {
  return {
    id,
    source: permalink ? 'x' : 'simulation',
    text: permalink ? `Live headline ${id}` : `Fictional demo ${id}`,
    links: [],
    createdAt,
    expiresAt: createdAt + 600_000,
    authorName: permalink ? 'Walter Bloomberg' : 'Tickerwire Demo',
    authorHandle: permalink ? 'DeItaone' : 'demo',
    authorAvatarUrl: null,
    permalink,
    demo: permalink === null,
    scope: 'global',
  };
}

function screenPoint(object: Group | Mesh, camera: PerspectiveCamera): { x: number; y: number } {
  const projected = object.getWorldPosition(new Vector3()).project(camera);
  return {
    x: (projected.x + 1) * 0.5 * VIEWPORT_SIZE,
    y: (1 - projected.y) * 0.5 * VIEWPORT_SIZE,
  };
}

function createCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 9.5, 28);
  camera.lookAt(0, 9.5, 3.15);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

describe('grand monument news integration', () => {
  it('mounts news only on grand monuments and keeps links attached through a candle shunt', () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const candles = Array.from({ length: 30 }, (_, index) => (
      candle(minute - (29 - index) * 60_000, 100 + index, index < 29)
    ));
    const older = newsItem('older', minute - 70_000, 'https://x.com/DeItaone/status/1');
    const newest = newsItem('newest', minute - 10_000, 'https://x.com/DeItaone/status/2');
    const grand = new Monument({ symbol: 'BTC', kind: 'grand' });
    const echo = new Monument({ symbol: 'BTC', kind: 'echo' });

    grand.setAssetState(state(candles));
    echo.setAssetState(state(candles));
    grand.setNewsItems([newest, older]);
    echo.setNewsItems([newest, older]);
    grand.update(1 / 60, 0);
    echo.update(1 / 60, 0);

    expect(grand.root.getObjectByName('grand-monument-news')).toBeDefined();
    expect(echo.root.getObjectByName('grand-monument-news')).toBeUndefined();
    const link = grand.root.getObjectByName('news-candle-link-older') as Line;
    const firstEndX = link.geometry.getAttribute('position').getX(1);

    const rolled = [
      ...candles.slice(1).map((entry) => ({ ...entry, closed: true })),
      candle(minute + 60_000, 129.4, false),
    ];
    grand.setAssetState(state(rolled, 2));
    for (let frame = 0; frame < 5; frame += 1) grand.update(0.1, (frame + 1) * 0.1);
    const shuntedEndX = link.geometry.getAttribute('position').getX(1);
    expect(shuntedEndX).toBeLessThan(firstEndX);

    expect(grand.root.getObjectByName('news-card-interaction')).toBeUndefined();
    const newestPin = grand.root.getObjectByName('news-pin-hit-newest') as Mesh;
    const disposePinGeometry = vi.spyOn(newestPin.geometry, 'dispose');
    grand.dispose();
    grand.dispose();
    echo.dispose();
    expect(disposePinGeometry).toHaveBeenCalledTimes(1);
  });

  it('selects older pins, exposes a candle anchor, minimizes, reopens, and rejects orbit drags', () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const candles = Array.from({ length: 30 }, (_, index) => (
      candle(minute - (29 - index) * 60_000, 100 + index, index < 29)
    ));
    const newestUrl = 'https://x.com/DeItaone/status/20';
    const olderUrl = 'https://x.com/DeItaone/status/10';
    const newest = {
      ...newsItem('newest', Date.now() - 5_000, newestUrl),
      links: [{
        kind: 'url' as const,
        start: 5,
        end: 13,
        label: 'example.com/story',
        href: 'https://t.co/abc123',
      }],
    };
    const older = newsItem('older', Date.now() - 65_000, olderUrl);
    const parent = new Group();
    const camera = createCamera();
    const surface = new FakeInteractionSurface();
    const system = new MonumentSystem({
      parent,
      camera,
      domElement: surface as unknown as HTMLElement,
    });
    const grand = system.add({ symbol: 'BTC', kind: 'grand' });
    system.updateAsset(state(candles));
    system.setNewsItems([newest, older]);
    system.update(1 / 60, 0);
    parent.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    const olderPin = grand.root.getObjectByName('news-pin-hit-older') as Mesh;
    const olderPoint = screenPoint(olderPin, camera);
    expect(system.activateNewsAt(olderPoint.x, olderPoint.y)).toBe(true);
    const playerPoint = new Vector3(0, 0, 0);
    const selected = system.getNearestNewsOverlay(playerPoint);
    expect(selected?.item.id).toBe('older');
    expect(selected?.dismissed).toBe(false);
    expect(selected?.candleAnchor).toBeInstanceOf(Vector3);

    expect(system.dismissNewsOverlay('older')).toBe(true);
    expect(system.getNearestNewsOverlay(playerPoint)?.dismissed).toBe(true);
    expect(system.activateNewsAt(olderPoint.x, olderPoint.y)).toBe(true);
    expect(system.getNearestNewsOverlay(playerPoint)?.dismissed).toBe(false);

    const newestPin = grand.root.getObjectByName('news-pin-hit-newest') as Mesh;
    const newestPoint = screenPoint(newestPin, camera);
    surface.dispatch('pointerdown', { clientX: newestPoint.x, clientY: newestPoint.y, timeStamp: 100 });
    surface.dispatch('pointermove', { clientX: newestPoint.x + 30, clientY: newestPoint.y, timeStamp: 150 });
    surface.dispatch('pointerup', { clientX: newestPoint.x, clientY: newestPoint.y, timeStamp: 200 });
    expect(system.getNearestNewsOverlay(playerPoint)?.item.id).toBe('older');

    expect(isSafeNewsPermalink('javascript:alert(1)')).toBe(false);
    expect(isSafeNewsPermalink('https://example.com/not-x')).toBe(false);
    expect(isSafeNewsPermalink('https://t.co/abc123')).toBe(true);
    expect(isSafeNewsPermalink('https://evil.t.co.example/abc123')).toBe(false);
    expect(isSafeNewsPermalink(newestUrl)).toBe(true);
    expect(isSafeNewsPermalink(olderUrl)).toBe(true);

    expect(surface.listenerCount()).toBe(5);
    system.dispose();
    system.dispose();
    expect(surface.listenerCount()).toBe(0);
  });

  it('returns a stable world-space firework anchor above the rotating live chart', () => {
    const parent = new Group();
    const camera = createCamera();
    const monument = new Monument({ symbol: 'BTC' }).mount(parent);
    monument.update(1 / 60, 0, camera);
    parent.updateMatrixWorld(true);

    const target = new Vector3();
    const frontOrigin = monument.getFireworkOrigin(target);
    expect(frontOrigin).toBe(target);
    const chart = monument.root.getObjectByName('BTC-chart') as Group;
    const localOrigin = chart.worldToLocal(frontOrigin.clone());
    expect(localOrigin.x).toBeCloseTo(0, 6);
    expect(localOrigin.y).toBeGreaterThanOrEqual(MONUMENT_CHART_HEIGHT + 1.2);

    camera.position.set(28, 10, 0);
    camera.lookAt(0, 9.5, 0);
    for (let frame = 0; frame < 120; frame += 1) {
      monument.update(1 / 60, (frame + 1) / 60, camera);
    }
    const sideOrigin = monument.getFireworkOrigin(new Vector3());
    expect(sideOrigin.distanceTo(frontOrigin)).toBeGreaterThan(1);
    monument.dispose();
  });
});
