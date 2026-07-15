import type { AssetSymbol } from '../types';
import type { LiveTradeExchange, TradeTier } from './types';

export interface TradeTierThresholds {
  /** Values below this are dust. */
  readonly minor: number;
  readonly notable: number;
  readonly big: number;
  readonly whale: number;
}

export interface TradeAudioConfig {
  readonly minimumTier: Exclude<TradeTier, 'dust'>;
  readonly maxVoices: number;
  readonly defaultVolume: number;
  readonly peakGain: number;
  readonly subPeakGain: number;
}

export interface TradeHologramConfig {
  readonly maxVisible: number;
  readonly holdSeconds: number;
  readonly materializeSeconds: number;
  readonly dissolveSeconds: number;
  readonly coalesceSeconds: number;
  readonly bigScale: number;
  readonly whaleScale: number;
  readonly overflowScale: number;
  readonly dissolveParticles: number;
  readonly dissolveCapacity: number;
  readonly minimumTier: 'big';
}

export interface TradeSurgeConfig {
  readonly minuteMoveRatio: number;
  readonly imbalanceRatio: number;
  readonly minimumTenSecondNotionalUsd: number;
  readonly tintStrength: number;
  readonly attackSeconds: number;
  readonly holdSeconds: number;
  readonly releaseSeconds: number;
  readonly cooldownSeconds: number;
  readonly repeatHoldExtensionSeconds: number;
  readonly maximumHoldSeconds: number;
  readonly reducedMotionStrengthMultiplier: number;
}

export interface MarketTradeConfig {
  readonly referencePrice: number;
  readonly pairs: Readonly<Partial<Record<LiveTradeExchange, string>>>;
  readonly tiers: TradeTierThresholds;
  readonly audio: TradeAudioConfig;
  readonly hologram: TradeHologramConfig;
  readonly surge: TradeSurgeConfig;
}

export const TRADE_AGGREGATION_CONFIG = Object.freeze({
  aggregationWindowMs: 75,
  flushIntervalMs: 150,
  socketStaleMs: 20_000,
  socketOpenTimeoutMs: 8_000,
  subscriptionTimeoutMs: 20_000,
  heartbeatIntervalMs: 15_000,
  reconnectMinimumMs: 1_000,
  reconnectMaximumMs: 30_000,
  fallbackAfterMs: 8_000,
  simulationIntervalMs: 400,
  maxInputBatch: 512,
  maxQueuedTrades: 8_192,
  maxOutputOrders: 48,
  maxDedupeEntries: 20_000,
  maxRollingEvents: 30_000,
} as const);

const DEFAULT_AUDIO: TradeAudioConfig = Object.freeze({
  minimumTier: 'minor',
  maxVoices: 8,
  defaultVolume: 0.62,
  peakGain: 0.11,
  subPeakGain: 0.055,
});

const DEFAULT_HOLOGRAM: TradeHologramConfig = Object.freeze({
  maxVisible: 3,
  // Big prints are rare enough that the player should have time to notice
  // their projection while approaching the chart. The slot pool is still
  // bounded, so sustained tape flow pre-empts rather than accumulates.
  holdSeconds: 5,
  materializeSeconds: 0.2,
  dissolveSeconds: 1.1,
  coalesceSeconds: 1.2,
  bigScale: 1.16,
  whaleScale: 1.35,
  // Keep concurrent shoulder cards inside the chart's readable viewport even
  // when a whale-sized projection is active.
  overflowScale: 0.5,
  dissolveParticles: 16,
  dissolveCapacity: 48,
  minimumTier: 'big',
});

function surge(
  minuteMoveRatio: number,
  minimumTenSecondNotionalUsd: number,
  imbalanceRatio = 0.72,
): TradeSurgeConfig {
  return Object.freeze({
    minuteMoveRatio,
    imbalanceRatio,
    minimumTenSecondNotionalUsd,
    tintStrength: 0.16,
    attackSeconds: 1,
    holdSeconds: 0.8,
    releaseSeconds: 5,
    cooldownSeconds: 10,
    repeatHoldExtensionSeconds: 0.5,
    maximumHoldSeconds: 2.3,
    reducedMotionStrengthMultiplier: 0.5,
  });
}

function tiers(scale: number): TradeTierThresholds {
  return Object.freeze({
    minor: 1_000 * scale,
    notable: 10_000 * scale,
    big: 100_000 * scale,
    whale: 1_000_000 * scale,
  });
}

function market(
  referencePrice: number,
  pairs: MarketTradeConfig['pairs'],
  tierScale: number,
  minuteMoveRatio: number,
  minimumTenSecondNotionalUsd: number,
): MarketTradeConfig {
  return Object.freeze({
    referencePrice,
    pairs: Object.freeze({ ...pairs }),
    tiers: tiers(tierScale),
    audio: DEFAULT_AUDIO,
    hologram: DEFAULT_HOLOGRAM,
    surge: surge(minuteMoveRatio, minimumTenSecondNotionalUsd),
  });
}

/**
 * Venue symbols are deliberately explicit. USD, USDT and USDC quote notionals
 * are treated as approximately equal only for this ambient tape visualization;
 * they are never used as chart or settlement prices.
 */
export const MARKET_TRADE_CONFIG: Readonly<Record<AssetSymbol, MarketTradeConfig>> = Object.freeze({
  BTC: market(118_000, {
    hyperliquid: 'BTC', binance: 'BTCUSDT', coinbase: 'BTC-USD', okx: 'BTC-USDT',
  }, 1, 0.005, 500_000),
  ETH: market(3_450, {
    hyperliquid: 'ETH', binance: 'ETHUSDT', coinbase: 'ETH-USD', okx: 'ETH-USDT',
  }, 0.65, 0.006, 300_000),
  SOL: market(178, {
    hyperliquid: 'SOL', binance: 'SOLUSDT', coinbase: 'SOL-USD', okx: 'SOL-USDT',
  }, 0.25, 0.008, 120_000),
  XRP: market(2.85, {
    hyperliquid: 'XRP', binance: 'XRPUSDT', coinbase: 'XRP-USD', okx: 'XRP-USDT',
  }, 0.2, 0.009, 90_000),
  DOGE: market(0.245, {
    hyperliquid: 'DOGE', binance: 'DOGEUSDT', coinbase: 'DOGE-USD', okx: 'DOGE-USDT',
  }, 0.18, 0.01, 75_000),
  BNB: market(725, {
    hyperliquid: 'BNB', binance: 'BNBUSDT', okx: 'BNB-USDT',
  }, 0.45, 0.007, 180_000),
  LINK: market(18.5, {
    hyperliquid: 'LINK', binance: 'LINKUSDT', coinbase: 'LINK-USD', okx: 'LINK-USDT',
  }, 0.2, 0.009, 75_000),
  AVAX: market(24.8, {
    hyperliquid: 'AVAX', binance: 'AVAXUSDT', coinbase: 'AVAX-USD', okx: 'AVAX-USDT',
  }, 0.2, 0.009, 75_000),
  WTI: market(74, { hyperliquid: 'xyz:CL' }, 0.5, 0.006, 150_000),
  TEST: market(100, {}, 0.05, 0.02, 5_000),
  PUMP: market(0.0015, { geckoterminal: 'PUMP' }, 0.025, 0.02, 2_500),
  ANSEM: market(0.24, { geckoterminal: 'ANSEM' }, 0.025, 0.025, 2_500),
  SHFL: market(0.26, { geckoterminal: 'SHFL' }, 0.025, 0.018, 2_500),
  SKHYNIX: market(350, { hyperliquid: 'xyz:SKHX' }, 0.3, 0.007, 100_000),
  HYPE: market(38, {
    hyperliquid: 'HYPE', binance: 'HYPEUSDT', okx: 'HYPE-USDT',
  }, 0.25, 0.009, 100_000),
  XYZ100: market(25_000, { hyperliquid: 'xyz:XYZ100' }, 0.75, 0.0035, 250_000),
  SP500: market(6_500, { hyperliquid: 'xyz:SP500' }, 0.75, 0.003, 300_000),
  MU: market(320, { hyperliquid: 'xyz:MU' }, 0.35, 0.006, 120_000),
  SPACEX: market(480, { hyperliquid: 'xyz:SPCX' }, 0.25, 0.0075, 100_000),
  NVDA: market(170, { hyperliquid: 'xyz:NVDA' }, 0.35, 0.005, 150_000),
  GOLD: market(3_350, { hyperliquid: 'xyz:GOLD' }, 0.6, 0.0035, 250_000),
  AAPL: market(230, { hyperliquid: 'xyz:AAPL' }, 0.35, 0.0045, 150_000),
  META: market(700, { hyperliquid: 'xyz:META' }, 0.35, 0.005, 140_000),
  GOOGL: market(200, { hyperliquid: 'xyz:GOOGL' }, 0.35, 0.0045, 150_000),
});

export function classifyTradeTier(symbol: AssetSymbol, notionalUsd: number): TradeTier {
  const value = Number.isFinite(notionalUsd) ? Math.max(0, notionalUsd) : 0;
  const threshold = MARKET_TRADE_CONFIG[symbol].tiers;
  if (value >= threshold.whale) return 'whale';
  if (value >= threshold.big) return 'big';
  if (value >= threshold.notable) return 'notable';
  if (value >= threshold.minor) return 'minor';
  return 'dust';
}

/** Log-shaped 0..1 progress within a tier, suitable for bounded audio/visual tuning. */
export function tradeTierProgress(
  symbol: AssetSymbol,
  tier: TradeTier,
  notionalUsd: number,
): number {
  const value = Number.isFinite(notionalUsd) ? Math.max(0, notionalUsd) : 0;
  const thresholds = MARKET_TRADE_CONFIG[symbol].tiers;
  const bounds: Readonly<Record<TradeTier, readonly [number, number]>> = {
    dust: [0, thresholds.minor],
    minor: [thresholds.minor, thresholds.notable],
    notable: [thresholds.notable, thresholds.big],
    big: [thresholds.big, thresholds.whale],
    whale: [thresholds.whale, thresholds.whale * 10],
  };
  const [minimum, maximum] = bounds[tier];
  if (value <= minimum) return 0;
  if (value >= maximum) return 1;
  if (minimum <= 0) return value / maximum;
  return Math.min(1, Math.max(0, Math.log(value / minimum) / Math.log(maximum / minimum)));
}

export function exchangesForMarket(symbol: AssetSymbol): readonly LiveTradeExchange[] {
  const pairs = MARKET_TRADE_CONFIG[symbol].pairs;
  return (['hyperliquid', 'binance', 'coinbase', 'okx', 'geckoterminal'] as const)
    .filter((exchange) => Boolean(pairs[exchange]));
}
