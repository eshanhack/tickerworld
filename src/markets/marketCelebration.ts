import { classifyMarketMove, MARKET_MOVE_THRESHOLDS } from '../audio';
import type { AssetSymbol, TickDirection } from '../types';

export type MarketCelebrationTier = 'large' | 'exceptional';

export interface MarketCelebrationEvent {
  readonly symbol: AssetSymbol;
  readonly direction: 'up' | 'down';
  readonly tier: MarketCelebrationTier;
  readonly magnitude: number;
}

interface AccentState extends MarketCelebrationEvent {
  readonly at: number;
  readonly armed: boolean;
}

const ACCENT_COOLDOWN_SECONDS = 1.8;
const GLOBAL_COOLDOWN_SECONDS = 0.22;
const UPGRADE_COOLDOWN_SECONDS = 0.38;
const REARM_COOLDOWN_SECONDS = 0.65;
const DIRECTION_CHANGE_COOLDOWN_SECONDS = 0.55;
const REARM_RATIO = MARKET_MOVE_THRESHOLDS.medium * 0.7;

/**
 * Mirrors the sound accent cadence for allocation-bounded visual celebrations.
 * A continuously large candle does not shower the sky on every 400 ms tick,
 * but a tier upgrade, reversal, or meaningful escalation can create a fresh
 * moment without waiting for the candle to return fully to neutral.
 */
export class MarketCelebrationGate {
  private readonly accents = new Map<AssetSymbol, AccentState>();
  private lastGlobalAccentAt = Number.NEGATIVE_INFINITY;

  evaluate(
    symbol: AssetSymbol,
    direction: TickDirection,
    moveRatio: number,
    nowSeconds: number,
  ): MarketCelebrationEvent | null {
    const magnitude = Math.abs(Number.isFinite(moveRatio) ? moveRatio : 0);
    this.observe(symbol, magnitude);
    const previous = this.accents.get(symbol);

    const moveClass = classifyMarketMove(magnitude);
    if (
      direction === 'flat'
      || (moveClass !== 'large' && moveClass !== 'exceptional')
      || !Number.isFinite(nowSeconds)
    ) {
      return null;
    }

    const tier: MarketCelebrationTier = moveClass;
    const eventDirection = direction;
    const isUpgrade = tier === 'exceptional'
      && previous?.tier === 'large'
      && nowSeconds - previous.at >= UPGRADE_COOLDOWN_SECONDS;
    const isDirectionChange = previous !== undefined
      && previous.direction !== eventDirection
      && nowSeconds - previous.at >= DIRECTION_CHANGE_COOLDOWN_SECONDS;
    const isMeaningfulEscalation = previous !== undefined
      && previous.tier === tier
      && magnitude >= previous.magnitude * 1.5
      && nowSeconds - previous.at >= ACCENT_COOLDOWN_SECONDS;
    const isRearmed = previous === undefined
      || (previous.armed && nowSeconds - previous.at >= REARM_COOLDOWN_SECONDS);
    if (
      (!isUpgrade && !isDirectionChange && !isMeaningfulEscalation && !isRearmed)
      || nowSeconds - this.lastGlobalAccentAt < GLOBAL_COOLDOWN_SECONDS
    ) {
      return null;
    }

    const event: MarketCelebrationEvent = {
      symbol,
      direction: eventDirection,
      tier,
      magnitude,
    };
    this.accents.set(symbol, { ...event, at: nowSeconds, armed: false });
    this.lastGlobalAccentAt = nowSeconds;
    return event;
  }

  /** Rearms a prior alert during calm updates without consuming far-away large moves. */
  observe(symbol: AssetSymbol, moveRatio: number): void {
    const magnitude = Math.abs(Number.isFinite(moveRatio) ? moveRatio : 0);
    const previous = this.accents.get(symbol);
    if (magnitude < REARM_RATIO && previous && !previous.armed) {
      this.accents.set(symbol, { ...previous, armed: true });
    }
  }

  clear(): void {
    this.accents.clear();
    this.lastGlobalAccentAt = Number.NEGATIVE_INFINITY;
  }
}
