import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { describe, expect, it, vi } from 'vitest';
import { ASSET_SYMBOLS } from '../src/types';
import {
  createPortalRoutes as createSharedPortalRoutes,
  marketForSymbol,
} from '../shared/src/index.js';
import {
  PORTAL_ARRIVAL_OFFSET,
  DEX_FIELD_PORTAL_RADIUS,
  PORTAL_DWELL_SECONDS,
  PORTAL_RADIUS,
  PortalDwellController,
  PortalSystem,
  createPortalLabelModel,
  createPortalRoutes,
  formatPortalPopulation,
  PORTAL_LABEL_LAYOUT,
  assignPortalLabelRows,
  portalLabelCardsOverlap,
  portalLabelCenterY,
  portalLabelLineBounds,
  portalArrivalSpawn,
} from '../src/portals';

describe('fixed portal routes', () => {
  it('provides every other destination in stable road slots for every world', () => {
    const btcRoutes = createPortalRoutes('BTC');
    expect(btcRoutes).toHaveLength(ASSET_SYMBOLS.length - 1);
    for (const activeMarket of ASSET_SYMBOLS) {
      const routes = createPortalRoutes(activeMarket);
      expect(routes).toHaveLength(ASSET_SYMBOLS.length - 1);
      expect(new Set(routes.map(({ destination }) => destination))).toEqual(
        new Set(ASSET_SYMBOLS.filter((symbol) => symbol !== activeMarket)),
      );
      expect(routes.map(({ slotMarket, bearing }) => ({ slotMarket, bearing }))).toEqual(
        btcRoutes.map(({ slotMarket, bearing }) => ({ slotMarket, bearing })),
      );
      expect(routes.every(({ x, z, radius }) => Math.abs(Math.hypot(x, z) - radius) < 1e-8)).toBe(true);
    }
  });

  it('keeps client presentation slots identical to the server protocol routes', () => {
    for (const symbol of ASSET_SYMBOLS) {
      const client = createPortalRoutes(symbol);
      const shared = createSharedPortalRoutes(marketForSymbol(symbol));
      for (const route of client) {
        const serverRoute = shared.find(({ to }) => to === route.destination.toLowerCase());
        expect(serverRoute).toBeDefined();
        expect(serverRoute?.x).toBeCloseTo(route.x, 10);
        expect(serverRoute?.z).toBeCloseTo(route.z, 10);
      }
    }
  });

  it("turns a non-BTC world's own spoke into its BTC return route", () => {
    const btcEth = createPortalRoutes('BTC').find(({ destination }) => destination === 'ETH');
    const ethBtc = createPortalRoutes('ETH').find(({ destination }) => destination === 'BTC');
    expect(ethBtc).toBeDefined();
    expect(ethBtc?.slotMarket).toBe('ETH');
    expect(ethBtc?.bearing).toBe(btcEth?.bearing);
    expect(ethBtc?.isReturnPortal).toBe(true);
  });

  it('spawns beyond the return portal facing toward the plaza', () => {
    const spawn = portalArrivalSpawn('ETH', 'BTC');
    expect(spawn).not.toBeNull();
    if (!spawn) return;
    expect(Math.hypot(spawn.x, spawn.z)).toBeCloseTo(PORTAL_RADIUS + PORTAL_ARRIVAL_OFFSET, 8);
    const facing = { x: -Math.sin(spawn.facingYaw), z: -Math.cos(spawn.facingYaw) };
    const inward = new THREE.Vector2(-spawn.x, -spawn.z).normalize();
    expect(facing.x).toBeCloseTo(inward.x, 8);
    expect(facing.z).toBeCloseTo(inward.y, 8);
  });

  it('keeps DEX arrivals on the outer field ring and inside the world boundary', () => {
    const spawn = portalArrivalSpawn('PUMP', 'BTC');
    expect(spawn).not.toBeNull();
    if (!spawn) return;
    expect(spawn.returnPortal.radius).toBe(DEX_FIELD_PORTAL_RADIUS);
    expect(Math.hypot(spawn.x, spawn.z)).toBeCloseTo(
      DEX_FIELD_PORTAL_RADIUS + PORTAL_ARRIVAL_OFFSET,
      8,
    );
    expect(Math.hypot(spawn.x, spawn.z)).toBeLessThan(84);
  });

  it('formats live price and aggregate population without inventing offline counts', () => {
    const route = createPortalRoutes('BTC')[0];
    expect(route).toBeDefined();
    if (!route) return;
    expect(createPortalLabelModel(route, {
      price: 1234.5,
      population: 1_204,
      connectionMode: 'online',
      feedMode: 'live',
    })).toMatchObject({
      priceText: '$1,234.5',
      populationText: '1,204 ONLINE',
      marketText: 'LIVE',
      text: `${route.destination}\n$1,234.5 · LIVE\n1,204 ONLINE`,
    });
    expect(createPortalLabelModel(route, {
      price: null,
      population: null,
      connectionMode: 'offline',
      feedMode: 'live',
    })).toMatchObject({
      priceText: '$—',
      populationText: 'SOLO WORLD',
      text: `${route.destination}\n$— · LIVE\nSOLO WORLD`,
    });
    expect(formatPortalPopulation(0, 'online')).toBe('0 ONLINE');
    expect(formatPortalPopulation(1, 'online')).toBe('1 ONLINE');
    expect(formatPortalPopulation(Number.NaN, 'online')).toBe('— ONLINE');
    expect(formatPortalPopulation(-4, 'online')).toBe('— ONLINE');
    expect(formatPortalPopulation(null, 'connecting')).toBe('CONNECTING');
    expect(formatPortalPopulation(null, 'offline')).toBe('SOLO WORLD');
  });

  it('shows truthful connected population labels for every destination in every world', () => {
    for (const activeMarket of ASSET_SYMBOLS) {
      for (const [index, route] of createPortalRoutes(activeMarket).entries()) {
        const population = index;
        const label = createPortalLabelModel(route, {
          price: 100 + index,
          population,
          connectionMode: 'online',
          feedMode: route.destination === 'TEST' ? 'simulated' : 'live',
        });
        expect(label.populationText).toBe(`${population} ONLINE`);
        expect(label.populationText).not.toContain('OFFLINE');
        expect(label.marketText).toBe(route.destination === 'TEST' ? 'DEMO' : 'LIVE');
      }
    }
  });

  it('assigns non-overlapping label cards and line bands in every world', () => {
    const lines = portalLabelLineBounds();
    expect(lines.title.bottom - lines.status.top).toBeGreaterThanOrEqual(
      PORTAL_LABEL_LAYOUT.minimumLineGap,
    );
    expect(lines.status.bottom - lines.population.top).toBeGreaterThanOrEqual(
      PORTAL_LABEL_LAYOUT.minimumLineGap,
    );

    for (const activeMarket of ASSET_SYMBOLS) {
      const routes = createPortalRoutes(activeMarket);
      const rows = assignPortalLabelRows(routes);
      expect(rows.size).toBe(ASSET_SYMBOLS.length - 1);
      expect([...rows.values()].every((row) => row >= 0 && Number.isInteger(row))).toBe(true);
      for (let firstIndex = 0; firstIndex < routes.length; firstIndex += 1) {
        const first = routes[firstIndex]!;
        // Portals and their cards sit beyond the central chart/plaza sightline.
        expect(Math.hypot(first.x, first.z) - 2.05).toBeGreaterThan(31);
        expect(Math.hypot(first.x, first.z)).toBeLessThan(62);
        const firstRow = rows.get(first.id) ?? 0;
        expect(portalLabelCenterY(firstRow) - PORTAL_LABEL_LAYOUT.cardHeight * 0.5)
          .toBeGreaterThan(2.22 + 2.05);
        for (let secondIndex = firstIndex + 1; secondIndex < routes.length; secondIndex += 1) {
          const second = routes[secondIndex]!;
          expect(portalLabelCardsOverlap(
            first,
            firstRow,
            second,
            rows.get(second.id) ?? 0,
          )).toBe(false);
        }
      }
    }
  });
});

describe('portal dwell state', () => {
  it('requires three grounded seconds and then applies re-entry cooldown', () => {
    const route = createPortalRoutes('BTC')[0];
    expect(route).toBeDefined();
    if (!route) return;
    const dwell = new PortalDwellController([route]);
    const probe = { x: route.x, z: route.z, grounded: true };
    let completion = null;
    for (let elapsed = 0; elapsed < PORTAL_DWELL_SECONDS - 0.1; elapsed += 0.1) {
      completion = dwell.update(0.1, probe).completed;
    }
    expect(completion).toBeNull();
    expect(dwell.update(0.11, probe).completed).toBe(route);
    expect(dwell.snapshot().phase).toBe('cooldown');
  });

  it('cancels when the player leaves, jumps, or is disabled', () => {
    const route = createPortalRoutes('BTC')[0];
    expect(route).toBeDefined();
    if (!route) return;
    const dwell = new PortalDwellController([route]);
    dwell.update(1, { x: route.x, z: route.z, grounded: true });
    expect(dwell.update(0.1, { x: route.x + 10, z: route.z, grounded: true }).cancelled).toBe(route);
    dwell.update(1, { x: route.x, z: route.z, grounded: true });
    expect(dwell.update(0.1, { x: route.x, z: route.z, grounded: false }).cancelled).toBe(route);
    dwell.update(1, { x: route.x, z: route.z, grounded: true });
    expect(dwell.update(0.1, { x: route.x, z: route.z, grounded: true, enabled: false }).cancelled).toBe(route);
  });
});

describe('PortalSystem presentation', () => {
  it('builds shared-geometry portals, updates labels, and requests one trip', () => {
    const parent = new THREE.Group();
    const travel = vi.fn();
    const system = new PortalSystem({ parent, activeMarket: 'BTC', onTravelRequested: travel });
    const route = system.getRoutes()[0];
    expect(route).toBeDefined();
    if (!route) return;
    expect(parent.children).toContain(system.root);
    expect(system.getDebugStats()).toMatchObject({
      activeMarket: 'BTC',
      portals: ASSET_SYMBOLS.length - 1,
      labels: (ASSET_SYMBOLS.length - 1) * 2,
    });

    system.setLiveData(route.destination, {
      price: 42.25,
      population: 18,
      connectionMode: 'online',
      feedMode: 'live',
    });
    const texts: Text[] = [];
    const ringGeometries = new Set<THREE.BufferGeometry>();
    const labelCards: THREE.Mesh[] = [];
    system.root.traverse((object) => {
      if (object instanceof Text) texts.push(object);
      if (object.name.endsWith('-ring') && object instanceof THREE.Mesh) ringGeometries.add(object.geometry);
      if (object.name.endsWith('-label-card') && object instanceof THREE.Mesh) labelCards.push(object);
    });
    expect(ringGeometries.size).toBe(1);
    expect(labelCards).toHaveLength((ASSET_SYMBOLS.length - 1) * 2);
    expect(labelCards.every(({ material }) => (
      !Array.isArray(material)
      && material.transparent === false
      && material.depthWrite === true
      && material.opacity === 1
    ))).toBe(true);
    expect(texts.filter(({ text }) => text === route.destination)).toHaveLength(2);
    expect(texts.filter(({ text }) => text === '18 ONLINE')).toHaveLength(2);
    expect(texts.filter(({ text }) => text === '$42.25 · LIVE')).toHaveLength(2);

    system.setPlayerProbe({ x: route.x, z: route.z, grounded: true });
    for (let frame = 0; frame < 31; frame += 1) system.update(0.1, frame * 0.1);
    expect(travel).toHaveBeenCalledTimes(1);
    expect(travel).toHaveBeenCalledWith(route);
    system.update(0.1, 4);
    expect(travel).toHaveBeenCalledTimes(1);

    system.dispose();
    system.dispose();
    expect(parent.children).not.toContain(system.root);
    expect(system.root.children).toHaveLength(0);
  });

  it('rebuilds destination mapping when the active market changes', () => {
    const system = new PortalSystem({ parent: new THREE.Group(), activeMarket: 'BTC' });
    system.setActiveMarket('SOL');
    expect(system.getRoutes().map(({ destination }) => destination)).not.toContain('SOL');
    expect(system.getRoutes().map(({ destination }) => destination)).toContain('BTC');
    expect(system.getDebugStats()).toMatchObject({
      activeMarket: 'SOL', portals: ASSET_SYMBOLS.length - 1,
    });
    system.dispose();
  });
});
