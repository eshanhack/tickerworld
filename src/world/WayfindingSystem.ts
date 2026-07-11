import {
  CylinderGeometry,
  DodecahedronGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Shape,
} from 'three';
import { Text } from 'troika-three-text';
import { GRAND_MONUMENTS, PALETTE } from '../config';
import type { AssetSymbol } from '../types';

export interface WayfindingCoordinate {
  readonly symbol: AssetSymbol;
  readonly x: number;
  readonly z: number;
  readonly scale?: number;
}

export interface WayfindingDestination extends WayfindingCoordinate {
  readonly distance: number;
  /** World bearing in radians: 0 points north (-Z), PI / 2 points east (+X). */
  readonly bearing: number;
  readonly label: string;
}

export interface WayfindingPostLayout {
  readonly origin: WayfindingCoordinate;
  readonly x: number;
  readonly z: number;
  readonly edgeBearing: number;
  readonly destinations: readonly WayfindingDestination[];
}

export interface WayfindingSystemOptions {
  readonly parent: Object3D;
  readonly fontUrl?: string;
  readonly heightAt?: (x: number, z: number) => number;
  readonly monuments?: readonly WayfindingCoordinate[];
}

const DESTINATIONS_AT_BTC = 7;
const DESTINATIONS_AT_OTHER_MARKETS = 3;
const POST_EDGE_RADIUS = 10.85;
const BTC_VISITOR_EDGE_BEARING = Math.PI;
const BTC_LATERAL_OFFSET = 4.5;
const BLADE_LENGTH = 3.85;
const BLADE_HEIGHT = 0.56;
const BLADE_DEPTH = 0.13;
const BLADE_BASE_Y = 2.15;
const BLADE_SPACING = 0.55;

const BLADE_COLORS = [
  PALETTE.terracotta,
  PALETTE.teal,
  PALETTE.pink,
  0xd8b76c,
] as const;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Returns the true horizontal world bearing, using Tickerworld's -Z-forward convention. */
export function bearingBetween(
  from: Pick<WayfindingCoordinate, 'x' | 'z'>,
  to: Pick<WayfindingCoordinate, 'x' | 'z'>,
): number {
  return Math.atan2(to.x - from.x, -(to.z - from.z));
}

/** Converts a bearing into a unit vector on the XZ plane. */
export function directionForBearing(bearing: number): Readonly<{ x: number; z: number }> {
  return { x: Math.sin(bearing), z: -Math.cos(bearing) };
}

/** World distances are presented as friendly metres rounded to the nearest ten. */
export function formatWayfindingDistance(distance: number): string {
  const rounded = Math.max(0, Math.round(finiteOrZero(distance) / 10) * 10);
  return `${rounded}m`;
}

/** Selects all seven destinations at BTC and the three nearest everywhere else. */
export function selectWayfindingDestinations(
  origin: WayfindingCoordinate,
  monuments: readonly WayfindingCoordinate[] = GRAND_MONUMENTS,
): readonly WayfindingDestination[] {
  const limit = origin.symbol === 'BTC'
    ? DESTINATIONS_AT_BTC
    : DESTINATIONS_AT_OTHER_MARKETS;

  return monuments
    .filter((candidate) => candidate.symbol !== origin.symbol)
    .map((candidate): WayfindingDestination => {
      const distance = Math.hypot(candidate.x - origin.x, candidate.z - origin.z);
      return {
        ...candidate,
        distance,
        bearing: bearingBetween(origin, candidate),
        label: `${candidate.symbol} · ${formatWayfindingDistance(distance)}`,
      };
    })
    .sort((left, right) => left.distance - right.distance || left.symbol.localeCompare(right.symbol))
    .slice(0, limit);
}

/**
 * Places each outer sign on the edge facing BTC. BTC's own post sits beside
 * the +Z visitor steps, offset laterally so it never blocks the main approach.
 */
export function createWayfindingPostLayout(
  origin: WayfindingCoordinate,
  monuments: readonly WayfindingCoordinate[] = GRAND_MONUMENTS,
): WayfindingPostLayout {
  const btc = monuments.find((candidate) => candidate.symbol === 'BTC');
  const edgeBearing = origin.symbol === 'BTC' || !btc
    ? BTC_VISITOR_EDGE_BEARING
    : bearingBetween(origin, btc);
  const scale = origin.scale ?? 1;
  const radius = POST_EDGE_RADIUS * scale;
  const direction = directionForBearing(edgeBearing);
  const tangent = { x: -direction.z, z: direction.x };
  const lateral = origin.symbol === 'BTC' ? BTC_LATERAL_OFFSET * scale : 0;
  const radial = Math.sqrt(Math.max(0, radius * radius - lateral * lateral));

  return {
    origin,
    x: origin.x + direction.x * radial + tangent.x * lateral,
    z: origin.z + direction.z * radial + tangent.z * lateral,
    edgeBearing,
    destinations: selectWayfindingDestinations(origin, monuments),
  };
}

export function createWayfindingLayouts(
  monuments: readonly WayfindingCoordinate[] = GRAND_MONUMENTS,
): readonly WayfindingPostLayout[] {
  return monuments.map((origin) => createWayfindingPostLayout(origin, monuments));
}

function createBladeGeometry(): ExtrudeGeometry {
  const shape = new Shape();
  shape.moveTo(0, -BLADE_HEIGHT * 0.5);
  shape.lineTo(BLADE_LENGTH - 0.62, -BLADE_HEIGHT * 0.5);
  shape.lineTo(BLADE_LENGTH, 0);
  shape.lineTo(BLADE_LENGTH - 0.62, BLADE_HEIGHT * 0.5);
  shape.lineTo(0, BLADE_HEIGHT * 0.5);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, {
    depth: BLADE_DEPTH,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -BLADE_DEPTH * 0.5);
  return geometry;
}

/** Static, world-oriented plaza signposts. No per-frame billboard work is required. */
export class WayfindingSystem {
  public readonly root = new Group();

  private readonly bladeGeometry = createBladeGeometry();
  private readonly poleGeometry = new CylinderGeometry(0.13, 0.17, 1, 8);
  private readonly baseGeometry = new CylinderGeometry(0.34, 0.42, 0.28, 10);
  private readonly capGeometry = new DodecahedronGeometry(0.24, 0);
  private readonly bladeMaterials = BLADE_COLORS.map((color) => new MeshStandardMaterial({
    color,
    roughness: 0.84,
    flatShading: true,
  }));
  private readonly postMaterial = new MeshStandardMaterial({
    color: PALETTE.ink,
    roughness: 0.76,
    flatShading: true,
  });
  private readonly baseMaterial = new MeshStandardMaterial({
    color: PALETTE.stoneDark,
    roughness: 0.9,
    flatShading: true,
  });
  private readonly texts: Text[] = [];
  private disposed = false;

  public constructor(options: WayfindingSystemOptions) {
    this.root.name = 'tickerworld-wayfinding';
    const heightAt = options.heightAt ?? (() => 0);
    const layouts = createWayfindingLayouts(options.monuments ?? GRAND_MONUMENTS);
    for (const layout of layouts) {
      this.root.add(this.buildPost(layout, finiteOrZero(heightAt(layout.x, layout.z)), options.fontUrl));
    }
    options.parent.add(this.root);
  }

  public setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const text of this.texts) text.dispose();
    this.texts.length = 0;
    this.bladeGeometry.dispose();
    this.poleGeometry.dispose();
    this.baseGeometry.dispose();
    this.capGeometry.dispose();
    for (const material of this.bladeMaterials) material.dispose();
    this.postMaterial.dispose();
    this.baseMaterial.dispose();
    this.root.clear();
  }

  private buildPost(layout: WayfindingPostLayout, groundHeight: number, fontUrl?: string): Group {
    const post = new Group();
    post.name = `wayfinding-${layout.origin.symbol}`;
    post.position.set(layout.x, groundHeight, layout.z);

    const topBladeY = BLADE_BASE_Y + Math.max(0, layout.destinations.length - 1) * BLADE_SPACING;
    const poleHeight = topBladeY + 0.72;
    const pole = new Mesh(this.poleGeometry, this.postMaterial);
    pole.name = `${layout.origin.symbol}-signpost-pole`;
    pole.position.y = poleHeight * 0.5;
    pole.scale.y = poleHeight;
    pole.castShadow = true;
    pole.receiveShadow = true;

    const base = new Mesh(this.baseGeometry, this.baseMaterial);
    base.name = `${layout.origin.symbol}-signpost-base`;
    base.position.y = 0.14;
    base.castShadow = true;
    base.receiveShadow = true;

    const cap = new Mesh(this.capGeometry, this.postMaterial);
    cap.name = `${layout.origin.symbol}-signpost-cap`;
    cap.position.y = poleHeight + 0.08;
    cap.rotation.y = Math.PI * 0.25;
    cap.castShadow = true;
    post.add(pole, base, cap);

    layout.destinations.forEach((destination, index) => {
      const blade = new Group();
      blade.name = `${layout.origin.symbol}-sign-to-${destination.symbol}`;
      blade.position.y = BLADE_BASE_Y
        + (layout.destinations.length - 1 - index) * BLADE_SPACING;
      // Blade geometry points along local +X. This converts the -Z-forward
      // world bearing into a fixed world yaw; it never rotates toward camera.
      blade.rotation.y = Math.PI * 0.5 - destination.bearing;

      const board = new Mesh(
        this.bladeGeometry,
        this.bladeMaterials[index % this.bladeMaterials.length],
      );
      board.name = `${layout.origin.symbol}-to-${destination.symbol}-blade`;
      board.castShadow = true;
      board.receiveShadow = true;
      blade.add(board);

      blade.add(
        this.buildLabel(destination.label, 'front', BLADE_DEPTH * 0.5 + 0.012, fontUrl),
        this.buildLabel(destination.label, 'back', -BLADE_DEPTH * 0.5 - 0.012, fontUrl),
      );
      post.add(blade);
    });

    return post;
  }

  private buildLabel(
    label: string,
    side: 'front' | 'back',
    z: number,
    fontUrl?: string,
  ): Text {
    const text = new Text();
    text.name = `${label.split(' ')[0]?.toLowerCase() ?? 'market'}-${side}-sign-label`;
    text.text = label;
    text.fontSize = 0.29;
    text.color = PALETTE.cream;
    text.anchorX = 'center';
    text.anchorY = 'middle';
    text.textAlign = 'center';
    text.outlineWidth = '2%';
    text.outlineColor = PALETTE.ink;
    text.outlineOpacity = 0.48;
    text.position.set((BLADE_LENGTH - 0.42) * 0.5, 0, z);
    if (side === 'back') text.rotation.y = Math.PI;
    if (fontUrl) text.font = fontUrl;
    if (typeof self !== 'undefined') text.sync();
    this.texts.push(text);
    return text;
  }
}
