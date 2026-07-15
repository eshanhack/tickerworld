import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildMedallion } from '../src/monuments/medallions';
import {
  SignatureMarketDistrict,
  createSignatureWorldLayout,
  isSignatureWorldProtectedPoint,
} from '../src/world/SignatureMarketDistrict';
import {
  SIGNATURE_WORLD_SYMBOLS,
  SIGNATURE_WORLD_THEMES,
} from '../src/world/signatureWorldThemes';

const heightAt = (x: number, z: number): number => Math.sin(x * 0.035) * 0.18
  + Math.cos(z * 0.041) * 0.14;

describe('signature market worlds', () => {
  it('defines one distinct deterministic bounded layout for every signature market', () => {
    expect(Object.keys(SIGNATURE_WORLD_THEMES).sort()).toEqual([...SIGNATURE_WORLD_SYMBOLS].sort());
    const motifs = new Set<string>();
    for (const symbol of SIGNATURE_WORLD_SYMBOLS) {
      const first = createSignatureWorldLayout(symbol, 'tickerworld-v1', heightAt);
      const mirror = createSignatureWorldLayout(symbol, 'tickerworld-v1', heightAt);
      expect(mirror).toEqual(first);
      expect(first.sites).toHaveLength(7);
      expect(first.primitives.length).toBeGreaterThan(20);
      expect(first.groundPatches).toHaveLength(7);
      expect(first.colliders.length).toBeGreaterThan(0);
      expect(first.theme.symbol).toBe(symbol);
      motifs.add(first.theme.motif);
      for (const site of first.sites) {
        expect(Math.hypot(site.x, site.z)).toBeLessThan(81);
        expect(isSignatureWorldProtectedPoint(site.x, site.z, 0.5)).toBe(false);
      }
    }
    expect(motifs.size).toBe(SIGNATURE_WORLD_SYMBOLS.length);
  });

  it('lazily swaps one active district while keeping resources and motion bounded', () => {
    const parent = new THREE.Group();
    const district = new SignatureMarketDistrict({ parent, heightAt, activeMarket: 'BTC' });
    expect(parent.children).toContain(district.root);
    expect(district.root.visible).toBe(false);

    district.setActiveMarket('SKHYNIX');
    district.update(1 / 60, 4, { nightFactor: 1, playerPosition: { x: 36, y: 1, z: 16 } });
    const firstStats = district.getDebugStats();
    expect(firstStats).toMatchObject({
      active: true,
      market: 'SKHYNIX',
      title: 'STACKED MEMORY GARDEN',
      featureSites: 7,
      particles: 32,
    });
    expect(firstStats.instancedPools).toBeLessThanOrEqual(12);
    expect(firstStats.activePointLights).toBeLessThanOrEqual(2);
    const firstMesh = district.root.children.find((child) => child instanceof THREE.InstancedMesh);
    if (!(firstMesh instanceof THREE.InstancedMesh)) throw new Error('Expected an instanced pool');
    const disposeMaterial = vi.spyOn(firstMesh.material as THREE.Material, 'dispose');

    district.setActiveMarket('HYPE');
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(district.getDebugStats()).toMatchObject({ active: true, market: 'HYPE' });
    for (let index = 0; index < 1_000; index += 1) {
      district.update(1 / 60, index / 60, { nightFactor: index % 2 });
    }
    expect(district.getDebugStats().activePointLights).toBeLessThanOrEqual(2);

    district.setActiveMarket('BTC');
    expect(district.root.visible).toBe(false);
    expect(district.getDebugStats().primitiveInstances).toBe(0);
    district.dispose();
    district.dispose();
    expect(parent.children).not.toContain(district.root);
  });

  it('exposes walkable pads, solid collision, sliding, and camera bounds', () => {
    const district = new SignatureMarketDistrict({
      parent: new THREE.Group(),
      heightAt,
      activeMarket: 'GOLD',
    });
    const layout = createSignatureWorldLayout('GOLD', 'tickerworld-v1', heightAt);
    const patch = layout.groundPatches[0];
    const collider = layout.colliders[0];
    if (!patch || !collider) throw new Error('Expected signature ground and collision');
    expect(district.sampleGround(patch.x, patch.z)).toEqual({ height: patch.top, surface: 'stone' });
    expect(district.collidesPlayer(collider.x, collider.z)).toBe(true);
    expect(district.collidesCamera(collider.x, collider.y + collider.height * 0.5, collider.z)).toBe(true);
    expect(district.collidesCamera(collider.x, collider.y + collider.height + 3, collider.z)).toBe(false);
    const resolved = district.resolveHorizontal(
      collider.x,
      collider.z,
      0.7,
      collider.x - collider.radius - 2,
      collider.z,
    );
    expect(district.collidesPlayer(resolved.x, resolved.z, 0.7)).toBe(false);
    district.dispose();
  });

  it('builds a named original grand and echo crest for every new market', () => {
    for (const symbol of SIGNATURE_WORLD_SYMBOLS) {
      const grand = buildMedallion(symbol, 'grand');
      const echo = buildMedallion(symbol, 'echo');
      expect(grand.name).toBe(`${symbol.toLowerCase()}-grand-medallion`);
      expect(echo.name).toBe(`${symbol.toLowerCase()}-echo-medallion`);
      expect(grand.children.length).toBeGreaterThan(2);
      expect(echo.children.length).toBeGreaterThan(1);
      for (const group of [grand, echo]) {
        group.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const item of materials) item.dispose();
        });
      }
    }
  });
});

