export type OverlayOwner =
  | 'chat'
  | 'player'
  | 'economy'
  | 'news'
  | 'portal'
  | 'share'
  | 'settings'
  | 'wardrobe'
  | 'emote'
  | 'context';

const LARGE_OVERLAYS = new Set<OverlayOwner>([
  'chat',
  'player',
  'economy',
  'news',
  'portal',
  'share',
  'settings',
  'wardrobe',
  'context',
]);

export interface OverlayTransition {
  readonly opened: OverlayOwner | null;
  readonly displaced: OverlayOwner | null;
  readonly largeOwner: OverlayOwner | null;
}

/** Keeps the launch HUD to one attention-heavy surface at a time. */
export class OverlayCoordinator {
  private readonly active = new Set<OverlayOwner>();
  private currentLarge: OverlayOwner | null = null;

  public get largeOwner(): OverlayOwner | null {
    return this.currentLarge;
  }

  public has(owner: OverlayOwner): boolean {
    return this.active.has(owner);
  }

  public set(owner: OverlayOwner, open: boolean): OverlayTransition {
    if (!open) {
      this.active.delete(owner);
      if (this.currentLarge === owner) this.currentLarge = null;
      return { opened: null, displaced: null, largeOwner: this.currentLarge };
    }

    // Recovery and world-transfer veils are authoritative. Keyboard shortcuts
    // or late async UI must not displace them while their operation is active.
    if (this.currentLarge === 'context' && owner !== 'context') {
      return { opened: null, displaced: null, largeOwner: this.currentLarge };
    }
    if (this.currentLarge === 'portal' && owner !== 'portal' && owner !== 'context') {
      return { opened: null, displaced: null, largeOwner: this.currentLarge };
    }

    let displaced: OverlayOwner | null = null;
    if (LARGE_OVERLAYS.has(owner) && this.currentLarge !== owner) {
      displaced = this.currentLarge;
      if (displaced) this.active.delete(displaced);
      this.currentLarge = owner;
    }
    this.active.add(owner);
    return { opened: owner, displaced, largeOwner: this.currentLarge };
  }

  public clear(): void {
    this.active.clear();
    this.currentLarge = null;
  }
}
