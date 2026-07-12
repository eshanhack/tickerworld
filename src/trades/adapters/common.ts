import type { AssetSymbol } from '../../types';
import type { LiveTradeExchange, NormalizedTrade, TradeKind, TradeSide } from '../types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function finitePositive(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function finiteTimestamp(value: unknown): number | null {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) && parsedDate >= 0 ? parsedDate : null;
  }
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function boundedReceivedAt(receivedAt: number): number {
  return Number.isFinite(receivedAt) && receivedAt >= 0 ? receivedAt : Date.now();
}

export function normalizeTrade(input: {
  exchange: LiveTradeExchange;
  id: string;
  symbol: AssetSymbol;
  side: TradeSide;
  price: unknown;
  baseSize: unknown;
  timestampMs: unknown;
  receivedAt: number;
  kind?: TradeKind;
}): NormalizedTrade | null {
  const price = finitePositive(input.price);
  const baseSize = finitePositive(input.baseSize);
  const timestampMs = finiteTimestamp(input.timestampMs);
  const receivedAt = boundedReceivedAt(input.receivedAt);
  const id = input.id.trim().slice(0, 160);
  if (!id || price === null || baseSize === null || timestampMs === null) return null;
  const notionalUsd = price * baseSize;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || notionalUsd > 1e15) return null;
  return {
    id,
    exchange: input.exchange,
    symbol: input.symbol,
    side: input.side,
    kind: input.kind ?? 'trade',
    price,
    baseSize,
    notionalUsd,
    timestampMs,
    receivedAt,
    simulated: false,
  };
}

export function parsePayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
