import {
  PRICE_HORIZONS,
  type Candle,
  type HorizonChange,
  type PriceHorizon,
  type TickDirection,
} from '../types';

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export const HORIZON_DURATIONS_MS: Readonly<Record<PriceHorizon, number>> = {
  '1m': MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '1h': 60 * MINUTE_MS,
  '1d': DAY_MS,
  '1w': 7 * DAY_MS,
  '1mo': 30 * DAY_MS,
  '1y': 365 * DAY_MS,
};

export interface CandleCountdown {
  readonly remainingMs: number;
  readonly remainingSeconds: number;
  readonly label: string;
}

function directionForRatio(ratio: number): TickDirection {
  if (ratio > 1e-10) return 'up';
  if (ratio < -1e-10) return 'down';
  return 'flat';
}

function referenceCandleAtOrBefore(
  candles: readonly Candle[],
  targetTime: number,
): Candle | undefined {
  let reference: Candle | undefined;
  for (const candle of candles) {
    if (
      candle.openTime <= targetTime
      && Number.isFinite(candle.close)
      && candle.close > 0
      && (!reference || candle.openTime > reference.openTime)
    ) {
      reference = candle;
    }
  }
  return reference;
}

export function createEmptyHorizonChanges(): HorizonChange[] {
  return PRICE_HORIZONS.map((horizon) => ({
    horizon,
    referenceTime: null,
    referencePrice: null,
    changeRatio: null,
    direction: 'flat',
  }));
}

/**
 * Derives the seven monument comparisons from real source candles. Minute data
 * powers the short horizons; daily data powers the longer ones. Missing source
 * history stays explicitly unavailable instead of inventing a direction.
 */
export function computeHorizonChanges(
  currentPrice: number | null | undefined,
  now: number,
  minuteHistory: readonly Candle[],
  dailyHistory: readonly Candle[],
): HorizonChange[] {
  if (currentPrice === null || currentPrice === undefined || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return createEmptyHorizonChanges();
  }

  return PRICE_HORIZONS.map((horizon): HorizonChange => {
    const duration = HORIZON_DURATIONS_MS[horizon];
    const history = duration <= 60 * MINUTE_MS ? minuteHistory : dailyHistory;
    const reference = referenceCandleAtOrBefore(history, now - duration);
    if (!reference) {
      return {
        horizon,
        referenceTime: null,
        referencePrice: null,
        changeRatio: null,
        direction: 'flat',
      };
    }

    const changeRatio = currentPrice / reference.close - 1;
    return {
      horizon,
      referenceTime: reference.openTime,
      referencePrice: reference.close,
      changeRatio,
      direction: directionForRatio(changeRatio),
    };
  });
}

/** A stable wall-clock countdown to the next interval boundary. */
export function getCandleCountdown(now: number, intervalMs = MINUTE_MS): CandleCountdown {
  const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.max(1, Math.floor(intervalMs))
    : MINUTE_MS;
  const safeNow = Number.isFinite(now) ? Math.floor(now) : 0;
  const elapsed = ((safeNow % safeInterval) + safeInterval) % safeInterval;
  const remainingMs = elapsed === 0 ? safeInterval : safeInterval - elapsed;
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return {
    remainingMs,
    remainingSeconds,
    label: `${minutes}:${seconds.toString().padStart(2, '0')}`,
  };
}
