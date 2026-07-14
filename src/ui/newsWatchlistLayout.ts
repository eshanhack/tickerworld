export type NewsWatchlistLayout =
  | 'desktop-side'
  | 'touch-side'
  | 'touch-landscape-bottom';

export interface NewsWatchlistViewport {
  readonly width: number;
  readonly height: number;
  readonly coarsePointer: boolean;
}

/**
 * Keeps source controls out of the top-right HUD stack. Narrow and touch
 * portrait screens use the middle-right edge; touch landscape uses the free
 * bottom-centre lane between the movement controls.
 */
export function newsWatchlistLayout(viewport: NewsWatchlistViewport): NewsWatchlistLayout {
  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  if (viewport.coarsePointer && width > height) return 'touch-landscape-bottom';
  if (viewport.coarsePointer || width <= 700) return 'touch-side';
  return 'desktop-side';
}
