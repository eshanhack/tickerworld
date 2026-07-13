import type { AssetSymbol } from '../../types';
import { parseDexTradesResponse } from '../../markets/dexMarket';
import type { NormalizedTrade } from '../types';

/** Normalizes Tickerworld's identity-checked on-chain trade proxy. */
export function parseGeckoTerminalTapeTrades(
  payload: unknown,
  symbol: AssetSymbol,
  receivedAt: number,
): NormalizedTrade[] {
  const parsed = parseDexTradesResponse(payload, receivedAt);
  if (!parsed || parsed.market.symbol !== symbol) return [];
  return parsed.trades.map((trade) => ({
    id: `geckoterminal:${trade.id}`,
    exchange: 'geckoterminal',
    symbol,
    side: trade.side,
    kind: 'trade',
    price: trade.priceUsd,
    baseSize: trade.baseAmount,
    notionalUsd: trade.volumeUsd > 0 ? trade.volumeUsd : trade.priceUsd * trade.baseAmount,
    timestampMs: trade.time,
    receivedAt,
    simulated: false,
  }));
}
