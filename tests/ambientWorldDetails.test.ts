import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AmbientWorldDetails } from '../src/world';

function createDetails(seed: string): AmbientWorldDetails {
  return new AmbientWorldDetails({
    seed,
    heightAt: (x, z) => Math.sin(x * 0.03) * 0.2 + Math.cos(z * 0.025) * 0.15,
    surfaceAt: () => 'grass',
  });
}

describe('AmbientWorldDetails', () => {
  it('switches three bounded one-draw procedural pools with daylight and rain', () => {
    const details = createDetails('ambient-visibility-test');
    expect(details.getDebugStats()).toEqual({
      fireflies: 0,
      petals: 28,
      birds: 8,
      drawCalls: 2,
    });

    const fireflies = details.root.getObjectByName('MeadowFireflies') as THREE.Points;
    const petals = details.root.getObjectByName('DayPetals') as THREE.InstancedMesh;
    const birds = details.root.getObjectByName('DistantBirds') as THREE.InstancedMesh;
    expect(fireflies).toBeDefined();
    expect(petals.count).toBe(28);
    expect(birds.count).toBe(8);

    details.update({ elapsedSeconds: 210, daylight: 0, rainIntensity: 0, reducedMotion: false });
    expect(details.getDebugStats()).toEqual({
      fireflies: 56,
      petals: 0,
      birds: 0,
      drawCalls: 1,
    });
    const dryOpacity = (fireflies.material as THREE.PointsMaterial).opacity;
    details.update({ elapsedSeconds: 211, daylight: 0, rainIntensity: 1, reducedMotion: false });
    expect((fireflies.material as THREE.PointsMaterial).opacity).toBeLessThan(dryOpacity);

    details.update({ elapsedSeconds: 420, daylight: 1, rainIntensity: 1, reducedMotion: false });
    expect(details.getDebugStats()).toEqual({
      fireflies: 0,
      petals: 0,
      birds: 0,
      drawCalls: 0,
    });
    details.dispose();
  });

  it('is deterministic, remains spatially bounded, and reduces rather than freezes motion', () => {
    const normal = createDetails('ambient-motion-test');
    const mirror = createDetails('ambient-motion-test');
    const reduced = createDetails('ambient-motion-test');
    const normalPetals = normal.root.getObjectByName('DayPetals') as THREE.InstancedMesh;
    const mirrorPetals = mirror.root.getObjectByName('DayPetals') as THREE.InstancedMesh;
    const reducedPetals = reduced.root.getObjectByName('DayPetals') as THREE.InstancedMesh;
    const beforeNormal = new THREE.Matrix4();
    const beforeReduced = new THREE.Matrix4();
    normal.update({ elapsedSeconds: 0, daylight: 1, rainIntensity: 0, reducedMotion: false });
    mirror.update({ elapsedSeconds: 0, daylight: 1, rainIntensity: 0, reducedMotion: false });
    reduced.update({ elapsedSeconds: 0, daylight: 1, rainIntensity: 0, reducedMotion: true });
    normalPetals.getMatrixAt(0, beforeNormal);
    reducedPetals.getMatrixAt(0, beforeReduced);
    normal.update({ elapsedSeconds: 3, daylight: 1, rainIntensity: 0, reducedMotion: false });
    mirror.update({ elapsedSeconds: 3, daylight: 1, rainIntensity: 0, reducedMotion: false });
    reduced.update({ elapsedSeconds: 3, daylight: 1, rainIntensity: 0, reducedMotion: true });

    const afterNormal = new THREE.Matrix4();
    const afterReduced = new THREE.Matrix4();
    const deterministic = new THREE.Matrix4();
    normalPetals.getMatrixAt(0, afterNormal);
    reducedPetals.getMatrixAt(0, afterReduced);
    mirrorPetals.getMatrixAt(0, deterministic);
    expect(deterministic.equals(afterNormal)).toBe(true);
    const beforePosition = new THREE.Vector3().setFromMatrixPosition(beforeNormal);
    const afterPosition = new THREE.Vector3().setFromMatrixPosition(afterNormal);
    const reducedBeforePosition = new THREE.Vector3().setFromMatrixPosition(beforeReduced);
    const reducedAfterPosition = new THREE.Vector3().setFromMatrixPosition(afterReduced);
    const normalTravel = afterPosition.distanceTo(beforePosition);
    const reducedTravel = reducedAfterPosition.distanceTo(reducedBeforePosition);
    expect(normalTravel).toBeGreaterThan(0.4);
    expect(reducedTravel).toBeGreaterThan(0.05);
    expect(reducedTravel).toBeLessThan(normalTravel * 0.4);

    normal.update({ elapsedSeconds: 100_000, daylight: 1, rainIntensity: 0, reducedMotion: false });
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    for (let index = 0; index < normalPetals.count; index += 1) {
      normalPetals.getMatrixAt(index, matrix);
      position.setFromMatrixPosition(matrix);
      expect(Math.abs(position.x)).toBeLessThanOrEqual(78);
      expect(Math.abs(position.z)).toBeLessThanOrEqual(85);
      expect(position.y).toBeGreaterThan(0.4);
      expect(position.y).toBeLessThan(6.8);
    }
    normal.dispose();
    mirror.dispose();
    reduced.dispose();
  });

  it('disposes every shared ambient resource and detaches its root', () => {
    const parent = new THREE.Group();
    const details = createDetails('ambient-disposal-test');
    parent.add(details.root);
    const geometry = (details.root.getObjectByName('DayPetals') as THREE.InstancedMesh).geometry;
    const material = (details.root.getObjectByName('MeadowFireflies') as THREE.Points).material;
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material as THREE.Material, 'dispose');
    details.dispose();
    details.dispose();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(parent.children).not.toContain(details.root);
  });
});
