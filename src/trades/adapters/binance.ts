import type { AssetSymbol } from '../../types';
import type { NormalizedTrade } from '../types';
import { isRecord, normalizeTrade, parsePayload } from './common';

/** Normalizes Binance spot aggregate trades. `m` means buyer-maker, so taker sold. */
export function parseBinanceTrades(
  payload: unknown,
  symbol: AssetSymbol,
  expectedPair: string,
  receivedAt = Date.now(),
): NormalizedTrade[] {
  const parsed = parsePayload(payload);
  const item = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
  if (!isRecord(item)
    || item.e !== 'aggTrade'
    || typeof item.s !== 'string'
    || item.s.toUpperCase() !== expectedPair.toUpperCase()
    || typeof item.m !== 'boolean') return [];
  const idValue = typeof item.a === 'string' || typeof item.a === 'number' ? String(item.a) : '';
  if (!idValue) return [];
  const trade = normalizeTrade({
    exchange: 'binance',
    id: `${item.s}:${idValue}`,
    symbol,
    side: item.m ? 'sell' : 'buy',
    price: item.p,
    baseSize: item.q,
    timestampMs: item.T ?? item.E,
    receivedAt,
  });
  return trade ? [trade] : [];
}

export function binanceStreamUrl(pair: string): string {
  return `wss://stream.binance.com:9443/ws/${encodeURIComponent(pair.toLowerCase())}@aggTrade`;
}
