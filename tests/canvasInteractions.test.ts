import { describe, expect, it, vi } from 'vitest';
import type { NetPlayerState } from '../shared/src/index.js';
import { CanvasInteractionCoordinator } from '../src/social/CanvasInteractionCoordinator';

const player: NetPlayerState = {
  actorId: 'anon_1234567890abcdef',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  speed: 0,
  verticalSpeed: 0,
  grounded: true,
  gait: 'idle',
  animal: 'fox',
  skin: 'base',
  username: null,
  updatedAt: 1,
};

function pointer(type: string, x: number, y: number, pointerId = 1): Event {
  const event = new Event(type);
  Object.assign(event, {
    pointerId,
    pointerType: 'mouse',
    button: 0,
    clientX: x,
    clientY: y,
  });
  return event;
}

describe('CanvasInteractionCoordinator', () => {
  it('gives a chart-news pin priority over a player on the same tap', () => {
    const element = new EventTarget();
    const news = vi.fn(() => true);
    const pick = vi.fn(() => player);
    const open = vi.fn();
    const coordinator = new CanvasInteractionCoordinator({
      element: element as HTMLElement,
      activateNewsAt: news,
      pickPlayerAt: pick,
      openPlayerCard: open,
    });
    element.dispatchEvent(pointer('pointerdown', 40, 50));
    element.dispatchEvent(pointer('pointerup', 40, 50));
    expect(news).toHaveBeenCalledWith(40, 50);
    expect(pick).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('selects a remote player on a clean tap and ignores camera drags', () => {
    const element = new EventTarget();
    const open = vi.fn();
    const coordinator = new CanvasInteractionCoordinator({
      element: element as HTMLElement,
      activateNewsAt: () => false,
      pickPlayerAt: () => player,
      openPlayerCard: open,
      dragThreshold: 7,
    });
    element.dispatchEvent(pointer('pointerdown', 10, 10));
    element.dispatchEvent(pointer('pointerup', 12, 13));
    expect(open).toHaveBeenCalledOnce();

    element.dispatchEvent(pointer('pointerdown', 10, 10));
    element.dispatchEvent(pointer('pointermove', 30, 10));
    element.dispatchEvent(pointer('pointerup', 30, 10));
    expect(open).toHaveBeenCalledOnce();
    coordinator.dispose();
  });
});
