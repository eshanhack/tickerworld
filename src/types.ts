export const ASSET_SYMBOLS = [
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'DOGE',
  'BNB',
  'LINK',
  'AVAX',
] as const;

export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];
export type FeedMode = 'live' | 'reconnecting' | 'simulated';
export type TickDirection = 'up' | 'down' | 'flat';
export type SurfaceKind = 'grass' | 'sand' | 'stone';

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
  pair: `${AssetSymbol}USDT`;
  candles: readonly Candle[];
  price: number;
  previousPrice: number;
  direction: TickDirection;
  mode: FeedMode;
  updatedAt: number;
  presentationTick: number;
}

export interface MarketFeed {
  start(): Promise<void>;
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
}
