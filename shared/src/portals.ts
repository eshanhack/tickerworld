import { MARKET_SLUGS } from './constants.js';
import type { MarketSlug, PortalRoute } from './contracts.js';

// Canonical directions derived from the original BTC roads. The inner ring
// clears the complete chart/plaza presentation, while DEX destinations remain
// on a distinct field ring. These values are shared with spawn allocation so
// server-authoritative arrivals always land beyond the portal they used.
export const PORTAL_RADIUS = 36;
export const DEX_FIELD_PORTAL_RADIUS = 58;
export const PORTAL_ARRIVAL_OFFSET = 4.5;

const ROAD_TARGETS: Readonly<Record<Exclude<MarketSlug, 'btc'>, readonly [number, number]>> = {
  eth: [190, 70],
  sol: [-240, 150],
  xrp: [100, -310],
  doge: [380, 220],
  bnb: [-420, -240],
  link: [-80, 520],
  avax: [510, -400],
  wti: [450, 780],
  test: [-620, 0],
  pump: [-500, 720],
  ansem: [-420, -780],
  shfl: [710, -560],
};

const FIELD_PORTAL_MARKETS = new Set<MarketSlug>(['pump', 'ansem', 'shfl']);

const BTC_DESTINATIONS = MARKET_SLUGS.filter(
  (market): market is Exclude<MarketSlug, 'btc'> => market !== 'btc',
);

export function createPortalRoutes(activeMarket: MarketSlug): readonly PortalRoute[] {
  return BTC_DESTINATIONS.map((btcDestination, slot) => {
    const target = activeMarket === 'btc'
      ? btcDestination
      : btcDestination === activeMarket
        ? 'btc'
        : btcDestination;
    const [roadX, roadZ] = ROAD_TARGETS[btcDestination];
    const roadLength = Math.hypot(roadX, roadZ);
    const radius = FIELD_PORTAL_MARKETS.has(btcDestination)
      ? DEX_FIELD_PORTAL_RADIUS
      : PORTAL_RADIUS;
    const x = roadX / roadLength * radius;
    const z = roadZ / roadLength * radius;
    return {
      slot,
      from: activeMarket,
      to: target,
      x,
      z,
      yaw: Math.atan2(-x, -z),
    };
  });
}
