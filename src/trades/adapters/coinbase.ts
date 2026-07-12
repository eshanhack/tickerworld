import type { AssetSymbol } from '../../types';
import type { NormalizedTrade, TradeSide } from '../types';
import { isRecord, normalizeTrade, parsePayload } from './common';

export const COINBASE_SOCKET_URL = 'wss://advanced-trade-ws.coinbase.com';

/** Coinbase documents `side` as maker side, so Tickerworld inverts it to taker side. */
export function parseCoinbaseTrades(
  payload: unknown,
  symbol: AssetSymbol,
  expectedProduct: string,
  receivedAt = Date.now(),
): NormalizedTrade[] {
  const parsed = parsePayload(payload);
  if (!isRecord(parsed) || parsed.channel !== 'market_trades' || !Array.isArray(parsed.events)) return [];
  const trades: NormalizedTrade[] = [];
  for (const event of parsed.events) {
    // Initial snapshots are historical backfill and must not create launch-time whale events.
    if (!isRecord(event) || event.type === 'snapshot' || !Array.isArray(event.trades)) continue;
    for (const item of event.trades) {
      if (!isRecord(item)
        || typeof item.product_id !== 'string'
        || item.product_id.toUpperCase() !== expectedProduct.toUpperCase()
        || typeof item.side !== 'string') continue;
      const maker = item.side.toUpperCase();
      const side: TradeSide | null = maker === 'BUY' ? 'sell' : maker === 'SELL' ? 'buy' : null;
      if (!side) continue;
      const id = typeof item.trade_id === 'string' || typeof item.trade_id === 'number'
        ? String(item.trade_id)
        : '';
      if (!id) continue;
      const trade = normalizeTrade({
        exchange: 'coinbase',
        id: `${item.product_id}:${id}`,
        symbol,
        side,
        price: item.price,
        baseSize: item.size,
        timestampMs: item.time ?? parsed.timestamp,
        receivedAt,
      });
      if (trade) trades.push(trade);
    }
  }
  return trades;
}

export function coinbaseSubscriptions(product: string): readonly unknown[] {
  return [
    { type: 'subscribe', product_ids: [product], channel: 'market_trades' },
    { type: 'subscribe', product_ids: [product], channel: 'heartbeats' },
  ];
}
