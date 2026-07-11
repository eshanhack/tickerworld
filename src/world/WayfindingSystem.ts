import {
  BoxGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { Text } from 'troika-three-text';
import { GRAND_MONUMENTS, PALETTE } from '../config';
import type { AssetSymbol } from '../types';
import {
  createMarketRoadSignDescriptors,
  createRoadSignDescriptors,
  type RoadSignDescriptor,
  type WayfindingCoordinate,
} from './RoadSignLayout';

export interface WayfindingSystemOptions {
  readonly parent: Object3D;
  readonly fontUrl?: string;
  readonly heightAt?: (x: number, z: number) => number;
  readonly monuments?: readonly WayfindingCoordinate[];
  /** When set, render only the seven portal-entry signs for this bounded world. */
  readonly activeMarket?: AssetSymbol;
}

const BOARD_WIDTH = 3.1;
const BOARD_HEIGHT = 0.62;
const BOARD_DEPTH = 0.14;
const BOARD_Y = 1.55;
const POLE_HEIGHT = 1.88;
const POLE_SPACING = 2.16;

const BOARD_COLORS = [
  PALETTE.terracotta,
  PALETTE.teal,
  PALETTE.pink,
  PALETTE.green,
] as const;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Fourteen static road-entry signs. No billboard work is required per frame. */
export class WayfindingSystem {
  public readonly root = new Group();
  public descriptors: readonly RoadSignDescriptor[];

  private readonly boardGeometry = new BoxGeometry(BOARD_WIDTH, BOARD_HEIGHT, BOARD_DEPTH);
  private readonly poleGeometry = new CylinderGeometry(0.09, 0.12, 1, 8);
  private readonly baseGeometry = new CylinderGeometry(0.21, 0.27, 0.18, 8);
  private readonly capGeometry = new DodecahedronGeometry(0.135, 0);
  private readonly boardMaterials = BOARD_COLORS.map((color) => new MeshStandardMaterial({
    color,
    roughness: 0.82,
    flatShading: true,
  }));
  private readonly postMaterial = new MeshStandardMaterial({
    color: PALETTE.ink,
    roughness: 0.78,
    flatShading: true,
  });
  private readonly baseMaterial = new MeshStandardMaterial({
    color: PALETTE.stoneDark,
    roughness: 0.9,
    flatShading: true,
  });
  private readonly texts: Text[] = [];
  private readonly heightAt: (x: number, z: number) => number;
  private readonly fontUrl?: string;
  private readonly monuments: readonly WayfindingCoordinate[];
  private disposed = false;

  public constructor(options: WayfindingSystemOptions) {
    this.root.name = 'tickerworld-wayfinding';
    this.heightAt = options.heightAt ?? (() => 0);
    this.fontUrl = options.fontUrl;
    this.monuments = options.monuments ?? GRAND_MONUMENTS;
    this.descriptors = options.activeMarket
      ? createMarketRoadSignDescriptors(options.activeMarket, this.monuments)
      : createRoadSignDescriptors(this.monuments);
    this.rebuild();
    options.parent.add(this.root);
  }

  public setActiveMarket(activeMarket: AssetSymbol): void {
    if (this.disposed) return;
    this.descriptors = createMarketRoadSignDescriptors(activeMarket, this.monuments);
    this.rebuild();
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
    this.boardGeometry.dispose();
    this.poleGeometry.dispose();
    this.baseGeometry.dispose();
    this.capGeometry.dispose();
    for (const material of this.boardMaterials) material.dispose();
    this.postMaterial.dispose();
    this.baseMaterial.dispose();
    this.root.clear();
  }

  private buildSign(
    descriptor: RoadSignDescriptor,
    index: number,
    groundHeight: number,
    fontUrl?: string,
  ): Group {
    const sign = new Group();
    sign.name = descriptor.id;
    sign.position.set(descriptor.x, groundHeight, descriptor.z);
    // A traveller leaving the origin sees the front face head-on. The board
    // width therefore runs along the road tangent, clear of the sand lane.
    sign.rotation.y = -descriptor.bearing;

    const board = new Mesh(
      this.boardGeometry,
      this.boardMaterials[index % this.boardMaterials.length],
    );
    board.name = `${descriptor.id}-board`;
    board.position.y = BOARD_Y;
    board.castShadow = true;
    board.receiveShadow = true;
    sign.add(board);

    for (const poleX of [-POLE_SPACING * 0.5, POLE_SPACING * 0.5]) {
      const pole = new Mesh(this.poleGeometry, this.postMaterial);
      pole.name = `${descriptor.id}-pole`;
      pole.position.set(poleX, POLE_HEIGHT * 0.5, 0);
      pole.scale.y = POLE_HEIGHT;
      pole.castShadow = true;
      pole.receiveShadow = true;

      const base = new Mesh(this.baseGeometry, this.baseMaterial);
      base.name = `${descriptor.id}-base`;
      base.position.set(poleX, 0.09, 0);
      base.castShadow = true;
      base.receiveShadow = true;

      const cap = new Mesh(this.capGeometry, this.postMaterial);
      cap.name = `${descriptor.id}-cap`;
      cap.position.set(poleX, POLE_HEIGHT + 0.025, 0);
      cap.rotation.y = Math.PI * 0.25;
      cap.castShadow = true;
      sign.add(pole, base, cap);
    }

    sign.add(
      this.buildLabel(descriptor, 'front', BOARD_DEPTH * 0.5 + 0.012, fontUrl),
      this.buildLabel(descriptor, 'back', -BOARD_DEPTH * 0.5 - 0.012, fontUrl),
    );
    return sign;
  }

  private rebuild(): void {
    for (const text of this.texts) text.dispose();
    this.texts.length = 0;
    this.root.clear();
    this.descriptors.forEach((descriptor, index) => {
      this.root.add(this.buildSign(
        descriptor,
        index,
        finiteOrZero(this.heightAt(descriptor.x, descriptor.z)),
        this.fontUrl,
      ));
    });
  }

  private buildLabel(
    descriptor: RoadSignDescriptor,
    side: 'front' | 'back',
    z: number,
    fontUrl?: string,
  ): Text {
    const text = new Text();
    text.name = `${descriptor.id}-${side}-label`;
    text.text = descriptor.label;
    text.fontSize = 0.275;
    text.color = PALETTE.cream;
    text.anchorX = 'center';
    text.anchorY = 'middle';
    text.textAlign = 'center';
    text.maxWidth = BOARD_WIDTH - 0.24;
    text.outlineWidth = '2%';
    text.outlineColor = PALETTE.ink;
    text.outlineOpacity = 0.5;
    text.position.set(0, BOARD_Y, z);
    if (side === 'back') text.rotation.y = Math.PI;
    if (fontUrl) text.font = fontUrl;
    if (typeof self !== 'undefined') text.sync();
    this.texts.push(text);
    return text;
  }
}
