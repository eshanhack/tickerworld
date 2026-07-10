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

export function stepSimulation(
  state: AssetState,
  random: () => number,
  now = Date.now(),
): AssetState {
  const latest = state.candles[state.candles.length - 1];
  if (!latest) return state;

  const openTime = Math.floor(now / 60_000) * 60_000;
  const move = gaussian(random) * VOLATILITY[state.symbol] * 0.38;
  const nextPrice = Math.max(0.0000001, state.price * Math.exp(move));
  let candles = [...state.candles];

  if (latest.openTime < openTime) {
    candles[candles.length - 1] = { ...latest, closed: true };
    candles.push({
      openTime,
      open: state.price,
      high: Math.max(state.price, nextPrice),
      low: Math.min(state.price, nextPrice),
      close: nextPrice,
      closed: false,
    });
    candles = candles.slice(-30);
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
    previousPrice: state.price,
    price: nextPrice,
    direction: nextPrice > state.price ? 'up' : nextPrice < state.price ? 'down' : 'flat',
    mode: 'simulated',
    updatedAt: now,
    presentationTick: state.presentationTick + 1,
  };
}
