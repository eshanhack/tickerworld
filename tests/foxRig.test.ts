import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../src/config';
import { FoxRig } from '../src/player/FoxRig';
import {
  FOX_LEG_KEYS,
  isFoxLegInContact,
  sampleFoxLegMotion,
  type FoxAirPose,
} from '../src/player/foxMotion';

function disposeRig(rig: FoxRig): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  rig.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    objectMaterials.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function settlePose(
  rig: FoxRig,
  pose: FoxAirPose,
  gaitPhase: number,
  movementBlend: number,
  runBlend: number,
  airProgress = 1,
): void {
  for (let frame = 0; frame < 30; frame += 1) {
    rig.updatePose({
      deltaSeconds: 1 / 30,
      elapsedSeconds: frame / 30,
      gaitPhase,
      movementBlend,
      runBlend,
      airPose: pose,
      airBlend: pose === 'grounded' ? 0 : 1,
      airProgress,
    });
  }
}

describe('FoxRig hierarchy and silhouette', () => {
  it('builds a spine chain and four articulated hip-knee-hock-paw chains', () => {
    const rig = new FoxRig();
    expect(rig.root.name).toBe('FoxModel');
    expect(rig.pelvis.parent).toBe(rig.root);
    expect(rig.spine.parent).toBe(rig.pelvis);
    expect(rig.chest.parent).toBe(rig.spine);
    expect(rig.neck.parent).toBe(rig.chest);
    expect(rig.head.parent).toBe(rig.neck);

    for (const label of ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight']) {
      const hip = rig.root.getObjectByName(`Fox${label}LegPivot`);
      const knee = rig.root.getObjectByName(`Fox${label}Knee`);
      const hock = rig.root.getObjectByName(`Fox${label}Hock`);
      const paw = rig.root.getObjectByName(`Fox${label}Paw`);
      expect(hip, `${label} hip`).toBeInstanceOf(THREE.Group);
      expect(knee?.parent, `${label} knee should descend from its hip`).toBe(hip);
      expect(hock?.parent, `${label} hock should descend from its knee`).toBe(knee);
      expect(paw?.parent, `${label} paw should descend from its hock`).toBe(hock);
      expect(rig.root.getObjectByName(`Fox${label}Leg`), `${label} compatibility mesh`).toBeInstanceOf(THREE.Mesh);
      const lower = rig.root.getObjectByName(`Fox${label}LowerLeg`) as THREE.Mesh;
      expect((lower.material as THREE.MeshStandardMaterial).color.getHex()).toBe(PALETTE.ink);
      expect(((paw as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex()).toBe(PALETTE.ink);
    }

    expect(rig.root.getObjectByName('FoxTailJoint6')).toBeInstanceOf(THREE.Group);
    expect(rig.root.getObjectByName('FoxTailTip')).toBeInstanceOf(THREE.Mesh);
    disposeRig(rig);
  });

  it('reports a lean fox silhouette rather than the former rounded proportions', () => {
    const rig = new FoxRig();
    const snapshot = rig.getDebugSnapshot();
    expect(snapshot.proportions.torsoLengthToWidth).toBeGreaterThanOrEqual(2);
    expect(snapshot.proportions.headToTorsoWidth).toBeLessThanOrEqual(0.68);
    expect(snapshot.proportions.exposedLegLength).toBeGreaterThan(0.7);
    expect(snapshot.proportions.tailToTorsoLength).toBeGreaterThanOrEqual(1.05);
    expect(snapshot.proportions.tailToTorsoLength).toBeLessThanOrEqual(1.2);
    expect(snapshot.bounds.height).toBeGreaterThan(1.65);
    expect(snapshot.bounds.length).toBeGreaterThan(snapshot.bounds.width * 3);
    expect(snapshot.bounds.minY).toBeGreaterThanOrEqual(-0.06);
    disposeRig(rig);
  });

  it('keeps every render resource visible to ordinary traversal-based disposal', () => {
    const rig = new FoxRig();
    let meshCount = 0;
    rig.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshCount += 1;
      expect(object.geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(object.material).toBeTruthy();
    });
    expect(meshCount).toBeGreaterThan(30);
    disposeRig(rig);
  });
});

describe('FoxRig motion topology', () => {
  it('uses four distinct walk contacts and shared deterministic contact helpers', () => {
    const landingPhases = new Map<string, number[]>();
    const previous = new Map(FOX_LEG_KEYS.map((leg) => [leg, isFoxLegInContact(leg, 0, 0)]));
    FOX_LEG_KEYS.forEach((leg) => landingPhases.set(leg, []));

    for (let index = 1; index <= 480; index += 1) {
      const cycle = index / 480;
      const gaitPhase = cycle * Math.PI * 2;
      for (const leg of FOX_LEG_KEYS) {
        const contact = isFoxLegInContact(leg, gaitPhase, 0);
        if (!previous.get(leg) && contact) landingPhases.get(leg)?.push(cycle);
        previous.set(leg, contact);
        expect(contact).toBe(sampleFoxLegMotion(leg, gaitPhase, 0).contact);
      }
    }

    const firstLandings = FOX_LEG_KEYS.map((leg) => landingPhases.get(leg)?.[0]);
    expect(firstLandings.every((phase) => phase !== undefined)).toBe(true);
    const separated = [...new Set(firstLandings.map((phase) => phase?.toFixed(2)))];
    expect(separated).toHaveLength(4);
  });

  it('creates one dominant gather/stretch through the run cycle and articulates every joint', () => {
    const rig = new FoxRig();
    settlePose(rig, 'grounded', 0, 1, 1);
    const gathered = rig.getDebugSnapshot();
    settlePose(rig, 'grounded', Math.PI, 1, 1);
    const stretched = rig.getDebugSnapshot();

    expect(gathered.pose.strideExtension).toBeGreaterThan(0.95);
    expect(stretched.pose.strideExtension).toBeLessThan(-0.95);
    expect(Math.abs(gathered.pose.spinePitch - stretched.pose.spinePitch)).toBeGreaterThan(0.3);
    for (const leg of FOX_LEG_KEYS) {
      const first = gathered.pose.legs[leg];
      const second = stretched.pose.legs[leg];
      expect(Math.abs(first.hip - second.hip), `${leg} hip should stride`).toBeGreaterThan(0.2);
      expect(Number.isFinite(second.knee)).toBe(true);
      expect(Number.isFinite(second.hock)).toBe(true);
      expect(Number.isFinite(second.paw)).toBe(true);
    }
    disposeRig(rig);
  });

  it('plants every audible run contact close to the floor', () => {
    const rig = new FoxRig();
    const framesPerCycle = 26;
    for (let index = 0; index < framesPerCycle * 4; index += 1) {
      const gaitPhase = ((index % framesPerCycle) / framesPerCycle) * Math.PI * 2;
      rig.updatePose({
        deltaSeconds: 1 / 60,
        elapsedSeconds: index / 60,
        gaitPhase,
        movementBlend: 1,
        runBlend: 1,
      });
      if (index < framesPerCycle) continue;
      rig.root.updateMatrixWorld(true);
      for (const leg of FOX_LEG_KEYS) {
        if (!sampleFoxLegMotion(leg, gaitPhase, 1).contact) continue;
        const label = `${leg.startsWith('front') ? 'Front' : 'Hind'}${leg.endsWith('Left') ? 'Left' : 'Right'}`;
        const paw = rig.root.getObjectByName(`Fox${label}Paw`)!;
        const bottom = new THREE.Box3().setFromObject(paw).min.y;
        expect(bottom, `${leg} should be planted when its contact is audible`).toBeGreaterThanOrEqual(-0.015);
        expect(bottom, `${leg} should not float during contact`).toBeLessThan(0.065);
      }
    }
    disposeRig(rig);
  });

  it('plants idle paws independently on an uneven local floor', () => {
    const rig = new FoxRig();
    const offsets = {
      frontLeft: 0.16,
      frontRight: 0.06,
      hindLeft: -0.1,
      hindRight: -0.18,
    } as const;
    for (let frame = 0; frame < 30; frame += 1) {
      rig.updatePose({
        deltaSeconds: 1 / 60,
        elapsedSeconds: frame / 60,
        gaitPhase: 0,
        movementBlend: 0,
        runBlend: 0,
        pawGroundOffsets: offsets,
      });
    }
    rig.root.updateMatrixWorld(true);
    for (const leg of FOX_LEG_KEYS) {
      const label = `${leg.startsWith('front') ? 'Front' : 'Hind'}${leg.endsWith('Left') ? 'Left' : 'Right'}`;
      const paw = rig.root.getObjectByName(`Fox${label}Paw`)!;
      const bottom = new THREE.Box3().setFromObject(paw).min.y;
      expect(bottom).toBeGreaterThan(offsets[leg] + 0.015);
      expect(bottom).toBeLessThan(offsets[leg] + 0.06);
    }
    disposeRig(rig);
  });

  it('supports staged natural leap, double-jump, glide, and landing poses without a body flip', () => {
    const rig = new FoxRig();
    settlePose(rig, 'rise', 0, 0, 0);
    const rise = rig.getDebugSnapshot();
    settlePose(rig, 'apex', 0, 0, 0);
    const apex = rig.getDebugSnapshot();
    settlePose(rig, 'fall', 0, 0, 0);
    const fall = rig.getDebugSnapshot();
    settlePose(rig, 'double', 0, 0, 0, 0.5);
    const double = rig.getDebugSnapshot();
    settlePose(rig, 'glide', 0, 0, 0);
    const glide = rig.getDebugSnapshot();

    expect(rise.pose.airPose).toBe('rise');
    expect(apex.pose.legs.frontLeft.hip).toBeGreaterThan(rise.pose.legs.frontLeft.hip + 0.3);
    expect(fall.pose.legs.hindLeft.hip).toBeGreaterThan(apex.pose.legs.hindLeft.hip);
    expect(double.pose.legs.frontLeft.knee).toBeGreaterThan(fall.pose.legs.frontLeft.knee + 0.45);
    expect(glide.pose.legs.frontLeft.hip).toBeGreaterThan(fall.pose.legs.frontLeft.hip + 0.35);
    expect(glide.pose.legs.hindLeft.hip).toBeLessThan(fall.pose.legs.hindLeft.hip - 0.35);
    expect(Math.abs(rig.root.rotation.x)).toBeLessThan(Math.PI * 0.25);

    settlePose(rig, 'land', 0, 0, 0, 0);
    const landing = rig.getDebugSnapshot();
    settlePose(rig, 'land', 0, 0, 0, 1);
    const recovered = rig.getDebugSnapshot();
    expect(Math.abs(landing.pose.legs.hindLeft.knee)).toBeGreaterThan(Math.abs(recovered.pose.legs.hindLeft.knee));
    disposeRig(rig);
  });
});
