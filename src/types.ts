export { ASSET_SYMBOLS } from '../shared/src/index.js';
export type { AssetSymbol } from '../shared/src/index.js';
import type { AssetSymbol } from '../shared/src/index.js';
export type FeedMode = 'connecting' | 'live' | 'reconnecting' | 'simulated';
export type MarketProvider = 'hyperliquid' | 'dexscreener' | 'simulation';
export type MarketUpdateKind = 'snapshot' | 'trade' | 'candle' | 'simulation';
export type TickDirection = 'up' | 'down' | 'flat';
export type SurfaceKind = 'grass' | 'sand' | 'stone';

export const PRICE_HORIZONS = ['1m', '15m', '1h', '1d', '1w', '1mo', '1y'] as const;
export type PriceHorizon = (typeof PRICE_HORIZONS)[number];

export interface HorizonChange {
  horizon: PriceHorizon;
  referenceTime: number | null;
  referencePrice: number | null;
  /** Signed ratio where 0.012 means the price is up 1.2%. */
  changeRatio: number | null;
  direction: TickDirection;
}

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closed: boolean;
}

export interface AssetState {
  symbol: AssetSymbol;
  instrument: AssetSymbol;
  provider: MarketProvider;
  candles: readonly Candle[];
  price: number | null;
  previousPrice: number | null;
  direction: TickDirection;
  mode: FeedMode;
  /** Identifies the event that produced this state so presentation side-effects stay truthful. */
  updateKind: MarketUpdateKind;
  updatedAt: number;
  /** Age of the last genuine upstream value when relayed or reconnecting. */
  ageMs?: number | null;
  presentationTick: number;
  horizonChanges: readonly HorizonChange[];
}

export interface MarketFeed {
  start(): Promise<void>;
  setActiveMarket(symbol: AssetSymbol): Promise<void>;
  pause(): void;
  resume(): void;
  subscribe(listener: (state: AssetState) => void): () => void;
  getState(symbol: AssetSymbol): AssetState;
  dispose(): void;
}

export interface GameSystem {
  update(deltaSeconds: number, elapsedSeconds: number): void;
  resize?(width: number, height: number, pixelRatio: number): void;
  setVisible?(visible: boolean): void;
  dispose(): void;
}

export interface ChunkDescriptor {
  chunkX: number;
  chunkZ: number;
  seed: number;
  hasEchoMonument: boolean;
  echoSymbol?: AssetSymbol;
}

export interface PlayerSnapshot {
  x: number;
  y: number;
  z: number;
  speed: number;
  sprinting: boolean;
  surface: SurfaceKind;
  grounded: boolean;
  jumpsUsed: number;
  verticalSpeed: number;
}
