import { MARKET_SLUGS } from './constants.js';
import type { MarketSlug, PortalRoute } from './contracts.js';

// Canonical directions derived from the original BTC roads plus the two new
// WTI and TEST portal bearings.
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
};

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
    const x = roadX / roadLength * 24;
    const z = roadZ / roadLength * 24;
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
