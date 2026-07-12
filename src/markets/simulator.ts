import type { AssetState, AssetSymbol, Candle } from '../types';

export const BASE_PRICES: Record<AssetSymbol, number> = {
  BTC: 118_000,
  ETH: 3_450,
  SOL: 178,
  XRP: 2.85,
  DOGE: 0.245,
  BNB: 725,
  LINK: 18.5,
  AVAX: 24.8,
  WTI: 74,
  TEST: 100,
};

const VOLATILITY: Record<AssetSymbol, number> = {
  BTC: 0.0012,
  ETH: 0.0015,
  SOL: 0.0021,
  XRP: 0.002,
  DOGE: 0.0026,
  BNB: 0.0014,
  LINK: 0.002,
  AVAX: 0.0022,
  WTI: 0.0014,
  // TEST history stays compact enough that its much larger live moves remain
  // visually legible instead of disappearing inside an oversized seed range.
  TEST: 0.0045,
};

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(random: () => number): number {
  const first = Math.max(1e-7, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(Math.PI * 2 * second);
}

export function createSimulatedCandles(
  symbol: AssetSymbol,
  now = Date.now(),
  count = 30,
  seedSuffix = '',
): Candle[] {
  const random = mulberry32(hashString(`${symbol}:${Math.floor(now / 3_600_000)}:${seedSuffix}`));
  const minute = Math.floor(now / 60_000) * 60_000;
  const volatility = VOLATILITY[symbol];
  let price = BASE_PRICES[symbol] * (0.94 + random() * 0.12);
  const candles: Candle[] = [];

  for (let index = count - 1; index >= 0; index -= 1) {
    const openTime = minute - index * 60_000;
    const open = price;
    const close = open * Math.exp(gaussian(random) * volatility * 2.2);
    const spread = Math.abs(gaussian(random)) * volatility * open * 1.6;
    const high = Math.max(open, close) + spread;
    const low = Math.max(0.0000001, Math.min(open, close) - spread * (0.7 + random() * 0.6));
    candles.push({ openTime, open, high, low, close, closed: index !== 0 });
    price = close;
  }
  return candles;
}

/** Deterministic coarser history used only by the explicit simulation QA mode. */
export function createSimulatedHistory(
  symbol: AssetSymbol,
  now: number,
  count: number,
  intervalMs: number,
  seedSuffix = '',
  targetLatestPrice?: number,
): Candle[] {
  const safeInterval = Math.max(60_000, Math.floor(intervalMs));
  const bucket = Math.floor(now / safeInterval) * safeInterval;
  const random = mulberry32(hashString(`${symbol}:${bucket}:${safeInterval}:${seedSuffix}`));
  const intervalScale = Math.min(22, Math.sqrt(safeInterval / 60_000) * 0.52);
  const volatility = VOLATILITY[symbol] * intervalScale;
  let price = BASE_PRICES[symbol] * (0.9 + random() * 0.2);
  const candles: Candle[] = [];

  for (let index = Math.max(0, Math.floor(count)) - 1; index >= 0; index -= 1) {
    const openTime = bucket - index * safeInterval;
    const open = price;
    const close = Math.max(0.0000001, open * Math.exp(gaussian(random) * volatility * 2.2));
    const spread = Math.abs(gaussian(random)) * volatility * open * 1.3;
    const high = Math.max(open, close) + spread;
    const low = Math.max(0.0000001, Math.min(open, close) - spread * (0.7 + random() * 0.6));
    candles.push({ openTime, open, high, low, close, closed: index !== 0 });
    price = close;
  }

  const latest = candles.at(-1);
  if (!latest || targetLatestPrice === undefined || !Number.isFinite(targetLatestPrice) || targetLatestPrice <= 0) {
    return candles;
  }
  const scale = targetLatestPrice / latest.close;
  return candles.map((candle) => ({
    ...candle,
    open: candle.open * scale,
    high: candle.high * scale,
    low: candle.low * scale,
    close: candle.close * scale,
  }));
}

export function stepSimulation(
  state: AssetState,
  random: () => number,
  now = Date.now(),
  candleLimit = 30,
): AssetState {
  const latest = state.candles[state.candles.length - 1];
  if (!latest) return state;

  const openTime = Math.floor(now / 60_000) * 60_000;
  const move = gaussian(random) * VOLATILITY[state.symbol] * 0.38;
  const currentPrice = state.price ?? latest.close;
  const nextPrice = Math.max(0.0000001, currentPrice * Math.exp(move));
  let candles = [...state.candles];

  if (latest.openTime < openTime) {
    candles[candles.length - 1] = { ...latest, closed: true };
    candles.push({
      openTime,
      open: currentPrice,
      high: Math.max(currentPrice, nextPrice),
      low: Math.min(currentPrice, nextPrice),
      close: nextPrice,
      closed: false,
    });
    candles = candles.slice(-Math.max(1, Math.floor(candleLimit)));
  } else {
    candles[candles.length - 1] = {
      ...latest,
      high: Math.max(latest.high, nextPrice),
      low: Math.min(latest.low, nextPrice),
      close: nextPrice,
      closed: false,
    };
  }

  return {
    ...state,
    candles,
    instrument: state.symbol,
    provider: 'simulation',
    previousPrice: currentPrice,
    price: nextPrice,
    direction: nextPrice > currentPrice ? 'up' : nextPrice < currentPrice ? 'down' : 'flat',
    mode: 'simulated',
    updateKind: 'simulation',
    updatedAt: now,
    presentationTick: state.presentationTick + 1,
  };
}

const TEST_EVENT_RATIOS = [
  0.00004,
  0.0028,
  0.0075,
  0.018,
  0.00006,
  -0.0032,
  -0.009,
  -0.021,
  -0.00005,
  0.004,
  0.011,
  0.024,
  0.00008,
  -0.005,
  -0.013,
  -0.026,
] as const;

/**
 * TEST deliberately cycles through calm, large, and exceptional moves in both
 * directions. Calm frames re-arm the shared celebration gate, so QA sessions
 * repeatedly exercise pulses, fireworks, fanfares, sirens, and sky flashes.
 */
export function stepTestSimulation(
  state: AssetState,
  now = Date.now(),
  candleLimit = 30,
): AssetState {
  const latest = state.candles.at(-1);
  if (!latest) return state;
  const openTime = Math.floor(now / 60_000) * 60_000;
  let candles = [...state.candles];
  let active = latest;
  if (latest.openTime < openTime) {
    candles[candles.length - 1] = { ...latest, closed: true };
    active = {
      openTime,
      open: state.price ?? latest.close,
      high: state.price ?? latest.close,
      low: state.price ?? latest.close,
      close: state.price ?? latest.close,
      closed: false,
    };
    candles.push(active);
    candles = candles.slice(-Math.max(1, Math.floor(candleLimit)));
  }

  const ratio = TEST_EVENT_RATIOS[state.presentationTick % TEST_EVENT_RATIOS.length] ?? 0;
  const nextPrice = Math.max(0.0000001, active.open * (1 + ratio));
  const previousPrice = state.price ?? active.close;
  candles[candles.length - 1] = {
    ...active,
    high: Math.max(active.high, nextPrice),
    low: Math.min(active.low, nextPrice),
    close: nextPrice,
    closed: false,
  };
  return {
    ...state,
    candles,
    instrument: 'TEST',
    provider: 'simulation',
    previousPrice,
    price: nextPrice,
    direction: nextPrice > previousPrice ? 'up' : nextPrice < previousPrice ? 'down' : 'flat',
    mode: 'simulated',
    updateKind: 'simulation',
    updatedAt: now,
    presentationTick: state.presentationTick + 1,
  };
}
