import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { describe, expect, it, vi } from 'vitest';

import { CHUNK_SIZE, GRAND_MONUMENTS, WORLD_SEED } from '../src/config';
import { generateChunkLayout, TerrainSampler } from '../src/world';
import {
  ROAD_SIGN_PROP_CLEARANCE,
  ROAD_SIGN_RADIAL_OFFSET,
  ROAD_SIGN_SHOULDER_OFFSET,
  bearingBetween,
  createCanonicalRoadDescriptors,
  createMarketRoadSignDescriptors,
  createRoadSignDescriptors,
  createRoadSignExclusionPoints,
  directionForBearing,
  formatWayfindingDistance,
} from '../src/world/RoadSignLayout';
import { WayfindingSystem } from '../src/world/WayfindingSystem';

describe('canonical road-sign layout', () => {
  it('uses true -Z-forward world bearings in all cardinal directions', () => {
    const origin = { x: 0, z: 0 };
    expect(bearingBetween(origin, { x: 0, z: -10 })).toBeCloseTo(0, 8);
    expect(bearingBetween(origin, { x: 10, z: 0 })).toBeCloseTo(Math.PI / 2, 8);
    expect(Math.abs(bearingBetween(origin, { x: 0, z: 10 }))).toBeCloseTo(Math.PI, 8);
    expect(bearingBetween(origin, { x: -10, z: 0 })).toBeCloseTo(-Math.PI / 2, 8);
  });

  it('rounds friendly road distances to the nearest ten metres', () => {
    expect(formatWayfindingDistance(202.48)).toBe('200m');
    expect(formatWayfindingDistance(207.1)).toBe('210m');
    expect(formatWayfindingDistance(Number.NaN)).toBe('0m');
  });

  it('maps exactly fourteen directed signs onto the seven real BTC spokes', () => {
    const roads = createCanonicalRoadDescriptors();
    const signs = createRoadSignDescriptors();
    expect(roads).toHaveLength(7);
    expect(signs).toHaveLength(14);
    expect(new Set(signs.map((sign) => sign.id)).size).toBe(14);
    expect(new Set(signs.map((sign) => sign.roadId))).toEqual(
      new Set(roads.map((road) => road.id)),
    );

    const outbound = signs.filter((sign) => sign.origin.symbol === 'BTC');
    const returns = signs.filter((sign) => sign.destination.symbol === 'BTC');
    expect(outbound).toHaveLength(7);
    expect(returns).toHaveLength(7);
    expect(new Set(outbound.map((sign) => sign.destination.symbol)).size).toBe(7);
    expect(returns.every((sign) => sign.origin.symbol !== 'BTC')).toBe(true);
    expect(signs.every((sign) => (
      sign.label === `↑ ${sign.destination.symbol} · ${formatWayfindingDistance(sign.distance)}`
    ))).toBe(true);
  });

  it('places each sign beside its sand road entrance with matched world shoulders', () => {
    const signs = createRoadSignDescriptors();
    for (const sign of signs) {
      const direction = directionForBearing(sign.bearing);
      const tangent = { x: -direction.z, z: direction.x };
      const offsetX = sign.x - sign.origin.x;
      const offsetZ = sign.z - sign.origin.z;
      expect(offsetX * direction.x + offsetZ * direction.z).toBeCloseTo(
        ROAD_SIGN_RADIAL_OFFSET,
        8,
      );
      expect(Math.abs(offsetX * tangent.x + offsetZ * tangent.z)).toBeCloseTo(
        ROAD_SIGN_SHOULDER_OFFSET,
        8,
      );
      expect(Math.hypot(offsetX, offsetZ)).toBeCloseTo(
        Math.hypot(ROAD_SIGN_RADIAL_OFFSET, ROAD_SIGN_SHOULDER_OFFSET),
        8,
      );
    }

    for (const roadId of new Set(signs.map((sign) => sign.roadId))) {
      const [outbound, returning] = signs.filter((sign) => sign.roadId === roadId);
      expect(outbound).toBeDefined();
      expect(returning).toBeDefined();
      if (!outbound || !returning) continue;
      const btcToMarket = directionForBearing(outbound.bearing);
      const worldTangent = { x: -btcToMarket.z, z: btcToMarket.x };
      const outboundSide = (outbound.x - outbound.origin.x) * worldTangent.x
        + (outbound.z - outbound.origin.z) * worldTangent.z;
      const returnSide = (returning.x - returning.origin.x) * worldTangent.x
        + (returning.z - returning.origin.z) * worldTangent.z;
      expect(Math.sign(outboundSide)).toBe(Math.sign(returnSide));
    }
  });

  it('deterministically separates the clustered BTC signs and exposes prop clearances', () => {
    const first = createRoadSignDescriptors();
    const second = createRoadSignDescriptors();
    expect(second).toEqual(first);

    const btcSigns = first.filter((sign) => sign.origin.symbol === 'BTC');
    let minimumPairDistance = Number.POSITIVE_INFINITY;
    for (let left = 0; left < btcSigns.length; left += 1) {
      for (let right = left + 1; right < btcSigns.length; right += 1) {
        const a = btcSigns[left];
        const b = btcSigns[right];
        if (!a || !b) continue;
        minimumPairDistance = Math.min(minimumPairDistance, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(minimumPairDistance).toBeGreaterThan(8.5);
    expect(new Set(btcSigns.map((sign) => sign.shoulder))).toEqual(new Set([-1, 1]));

    const exclusions = createRoadSignExclusionPoints();
    expect(exclusions).toHaveLength(14);
    expect(exclusions.every((point) => point.radius === ROAD_SIGN_PROP_CLEARANCE)).toBe(true);
    expect(exclusions.map(({ x, z }) => ({ x, z }))).toEqual(
      first.map(({ x, z }) => ({ x, z })),
    );
  });

  it('supports the same graph for an explicitly supplied monument list', () => {
    const cloned = GRAND_MONUMENTS.map((monument) => ({ ...monument }));
    expect(createRoadSignDescriptors(cloned)).toEqual(createRoadSignDescriptors());
  });

  it('reuses the seven canonical bearings and replaces the active outer slot with BTC', () => {
    const btc = createMarketRoadSignDescriptors('BTC');
    const eth = createMarketRoadSignDescriptors('ETH');
    expect(btc).toHaveLength(7);
    expect(eth).toHaveLength(7);
    expect(eth.map((sign) => sign.bearing)).toEqual(btc.map((sign) => sign.bearing));
    expect(eth.map((sign) => sign.destination.symbol).sort()).toEqual(
      ['AVAX', 'BNB', 'BTC', 'DOGE', 'LINK', 'SOL', 'XRP'],
    );
    expect(eth.every((sign) => sign.destination.symbol !== 'ETH')).toBe(true);
  });

  it('keeps generated lamps and benches outside every sign clearance', () => {
    const terrain = new TerrainSampler({
      seed: WORLD_SEED,
      chunkSize: CHUNK_SIZE,
      monuments: GRAND_MONUMENTS,
    });
    const exclusions = createRoadSignExclusionPoints();
    const chunks = new Map(exclusions.map((point) => {
      const chunkX = Math.floor((point.x + CHUNK_SIZE * 0.5) / CHUNK_SIZE);
      const chunkZ = Math.floor((point.z + CHUNK_SIZE * 0.5) / CHUNK_SIZE);
      return [`${chunkX}:${chunkZ}`, { chunkX, chunkZ }] as const;
    }));

    for (const { chunkX, chunkZ } of chunks.values()) {
      for (let seedIndex = 0; seedIndex < 20; seedIndex += 1) {
        const layout = generateChunkLayout({
          seed: `${WORLD_SEED}:sign-clearance:${seedIndex}`,
          chunkX,
          chunkZ,
          chunkSize: CHUNK_SIZE,
          terrain,
          monuments: GRAND_MONUMENTS,
        });
        for (const prop of layout.props.filter(({ kind }) => kind === 'lamp' || kind === 'bench')) {
          expect(exclusions.every((point) => (
            Math.hypot(prop.x - point.x, prop.z - point.z) >= point.radius
          ))).toBe(true);
        }
      }
    }
  });
});

describe('WayfindingSystem presentation', () => {
  it('rebuilds seven bounded-world signs when the active market changes', () => {
    const parent = new THREE.Group();
    const system = new WayfindingSystem({ parent, activeMarket: 'BTC' });
    expect(system.descriptors).toHaveLength(7);
    expect(system.descriptors.some((sign) => sign.destination.symbol === 'BTC')).toBe(false);

    system.setActiveMarket('SOL');
    expect(system.descriptors).toHaveLength(7);
    expect(system.descriptors.filter((sign) => sign.destination.symbol === 'BTC')).toHaveLength(1);
    expect(system.descriptors.some((sign) => sign.destination.symbol === 'SOL')).toBe(false);
    expect(system.root.children).toHaveLength(7);
    system.dispose();
  });

  it('builds fourteen low, fixed, double-sided one-destination signs', () => {
    const parent = new THREE.Group();
    const system = new WayfindingSystem({
      parent,
      heightAt: () => 4.25,
    });

    const signs = system.root.children.filter((child) => child.name.startsWith('road-sign-'));
    const boards: THREE.Mesh[] = [];
    const labels: Text[] = [];
    const caps: THREE.Object3D[] = [];
    system.root.traverse((object) => {
      if (object.name.endsWith('-board') && object instanceof THREE.Mesh) boards.push(object);
      if (object.name.endsWith('-cap')) caps.push(object);
      if (object instanceof Text) labels.push(object);
    });

    expect(parent.children).toContain(system.root);
    expect(system.descriptors).toHaveLength(14);
    expect(signs).toHaveLength(14);
    expect(signs.every((sign) => sign.position.y === 4.25)).toBe(true);
    expect(boards).toHaveLength(14);
    expect(labels).toHaveLength(28);
    expect(caps).toHaveLength(28);
    expect(new Set(boards.map((board) => board.geometry)).size).toBe(1);
    expect(new Set(boards.map((board) => board.material)).size).toBeLessThanOrEqual(4);
    expect(labels.every((label) => label.position.y < 2.2)).toBe(true);
    expect(labels.map((label) => label.text)).toEqual(
      system.descriptors.flatMap((descriptor) => [descriptor.label, descriptor.label]),
    );
    signs.forEach((sign, index) => {
      expect(sign.rotation.y).toBeCloseTo(-(system.descriptors[index]?.bearing ?? 0), 8);
    });

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
