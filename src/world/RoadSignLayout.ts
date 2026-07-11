import { GRAND_MONUMENTS } from '../config';
import type { AssetSymbol } from '../types';

export const ROAD_SIGN_RADIAL_OFFSET = 22;
export const ROAD_SIGN_SHOULDER_OFFSET = 6.25;
export const ROAD_SIGN_PROP_CLEARANCE = 4.5;

export interface WayfindingCoordinate {
  readonly symbol: AssetSymbol;
  readonly x: number;
  readonly z: number;
  readonly scale?: number;
}

export interface RoadVector {
  readonly x: number;
  readonly z: number;
}

/** One of the seven canonical, bidirectional roads radiating from BTC. */
export interface CanonicalRoadDescriptor {
  readonly id: string;
  readonly btc: WayfindingCoordinate;
  readonly market: WayfindingCoordinate;
  readonly distance: number;
  /** World bearing in radians: 0 points north (-Z), PI / 2 points east (+X). */
  readonly bearing: number;
  readonly direction: RoadVector;
  readonly tangent: RoadVector;
  readonly btcShoulder: -1 | 1;
}

/** A single destination board placed beside one directed road entrance. */
export interface RoadSignDescriptor {
  readonly id: string;
  readonly roadId: string;
  readonly origin: WayfindingCoordinate;
  readonly destination: WayfindingCoordinate;
  readonly direction: RoadVector;
  readonly tangent: RoadVector;
  readonly bearing: number;
  readonly shoulder: -1 | 1;
  readonly x: number;
  readonly z: number;
  readonly distance: number;
  readonly label: string;
}

export interface RoadSignExclusionPoint {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Returns the true horizontal world bearing, using Tickerworld's -Z-forward convention. */
export function bearingBetween(
  from: Pick<WayfindingCoordinate, 'x' | 'z'>,
  to: Pick<WayfindingCoordinate, 'x' | 'z'>,
): number {
  return Math.atan2(to.x - from.x, -(to.z - from.z));
}

/** Converts a bearing into a unit vector on the XZ plane. */
export function directionForBearing(bearing: number): RoadVector {
  return { x: Math.sin(bearing), z: -Math.cos(bearing) };
}

/** World distances are presented as friendly metres rounded to the nearest ten. */
export function formatWayfindingDistance(distance: number): string {
  const rounded = Math.max(0, Math.round(finiteOrZero(distance) / 10) * 10);
  return `${rounded}m`;
}

function normalizedBearing(bearing: number): number {
  const fullTurn = Math.PI * 2;
  return ((bearing % fullTurn) + fullTurn) % fullTurn;
}

function signPosition(
  origin: Pick<WayfindingCoordinate, 'x' | 'z'>,
  direction: RoadVector,
  tangent: RoadVector,
  shoulder: -1 | 1,
): RoadVector {
  return {
    x: origin.x
      + direction.x * ROAD_SIGN_RADIAL_OFFSET
      + tangent.x * shoulder * ROAD_SIGN_SHOULDER_OFFSET,
    z: origin.z
      + direction.z * ROAD_SIGN_RADIAL_OFFSET
      + tangent.z * shoulder * ROAD_SIGN_SHOULDER_OFFSET,
  };
}

function minimumDistanceToChosen(position: RoadVector, chosen: readonly RoadVector[]): number {
  if (chosen.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...chosen.map((other) => Math.hypot(position.x - other.x, position.z - other.z)));
}

/**
 * Builds the fixed BTC spoke graph. Shoulder choice is deterministic and
 * greedily maximises space between the seven signs clustered around BTC.
 */
export function createCanonicalRoadDescriptors(
  monuments: readonly WayfindingCoordinate[] = GRAND_MONUMENTS,
): readonly CanonicalRoadDescriptor[] {
  const btc = monuments.find((candidate) => candidate.symbol === 'BTC');
  if (!btc) return [];

  const candidates = monuments
    .filter((candidate) => candidate.symbol !== 'BTC')
    .map((market) => {
      const bearing = bearingBetween(btc, market);
      const direction = directionForBearing(bearing);
      return {
        market,
        bearing,
        direction,
        tangent: { x: -direction.z, z: direction.x },
        distance: Math.hypot(market.x - btc.x, market.z - btc.z),
      };
    })
    .sort((left, right) => (
      normalizedBearing(left.bearing) - normalizedBearing(right.bearing)
      || left.market.symbol.localeCompare(right.market.symbol)
    ));

  const chosenPositions: RoadVector[] = [];
  return candidates.map((candidate, index): CanonicalRoadDescriptor => {
    const leftPosition = signPosition(btc, candidate.direction, candidate.tangent, -1);
    const rightPosition = signPosition(btc, candidate.direction, candidate.tangent, 1);
    const leftClearance = minimumDistanceToChosen(leftPosition, chosenPositions);
    const rightClearance = minimumDistanceToChosen(rightPosition, chosenPositions);
    const tieBreak: -1 | 1 = index % 2 === 0 ? -1 : 1;
    const btcShoulder: -1 | 1 = Math.abs(leftClearance - rightClearance) < 1e-9
      ? tieBreak
      : leftClearance > rightClearance ? -1 : 1;
    chosenPositions.push(btcShoulder === -1 ? leftPosition : rightPosition);

    return {
      id: `road-BTC-${candidate.market.symbol}`,
      btc,
      market: candidate.market,
      distance: candidate.distance,
      bearing: candidate.bearing,
      direction: candidate.direction,
      tangent: candidate.tangent,
      btcShoulder,
    };
  });
}

function directedSign(
  road: CanonicalRoadDescriptor,
  origin: WayfindingCoordinate,
  destination: WayfindingCoordinate,
  direction: RoadVector,
  tangent: RoadVector,
  bearing: number,
  shoulder: -1 | 1,
): RoadSignDescriptor {
  const position = signPosition(origin, direction, tangent, shoulder);
  return {
    id: `road-sign-${origin.symbol}-to-${destination.symbol}`,
    roadId: road.id,
    origin,
    destination,
    direction,
    tangent,
    bearing,
    shoulder,
    x: position.x,
    z: position.z,
    distance: road.distance,
    label: `↑ ${destination.symbol} · ${formatWayfindingDistance(road.distance)}`,
  };
}

/** Creates seven outbound BTC signs and seven return-to-BTC signs. */
export function createRoadSignDescriptors(
  monuments: readonly WayfindingCoordinate[] = GRAND_MONUMENTS,
): readonly RoadSignDescriptor[] {
  return createCanonicalRoadDescriptors(monuments).flatMap((road) => {
    const returnDirection = { x: -road.direction.x, z: -road.direction.z };
    const returnTangent = { x: -road.tangent.x, z: -road.tangent.z };
    return [
      directedSign(
        road,
        road.btc,
        road.market,
        road.direction,
        road.tangent,
        road.bearing,
        road.btcShoulder,
      ),
      // Opposite local shoulder keeps both endpoint signs on the same world
      // side of their shared road.
      directedSign(
        road,
        road.market,
        road.btc,
        returnDirection,
        returnTangent,
        bearingBetween(road.market, road.btc),
        road.btcShoulder === -1 ? 1 : -1,
      ),
    ];
  });
}

/**
 * Builds the seven signs visible in a bounded market world. The canonical BTC
 * spokes keep their bearings; in an outer market's former slot the sign points
 * back to BTC, matching the portal occupying that road.
 */
export function createMarketRoadSignDescriptors(
  activeMarket: AssetSymbol,
  monuments: readonly WayfindingCoordinate[] = GRAND_MONUMENTS,
): readonly RoadSignDescriptor[] {
  return createCanonicalRoadDescriptors(monuments).map((road) => {
    if (activeMarket !== 'BTC' && road.market.symbol === activeMarket) {
      return directedSign(
        road,
        { ...road.market, x: road.btc.x, z: road.btc.z },
        road.btc,
        road.direction,
        road.tangent,
        road.bearing,
        road.btcShoulder,
      );
    }
    return directedSign(
      road,
      { ...road.btc, symbol: activeMarket },
      road.market,
      road.direction,
      road.tangent,
      road.bearing,
      road.btcShoulder,
    );
  });
}

/** Positions reserved from generated lamps and benches. */
export function createRoadSignExclusionPoints(
  monuments: readonly WayfindingCoordinate[] = GRAND_MONUMENTS,
): readonly RoadSignExclusionPoint[] {
  return createRoadSignDescriptors(monuments).map(({ x, z }) => ({
    x,
    z,
    radius: ROAD_SIGN_PROP_CLEARANCE,
  }));
}
