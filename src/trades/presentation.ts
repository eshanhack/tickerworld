import { classifyTradeTier } from './config';
import type { AggregatedOrder, TradeSide } from './types';

/**
 * Keeps the largest tape voices intact and folds the tail into one bounded,
 * side-dominant voice. Visuals still receive the original orders; this helper
 * exists only to keep an extreme flush musical instead of clipping or going
 * abruptly silent.
 */
export function coalesceTradeAudioOrders(
  orders: readonly AggregatedOrder[],
  maximumVoices: number,
): readonly AggregatedOrder[] {
  const audible = orders
    .filter((order) => order.tier !== 'dust')
    .sort((left, right) => right.notionalUsd - left.notionalUsd);
  const limit = Math.max(1, Math.floor(maximumVoices));
  if (audible.length <= limit) return audible;

  const kept = audible.slice(0, Math.max(0, limit - 1));
  const overflow = audible.slice(Math.max(0, limit - 1));
  const buyNotional = overflow.reduce(
    (sum, order) => sum + (order.side === 'buy' ? order.notionalUsd : 0),
    0,
  );
  const sellNotional = overflow.reduce(
    (sum, order) => sum + (order.side === 'sell' ? order.notionalUsd : 0),
    0,
  );
  const side: TradeSide = buyNotional >= sellNotional ? 'buy' : 'sell';
  // Both sides contribute to the blended weight; the dominant side determines
  // the clearly recognizable rising/falling identity of the one remaining voice.
  const blend = overflow;
  const notionalUsd = blend.reduce((sum, order) => sum + order.notionalUsd, 0);
  const baseSize = blend.reduce((sum, order) => sum + order.baseSize, 0);
  const priceWeight = blend.reduce(
    (sum, order) => sum + order.vwap * order.notionalUsd,
    0,
  );
  const sources = [...new Set(blend.flatMap((order) => order.sources))];
  const startedAt = Math.min(...blend.map((order) => order.startedAt));
  const endedAt = Math.max(...blend.map((order) => order.endedAt));
  const symbol = blend[0]!.symbol;
  const blended: AggregatedOrder = {
    id: `audio-overflow:${symbol}:${side}:${endedAt}`,
    symbol,
    side,
    tier: classifyTradeTier(symbol, notionalUsd),
    kind: blend.every((order) => order.kind === 'liquidation') ? 'liquidation' : 'trade',
    notionalUsd,
    vwap: notionalUsd > 0 ? priceWeight / notionalUsd : blend[0]!.vwap,
    baseSize,
    tradeCount: blend.reduce((sum, order) => sum + order.tradeCount, 0),
    sources,
    sourceCount: sources.length,
    simulated: blend.every((order) => order.simulated),
    startedAt,
    endedAt,
    timestampMs: endedAt,
  };
  return [...kept, blended];
}
