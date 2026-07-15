import { formatPrice } from '../monuments/chartMath';
import { marketPath } from '../routing';
import type { AssetSymbol, FeedMode } from '../types';
import {
  DEX_FIELD_PORTAL_RADIUS,
  PORTAL_ARRIVAL_OFFSET,
  PORTAL_RADIUS,
  SIGNATURE_WORLD_PORTAL_RADIUS,
  createPortalRoutes as createSharedPortalRoutes,
} from '../../shared/src/portals.js';
import { marketForSymbol, symbolForMarket } from '../../shared/src/validation.js';
import { MARKET_ROOM_MAX_CLIENTS } from '../../shared/src/constants.js';
import {
  type CanonicalRoadDescriptor,
  type RoadVector,
} from '../world/RoadSignLayout';

export {
  DEX_FIELD_PORTAL_RADIUS,
  PORTAL_ARRIVAL_OFFSET,
  PORTAL_RADIUS,
  SIGNATURE_WORLD_PORTAL_RADIUS,
};

const DEX_FIELD_PORTALS = new Set<AssetSymbol>(['PUMP', 'ANSEM', 'SHFL']);

export interface PortalRoute {
  readonly id: string;
  readonly activeMarket: AssetSymbol;
  readonly destination: AssetSymbol;
  /** The original BTC spoke whose bearing this portal occupies. */
  readonly slotMarket: Exclude<AssetSymbol, 'BTC'>;
  readonly destinationPath: ReturnType<typeof marketPath>;
  readonly bearing: number;
  readonly direction: RoadVector;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly isReturnPortal: boolean;
}

export type PortalConnectionMode = 'online' | 'connecting' | 'offline';

export interface PortalLiveData {
  readonly price: number | null;
  readonly feedMode?: FeedMode;
  /** Aggregate population across every shard for this destination. */
  readonly population: number | null;
  /** Sum of advertised channel seats for this destination. */
  readonly capacity?: number | null;
  readonly connectionMode?: PortalConnectionMode;
}

export interface PortalLabelModel {
  readonly destination: AssetSymbol;
  readonly title: string;
  readonly priceText: string;
  readonly populationText: string;
  readonly marketText: string;
  readonly connectionMode: PortalConnectionMode;
  readonly text: string;
}

export interface PortalArrivalSpawn {
  readonly x: number;
  readonly z: number;
  /** FoxPlayer yaw that faces from the arrival point back toward the plaza. */
  readonly facingYaw: number;
  readonly returnPortal: PortalRoute;
}

/** Solo/offline counterpart to the server's near-chart spawn grid. */
export const PORTAL_CENTRE_SPAWN = Object.freeze({
  x: 0,
  z: -18,
  facingYaw: Math.PI,
});

export function formatPortalPopulation(
  population: number | null,
  connectionMode: PortalConnectionMode,
  advertisedCapacity: number | null = null,
): string {
  const populationCount = population !== null && Number.isFinite(population) && population >= 0
    ? Math.floor(population)
    : null;
  const capacityCount = advertisedCapacity !== null
    && Number.isFinite(advertisedCapacity)
    && advertisedCapacity > 0
    ? Math.floor(advertisedCapacity)
    : MARKET_ROOM_MAX_CLIENTS;
  const minimumCapacity = populationCount === null
    ? MARKET_ROOM_MAX_CLIENTS
    : Math.max(MARKET_ROOM_MAX_CLIENTS, Math.ceil(populationCount / MARKET_ROOM_MAX_CLIENTS) * MARKET_ROOM_MAX_CLIENTS);
  const capacity = Math.max(capacityCount, minimumCapacity);
  // A room outage never makes the destination world unavailable. Keep the
  // occupancy unknown rather than rebranding the whole experience as solo.
  if (connectionMode === 'offline') return `— / ${capacity.toLocaleString('en-US')} PEOPLE INSIDE`;
  if (connectionMode === 'connecting') return 'CONNECTING';
  if (populationCount === null) {
    return `— / ${capacity.toLocaleString('en-US')} PEOPLE INSIDE`;
  }
  return `${populationCount.toLocaleString('en-US')} / ${capacity.toLocaleString('en-US')} PEOPLE INSIDE`;
}

function asSlotMarket(symbol: AssetSymbol): Exclude<AssetSymbol, 'BTC'> {
  if (symbol === 'BTC') throw new Error('BTC does not own a radial portal slot.');
  return symbol;
}

/**
 * Maps the nine canonical BTC spokes onto a bounded single-ticker world.
 * A non-BTC world's own spoke becomes its return route to BTC.
 */
export function createPortalRoutes(
  activeMarket: AssetSymbol,
  roads?: readonly CanonicalRoadDescriptor[],
): readonly PortalRoute[] {
  if (!roads) {
    const activeSlug = marketForSymbol(activeMarket);
    const routes = createSharedPortalRoutes(activeSlug);
    const btcSlots = createSharedPortalRoutes('btc');
    return routes.map((route, index) => {
      const btcSlot = btcSlots[index];
      if (!btcSlot) throw new Error(`Missing canonical portal slot ${index}.`);
      const destination = symbolForMarket(route.to);
      const slotMarket = asSlotMarket(symbolForMarket(btcSlot.to));
      const radius = Math.hypot(route.x, route.z);
      const direction = radius > 0
        ? { x: route.x / radius, z: route.z / radius }
        : { x: 0, z: -1 };
      return {
        id: `portal-${activeMarket}-to-${destination}`,
        activeMarket,
        destination,
        slotMarket,
        destinationPath: marketPath(destination),
        bearing: Math.atan2(direction.x, -direction.z),
        direction,
        x: route.x,
        z: route.z,
        radius,
        isReturnPortal: destination === 'BTC',
      };
    });
  }
  return roads.map((road) => {
    const slotMarket = asSlotMarket(road.market.symbol);
    const destination = activeMarket !== 'BTC' && slotMarket === activeMarket
      ? 'BTC'
      : slotMarket;
    const radius = DEX_FIELD_PORTALS.has(slotMarket) ? DEX_FIELD_PORTAL_RADIUS : PORTAL_RADIUS;
    return {
      id: `portal-${activeMarket}-to-${destination}`,
      activeMarket,
      destination,
      slotMarket,
      destinationPath: marketPath(destination),
      bearing: road.bearing,
      direction: road.direction,
      x: road.direction.x * radius,
      z: road.direction.z * radius,
      radius,
      isReturnPortal: destination === 'BTC',
    };
  });
}

export function createPortalLabelModel(
  route: PortalRoute,
  live: PortalLiveData,
): PortalLabelModel {
  const connectionMode = live.connectionMode ?? (live.population === null ? 'offline' : 'online');
  const priceText = formatPrice(live.price);
  const populationText = formatPortalPopulation(live.population, connectionMode, live.capacity ?? null);
  const marketText = live.feedMode === 'simulated'
    ? 'DEMO'
    : live.feedMode === 'live'
      ? 'LIVE'
      : live.feedMode === 'reconnecting'
        ? 'RECONNECTING'
        : 'CONNECTING';
  return {
    destination: route.destination,
    title: route.destination,
    priceText,
    populationText,
    marketText,
    connectionMode,
    text: `${route.destination}\n${priceText} · ${marketText}\n${populationText}`,
  };
}

/** Finds the return route while placing the player near the destination chart. */
export function portalArrivalSpawn(
  activeMarket: AssetSymbol,
  previousMarket: AssetSymbol,
  routes: readonly PortalRoute[] = createPortalRoutes(activeMarket),
): PortalArrivalSpawn | null {
  const returnPortal = routes.find((route) => route.destination === previousMarket);
  if (!returnPortal) return null;
  return {
    ...PORTAL_CENTRE_SPAWN,
    returnPortal,
  };
}
