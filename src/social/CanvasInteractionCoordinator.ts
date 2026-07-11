import type { NetPlayerState } from '../../shared/src/index.js';

export interface CanvasInteractionCoordinatorOptions {
  readonly element: HTMLElement;
  readonly activateNewsAt: (clientX: number, clientY: number) => boolean;
  readonly pickPlayerAt: (clientX: number, clientY: number) => NetPlayerState | null;
  readonly openPlayerCard: (player: NetPlayerState) => void;
  readonly dragThreshold?: number;
}

interface PointerGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  maxDistanceSquared: number;
}

/**
 * Gives a canvas tap one deterministic owner: chart-news pins first, then
 * remote players. Camera orbit keeps owning drags, so a look gesture can never
 * accidentally open either UI.
 */
export class CanvasInteractionCoordinator {
  private readonly element: HTMLElement;
  private readonly options: CanvasInteractionCoordinatorOptions;
  private readonly dragThresholdSquared: number;
  private gesture: PointerGesture | null = null;
  private disposed = false;

  public constructor(options: CanvasInteractionCoordinatorOptions) {
    this.options = options;
    this.element = options.element;
    this.dragThresholdSquared = Math.max(0, options.dragThreshold ?? 7) ** 2;
    this.element.addEventListener('pointerdown', this.pointerDown);
    this.element.addEventListener('pointermove', this.pointerMove);
    this.element.addEventListener('pointerup', this.pointerUp);
    this.element.addEventListener('pointercancel', this.pointerCancel);
    this.element.addEventListener('pointerleave', this.pointerCancel);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gesture = null;
    this.element.removeEventListener('pointerdown', this.pointerDown);
    this.element.removeEventListener('pointermove', this.pointerMove);
    this.element.removeEventListener('pointerup', this.pointerUp);
    this.element.removeEventListener('pointercancel', this.pointerCancel);
    this.element.removeEventListener('pointerleave', this.pointerCancel);
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (this.disposed || (event.pointerType === 'mouse' && event.button !== 0)) return;
    this.gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      maxDistanceSquared: 0,
    };
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distanceSquared = (event.clientX - gesture.startX) ** 2
      + (event.clientY - gesture.startY) ** 2;
    gesture.maxDistanceSquared = Math.max(gesture.maxDistanceSquared, distanceSquared);
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.pointerMove(event);
    this.gesture = null;
    if (gesture.maxDistanceSquared > this.dragThresholdSquared) return;
    if (this.options.activateNewsAt(event.clientX, event.clientY)) return;
    const player = this.options.pickPlayerAt(event.clientX, event.clientY);
    if (player) this.options.openPlayerCard(player);
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    if (this.gesture?.pointerId === event.pointerId) this.gesture = null;
  };
}
