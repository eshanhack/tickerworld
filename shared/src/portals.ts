import { MARKET_SLUGS } from './constants.js';
import type { MarketSlug, PortalRoute } from './contracts.js';

// Canonical directions derived from the original BTC roads. The inner ring
// clears the complete chart/plaza presentation, while DEX destinations remain
// on a distinct field ring. These values are shared with spawn allocation so
// server-authoritative arrivals always land beyond the portal they used.
export const PORTAL_RADIUS = 36;
export const DEX_FIELD_PORTAL_RADIUS = 58;
/**
 * A quiet outer discovery ring for the larger equities, indices, commodity,
 * and Hyperliquid worlds. Keeping it separate from the original road spokes
 * leaves the chart plaza readable even as the world catalogue grows.
 */
export const SIGNATURE_WORLD_PORTAL_RADIUS = 68;
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
  // These bearings intentionally use an offset eleven-point ring. None lands
  // on the east/west parkour axis, and the larger radius gives each label a
  // generous arc-length clearance from its neighbours.
  skhynix: [0.9659, 0.2588],
  hype: [0.5900, 0.8074],
  xyz100: [0.0024, 1],
  sp500: [-0.5861, 0.8102],
  micron: [-0.9647, 0.2631],
  spacex: [-0.8978, -0.4404],
  nvidia: [-0.4170, -0.9089],
  gold: [0.1680, -0.9858],
  apple: [0.6997, -0.7144],
  meta: [0.9927, -0.1205],
  google: [0.7631, 0.6463],
};

const FIELD_PORTAL_MARKETS = new Set<MarketSlug>(['pump', 'ansem', 'shfl']);
const SIGNATURE_WORLD_MARKETS = new Set<MarketSlug>([
  'skhynix',
  'hype',
  'xyz100',
  'sp500',
  'micron',
  'spacex',
  'nvidia',
  'gold',
  'apple',
  'meta',
  'google',
]);

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
    const radius = SIGNATURE_WORLD_MARKETS.has(btcDestination)
      ? SIGNATURE_WORLD_PORTAL_RADIUS
      : FIELD_PORTAL_MARKETS.has(btcDestination)
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
