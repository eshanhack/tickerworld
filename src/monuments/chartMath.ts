import type { Candle } from '../types';

export const MONUMENT_CANDLE_COUNT = 30;
export const MONUMENT_SHUNT_DURATION_SECONDS = 0.58;

export interface PriceRange {
  min: number;
  max: number;
}

export interface CandleLayout {
  readonly candle: Candle;
  readonly index: number;
  readonly x: number;
  readonly openY: number;
  readonly closeY: number;
  readonly bodyY: number;
  readonly bodyHeight: number;
  readonly wickY: number;
  readonly wickHeight: number;
  readonly isUp: boolean;
}

const MIN_ABSOLUTE_RANGE = 1e-8;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function cloneCandle(candle: Candle): Candle {
  const open = finiteOr(candle.open, 0);
  const close = finiteOr(candle.close, open);
  const rawHigh = finiteOr(candle.high, Math.max(open, close));
  const rawLow = finiteOr(candle.low, Math.min(open, close));

  return {
    openTime: candle.openTime,
    open,
    high: Math.max(rawHigh, open, close),
    low: Math.min(rawLow, open, close),
    close,
    closed: candle.closed,
  };
}

export function selectChartCandles(
  candles: readonly Candle[],
  count = MONUMENT_CANDLE_COUNT,
): Candle[] {
  return candles.slice(-Math.max(0, count)).map(cloneCandle);
}

export function computePriceRange(candles: readonly Candle[], padding = 0.09): PriceRange {
  if (candles.length === 0) {
    return { min: 0, max: 1 };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const source of candles) {
    const candle = cloneCandle(source);
    min = Math.min(min, candle.low, candle.open, candle.close);
    max = Math.max(max, candle.high, candle.open, candle.close);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }

  const center = (min + max) * 0.5;
  const minimumSpan = Math.max(Math.abs(center) * 0.002, MIN_ABSOLUTE_RANGE);
  const span = Math.max(max - min, minimumSpan);
  const paddedSpan = span * (1 + Math.max(0, padding) * 2);

  return {
    min: center - paddedSpan * 0.5,
    max: center + paddedSpan * 0.5,
  };
}

/**
 * Expansions happen immediately so a new high/low never clips. Contractions ease,
 * preventing the whole chart from visibly breathing on every trade.
 */
export function easePriceRange(
  current: PriceRange,
  target: PriceRange,
  deltaSeconds: number,
  response = 2.8,
): PriceRange {
  const alpha = 1 - Math.exp(-Math.max(0, deltaSeconds) * response);
  return {
    min: target.min < current.min
      ? target.min
      : current.min + (target.min - current.min) * alpha,
    max: target.max > current.max
      ? target.max
      : current.max + (target.max - current.max) * alpha,
  };
}

export function priceToChartY(price: number, range: PriceRange, height: number): number {
  const span = Math.max(range.max - range.min, MIN_ABSOLUTE_RANGE);
  const normalized = (finiteOr(price, range.min) - range.min) / span;
  return Math.min(1, Math.max(0, normalized)) * height;
}

export function layoutCandles(
  candles: readonly Candle[],
  range: PriceRange,
  chartWidth: number,
  chartHeight: number,
  xOffset = 0,
): CandleLayout[] {
  const selected = selectChartCandles(candles);
  const spacing = chartWidth / MONUMENT_CANDLE_COUNT;
  const centerOffset = (selected.length - 1) * spacing * 0.5;
  const minimumBodyHeight = Math.max(0.045, chartHeight * 0.012);

  return selected.map((source, index) => {
    const candle = cloneCandle(source);
    const openY = priceToChartY(candle.open, range, chartHeight);
    const closeY = priceToChartY(candle.close, range, chartHeight);
    const highY = priceToChartY(candle.high, range, chartHeight);
    const lowY = priceToChartY(candle.low, range, chartHeight);
    const bodyHeight = Math.max(Math.abs(closeY - openY), minimumBodyHeight);

    return {
      candle,
      index,
      x: index * spacing - centerOffset + xOffset,
      openY,
      closeY,
      bodyY: (openY + closeY) * 0.5,
      bodyHeight,
      wickY: (highY + lowY) * 0.5,
      wickHeight: Math.max(highY - lowY, minimumBodyHeight),
      isUp: candle.close >= candle.open,
    };
  });
}

export function didCandleWindowRoll(previous: readonly Candle[], next: readonly Candle[]): boolean {
  const previousLast = previous.at(-1);
  const nextLast = next.at(-1);
  if (!previousLast || !nextLast || nextLast.openTime <= previousLast.openTime) {
    return false;
  }

  return next.some((candle) => candle.openTime === previousLast.openTime);
}

export function smoothCandles(
  displayed: readonly Candle[],
  target: readonly Candle[],
  deltaSeconds: number,
): Candle[] {
  const priorByTime = new Map(displayed.map((candle) => [candle.openTime, candle]));
  const alpha = 1 - Math.exp(-Math.max(0, deltaSeconds) * 9);

  return target.map((targetCandle, index) => {
    const prior = priorByTime.get(targetCandle.openTime);
    const isCurrent = index === target.length - 1 && !targetCandle.closed;
    if (!prior || !isCurrent) {
      return cloneCandle(targetCandle);
    }

    const lerp = (from: number, to: number): number => from + (to - from) * alpha;
    const close = lerp(prior.close, targetCandle.close);
    return cloneCandle({
      ...targetCandle,
      high: lerp(prior.high, targetCandle.high),
      low: lerp(prior.low, targetCandle.low),
      close,
    });
  });
}

export function unusualMoveScore(
  candles: readonly Candle[],
  previousPrice: number | null | undefined,
  price: number | null | undefined,
): number {
  const recent = selectChartCandles(candles, 20);
  if (
    recent.length === 0
    || previousPrice === null
    || previousPrice === undefined
    || price === null
    || price === undefined
    || !Number.isFinite(previousPrice)
    || !Number.isFinite(price)
  ) {
    return 0;
  }

  const averageRange = recent.reduce((total, candle) => total + Math.abs(candle.high - candle.low), 0)
    / recent.length;
  const baseline = Math.max(averageRange, Math.abs(price) * 0.00005, MIN_ABSOLUTE_RANGE);
  return Math.abs(price - previousPrice) / baseline;
}

const largePriceFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const regularPriceFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const fractionalPriceFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

export function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) {
    return '$—';
  }
  if (Math.abs(price) >= 1_000) {
    return `$${largePriceFormatter.format(price)}`;
  }
  if (Math.abs(price) >= 1) {
    return `$${regularPriceFormatter.format(price)}`;
  }
  return `$${fractionalPriceFormatter.format(price)}`;
}
