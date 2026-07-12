import type { AssetSymbol } from '../../types';
import type { NormalizedTrade, TradeSide } from '../types';
import { isRecord, normalizeTrade, parsePayload } from './common';

export const HYPERLIQUID_SOCKET_URL = 'wss://api.hyperliquid.xyz/ws';

export function parseHyperliquidTapeTrades(
  payload: unknown,
  symbol: AssetSymbol,
  expectedCoin: string,
  receivedAt = Date.now(),
): NormalizedTrade[] {
  const parsed = parsePayload(payload);
  if (!isRecord(parsed) || parsed.channel !== 'trades') return [];
  const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const trades: NormalizedTrade[] = [];
  for (const item of rows) {
    if (!isRecord(item)
      || typeof item.coin !== 'string'
      || item.coin.toLowerCase() !== expectedCoin.toLowerCase()
      || typeof item.side !== 'string') continue;
    const rawSide = item.side.toLowerCase();
    const side: TradeSide | null = rawSide === 'b' || rawSide === 'buy'
      ? 'buy'
      : rawSide === 'a' || rawSide === 'sell'
        ? 'sell'
        : null;
    if (!side) continue;
    const tid = typeof item.tid === 'string' || typeof item.tid === 'number' ? String(item.tid) : '';
    if (!tid) continue;
    const trade = normalizeTrade({
      exchange: 'hyperliquid',
      id: `${item.coin}:${String(item.time ?? '')}:${tid}`,
      symbol,
      side,
      price: item.px,
      baseSize: item.sz,
      timestampMs: item.time,
      receivedAt,
    });
    if (trade) trades.push(trade);
  }
  return trades;
}

export function hyperliquidSubscriptions(coin: string): readonly unknown[] {
  return [{ method: 'subscribe', subscription: { type: 'trades', coin } }];
}
