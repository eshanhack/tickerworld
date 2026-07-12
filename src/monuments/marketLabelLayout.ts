export interface LabelBounds {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

export interface MonumentMarketLabelBounds {
  readonly card: LabelBounds;
  readonly symbol: LabelBounds;
  readonly price: LabelBounds;
  readonly countdownCard: LabelBounds;
}

/**
 * Billboard-local dimensions for the market identity plaque. Keeping the
 * ticker and price in two explicit bands avoids relying on font metrics that
 * can settle on different frames in Troika.
 */
export const MONUMENT_MARKET_LABEL_LAYOUT = {
  centerY: 7.78,
  grandCardWidth: 4.6,
  grandCardHeight: 1.5,
  echoCardWidth: 3.72,
  echoCardHeight: 1.3,
  symbolY: 0.39,
  symbolFontSize: 0.34,
  echoSymbolFontSize: 0.29,
  priceY: -0.2,
  priceFontSize: 0.52,
  echoPriceFontSize: 0.46,
  minimumLineGap: 0.14,
  chartTopY: 0.9 + 5.75,
  minimumChartGap: 0.3,
  countdownCenterX: 3.72,
  countdownWidth: 2.55,
  countdownHeight: 0.68,
  minimumSiblingGap: 0.14,
} as const;

function centeredBounds(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
): LabelBounds {
  return {
    left: centerX - width * 0.5,
    right: centerX + width * 0.5,
    bottom: centerY - height * 0.5,
    top: centerY + height * 0.5,
  };
}

/** Deterministic conservative bounds used by both layout tests and QA tools. */
export function monumentMarketLabelBounds(
  kind: 'grand' | 'echo',
): MonumentMarketLabelBounds {
  const echo = kind === 'echo';
  const cardWidth = echo
    ? MONUMENT_MARKET_LABEL_LAYOUT.echoCardWidth
    : MONUMENT_MARKET_LABEL_LAYOUT.grandCardWidth;
  const cardHeight = echo
    ? MONUMENT_MARKET_LABEL_LAYOUT.echoCardHeight
    : MONUMENT_MARKET_LABEL_LAYOUT.grandCardHeight;
  const symbolFontSize = echo
    ? MONUMENT_MARKET_LABEL_LAYOUT.echoSymbolFontSize
    : MONUMENT_MARKET_LABEL_LAYOUT.symbolFontSize;
  const priceFontSize = echo
    ? MONUMENT_MARKET_LABEL_LAYOUT.echoPriceFontSize
    : MONUMENT_MARKET_LABEL_LAYOUT.priceFontSize;
  return {
    card: centeredBounds(0, 0, cardWidth, cardHeight),
    symbol: centeredBounds(0, MONUMENT_MARKET_LABEL_LAYOUT.symbolY, cardWidth - 0.42, symbolFontSize),
    price: centeredBounds(0, MONUMENT_MARKET_LABEL_LAYOUT.priceY, cardWidth - 0.42, priceFontSize),
    countdownCard: centeredBounds(
      MONUMENT_MARKET_LABEL_LAYOUT.countdownCenterX,
      0,
      MONUMENT_MARKET_LABEL_LAYOUT.countdownWidth,
      MONUMENT_MARKET_LABEL_LAYOUT.countdownHeight,
    ),
  };
}

export function labelBoundsOverlap(
  first: LabelBounds,
  second: LabelBounds,
  gap = 0,
): boolean {
  return !(
    first.right + gap <= second.left
    || second.right + gap <= first.left
    || first.top + gap <= second.bottom
    || second.top + gap <= first.bottom
  );
}
