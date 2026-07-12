import type { AssetSymbol } from '../../types';
import type { NormalizedTrade, TradeSide } from '../types';
import { isRecord, normalizeTrade, parsePayload } from './common';

export const OKX_SOCKET_URL = 'wss://ws.okx.com:8443/ws/v5/public';

/** OKX public trades already report the taker side. */
export function parseOkxTrades(
  payload: unknown,
  symbol: AssetSymbol,
  expectedInstrument: string,
  receivedAt = Date.now(),
): NormalizedTrade[] {
  const parsed = parsePayload(payload);
  if (!isRecord(parsed) || !isRecord(parsed.arg) || parsed.arg.channel !== 'trades'
    || !Array.isArray(parsed.data)) return [];
  const trades: NormalizedTrade[] = [];
  for (const item of parsed.data) {
    if (!isRecord(item)
      || typeof item.instId !== 'string'
      || item.instId.toUpperCase() !== expectedInstrument.toUpperCase()
      || typeof item.side !== 'string') continue;
    const rawSide = item.side.toLowerCase();
    const side: TradeSide | null = rawSide === 'buy' ? 'buy' : rawSide === 'sell' ? 'sell' : null;
    if (!side) continue;
    const id = typeof item.tradeId === 'string' || typeof item.tradeId === 'number'
      ? String(item.tradeId)
      : '';
    if (!id) continue;
    const trade = normalizeTrade({
      exchange: 'okx',
      id: `${item.instId}:${id}`,
      symbol,
      side,
      price: item.px,
      baseSize: item.sz,
      timestampMs: item.ts,
      receivedAt,
    });
    if (trade) trades.push(trade);
  }
  return trades;
}

export function okxSubscriptions(instrument: string): readonly unknown[] {
  return [{ op: 'subscribe', args: [{ channel: 'trades', instId: instrument }] }];
}
