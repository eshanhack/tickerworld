export type NewsInteractionSurface = 'overlay' | 'sources';

/**
 * Aggregates the independently interactive news card and source manager.
 * A pointer-up from one surface must not release camera input while the other
 * surface remains active.
 */
export class NewsInteractionAggregate {
  private readonly activeSurfaces = new Set<NewsInteractionSurface>();

  get active(): boolean {
    return this.activeSurfaces.size > 0;
  }

  set(surface: NewsInteractionSurface, active: boolean): boolean {
    const wasActive = this.active;
    if (active) this.activeSurfaces.add(surface);
    else this.activeSurfaces.delete(surface);
    return wasActive !== this.active;
  }

  clear(): boolean {
    const changed = this.active;
    this.activeSurfaces.clear();
    return changed;
  }
}
