import {
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Text } from 'troika-three-text';
import { PALETTE } from '../config';
import type { GameSystem, AssetSymbol } from '../types';
import {
  PortalDwellController,
  type PortalDwellSnapshot,
  type PortalPlayerProbe,
} from './PortalDwellController';
import {
  createPortalLabelModel,
  createPortalRoutes,
  type PortalLiveData,
  type PortalRoute,
} from './portalLayout';
import { PortalOverlayView } from './PortalOverlayView';
import {
  PORTAL_LABEL_LAYOUT,
  assignPortalLabelRows,
  portalLabelCenterY,
} from './portalLabelLayout';

const RING_RADIUS = 2.05;
const RING_TUBE = 0.18;
const PORTAL_CENTER_Y = 2.22;
/** Labels resolve as the player approaches; distant outer worlds remain calm silhouettes. */
const PORTAL_LABEL_REVEAL_RADIUS = 42;

const DESTINATION_COLORS: Readonly<Record<AssetSymbol, number>> = {
  BTC: 0xe7a869,
  ETH: 0xaaa5d7,
  SOL: 0x72b8aa,
  XRP: 0x90b4cc,
  DOGE: 0xddba72,
  BNB: 0xe3bd69,
  LINK: 0x7e9ccb,
  AVAX: 0xd9857d,
  WTI: 0x7f8f88,
  TEST: 0xd68bd8,
  PUMP: 0xe990b7,
  ANSEM: 0x746b83,
  SHFL: 0x75a9d6,
  SKHYNIX: 0xb291d1,
  HYPE: 0x69cfc0,
  XYZ100: 0x70a9dc,
  SP500: 0x91b99b,
  MU: 0x8d83cf,
  SPACEX: 0xaeb8c8,
  NVDA: 0x84bd69,
  GOLD: 0xe2c36d,
  AAPL: 0xc9ced4,
  META: 0x72a0df,
  GOOGL: 0xda8a79,
};

interface PortalVisual {
  readonly route: PortalRoute;
  readonly group: Group;
  readonly ring: Mesh<TorusGeometry, MeshStandardMaterial>;
  readonly frontLabel: PortalLabelFace;
  readonly backLabel: PortalLabelFace;
}

interface PortalLabelFace {
  readonly root: Group;
  readonly title: Text;
  readonly status: Text;
  readonly population: Text;
}

export interface PortalSystemOptions {
  readonly parent: Object3D;
  readonly activeMarket: AssetSymbol;
  readonly fontUrl?: string;
  readonly heightAt?: (x: number, z: number) => number;
  readonly overlayParent?: HTMLElement;
  readonly reducedMotion?: boolean;
  readonly onTravelRequested?: (route: PortalRoute) => void | Promise<void>;
  readonly onPortalChime?: (route: PortalRoute, stage: 'start' | 'cancel' | 'complete') => void;
}

export interface PortalSystemDebugStats {
  readonly activeMarket: AssetSymbol;
  readonly portals: number;
  readonly labels: number;
  readonly travelPending: boolean;
  readonly dwell: PortalDwellSnapshot;
}

function finiteHeight(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Standalone Three/Troika presentation plus portal dwell orchestration. */
export class PortalSystem implements GameSystem {
  public readonly root = new Group();

  private readonly heightAt: (x: number, z: number) => number;
  private readonly fontUrl?: string;
  private reducedMotion: boolean;
  private readonly onTravelRequested?: (route: PortalRoute) => void | Promise<void>;
  private readonly onPortalChime?: (route: PortalRoute, stage: 'start' | 'cancel' | 'complete') => void;
  private readonly overlay: PortalOverlayView | null;
  private readonly ringGeometry = new TorusGeometry(RING_RADIUS, RING_TUBE, 8, 32);
  private readonly apertureGeometry = new CircleGeometry(RING_RADIUS - RING_TUBE * 1.5, 32);
  private readonly pedestalGeometry = new CylinderGeometry(0.38, 0.52, 0.42, 8);
  private readonly labelCardGeometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.12);
  private readonly pedestalMaterial = new MeshStandardMaterial({
    color: PALETTE.stoneDark,
    roughness: 0.86,
    flatShading: true,
  });
  private readonly apertureMaterial = new MeshBasicMaterial({
    color: PALETTE.cream,
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
    side: DoubleSide,
  });
  // Depth-writing opaque backing prevents the rear Troika face from bleeding
  // through when a renderer/material variant treats glyphs as double-sided.
  private readonly labelCardMaterial = new MeshBasicMaterial({
    color: PALETTE.ink,
    side: DoubleSide,
    toneMapped: false,
  });
  private readonly ringMaterials = new Map<AssetSymbol, MeshStandardMaterial>();
  private readonly visuals: PortalVisual[] = [];
  private readonly liveData = new Map<AssetSymbol, PortalLiveData>();
  private dwellController: PortalDwellController;
  private routes: readonly PortalRoute[];
  private probe: PortalPlayerProbe = { x: 0, z: 0, grounded: false, enabled: false };
  private activeMarket: AssetSymbol;
  private pendingRoute: PortalRoute | null = null;
  private disposed = false;

  public constructor(options: PortalSystemOptions) {
    this.root.name = 'tickerworld-portals';
    this.heightAt = options.heightAt ?? (() => 0);
    this.fontUrl = options.fontUrl;
    this.reducedMotion = options.reducedMotion ?? false;
    this.onTravelRequested = options.onTravelRequested;
    this.onPortalChime = options.onPortalChime;
    this.overlay = options.overlayParent ? new PortalOverlayView(options.overlayParent) : null;
    this.activeMarket = options.activeMarket;
    this.routes = createPortalRoutes(this.activeMarket);
    this.dwellController = new PortalDwellController(this.routes);
    this.buildVisuals();
    options.parent.add(this.root);
  }

  public getActiveMarket(): AssetSymbol {
    return this.activeMarket;
  }

  public getRoutes(): readonly PortalRoute[] {
    return this.routes;
  }

  public setActiveMarket(activeMarket: AssetSymbol): void {
    if (this.disposed || activeMarket === this.activeMarket) {
      this.cancelTravel();
      return;
    }
    this.activeMarket = activeMarket;
    this.routes = createPortalRoutes(activeMarket);
    this.dwellController.setRoutes(this.routes, true);
    this.pendingRoute = null;
    this.overlay?.hideLoading();
    this.clearVisuals();
    this.buildVisuals();
  }

  public setPlayerProbe(probe: PortalPlayerProbe): void {
    this.probe = probe;
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  /** Keeps the shared loading veil visible for history-driven room transfers. */
  public beginTransfer(destination: AssetSymbol): void {
    if (this.disposed) return;
    this.overlay?.showLoading(destination);
  }

  public setLiveData(symbol: AssetSymbol, data: PortalLiveData): void {
    this.liveData.set(symbol, data);
    const visual = this.visuals.find(({ route }) => route.destination === symbol);
    if (visual) this.updateLabel(visual);
  }

  public cancelTravel(): void {
    this.pendingRoute = null;
    this.dwellController.reset(0);
    this.overlay?.hideLoading();
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.disposed) return;
    const delta = Math.min(0.1, Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
    const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    this.animateVisuals(elapsed);

    if (this.pendingRoute) return;
    const dwell = this.dwellController.update(delta, this.probe);
    this.overlay?.setDwell(dwell.snapshot);
    if (dwell.cancelled) this.onPortalChime?.(dwell.cancelled, 'cancel');
    if (dwell.started) this.onPortalChime?.(dwell.started, 'start');
    if (!dwell.completed) return;

    this.pendingRoute = dwell.completed;
    this.overlay?.showLoading(dwell.completed.destination);
    this.onPortalChime?.(dwell.completed, 'complete');
    try {
      const result = this.onTravelRequested?.(dwell.completed);
      if (result && typeof result.then === 'function') {
        void result.catch(() => this.cancelTravel());
      }
    } catch {
      this.cancelTravel();
    }
  }

  public setVisible(visible: boolean): void {
    this.root.visible = visible;
    if (!visible) this.overlay?.hide();
  }

  public getDebugStats(): PortalSystemDebugStats {
    return {
      activeMarket: this.activeMarket,
      portals: this.visuals.length,
      labels: this.visuals.length * 2,
      travelPending: this.pendingRoute !== null,
      dwell: this.dwellController.snapshot(),
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.overlay?.dispose();
    this.clearVisuals();
    this.root.removeFromParent();
    this.ringGeometry.dispose();
    this.apertureGeometry.dispose();
    this.pedestalGeometry.dispose();
    this.labelCardGeometry.dispose();
    this.pedestalMaterial.dispose();
    this.apertureMaterial.dispose();
    this.labelCardMaterial.dispose();
    for (const material of this.ringMaterials.values()) material.dispose();
    this.ringMaterials.clear();
    this.root.clear();
  }

  private buildVisuals(): void {
    const labelRows = assignPortalLabelRows(this.routes);
    for (const route of this.routes) {
      const group = new Group();
      group.name = route.id;
      group.position.set(route.x, finiteHeight(this.heightAt(route.x, route.z)), route.z);
      group.rotation.y = -route.bearing;

      const ring = new Mesh(this.ringGeometry, this.materialFor(route.destination));
      ring.name = `${route.id}-ring`;
      ring.position.y = PORTAL_CENTER_Y;
      ring.castShadow = true;
      ring.receiveShadow = true;

      const aperture = new Mesh(this.apertureGeometry, this.apertureMaterial);
      aperture.name = `${route.id}-aperture`;
      aperture.position.set(0, PORTAL_CENTER_Y, -0.012);

      const leftPedestal = new Mesh(this.pedestalGeometry, this.pedestalMaterial);
      leftPedestal.name = `${route.id}-left-pedestal`;
      leftPedestal.position.set(-1.58, 0.21, 0);
      leftPedestal.castShadow = true;
      leftPedestal.receiveShadow = true;
      const rightPedestal = leftPedestal.clone();
      rightPedestal.name = `${route.id}-right-pedestal`;
      rightPedestal.position.x = 1.58;

      const labelCenterY = portalLabelCenterY(labelRows.get(route.id) ?? 0);
      const frontLabel = this.createLabel(route, 'front', labelCenterY);
      const backLabel = this.createLabel(route, 'back', labelCenterY);
      group.add(ring, aperture, leftPedestal, rightPedestal, frontLabel.root, backLabel.root);
      this.root.add(group);
      const visual = { route, group, ring, frontLabel, backLabel };
      this.visuals.push(visual);
      this.updateLabel(visual);
    }
  }

  private createLabel(
    route: PortalRoute,
    side: 'front' | 'back',
    centerY: number,
  ): PortalLabelFace {
    const root = new Group();
    root.name = `${route.id}-${side}-label`;
    root.position.set(0, centerY, side === 'front' ? 0.1 : -0.1);
    if (side === 'back') root.rotation.y = Math.PI;

    const card = new Mesh(this.labelCardGeometry, this.labelCardMaterial);
    card.name = `${route.id}-${side}-label-card`;
    card.scale.set(PORTAL_LABEL_LAYOUT.cardWidth, PORTAL_LABEL_LAYOUT.cardHeight, 0.08);
    card.renderOrder = 1;
    root.add(card);

    const createLine = (
      name: string,
      fontSize: number,
      y: number,
    ): Text => {
      const text = new Text();
      text.name = `${route.id}-${side}-${name}`;
      text.fontSize = fontSize;
      text.color = PALETTE.cream;
      text.anchorX = 'center';
      text.anchorY = 'middle';
      text.textAlign = 'center';
      text.whiteSpace = 'nowrap';
      text.maxWidth = PORTAL_LABEL_LAYOUT.textMaxWidth;
      text.outlineWidth = '2%';
      text.outlineColor = PALETTE.ink;
      text.outlineOpacity = 0.5;
      text.depthOffset = -2;
      text.renderOrder = 2;
      text.position.set(0, y, 0.055);
      if (this.fontUrl) text.font = this.fontUrl;
      root.add(text);
      return text;
    };

    const title = createLine('title', PORTAL_LABEL_LAYOUT.titleFontSize, PORTAL_LABEL_LAYOUT.titleY);
    const status = createLine('status', PORTAL_LABEL_LAYOUT.statusFontSize, PORTAL_LABEL_LAYOUT.statusY);
    const population = createLine(
      'population',
      PORTAL_LABEL_LAYOUT.populationFontSize,
      PORTAL_LABEL_LAYOUT.populationY,
    );
    return { root, title, status, population };
  }

  private updateLabel(visual: PortalVisual): void {
    const data = this.liveData.get(visual.route.destination) ?? {
      price: null,
      population: null,
      connectionMode: 'offline' as const,
    };
    const model = createPortalLabelModel(visual.route, data);
    for (const face of [visual.frontLabel, visual.backLabel]) {
      face.title.text = model.title;
      face.status.text = `${model.priceText} · ${model.marketText}`;
      face.population.text = model.populationText;
    }
    if (typeof self !== 'undefined') {
      for (const face of [visual.frontLabel, visual.backLabel]) {
        face.title.sync();
        face.status.sync();
        face.population.sync();
      }
    }
  }

  private materialFor(symbol: AssetSymbol): MeshStandardMaterial {
    const existing = this.ringMaterials.get(symbol);
    if (existing) return existing;
    const material = new MeshStandardMaterial({
      color: DESTINATION_COLORS[symbol],
      emissive: DESTINATION_COLORS[symbol],
      emissiveIntensity: 0.14,
      roughness: 0.58,
      metalness: 0.04,
      flatShading: true,
    });
    this.ringMaterials.set(symbol, material);
    return material;
  }

  private animateVisuals(elapsedSeconds: number): void {
    const motionScale = this.reducedMotion ? 0.18 : 1;
    this.visuals.forEach((visual, index) => {
      const phase = elapsedSeconds * 0.85 + index * 0.73;
      visual.ring.rotation.z = Math.sin(phase) * 0.055 * motionScale;
      const pulse = 1 + Math.sin(phase * 1.35) * 0.018 * motionScale;
      visual.ring.scale.setScalar(pulse);
      visual.group.position.y = finiteHeight(this.heightAt(visual.route.x, visual.route.z))
        + Math.sin(phase * 0.72) * 0.045 * motionScale;
      const labelVisible = Math.hypot(
        this.probe.x - visual.route.x,
        this.probe.z - visual.route.z,
      ) <= PORTAL_LABEL_REVEAL_RADIUS;
      visual.frontLabel.root.visible = labelVisible;
      visual.backLabel.root.visible = labelVisible;
    });
  }

  private clearVisuals(): void {
    for (const visual of this.visuals) {
      for (const face of [visual.frontLabel, visual.backLabel]) {
        face.title.dispose();
        face.status.dispose();
        face.population.dispose();
      }
      visual.group.removeFromParent();
      visual.group.clear();
    }
    this.visuals.length = 0;
  }
}
