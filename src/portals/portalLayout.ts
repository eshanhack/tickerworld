import { GRAND_MONUMENTS } from '../config';
import { formatPrice } from '../monuments/chartMath';
import { marketPath } from '../routing';
import type { AssetSymbol, FeedMode } from '../types';
import {
  createCanonicalRoadDescriptors,
  type CanonicalRoadDescriptor,
  type RoadVector,
} from '../world/RoadSignLayout';

export const PORTAL_RADIUS = 24;
export const DEX_FIELD_PORTAL_RADIUS = 47;
export const PORTAL_ARRIVAL_OFFSET = 4.5;

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

export function formatPortalPopulation(
  population: number | null,
  connectionMode: PortalConnectionMode,
): string {
  // A room outage never makes the destination world unavailable: portals keep
  // routing locally with live direct market data, so describe that truthfully.
  if (connectionMode === 'offline') return 'SOLO WORLD';
  if (connectionMode === 'connecting') return 'CONNECTING';
  if (population === null || !Number.isFinite(population) || population < 0) return '— ONLINE';
  const people = Math.floor(population);
  return `${people.toLocaleString('en-US')} ONLINE`;
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
  roads: readonly CanonicalRoadDescriptor[] = createCanonicalRoadDescriptors(GRAND_MONUMENTS),
): readonly PortalRoute[] {
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
  const populationText = formatPortalPopulation(live.population, connectionMode);
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
    text: `${route.destination}\n${marketText}\n${populationText}`,
  };
}

/** Finds the spawn just outside the portal that returns to the previous world. */
export function portalArrivalSpawn(
  activeMarket: AssetSymbol,
  previousMarket: AssetSymbol,
  routes: readonly PortalRoute[] = createPortalRoutes(activeMarket),
): PortalArrivalSpawn | null {
  const returnPortal = routes.find((route) => route.destination === previousMarket);
  if (!returnPortal) return null;
  return {
    x: returnPortal.x + returnPortal.direction.x * PORTAL_ARRIVAL_OFFSET,
    z: returnPortal.z + returnPortal.direction.z * PORTAL_ARRIVAL_OFFSET,
    facingYaw: Math.atan2(returnPortal.direction.x, returnPortal.direction.z),
    returnPortal,
  };
}
