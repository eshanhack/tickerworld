import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { createPortalRoutes } from '../../shared/src/index.js';
import type { AssetSymbol, SurfaceKind } from '../types';
import { PARKOUR_PARK_BOUNDS } from './ParkourParkSystem';
import { createRandom } from './random';
import {
  SIGNATURE_WORLD_THEMES,
  isSignatureMarketSymbol,
  type SignatureMarketSymbol,
  type SignatureParticleStyle,
  type SignatureWorldThemeDefinition,
} from './signatureWorldThemes';

const WORLD_EDGE = 81;
const PLAZA_CLEAR_RADIUS = 22;
const ROAD_HALF_WIDTH = 3.2;
const PORTAL_CLEAR_RADIUS = 6.6;
const FEATURE_SITE_COUNT = 7;
const PARTICLE_COUNT = 32;
const LIGHT_COUNT = 2;

const INSTANCE_MATRIX = new Matrix4();
const INSTANCE_POSITION = new Vector3();
const INSTANCE_SCALE = new Vector3();
const INSTANCE_ROTATION = new Quaternion();
const INSTANCE_EULER = new Euler();

export type SignaturePrimitiveShape =
  | 'box'
  | 'cylinder'
  | 'cone'
  | 'sphere'
  | 'icosahedron'
  | 'torus';
export type SignatureMaterialRole = 'primary' | 'secondary' | 'accent' | 'ground';
export type SignatureMotionKind = 'bob' | 'spin' | 'pulse';

export interface SignatureFeatureSite {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
}

export interface SignaturePrimitiveDescriptor {
  readonly id: string;
  readonly shape: SignaturePrimitiveShape;
  readonly role: SignatureMaterialRole;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
  readonly rotationX: number;
  readonly rotationY: number;
  readonly rotationZ: number;
  readonly motion?: SignatureMotionKind;
  readonly motionSpeed?: number;
  readonly motionAmount?: number;
  readonly phase: number;
}

export interface SignatureCollider {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

export interface SignatureGroundPatch {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly top: number;
}

export interface SignatureWorldLayout {
  readonly symbol: SignatureMarketSymbol;
  readonly theme: SignatureWorldThemeDefinition;
  readonly sites: readonly SignatureFeatureSite[];
  readonly primitives: readonly SignaturePrimitiveDescriptor[];
  readonly colliders: readonly SignatureCollider[];
  readonly groundPatches: readonly SignatureGroundPatch[];
}

export interface SignatureMarketDistrictEnvironment {
  /** 0 in bright daylight, 1 at full night. */
  readonly nightFactor: number;
  readonly playerPosition?: Readonly<{ x: number; y: number; z: number }>;
}

export interface SignatureMarketDistrictOptions {
  readonly parent: Object3D;
  readonly heightAt: (x: number, z: number) => number;
  readonly seed?: string;
  readonly activeMarket?: AssetSymbol;
  readonly reducedMotion?: boolean;
}

export interface SignatureMarketDistrictStats {
  readonly active: boolean;
  readonly market: SignatureMarketSymbol | null;
  readonly title: string | null;
  readonly featureSites: number;
  readonly primitiveInstances: number;
  readonly instancedPools: number;
  readonly dynamicPools: number;
  readonly colliders: number;
  readonly particles: number;
  readonly activePointLights: number;
  readonly geometryResources: number;
  readonly materialResources: number;
}

interface PrimitivePool {
  readonly mesh: InstancedMesh;
  readonly descriptors: readonly SignaturePrimitiveDescriptor[];
  readonly dynamic: boolean;
}

interface ParticleSeed {
  readonly siteIndex: number;
  readonly angle: number;
  readonly radius: number;
  readonly height: number;
  readonly phase: number;
  readonly speed: number;
}

const PORTAL_ROUTES = createPortalRoutes('btc');

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function distanceToRoad(x: number, z: number, roadX: number, roadZ: number): number {
  const length = Math.hypot(roadX, roadZ) || 1;
  const dx = roadX / length;
  const dz = roadZ / length;
  const along = x * dx + z * dz;
  if (along < PLAZA_CLEAR_RADIUS - 2 || along > WORLD_EDGE + 2) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(x * -dz + z * dx);
}

/** Pure exclusion shared by deterministic layout tests and integration code. */
export function isSignatureWorldProtectedPoint(x: number, z: number, margin = 0): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(margin)) return true;
  const safeMargin = Math.max(0, margin);
  const radius = Math.hypot(x, z);
  if (radius < PLAZA_CLEAR_RADIUS + safeMargin || radius > WORLD_EDGE - safeMargin) return true;
  if (
    x >= PARKOUR_PARK_BOUNDS.left - safeMargin
    && x <= PARKOUR_PARK_BOUNDS.right + safeMargin
    && z >= PARKOUR_PARK_BOUNDS.bottom - safeMargin
    && z <= PARKOUR_PARK_BOUNDS.top + safeMargin
  ) return true;
  return PORTAL_ROUTES.some((route) => (
    Math.hypot(x - route.x, z - route.z) < PORTAL_CLEAR_RADIUS + safeMargin
    || distanceToRoad(x, z, route.x, route.z) < ROAD_HALF_WIDTH + safeMargin
  ));
}

function createFeatureSites(
  symbol: SignatureMarketSymbol,
  seed: string,
  heightAt: (x: number, z: number) => number,
): SignatureFeatureSite[] {
  const random = createRandom(`${seed}:${symbol}:signature-sites-v1`);
  const sites: SignatureFeatureSite[] = [];
  for (let attempt = 0; attempt < 6_000 && sites.length < FEATURE_SITE_COUNT; attempt += 1) {
    // Two staggered bands keep landmarks readable without forming a wall.
    const band = attempt % 2;
    const radius = band === 0 ? 30 + random() * 17 : 53 + random() * 22;
    const angle = random() * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (isSignatureWorldProtectedPoint(x, z, 2.15)) continue;
    if (sites.some((site) => Math.hypot(x - site.x, z - site.z) < 12.5)) continue;
    sites.push({
      x,
      y: heightAt(x, z),
      z,
      yaw: angle + Math.PI * 0.5,
      scale: 0.9 + random() * 0.22,
    });
  }

  // Extremely dense future portal layouts may leave no 2.15-unit road gap.
  // A second conservative pass only relaxes roadside clearance; it never
  // enters a portal, plaza, parkour course, or the world boundary.
  for (let attempt = 0; attempt < 6_000 && sites.length < FEATURE_SITE_COUNT; attempt += 1) {
    const radius = 30 + random() * 45;
    const angle = random() * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (isSignatureWorldProtectedPoint(x, z, 0.55)) continue;
    if (sites.some((site) => Math.hypot(x - site.x, z - site.z) < 10.5)) continue;
    sites.push({ x, y: heightAt(x, z), z, yaw: angle + Math.PI * 0.5, scale: 0.9 + random() * 0.22 });
  }
  return sites;
}

function sitePoint(
  site: SignatureFeatureSite,
  outward: number,
  tangent: number,
): Readonly<{ x: number; z: number }> {
  const radialX = Math.cos(site.yaw - Math.PI * 0.5);
  const radialZ = Math.sin(site.yaw - Math.PI * 0.5);
  return {
    x: site.x + radialX * outward - radialZ * tangent,
    z: site.z + radialZ * outward + radialX * tangent,
  };
}

function addPrimitive(
  target: SignaturePrimitiveDescriptor[],
  options: Omit<SignaturePrimitiveDescriptor, 'id' | 'phase'> & { readonly phase?: number },
): SignaturePrimitiveDescriptor {
  const primitive: SignaturePrimitiveDescriptor = {
    ...options,
    id: `signature-primitive-${target.length + 1}`,
    phase: options.phase ?? target.length * 0.731,
  };
  target.push(primitive);
  return primitive;
}

function addPad(
  target: SignaturePrimitiveDescriptor[],
  patches: SignatureGroundPatch[],
  site: SignatureFeatureSite,
  radius = 4.3,
): void {
  const height = 0.2;
  addPrimitive(target, {
    shape: 'cylinder',
    role: 'ground',
    x: site.x,
    y: site.y + height * 0.5,
    z: site.z,
    scaleX: radius * 2,
    scaleY: height,
    scaleZ: radius * 2,
    rotationX: 0,
    rotationY: site.yaw,
    rotationZ: 0,
  });
  patches.push({ x: site.x, z: site.z, radius, top: site.y + height });
}

function addCollider(
  target: SignatureCollider[],
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
): void {
  target.push({ id: `signature-collider-${target.length + 1}`, x, y, z, radius, height });
}

function buildMemoryStacks(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.4);
    const width = 4.3 * site.scale;
    const depth = 3.3 * site.scale;
    for (let layer = 0; layer < 4; layer += 1) {
      addPrimitive(primitives, {
        shape: 'box', role: layer % 2 === 0 ? 'primary' : 'secondary',
        x: site.x, y: site.y + 0.42 + layer * 0.54, z: site.z,
        scaleX: width - layer * 0.18, scaleY: 0.34, scaleZ: depth - layer * 0.14,
        rotationX: 0, rotationY: site.yaw + layer * 0.035, rotationZ: 0,
      });
    }
    addPrimitive(primitives, {
      shape: 'torus', role: 'accent', x: site.x, y: site.y + 3.15, z: site.z,
      scaleX: 3.2, scaleY: 3.2, scaleZ: 1,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      motion: 'spin', motionSpeed: 0.2 + siteIndex * 0.012, motionAmount: 1,
    });
    addCollider(colliders, site.x, site.y, site.z, 2.05, 2.55);
  }
}

function buildHypercoreIslands(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [index, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.7);
    addPrimitive(primitives, {
      shape: 'sphere', role: 'primary', x: site.x, y: site.y + 0.18, z: site.z,
      scaleX: 7.6, scaleY: 0.72, scaleZ: 5.9,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
    });
    addPrimitive(primitives, {
      shape: 'cylinder', role: 'secondary', x: site.x, y: site.y + 1.35, z: site.z,
      scaleX: 1.65, scaleY: 2.35, scaleZ: 1.65,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
    });
    for (let ring = 0; ring < 2; ring += 1) {
      addPrimitive(primitives, {
        shape: 'torus', role: 'accent', x: site.x, y: site.y + 1.15 + ring * 0.75, z: site.z,
        scaleX: 3.3 + ring * 1.15, scaleY: 3.3 + ring * 1.15, scaleZ: 1,
        rotationX: Math.PI * 0.5, rotationY: 0, rotationZ: 0,
        motion: 'pulse', motionSpeed: 0.8 + ring * 0.2, motionAmount: 0.055,
        phase: index * 0.67 + ring,
      });
    }
    addCollider(colliders, site.x, site.y, site.z, 0.95, 2.6);
  }
}

function buildInnovationSkyline(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.9);
    for (let column = -1; column <= 1; column += 1) {
      const point = sitePoint(site, column === 0 ? 0.35 : -0.2, column * 1.45);
      const height = 3.2 + ((siteIndex * 3 + column + 4) % 5) * 0.72;
      addPrimitive(primitives, {
        shape: 'box', role: column === 0 ? 'accent' : column < 0 ? 'primary' : 'secondary',
        x: point.x, y: site.y + 0.2 + height * 0.5, z: point.z,
        scaleX: 1.08, scaleY: height, scaleZ: 1.08,
        rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      });
      addPrimitive(primitives, {
        shape: 'sphere', role: 'accent', x: point.x, y: site.y + height + 0.62, z: point.z,
        scaleX: 0.44, scaleY: 0.44, scaleZ: 0.44,
        rotationX: 0, rotationY: 0, rotationZ: 0,
        motion: 'bob', motionSpeed: 0.72, motionAmount: 0.18,
        phase: siteIndex + column,
      });
    }
    addCollider(colliders, site.x, site.y, site.z, 1.65, 6.6);
  }
}

function buildSectorMosaic(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.8);
    for (let tile = 0; tile < 5; tile += 1) {
      const angle = tile / 5 * Math.PI * 2;
      const point = sitePoint(site, Math.cos(angle) * 1.45, Math.sin(angle) * 1.45);
      const height = 0.48 + ((siteIndex + tile) % 4) * 0.25;
      addPrimitive(primitives, {
        shape: 'cylinder', role: tile === 0 ? 'accent' : tile % 2 === 0 ? 'primary' : 'secondary',
        x: point.x, y: site.y + 0.2 + height * 0.5, z: point.z,
        scaleX: 1.45, scaleY: height, scaleZ: 1.45,
        rotationX: 0, rotationY: angle + site.yaw, rotationZ: 0,
      });
    }
    addPrimitive(primitives, {
      shape: 'icosahedron', role: 'accent', x: site.x, y: site.y + 2.35, z: site.z,
      scaleX: 1.45, scaleY: 1.45, scaleZ: 1.45,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      motion: 'spin', motionSpeed: 0.16, motionAmount: 1,
      phase: siteIndex,
    });
    addCollider(colliders, site.x, site.y, site.z, 0.9, 3.15);
  }
}

function buildMemoryCanyon(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.7);
    for (const side of [-1, 1] as const) {
      const point = sitePoint(site, 0, side * 1.45);
      addPrimitive(primitives, {
        shape: 'box', role: side < 0 ? 'primary' : 'secondary',
        x: point.x, y: site.y + 2.25, z: point.z,
        scaleX: 1.0, scaleY: 4.1, scaleZ: 3.45,
        rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      });
      addCollider(colliders, point.x, site.y, point.z, 0.72, 4.4);
    }
    addPrimitive(primitives, {
      shape: 'torus', role: 'accent', x: site.x, y: site.y + 3.05, z: site.z,
      scaleX: 2.8, scaleY: 2.8, scaleZ: 0.85,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      motion: 'spin', motionSpeed: 0.15, motionAmount: 1,
      phase: siteIndex * 0.7,
    });
  }
}

function buildLaunchCoast(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, siteIndex === 0 ? 5.2 : 4.2);
    if (siteIndex === 0) {
      const rocket = sitePoint(site, 0, -0.7);
      addPrimitive(primitives, {
        shape: 'cylinder', role: 'secondary', x: rocket.x, y: site.y + 3.15, z: rocket.z,
        scaleX: 1.35, scaleY: 5.9, scaleZ: 1.35,
        rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      });
      addPrimitive(primitives, {
        shape: 'cone', role: 'accent', x: rocket.x, y: site.y + 6.72, z: rocket.z,
        scaleX: 1.42, scaleY: 1.55, scaleZ: 1.42,
        rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      });
      const tower = sitePoint(site, 0, 2.1);
      addPrimitive(primitives, {
        shape: 'box', role: 'primary', x: tower.x, y: site.y + 3.2, z: tower.z,
        scaleX: 0.72, scaleY: 6.1, scaleZ: 0.72,
        rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      });
      addCollider(colliders, rocket.x, site.y, rocket.z, 0.85, 7.55);
      addCollider(colliders, tower.x, site.y, tower.z, 0.58, 6.3);
    } else {
      addPrimitive(primitives, {
        shape: 'cylinder', role: 'primary', x: site.x, y: site.y + 0.45, z: site.z,
        scaleX: 3.7, scaleY: 0.55, scaleZ: 3.7,
        rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      });
      addPrimitive(primitives, {
        shape: 'torus', role: 'accent', x: site.x, y: site.y + 2.45, z: site.z,
        scaleX: 3.2, scaleY: 3.2, scaleZ: 1,
        rotationX: Math.PI * 0.33, rotationY: site.yaw, rotationZ: 0,
        motion: 'spin', motionSpeed: 0.24, motionAmount: 1,
        phase: siteIndex,
      });
      addPrimitive(primitives, {
        shape: 'icosahedron', role: 'secondary', x: site.x, y: site.y + 2.45, z: site.z,
        scaleX: 0.72, scaleY: 0.72, scaleZ: 0.72,
        rotationX: 0, rotationY: 0, rotationZ: 0,
        motion: 'bob', motionSpeed: 0.65, motionAmount: 0.24,
        phase: siteIndex,
      });
    }
  }
}

function buildAiFactory(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.6);
    addPrimitive(primitives, {
      shape: 'box', role: 'primary', x: site.x, y: site.y + 2.15, z: site.z,
      scaleX: 3.9, scaleY: 3.7, scaleZ: 0.72,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
    });
    addPrimitive(primitives, {
      shape: 'box', role: 'secondary', x: site.x, y: site.y + 2.15, z: site.z,
      scaleX: 2.35, scaleY: 2.18, scaleZ: 0.92,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
    });
    for (let node = 0; node < 4; node += 1) {
      const angle = node / 4 * Math.PI * 2;
      const point = sitePoint(site, Math.cos(angle) * 2.45, Math.sin(angle) * 2.45);
      addPrimitive(primitives, {
        shape: 'sphere', role: 'accent', x: point.x, y: site.y + 1.05, z: point.z,
        scaleX: 0.46, scaleY: 0.46, scaleZ: 0.46,
        rotationX: 0, rotationY: 0, rotationZ: 0,
        motion: 'pulse', motionSpeed: 1.25, motionAmount: 0.16,
        phase: siteIndex + node * 0.6,
      });
    }
    addCollider(colliders, site.x, site.y, site.z, 1.8, 4.1);
  }
}

function buildGoldVault(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.75);
    for (let nugget = 0; nugget < 3; nugget += 1) {
      const point = sitePoint(site, -0.25 + nugget * 0.45, (nugget - 1) * 1.45);
      const size = 1.35 + ((siteIndex + nugget) % 3) * 0.28;
      addPrimitive(primitives, {
        shape: 'icosahedron', role: nugget === 1 ? 'accent' : 'primary',
        x: point.x, y: site.y + 0.35 + size * 0.5, z: point.z,
        scaleX: size, scaleY: size * 1.15, scaleZ: size,
        rotationX: nugget * 0.2, rotationY: site.yaw + nugget, rotationZ: nugget * 0.13,
      });
    }
    addPrimitive(primitives, {
      shape: 'torus', role: 'secondary', x: site.x, y: site.y + 2.25, z: site.z,
      scaleX: 4.7, scaleY: 4.7, scaleZ: 1.1,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
    });
    addPrimitive(primitives, {
      shape: 'box', role: 'accent', x: site.x, y: site.y + 0.72, z: site.z,
      scaleX: 2.5, scaleY: 0.52, scaleZ: 1.45,
      rotationX: 0, rotationY: site.yaw + 0.08, rotationZ: 0.08,
    });
    addCollider(colliders, site.x, site.y, site.z, 1.75, 2.25);
  }
}

function buildIdeaOrchard(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.65);
    addPrimitive(primitives, {
      shape: 'cylinder', role: 'primary', x: site.x, y: site.y + 1.85, z: site.z,
      scaleX: 0.72, scaleY: 3.45, scaleZ: 0.72,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
    });
    for (let crown = 0; crown < 3; crown += 1) {
      const point = sitePoint(site, crown === 0 ? 0.2 : 0, (crown - 1) * 1.05);
      addPrimitive(primitives, {
        shape: 'sphere', role: crown === 1 ? 'secondary' : 'accent',
        x: point.x, y: site.y + 3.62 + (crown % 2) * 0.48, z: point.z,
        scaleX: 2.15, scaleY: 1.8, scaleZ: 2.15,
        rotationX: 0, rotationY: 0, rotationZ: 0,
        motion: 'bob', motionSpeed: 0.28, motionAmount: 0.11,
        phase: siteIndex + crown,
      });
    }
    addPrimitive(primitives, {
      shape: 'torus', role: 'secondary', x: site.x, y: site.y + 2.05, z: site.z,
      scaleX: 5.4, scaleY: 5.4, scaleZ: 1,
      rotationX: Math.PI * 0.5, rotationY: 0, rotationZ: 0,
      motion: 'pulse', motionSpeed: 0.45, motionAmount: 0.035,
      phase: siteIndex,
    });
    addCollider(colliders, site.x, site.y, site.z, 0.62, 4.65);
  }
}

function buildConnectionLoom(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.65);
    for (const side of [-1, 1] as const) {
      const point = sitePoint(site, 0, side * 1.55);
      addPrimitive(primitives, {
        shape: 'sphere', role: side < 0 ? 'primary' : 'secondary',
        x: point.x, y: site.y + 2.15, z: point.z,
        scaleX: 1.42, scaleY: 1.42, scaleZ: 1.42,
        rotationX: 0, rotationY: 0, rotationZ: 0,
        motion: 'pulse', motionSpeed: 0.75, motionAmount: 0.1,
        phase: siteIndex + side,
      });
    }
    for (const tilt of [-0.48, 0.48] as const) {
      addPrimitive(primitives, {
        shape: 'torus', role: 'accent', x: site.x, y: site.y + 2.15, z: site.z,
        scaleX: 4.55, scaleY: 2.35, scaleZ: 1,
        rotationX: tilt * 0.35, rotationY: site.yaw, rotationZ: tilt,
        motion: 'spin', motionSpeed: 0.12 * Math.sign(tilt), motionAmount: 1,
        phase: siteIndex,
      });
    }
    addPrimitive(primitives, {
      shape: 'box', role: 'secondary', x: site.x, y: site.y + 2.15, z: site.z,
      scaleX: 0.32, scaleY: 3.2, scaleZ: 0.32,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
    });
    addCollider(colliders, site.x, site.y, site.z, 0.42, 3.8);
  }
}

function buildInformationAtlas(
  sites: readonly SignatureFeatureSite[],
  primitives: SignaturePrimitiveDescriptor[],
  colliders: SignatureCollider[],
  patches: SignatureGroundPatch[],
): void {
  for (const [siteIndex, site] of sites.entries()) {
    addPad(primitives, patches, site, 4.8);
    addPrimitive(primitives, {
      shape: 'sphere', role: 'primary', x: site.x, y: site.y + 2.25, z: site.z,
      scaleX: 2.75, scaleY: 2.75, scaleZ: 2.75,
      rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      motion: 'spin', motionSpeed: 0.09, motionAmount: 1,
      phase: siteIndex,
    });
    for (let orbit = 0; orbit < 2; orbit += 1) {
      addPrimitive(primitives, {
        shape: 'torus', role: orbit === 0 ? 'secondary' : 'accent',
        x: site.x, y: site.y + 2.25, z: site.z,
        scaleX: 4.1 + orbit * 0.7, scaleY: 4.1 + orbit * 0.7, scaleZ: 1,
        rotationX: Math.PI * (0.16 + orbit * 0.27),
        rotationY: site.yaw,
        rotationZ: orbit * 0.48,
        motion: 'spin', motionSpeed: orbit === 0 ? 0.14 : -0.11, motionAmount: 1,
        phase: siteIndex + orbit,
      });
    }
    for (const side of [-1, 1] as const) {
      const point = sitePoint(site, -1.15, side * 2.25);
      addPrimitive(primitives, {
        shape: 'box', role: 'secondary', x: point.x, y: site.y + 1.15, z: point.z,
        scaleX: 0.48, scaleY: 1.9 + ((siteIndex + side + 1) % 3) * 0.35, scaleZ: 0.48,
        rotationX: 0, rotationY: site.yaw, rotationZ: 0,
      });
    }
    addCollider(colliders, site.x, site.y, site.z, 1.55, 3.8);
  }
}

/** Deterministic descriptor generation with no Three.js allocations. */
export function createSignatureWorldLayout(
  symbol: SignatureMarketSymbol,
  seed: string,
  heightAt: (x: number, z: number) => number,
): SignatureWorldLayout {
  const sites = createFeatureSites(symbol, seed, heightAt);
  const primitives: SignaturePrimitiveDescriptor[] = [];
  const colliders: SignatureCollider[] = [];
  const groundPatches: SignatureGroundPatch[] = [];
  const args = [sites, primitives, colliders, groundPatches] as const;
  switch (SIGNATURE_WORLD_THEMES[symbol].motif) {
    case 'memory-stack': buildMemoryStacks(...args); break;
    case 'hypercore-islands': buildHypercoreIslands(...args); break;
    case 'innovation-skyline': buildInnovationSkyline(...args); break;
    case 'sector-mosaic': buildSectorMosaic(...args); break;
    case 'memory-canyon': buildMemoryCanyon(...args); break;
    case 'launch-coast': buildLaunchCoast(...args); break;
    case 'ai-factory': buildAiFactory(...args); break;
    case 'gold-vault': buildGoldVault(...args); break;
    case 'idea-orchard': buildIdeaOrchard(...args); break;
    case 'connection-loom': buildConnectionLoom(...args); break;
    case 'information-atlas': buildInformationAtlas(...args); break;
  }
  return { symbol, theme: SIGNATURE_WORLD_THEMES[symbol], sites, primitives, colliders, groundPatches };
}

function geometryForShape(shape: SignaturePrimitiveShape): BufferGeometry {
  switch (shape) {
    case 'box': return new BoxGeometry(1, 1, 1);
    case 'cylinder': return new CylinderGeometry(0.5, 0.5, 1, 12);
    case 'cone': return new ConeGeometry(0.5, 1, 14);
    case 'sphere': return new SphereGeometry(0.5, 12, 8);
    case 'icosahedron': return new IcosahedronGeometry(0.5, 0);
    case 'torus': return new TorusGeometry(0.5, 0.075, 6, 24);
  }
}

function setInstanceMatrix(
  mesh: InstancedMesh,
  index: number,
  descriptor: SignaturePrimitiveDescriptor,
  elapsedSeconds: number,
  motionScale: number,
): void {
  let y = descriptor.y;
  let rotationY = descriptor.rotationY;
  let scaleMultiplier = 1;
  const speed = descriptor.motionSpeed ?? 0.5;
  const amount = descriptor.motionAmount ?? 0.1;
  const wave = Math.sin(elapsedSeconds * speed + descriptor.phase);
  if (descriptor.motion === 'bob') y += wave * amount * motionScale;
  if (descriptor.motion === 'spin') rotationY += elapsedSeconds * speed * motionScale;
  if (descriptor.motion === 'pulse') scaleMultiplier += wave * amount * motionScale;
  INSTANCE_POSITION.set(descriptor.x, y, descriptor.z);
  INSTANCE_SCALE.set(
    descriptor.scaleX * scaleMultiplier,
    descriptor.scaleY * scaleMultiplier,
    descriptor.scaleZ * scaleMultiplier,
  );
  INSTANCE_EULER.set(descriptor.rotationX, rotationY, descriptor.rotationZ);
  INSTANCE_ROTATION.setFromEuler(INSTANCE_EULER);
  INSTANCE_MATRIX.compose(INSTANCE_POSITION, INSTANCE_ROTATION, INSTANCE_SCALE);
  mesh.setMatrixAt(index, INSTANCE_MATRIX);
}

/**
 * One lazy, allocation-bounded system for all signature worlds. Switching a
 * market disposes the old district before constructing the new one, so only
 * the visible world's primitives, particles, and two lights occupy memory.
 */
export class SignatureMarketDistrict {
  public readonly root = new Group();

  private readonly heightAt: SignatureMarketDistrictOptions['heightAt'];
  private readonly seed: string;
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private readonly pools: PrimitivePool[] = [];
  private readonly pooledLights: PointLight[] = [];
  private readonly particlePositions = new Float32Array(PARTICLE_COUNT * 3);
  private particleSeeds: readonly ParticleSeed[] = [];
  private particles: Points<BufferGeometry, PointsMaterial> | null = null;
  private particleMaterial: PointsMaterial | null = null;
  private roleMaterials: Readonly<Partial<Record<SignatureMaterialRole, MeshStandardMaterial>>> = {};
  private activeMarket: SignatureMarketSymbol | null = null;
  private activeLayout: SignatureWorldLayout | null = null;
  private reducedMotion: boolean;
  private disposed = false;

  public constructor(options: SignatureMarketDistrictOptions) {
    this.heightAt = options.heightAt;
    this.seed = options.seed ?? 'tickerworld-v1';
    this.reducedMotion = options.reducedMotion ?? false;
    this.root.name = 'tickerworld-signature-market-district';
    this.root.visible = false;
    options.parent.add(this.root);
    if (options.activeMarket) this.setActiveMarket(options.activeMarket);
  }

  public setActiveMarket(symbol: AssetSymbol): void {
    if (this.disposed) return;
    const next = isSignatureMarketSymbol(symbol) ? symbol : null;
    if (next === this.activeMarket) return;
    this.clearActiveTheme();
    this.activeMarket = next;
    if (!next) {
      this.root.visible = false;
      return;
    }
    this.buildActiveTheme(next);
    this.root.visible = true;
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  public update(
    _deltaSeconds: number,
    elapsedSeconds: number,
    environment: SignatureMarketDistrictEnvironment,
  ): void {
    if (this.disposed || !this.activeLayout) return;
    const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    const night = clamp01(environment.nightFactor);
    const motionScale = this.reducedMotion ? 0.16 : 1;
    for (const pool of this.pools) {
      if (!pool.dynamic) continue;
      pool.descriptors.forEach((descriptor, index) => {
        setInstanceMatrix(pool.mesh, index, descriptor, elapsed, motionScale);
      });
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
    this.updateParticles(elapsed, night, this.activeLayout.theme.particleStyle);
    const player = environment.playerPosition;
    for (let index = 0; index < this.pooledLights.length; index += 1) {
      const light = this.pooledLights[index]!;
      const site = this.activeLayout.sites[index];
      if (!site) {
        light.visible = false;
        continue;
      }
      const distance = player ? Math.hypot(player.x - site.x, player.z - site.z) : index * 10;
      light.visible = night > 0.12 && distance < 36;
      light.intensity = light.visible ? 0.12 + night * 2.15 : 0;
      light.position.set(site.x, site.y + 3.4, site.z);
    }
    const accentMaterial = this.roleMaterials.accent;
    if (accentMaterial) accentMaterial.emissiveIntensity = 0.28 + night * 1.02;
    const secondaryMaterial = this.roleMaterials.secondary;
    if (secondaryMaterial) secondaryMaterial.emissiveIntensity = 0.035 + night * 0.12;
  }

  public sampleGround(x: number, z: number): Readonly<{
    height: number;
    surface: Extract<SurfaceKind, 'stone'>;
  }> | null {
    if (!this.activeLayout || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    let height = Number.NEGATIVE_INFINITY;
    for (const patch of this.activeLayout.groundPatches) {
      if (Math.hypot(x - patch.x, z - patch.z) <= patch.radius) {
        height = Math.max(height, patch.top);
      }
    }
    return Number.isFinite(height) ? { height, surface: 'stone' } : null;
  }

  public collidesPlayer(x: number, z: number, radius = 0.7): boolean {
    if (!this.activeLayout || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    return this.activeLayout.colliders.some((collider) => (
      Math.hypot(x - collider.x, z - collider.z) < collider.radius + radius
    ));
  }

  public resolveHorizontal(
    x: number,
    z: number,
    radius: number,
    previousX: number,
    previousZ: number,
  ): Readonly<{ x: number; z: number }> {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return {
        x: Number.isFinite(previousX) ? previousX : 0,
        z: Number.isFinite(previousZ) ? previousZ : 0,
      };
    }
    if (!this.collidesPlayer(x, z, radius)) return { x, z };
    if (!this.collidesPlayer(x, previousZ, radius)) return { x, z: previousZ };
    if (!this.collidesPlayer(previousX, z, radius)) return { x: previousX, z };
    return { x: previousX, z: previousZ };
  }

  public collidesCamera(x: number, y: number, z: number, radius = 0.42): boolean {
    if (!this.activeLayout || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return false;
    }
    return this.activeLayout.colliders.some((collider) => (
      y >= collider.y - radius
      && y <= collider.y + collider.height + radius
      && Math.hypot(x - collider.x, z - collider.z) < collider.radius + radius
    ));
  }

  public getDebugStats(): SignatureMarketDistrictStats {
    return {
      active: this.activeLayout !== null,
      market: this.activeMarket,
      title: this.activeLayout?.theme.title ?? null,
      featureSites: this.activeLayout?.sites.length ?? 0,
      primitiveInstances: this.activeLayout?.primitives.length ?? 0,
      instancedPools: this.pools.length,
      dynamicPools: this.pools.filter((pool) => pool.dynamic).length,
      colliders: this.activeLayout?.colliders.length ?? 0,
      particles: this.activeLayout ? PARTICLE_COUNT : 0,
      activePointLights: this.pooledLights.filter((light) => light.visible).length,
      geometryResources: this.geometries.size,
      materialResources: this.materials.size,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearActiveTheme();
    this.root.removeFromParent();
  }

  private buildActiveTheme(symbol: SignatureMarketSymbol): void {
    const layout = createSignatureWorldLayout(symbol, this.seed, this.heightAt);
    this.activeLayout = layout;
    const geometryByShape = new Map<SignaturePrimitiveShape, BufferGeometry>();
    const materialByRole: Partial<Record<SignatureMaterialRole, MeshStandardMaterial>> = {};
    const theme = layout.theme;
    const colors: Readonly<Record<SignatureMaterialRole, number>> = {
      primary: theme.primary,
      secondary: theme.secondary,
      accent: theme.accent,
      ground: theme.ground,
    };
    for (const role of ['primary', 'secondary', 'accent', 'ground'] as const) {
      const roleMaterial = this.trackMaterial(new MeshStandardMaterial({
        color: colors[role],
        emissive: colors[role],
        emissiveIntensity: role === 'accent' ? 0.28 : role === 'secondary' ? 0.035 : 0.018,
        roughness: role === 'accent' ? 0.42 : role === 'ground' ? 0.94 : 0.72,
        metalness: role === 'accent' ? 0.12 : 0.025,
        flatShading: role !== 'accent',
      }));
      materialByRole[role] = roleMaterial;
    }
    this.roleMaterials = materialByRole;

    const grouped = new Map<string, SignaturePrimitiveDescriptor[]>();
    for (const descriptor of layout.primitives) {
      const key = `${descriptor.shape}:${descriptor.role}`;
      const descriptors = grouped.get(key) ?? [];
      descriptors.push(descriptor);
      grouped.set(key, descriptors);
    }
    for (const [key, descriptors] of grouped) {
      const descriptor = descriptors[0];
      if (!descriptor) continue;
      let geometry = geometryByShape.get(descriptor.shape);
      if (!geometry) {
        geometry = this.trackGeometry(geometryForShape(descriptor.shape));
        geometryByShape.set(descriptor.shape, geometry);
      }
      const poolMaterial = materialByRole[descriptor.role];
      if (!poolMaterial) continue;
      const mesh = new InstancedMesh(geometry, poolMaterial, descriptors.length);
      mesh.name = `${symbol.toLowerCase()}-${key.replace(':', '-')}`;
      mesh.castShadow = descriptor.role !== 'ground';
      mesh.receiveShadow = true;
      const dynamic = descriptors.some((item) => item.motion !== undefined);
      descriptors.forEach((item, index) => setInstanceMatrix(mesh, index, item, 0, 0));
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
      this.pools.push({ mesh, descriptors, dynamic });
    }

    const random = createRandom(`${this.seed}:${symbol}:signature-particles-v1`);
    this.particleSeeds = Array.from({ length: PARTICLE_COUNT }, (_, index) => ({
      siteIndex: index % Math.max(1, layout.sites.length),
      angle: random() * Math.PI * 2,
      radius: 0.8 + random() * 5.2,
      height: 0.5 + random() * 7.2,
      phase: random() * Math.PI * 2,
      speed: 0.12 + random() * 0.32,
    }));
    const particleGeometry = this.trackGeometry(new BufferGeometry());
    const attribute = new BufferAttribute(this.particlePositions, 3);
    attribute.setUsage(DynamicDrawUsage);
    particleGeometry.setAttribute('position', attribute);
    this.particleMaterial = this.trackMaterial(new PointsMaterial({
      color: theme.particle,
      size: theme.particleStyle === 'stars' ? 0.22 : 0.3,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    this.particles = new Points(particleGeometry, this.particleMaterial);
    this.particles.name = `${symbol.toLowerCase()}-signature-atmosphere`;
    this.particles.frustumCulled = false;
    this.root.add(this.particles);
    this.updateParticles(0, 0, theme.particleStyle);

    for (let index = 0; index < LIGHT_COUNT; index += 1) {
      const light = new PointLight(theme.lightColor, 0, 14, 2);
      light.name = `${symbol}SignatureLight${index + 1}`;
      light.visible = false;
      this.pooledLights.push(light);
      this.root.add(light);
    }
  }

  private updateParticles(
    elapsedSeconds: number,
    nightFactor: number,
    style: SignatureParticleStyle,
  ): void {
    if (!this.activeLayout || !this.particles || !this.particleMaterial) return;
    const motion = this.reducedMotion ? 0.12 : 1;
    for (let index = 0; index < this.particleSeeds.length; index += 1) {
      const seed = this.particleSeeds[index];
      if (!seed) continue;
      const site = this.activeLayout.sites[seed.siteIndex];
      if (!site) continue;
      const time = elapsedSeconds * seed.speed * motion + seed.phase;
      let angle = seed.angle;
      let radius = seed.radius;
      let y = site.y + seed.height;
      if (style === 'data') {
        y = site.y + 0.5 + ((seed.height + time * 1.2) % 7.6);
        radius += Math.sin(time * 1.8) * 0.28 * motion;
      } else if (style === 'embers') {
        y = site.y + 0.35 + ((seed.height + time * 0.9) % 6.4);
        angle += Math.sin(time) * 0.18 * motion;
      } else if (style === 'petals') {
        y = site.y + 0.5 + Math.abs(Math.sin(time * 0.46)) * seed.height;
        angle += time * 0.14;
      } else if (style === 'stars') {
        angle += time * 0.055;
        y += Math.sin(time * 0.7) * 0.18 * motion;
      } else {
        angle += time * 0.18;
        radius += Math.sin(time * 0.8) * 0.55 * motion;
      }
      const offset = index * 3;
      this.particlePositions[offset] = site.x + Math.cos(angle) * radius;
      this.particlePositions[offset + 1] = y;
      this.particlePositions[offset + 2] = site.z + Math.sin(angle) * radius;
    }
    this.particles.geometry.getAttribute('position').needsUpdate = true;
    const baseOpacity = style === 'stars' ? 0.25 + nightFactor * 0.45 : 0.25 + nightFactor * 0.16;
    this.particleMaterial.opacity = this.reducedMotion ? baseOpacity * 0.58 : baseOpacity;
  }

  private clearActiveTheme(): void {
    this.root.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.pools.length = 0;
    this.pooledLights.length = 0;
    this.particleSeeds = [];
    this.particles = null;
    this.particleMaterial = null;
    this.roleMaterials = {};
    this.activeLayout = null;
  }

  private trackGeometry<T extends BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private trackMaterial<T extends Material>(material: T): T {
    this.materials.add(material);
    return material;
  }
}

