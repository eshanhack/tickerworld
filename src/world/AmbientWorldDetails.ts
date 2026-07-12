import * as THREE from 'three';
import type { SurfaceKind } from '../types';
import { hashCoordinates, hashSeed } from './random';

const FIREFLY_CAPACITY = 56;
const PETAL_CAPACITY = 28;
const BIRD_CAPACITY = 8;
const DETAIL_RADIUS = 82;
const PETAL_WRAP_RADIUS = 78;

interface GroundDetail {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly phase: number;
  readonly speed: number;
  readonly scale: number;
}

interface BirdDetail {
  readonly radius: number;
  readonly y: number;
  readonly angle: number;
  readonly speed: number;
  readonly phase: number;
  readonly scale: number;
}

export interface AmbientWorldDetailsOptions {
  readonly seed: string;
  readonly heightAt: (x: number, z: number) => number;
  readonly surfaceAt: (x: number, z: number) => SurfaceKind;
}

export interface AmbientWorldDetailsUpdate {
  readonly elapsedSeconds: number;
  readonly daylight: number;
  readonly rainIntensity: number;
  readonly reducedMotion: boolean;
}

export interface AmbientWorldDetailsStats {
  readonly fireflies: number;
  readonly petals: number;
  readonly birds: number;
  readonly drawCalls: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function makeBirdGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    -0.95, 0.18, 0,
    -0.24, -0.08, 0,
    0, 0, 0,
    0.95, 0.18, 0,
    0.24, -0.08, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Three tiny deterministic ambience pools. Everything is procedural and each
 * category stays at one draw call regardless of play time.
 */
export class AmbientWorldDetails {
  public readonly root = new THREE.Group();

  private readonly fireflies: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly fireflyPositions = new Float32Array(FIREFLY_CAPACITY * 3);
  private readonly fireflyDetails: readonly GroundDetail[];
  private readonly petals: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly petalDetails: readonly GroundDetail[];
  private readonly birds: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly birdDetails: readonly BirdDetail[];
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private disposed = false;

  public constructor(options: AmbientWorldDetailsOptions) {
    const detailSeed = hashSeed(`${options.seed}:ambient-details`);
    this.root.name = 'AmbientWorldDetails';

    this.fireflyDetails = this.createGroundDetails(
      detailSeed,
      FIREFLY_CAPACITY,
      71_003,
      options,
      0.42,
      1.15,
    );
    const fireflyGeometry = this.trackGeometry(new THREE.BufferGeometry());
    const fireflyAttribute = new THREE.BufferAttribute(this.fireflyPositions, 3);
    fireflyAttribute.setUsage(THREE.DynamicDrawUsage);
    fireflyGeometry.setAttribute('position', fireflyAttribute);
    fireflyGeometry.setDrawRange(0, FIREFLY_CAPACITY);
    const fireflyMaterial = this.trackMaterial(new THREE.PointsMaterial({
      color: 0xffe493,
      size: 0.14,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }));
    this.fireflies = new THREE.Points(fireflyGeometry, fireflyMaterial);
    this.fireflies.name = 'MeadowFireflies';
    this.fireflies.frustumCulled = false;
    this.fireflies.visible = false;
    this.fireflies.renderOrder = 2;

    this.petalDetails = this.createGroundDetails(
      detailSeed,
      PETAL_CAPACITY,
      73_001,
      options,
      1.2,
      5.8,
    );
    const petalGeometry = this.trackGeometry(new THREE.TetrahedronGeometry(0.14, 0));
    const petalMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: true,
    }));
    this.petals = new THREE.InstancedMesh(petalGeometry, petalMaterial, PETAL_CAPACITY);
    this.petals.name = 'DayPetals';
    this.petals.count = PETAL_CAPACITY;
    this.petals.frustumCulled = false;
    this.petals.castShadow = false;
    this.petals.receiveShadow = false;
    const petalPalette = [0xf2b4b0, 0xffe7b0, 0xc9d99d, 0xd9c1e5] as const;
    for (let index = 0; index < PETAL_CAPACITY; index += 1) {
      const paletteIndex = Math.floor(
        hashCoordinates(detailSeed, index, 0, 73_087) * petalPalette.length,
      );
      this.petals.setColorAt(index, this.color.set(petalPalette[paletteIndex] ?? petalPalette[0]));
    }
    if (this.petals.instanceColor) this.petals.instanceColor.needsUpdate = true;

    const birdGeometry = this.trackGeometry(makeBirdGeometry());
    const birdMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x536273,
      side: THREE.DoubleSide,
      fog: true,
    }));
    this.birds = new THREE.InstancedMesh(birdGeometry, birdMaterial, BIRD_CAPACITY);
    this.birds.name = 'DistantBirds';
    this.birds.count = BIRD_CAPACITY;
    this.birds.frustumCulled = false;
    this.birds.castShadow = false;
    this.birds.receiveShadow = false;
    this.birdDetails = Array.from({ length: BIRD_CAPACITY }, (_, index) => ({
      radius: 48 + hashCoordinates(detailSeed, index, 0, 79_003) * 34,
      y: 20 + hashCoordinates(detailSeed, index, 0, 79_019) * 13,
      angle: hashCoordinates(detailSeed, index, 0, 79_037) * Math.PI * 2,
      speed: 0.018 + hashCoordinates(detailSeed, index, 0, 79_043) * 0.014,
      phase: hashCoordinates(detailSeed, index, 0, 79_069) * Math.PI * 2,
      scale: 0.75 + hashCoordinates(detailSeed, index, 0, 79_087) * 0.65,
    }));

    this.root.add(this.fireflies, this.petals, this.birds);
    this.update({ elapsedSeconds: 0, daylight: 1, rainIntensity: 0, reducedMotion: false });
  }

  public update(update: AmbientWorldDetailsUpdate): void {
    if (this.disposed) return;
    const elapsed = Number.isFinite(update.elapsedSeconds) ? update.elapsedSeconds : 0;
    const daylight = clamp01(update.daylight);
    const rain = clamp01(update.rainIntensity);
    const motionScale = update.reducedMotion ? 0.22 : 1;

    const fireflyStrength = clamp01(
      clamp01((1 - daylight - 0.18) / 0.55) * (1 - rain * 0.82),
    );
    for (let index = 0; index < this.fireflyDetails.length; index += 1) {
      const detail = this.fireflyDetails[index];
      if (!detail) continue;
      const offset = index * 3;
      const time = elapsed * detail.speed * motionScale;
      this.fireflyPositions[offset] = detail.x + Math.sin(detail.phase + time * 0.8) * 0.46;
      this.fireflyPositions[offset + 1] = detail.y
        + Math.sin(detail.phase * 1.7 + time * 1.35) * (update.reducedMotion ? 0.08 : 0.24);
      this.fireflyPositions[offset + 2] = detail.z + Math.cos(detail.phase + time * 0.65) * 0.42;
    }
    this.fireflies.geometry.getAttribute('position').needsUpdate = true;
    this.fireflies.visible = fireflyStrength > 0.01;
    this.fireflies.material.opacity = fireflyStrength
      * (0.48 + Math.sin(elapsed * 0.9) * (update.reducedMotion ? 0.03 : 0.1));

    const petalStrength = clamp01(
      clamp01((daylight - 0.3) / 0.52) * (1 - rain * 1.4),
    );
    const petalTime = elapsed * motionScale;
    for (let index = 0; index < this.petalDetails.length; index += 1) {
      const detail = this.petalDetails[index];
      if (!detail) continue;
      const x = positiveModulo(
        detail.x + petalTime * detail.speed * 0.34 + PETAL_WRAP_RADIUS,
        PETAL_WRAP_RADIUS * 2,
      ) - PETAL_WRAP_RADIUS;
      const z = detail.z + Math.sin(detail.phase + petalTime * 0.18) * 2.4;
      const y = detail.y + Math.sin(detail.phase * 1.3 + petalTime * detail.speed) * 0.56;
      this.position.set(x, y, z);
      this.quaternion.setFromEuler(this.euler.set(
        detail.phase + petalTime * 0.42,
        detail.phase * 0.4 + petalTime * 0.3,
        detail.phase * 0.7 + petalTime * 0.55,
      ));
      this.scale.setScalar(detail.scale * (0.82 + Math.sin(detail.phase + petalTime * 1.4) * 0.12));
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.petals.setMatrixAt(index, this.matrix);
    }
    this.petals.instanceMatrix.needsUpdate = true;
    this.petals.visible = petalStrength > 0.04;
    this.petals.material.color.set(0xffffff).lerp(this.color.set(0xcbd6da), rain * 0.45);

    const birdStrength = clamp01(
      clamp01((daylight - 0.18) / 0.36) * (1 - rain * 1.8),
    );
    for (let index = 0; index < this.birdDetails.length; index += 1) {
      const detail = this.birdDetails[index];
      if (!detail) continue;
      const time = elapsed * detail.speed * motionScale;
      const angle = detail.angle + time;
      this.position.set(
        Math.cos(angle) * detail.radius,
        detail.y + Math.sin(detail.phase + time * 3.2) * (update.reducedMotion ? 0.1 : 0.72),
        Math.sin(angle) * detail.radius,
      );
      this.quaternion.setFromEuler(this.euler.set(0, -angle, 0));
      const flap = Math.sin(detail.phase + elapsed * 2.1 * motionScale);
      this.scale.set(
        detail.scale,
        detail.scale * (1 + flap * (update.reducedMotion ? 0.04 : 0.18)),
        detail.scale,
      );
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.birds.setMatrixAt(index, this.matrix);
    }
    this.birds.instanceMatrix.needsUpdate = true;
    this.birds.visible = birdStrength > 0.04;
    this.birds.material.color.set(0x405061).lerp(this.color.set(0x8796a4), 1 - daylight);
  }

  public getDebugStats(): AmbientWorldDetailsStats {
    return {
      fireflies: this.fireflies.visible ? FIREFLY_CAPACITY : 0,
      petals: this.petals.visible ? PETAL_CAPACITY : 0,
      birds: this.birds.visible ? BIRD_CAPACITY : 0,
      drawCalls: Number(this.fireflies.visible)
        + Number(this.petals.visible)
        + Number(this.birds.visible),
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.root.clear();
  }

  private createGroundDetails(
    seed: number,
    count: number,
    salt: number,
    options: AmbientWorldDetailsOptions,
    minY: number,
    maxY: number,
  ): readonly GroundDetail[] {
    const details: GroundDetail[] = [];
    let attempts = 0;
    while (details.length < count && attempts < count * 18) {
      const index = attempts;
      attempts += 1;
      const angle = hashCoordinates(seed, index, 0, salt) * Math.PI * 2;
      const radius = 8 + Math.sqrt(hashCoordinates(seed, index, 0, salt + 12)) * (DETAIL_RADIUS - 8);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (options.surfaceAt(x, z) !== 'grass') continue;
      details.push({
        x,
        y: options.heightAt(x, z) + minY
          + hashCoordinates(seed, index, 0, salt + 28) * (maxY - minY),
        z,
        phase: hashCoordinates(seed, index, 0, salt + 44) * Math.PI * 2,
        speed: 0.72 + hashCoordinates(seed, index, 0, salt + 62) * 0.72,
        scale: 0.72 + hashCoordinates(seed, index, 0, salt + 78) * 0.68,
      });
    }
    // Extremely road-heavy custom terrain still gets a deterministic bounded
    // pool rather than changing draw counts across sessions.
    while (details.length < count) {
      const index = details.length;
      const angle = hashCoordinates(seed, index, 0, salt + 101) * Math.PI * 2;
      const radius = 18 + hashCoordinates(seed, index, 0, salt + 117) * 54;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      details.push({
        x,
        y: options.heightAt(x, z) + minY,
        z,
        phase: angle,
        speed: 0.9,
        scale: 1,
      });
    }
    return details;
  }

  private trackGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private trackMaterial<T extends THREE.Material>(material: T): T {
    this.materials.add(material);
    return material;
  }
}
