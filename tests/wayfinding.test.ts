import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { describe, expect, it, vi } from 'vitest';

import { GRAND_MONUMENTS } from '../src/config';
import {
  WayfindingSystem,
  bearingBetween,
  createWayfindingPostLayout,
  formatWayfindingDistance,
  selectWayfindingDestinations,
} from '../src/world/WayfindingSystem';

describe('wayfinding layout helpers', () => {
  it('uses true -Z-forward world bearings in all cardinal directions', () => {
    const origin = { x: 0, z: 0 };
    expect(bearingBetween(origin, { x: 0, z: -10 })).toBeCloseTo(0, 8);
    expect(bearingBetween(origin, { x: 10, z: 0 })).toBeCloseTo(Math.PI / 2, 8);
    expect(Math.abs(bearingBetween(origin, { x: 0, z: 10 }))).toBeCloseTo(Math.PI, 8);
    expect(bearingBetween(origin, { x: -10, z: 0 })).toBeCloseTo(-Math.PI / 2, 8);
  });

  it('shows all seven destinations at BTC and the nearest three elsewhere', () => {
    const btc = GRAND_MONUMENTS.find((market) => market.symbol === 'BTC');
    const eth = GRAND_MONUMENTS.find((market) => market.symbol === 'ETH');
    expect(btc).toBeDefined();
    expect(eth).toBeDefined();
    if (!btc || !eth) return;

    const fromBtc = selectWayfindingDestinations(btc);
    expect(fromBtc).toHaveLength(7);
    expect(new Set(fromBtc.map((destination) => destination.symbol)).size).toBe(7);

    const fromEth = selectWayfindingDestinations(eth);
    const independentlySorted = GRAND_MONUMENTS
      .filter((candidate) => candidate.symbol !== 'ETH')
      .sort((left, right) => (
        Math.hypot(left.x - eth.x, left.z - eth.z)
        - Math.hypot(right.x - eth.x, right.z - eth.z)
      ))
      .slice(0, 3)
      .map((candidate) => candidate.symbol);
    expect(fromEth.map((destination) => destination.symbol)).toEqual(independentlySorted);
    expect(fromEth.every((destination) => destination.label.includes(' · '))).toBe(true);
  });

  it('rounds distances and places outer posts precisely on their BTC-facing edge', () => {
    expect(formatWayfindingDistance(202.48)).toBe('200m');
    expect(formatWayfindingDistance(207.1)).toBe('210m');

    const eth = GRAND_MONUMENTS.find((market) => market.symbol === 'ETH');
    const btc = GRAND_MONUMENTS.find((market) => market.symbol === 'BTC');
    expect(eth).toBeDefined();
    expect(btc).toBeDefined();
    if (!eth || !btc) return;

    const layout = createWayfindingPostLayout(eth);
    const postDirection = new THREE.Vector2(layout.x - eth.x, layout.z - eth.z).normalize();
    const btcDirection = new THREE.Vector2(btc.x - eth.x, btc.z - eth.z).normalize();
    expect(postDirection.dot(btcDirection)).toBeCloseTo(1, 8);
    expect(Math.hypot(layout.x - eth.x, layout.z - eth.z)).toBeCloseTo(10.85, 8);
  });
});

describe('WayfindingSystem presentation', () => {
  it('builds eight low-poly posts, 28 fixed blades, and two labels per blade', () => {
    const parent = new THREE.Group();
    const system = new WayfindingSystem({
      parent,
      heightAt: () => 4.25,
    });

    const posts = system.root.children.filter((child) => child.name.startsWith('wayfinding-'));
    const bladeGroups: THREE.Object3D[] = [];
    const boards: THREE.Mesh[] = [];
    const labels: Text[] = [];
    system.root.traverse((object) => {
      if (object.name.includes('-sign-to-')) bladeGroups.push(object);
      if (object.name.endsWith('-blade') && object instanceof THREE.Mesh) boards.push(object);
      if (object instanceof Text) labels.push(object);
    });

    expect(parent.children).toContain(system.root);
    expect(posts).toHaveLength(8);
    expect(posts.every((post) => post.position.y === 4.25)).toBe(true);
    expect(bladeGroups).toHaveLength(28);
    expect(boards).toHaveLength(28);
    expect(labels).toHaveLength(56);
    expect(new Set(boards.map((board) => board.geometry)).size).toBe(1);
    expect(new Set(boards.map((board) => board.material)).size).toBeLessThanOrEqual(4);

    const ethLayout = createWayfindingPostLayout(
      GRAND_MONUMENTS.find((market) => market.symbol === 'ETH')!,
    );
    const firstEthBlade = system.root.getObjectByName(
      `ETH-sign-to-${ethLayout.destinations[0]?.symbol ?? ''}`,
    );
    expect(firstEthBlade?.rotation.y).toBeCloseTo(
      Math.PI * 0.5 - (ethLayout.destinations[0]?.bearing ?? 0),
      8,
    );

    system.dispose();
  });

  it('disposes every shared geometry, material, and Troika label exactly once', () => {
    const parent = new THREE.Group();
    const system = new WayfindingSystem({ parent });
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const texts: Text[] = [];
    system.root.traverse((object) => {
      if (object instanceof Text) texts.push(object);
      if (object instanceof THREE.Mesh && !(object instanceof Text)) {
        geometries.add(object.geometry);
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of meshMaterials) materials.add(material);
      }
    });
    const geometrySpies = [...geometries].map((geometry) => vi.spyOn(geometry, 'dispose'));
    const materialSpies = [...materials].map((material) => vi.spyOn(material, 'dispose'));
    const textSpies = texts.map((text) => vi.spyOn(text, 'dispose'));

    system.dispose();
    system.dispose();

    expect(parent.children).not.toContain(system.root);
    expect(system.root.children).toHaveLength(0);
    for (const spy of [...geometrySpies, ...materialSpies, ...textSpies]) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});
