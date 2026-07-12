import type { AssetSymbol } from '../types';
import { MARKET_TRADE_CONFIG } from './config';
import type { NormalizedTrade, TradeTier } from './types';

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function tierBounds(symbol: AssetSymbol, tier: TradeTier): readonly [number, number] {
  const thresholds = MARKET_TRADE_CONFIG[symbol].tiers;
  switch (tier) {
    case 'dust': return [Math.max(1, thresholds.minor * 0.02), thresholds.minor * 0.95];
    case 'minor': return [thresholds.minor, thresholds.notable * 0.95];
    case 'notable': return [thresholds.notable, thresholds.big * 0.95];
    case 'big': return [thresholds.big, thresholds.whale * 0.95];
    case 'whale': return [thresholds.whale, thresholds.whale * 2.5];
  }
}

function chooseTier(random: () => number, eventLab: boolean): TradeTier {
  const roll = random();
  if (eventLab) {
    if (roll > 0.9) return 'whale';
    if (roll > 0.68) return 'big';
    if (roll > 0.38) return 'notable';
    if (roll > 0.12) return 'minor';
    return 'dust';
  }
  if (roll > 0.998) return 'whale';
  if (roll > 0.975) return 'big';
  if (roll > 0.78) return 'notable';
  if (roll > 0.28) return 'minor';
  return 'dust';
}

/** Deterministic tape-only simulation. It never creates or mutates candles. */
export class TradeTapeSimulator {
  private symbol: AssetSymbol;
  private readonly seed: string;
  private random: () => number;
  private sequence = 0;
  private price: number;

  constructor(symbol: AssetSymbol = 'BTC', seed = 'tickerworld-trade-tape-v1') {
    this.symbol = symbol;
    this.seed = seed;
    this.random = mulberry32(hashString(`${seed}:${symbol}`));
    this.price = MARKET_TRADE_CONFIG[symbol].referencePrice;
  }

  setActiveMarket(symbol: AssetSymbol): void {
    this.symbol = symbol;
    this.random = mulberry32(hashString(`${this.seed}:${symbol}`));
    this.sequence = 0;
    this.price = MARKET_TRADE_CONFIG[symbol].referencePrice;
  }

  next(now = Date.now()): NormalizedTrade[] {
    const timestamp = Number.isFinite(now) && now >= 0 ? now : Date.now();
    const eventLab = this.symbol === 'TEST';
    const count = eventLab ? 3 + Math.floor(this.random() * 6) : 1 + Math.floor(this.random() * 4);
    const trades: NormalizedTrade[] = [];
    for (let index = 0; index < count; index += 1) {
      const tier = chooseTier(this.random, eventLab);
      const [minimum, maximum] = tierBounds(this.symbol, tier);
      const notionalUsd = minimum * Math.pow(maximum / minimum, this.random());
      const side = this.random() >= 0.48 ? 'buy' : 'sell';
      const drift = (side === 'buy' ? 1 : -1) * (0.00001 + this.random() * (eventLab ? 0.0009 : 0.00006));
      this.price = Math.max(1e-9, this.price * (1 + drift));
      const baseSize = notionalUsd / this.price;
      this.sequence += 1;
      trades.push({
        id: `${this.symbol}:${this.sequence}`,
        exchange: 'simulation',
        symbol: this.symbol,
        side,
        kind: this.random() > 0.992 ? 'liquidation' : 'trade',
        price: this.price,
        baseSize,
        notionalUsd,
        timestampMs: timestamp + index,
        receivedAt: timestamp + index,
        simulated: true,
      });
    }
    return trades;
  }
}
