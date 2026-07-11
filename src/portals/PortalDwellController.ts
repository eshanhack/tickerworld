import type { PortalRoute } from './portalLayout';

export const PORTAL_DWELL_SECONDS = 3;
export const PORTAL_TRIGGER_RADIUS = 3.2;
export const PORTAL_REENTRY_COOLDOWN_SECONDS = 1.25;

export type PortalDwellPhase = 'idle' | 'dwelling' | 'cooldown';

export interface PortalPlayerProbe {
  readonly x: number;
  readonly z: number;
  readonly grounded: boolean;
  readonly enabled?: boolean;
}

export interface PortalDwellSnapshot {
  readonly phase: PortalDwellPhase;
  readonly route: PortalRoute | null;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
  readonly progress: number;
  readonly cooldownRemainingSeconds: number;
}

export interface PortalDwellUpdate {
  readonly snapshot: PortalDwellSnapshot;
  readonly started: PortalRoute | null;
  readonly cancelled: PortalRoute | null;
  readonly completed: PortalRoute | null;
}

function eligibleRoute(
  probe: PortalPlayerProbe,
  routes: readonly PortalRoute[],
  triggerRadius: number,
): PortalRoute | null {
  if (probe.enabled === false || !probe.grounded || !Number.isFinite(probe.x) || !Number.isFinite(probe.z)) {
    return null;
  }
  let nearest: PortalRoute | null = null;
  let nearestDistance = triggerRadius;
  for (const route of routes) {
    const distance = Math.hypot(probe.x - route.x, probe.z - route.z);
    if (distance <= nearestDistance) {
      if (distance < nearestDistance || !nearest || route.id.localeCompare(nearest.id) < 0) {
        nearest = route;
        nearestDistance = distance;
      }
    }
  }
  return nearest;
}

/** Pure dwell/cancel/completion state machine; rendering and routing stay separate. */
export class PortalDwellController {
  private routes: readonly PortalRoute[];
  private activeRoute: PortalRoute | null = null;
  private elapsedSeconds = 0;
  private cooldownRemainingSeconds = 0;

  public constructor(
    routes: readonly PortalRoute[],
    private readonly dwellSeconds = PORTAL_DWELL_SECONDS,
    private readonly triggerRadius = PORTAL_TRIGGER_RADIUS,
    private readonly reentryCooldownSeconds = PORTAL_REENTRY_COOLDOWN_SECONDS,
  ) {
    this.routes = routes;
  }

  public setRoutes(routes: readonly PortalRoute[], startCooldown = true): void {
    this.routes = routes;
    this.activeRoute = null;
    this.elapsedSeconds = 0;
    if (startCooldown) {
      this.cooldownRemainingSeconds = Math.max(
        this.cooldownRemainingSeconds,
        this.reentryCooldownSeconds,
      );
    }
  }

  public reset(cooldownSeconds = 0): void {
    this.activeRoute = null;
    this.elapsedSeconds = 0;
    this.cooldownRemainingSeconds = Math.max(0, cooldownSeconds);
  }

  public update(deltaSeconds: number, probe: PortalPlayerProbe): PortalDwellUpdate {
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    let started: PortalRoute | null = null;
    let cancelled: PortalRoute | null = null;
    let completed: PortalRoute | null = null;

    if (this.cooldownRemainingSeconds > 0) {
      this.cooldownRemainingSeconds = Math.max(0, this.cooldownRemainingSeconds - delta);
      if (this.activeRoute) cancelled = this.activeRoute;
      this.activeRoute = null;
      this.elapsedSeconds = 0;
      return { snapshot: this.snapshot(), started, cancelled, completed };
    }

    const candidate = eligibleRoute(probe, this.routes, this.triggerRadius);
    if (!candidate) {
      cancelled = this.activeRoute;
      this.activeRoute = null;
      this.elapsedSeconds = 0;
      return { snapshot: this.snapshot(), started, cancelled, completed };
    }

    if (this.activeRoute?.id !== candidate.id) {
      cancelled = this.activeRoute;
      this.activeRoute = candidate;
      this.elapsedSeconds = 0;
      started = candidate;
    }

    this.elapsedSeconds += delta;
    if (this.elapsedSeconds >= this.dwellSeconds) {
      completed = this.activeRoute;
      this.activeRoute = null;
      this.elapsedSeconds = 0;
      this.cooldownRemainingSeconds = this.reentryCooldownSeconds;
    }

    return { snapshot: this.snapshot(), started, cancelled, completed };
  }

  public snapshot(): PortalDwellSnapshot {
    const progress = this.activeRoute
      ? Math.min(1, this.elapsedSeconds / Math.max(this.dwellSeconds, Number.EPSILON))
      : 0;
    return {
      phase: this.cooldownRemainingSeconds > 0
        ? 'cooldown'
        : this.activeRoute ? 'dwelling' : 'idle',
      route: this.activeRoute,
      elapsedSeconds: this.elapsedSeconds,
      remainingSeconds: this.activeRoute ? Math.max(0, this.dwellSeconds - this.elapsedSeconds) : 0,
      progress,
      cooldownRemainingSeconds: this.cooldownRemainingSeconds,
    };
  }
}
