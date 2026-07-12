export interface PortalLabelAnchor {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

export interface PortalLabelLineBounds {
  readonly bottom: number;
  readonly top: number;
}

export const PORTAL_LABEL_LAYOUT = {
  cardWidth: 5,
  cardHeight: 2,
  baseCenterY: 5.4,
  rowStep: 2.16,
  rowCollisionDistance: 5.34,
  minimumCardGap: 0.12,
  titleY: 0.45,
  titleFontSize: 0.6,
  statusY: -0.14,
  statusFontSize: 0.34,
  populationY: -0.55,
  populationFontSize: 0.3,
  minimumLineGap: 0.08,
  textMaxWidth: 4.5,
} as const;

function lineBounds(centerY: number, fontSize: number): PortalLabelLineBounds {
  return { bottom: centerY - fontSize * 0.5, top: centerY + fontSize * 0.5 };
}

export function portalLabelLineBounds(): Readonly<{
  title: PortalLabelLineBounds;
  status: PortalLabelLineBounds;
  population: PortalLabelLineBounds;
}> {
  return {
    title: lineBounds(PORTAL_LABEL_LAYOUT.titleY, PORTAL_LABEL_LAYOUT.titleFontSize),
    status: lineBounds(PORTAL_LABEL_LAYOUT.statusY, PORTAL_LABEL_LAYOUT.statusFontSize),
    population: lineBounds(PORTAL_LABEL_LAYOUT.populationY, PORTAL_LABEL_LAYOUT.populationFontSize),
  };
}

/**
 * Assigns the lowest deterministic vertical row that clears nearby portal
 * cards. This is needed for the ETH/DOGE spokes, whose inherited road bearings
 * are closer than one full label width at the 24-unit portal radius.
 */
export function assignPortalLabelRows(
  anchors: readonly PortalLabelAnchor[],
): ReadonlyMap<string, number> {
  const rows = new Map<string, number>();
  for (const anchor of anchors) {
    let row = 0;
    while (anchors.some((other) => {
      if (other === anchor || !rows.has(other.id) || rows.get(other.id) !== row) return false;
      return Math.hypot(anchor.x - other.x, anchor.z - other.z)
        < PORTAL_LABEL_LAYOUT.rowCollisionDistance;
    })) {
      row += 1;
    }
    rows.set(anchor.id, row);
  }
  return rows;
}

export function portalLabelCenterY(row: number): number {
  const safeRow = Number.isFinite(row) ? Math.max(0, Math.floor(row)) : 0;
  return PORTAL_LABEL_LAYOUT.baseCenterY + safeRow * PORTAL_LABEL_LAYOUT.rowStep;
}

/** Conservative card-level overlap check, independent of portal yaw. */
export function portalLabelCardsOverlap(
  first: PortalLabelAnchor,
  firstRow: number,
  second: PortalLabelAnchor,
  secondRow: number,
): boolean {
  const horizontalDistance = Math.hypot(first.x - second.x, first.z - second.z);
  const verticalDistance = Math.abs(portalLabelCenterY(firstRow) - portalLabelCenterY(secondRow));
  return horizontalDistance < PORTAL_LABEL_LAYOUT.cardWidth + PORTAL_LABEL_LAYOUT.minimumCardGap
    && verticalDistance < PORTAL_LABEL_LAYOUT.cardHeight + PORTAL_LABEL_LAYOUT.minimumCardGap;
}
