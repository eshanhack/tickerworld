import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { AssetSymbol } from '../types';

export interface OilWorldEffectsOptions {
  readonly parent: Object3D;
  readonly heightAt: (x: number, z: number) => number;
  readonly onJetFlyby?: (position: { x: number; y: number; z: number }, intensity: number) => void;
  readonly onExplosion?: (position: { x: number; y: number; z: number }, intensity: number) => void;
  readonly reducedMotion?: boolean;
}

interface JetFlight {
  readonly group: Group;
  readonly start: Vector3;
  readonly end: Vector3;
  readonly target: Vector3;
  elapsed: number;
  readonly duration: number;
  sounded: boolean;
  exploded: boolean;
}

interface OilBlast {
  readonly group: Group;
  readonly core: Mesh<SphereGeometry, MeshBasicMaterial>;
  readonly ring: Mesh<TorusGeometry, MeshBasicMaterial>;
  readonly smoke: readonly Mesh<SphereGeometry, MeshStandardMaterial>[];
  readonly light: PointLight;
  elapsed: number;
  readonly duration: number;
}

const WELCOME_FLYBY_DELAY_SECONDS = 0.85;
const RETURN_FLYBY_MIN_DELAY_SECONDS = 18;
const RETURN_FLYBY_DELAY_RANGE_SECONDS = 10;
const REPEAT_FLYBY_MIN_DELAY_SECONDS = 36;
const REPEAT_FLYBY_DELAY_RANGE_SECONDS = 18;

/**
 * A small, allocation-bounded WTI vignette. Aircraft and blasts are stylised
 * toys with no flags, factions, targets, or real-world conflict references.
 */
export class OilWorldEffects {
  public readonly root = new Group();

  private readonly heightAt: OilWorldEffectsOptions['heightAt'];
  private readonly onJetFlyby?: OilWorldEffectsOptions['onJetFlyby'];
  private readonly onExplosion?: OilWorldEffectsOptions['onExplosion'];
  private readonly jetBodyGeometry = new CylinderGeometry(0.28, 0.38, 3.2, 8);
  private readonly jetNoseGeometry = new ConeGeometry(0.29, 0.9, 8);
  private readonly jetWingGeometry = new BoxGeometry(3.35, 0.12, 0.82);
  private readonly jetTailGeometry = new BoxGeometry(1.15, 0.48, 0.1);
  private readonly jetMaterial = new MeshStandardMaterial({
    color: 0xc6d0cd,
    emissive: 0x70817d,
    emissiveIntensity: 0.08,
    roughness: 0.48,
    metalness: 0.18,
    flatShading: true,
  });
  private readonly jetAccentMaterial = new MeshStandardMaterial({
    color: 0xf0bd73,
    emissive: 0xd58b47,
    emissiveIntensity: 0.16,
    roughness: 0.55,
    flatShading: true,
  });
  private readonly blastSphereGeometry = new SphereGeometry(1, 10, 7);
  private readonly blastRingGeometry = new TorusGeometry(1, 0.1, 6, 24);
  private readonly jets: JetFlight[] = [];
  private readonly blasts: OilBlast[] = [];
  private randomState = 0x51f15e;
  private secondsUntilNextFlight = Number.POSITIVE_INFINITY;
  private welcomeFlybyPlayed = false;
  private active = false;
  private reducedMotion: boolean;
  private disposed = false;

  constructor(options: OilWorldEffectsOptions) {
    this.heightAt = options.heightAt;
    this.onJetFlyby = options.onJetFlyby;
    this.onExplosion = options.onExplosion;
    this.reducedMotion = options.reducedMotion ?? false;
    this.root.name = 'wti-oil-world-effects';
    this.root.visible = false;
    options.parent.add(this.root);
  }

  public setActiveMarket(symbol: AssetSymbol): void {
    const active = symbol === 'WTI';
    if (this.active === active || this.disposed) return;
    this.active = active;
    this.root.visible = active;
    this.clearActiveEffects();
    this.secondsUntilNextFlight = active
      ? this.welcomeFlybyPlayed
        ? RETURN_FLYBY_MIN_DELAY_SECONDS + this.random() * RETURN_FLYBY_DELAY_RANGE_SECONDS
        : WELCOME_FLYBY_DELAY_SECONDS
      : Number.POSITIVE_INFINITY;
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  public update(deltaSeconds: number, _elapsedSeconds: number, playerPosition: Vector3): void {
    if (!this.active || this.disposed) return;
    const delta = Math.max(0, Math.min(0.1, deltaSeconds));
    this.secondsUntilNextFlight = Math.max(0, this.secondsUntilNextFlight - delta);
    if (this.secondsUntilNextFlight <= 0 && this.jets.length < 2) {
      this.spawnJet();
      this.welcomeFlybyPlayed = true;
      this.secondsUntilNextFlight = REPEAT_FLYBY_MIN_DELAY_SECONDS
        + this.random() * REPEAT_FLYBY_DELAY_RANGE_SECONDS;
    }

    for (let index = this.jets.length - 1; index >= 0; index -= 1) {
      const jet = this.jets[index]!;
      jet.elapsed += delta;
      const t = Math.min(1, jet.elapsed / jet.duration);
      jet.group.position.lerpVectors(jet.start, jet.end, t);
      const dx = jet.end.x - jet.start.x;
      const dz = jet.end.z - jet.start.z;
      jet.group.rotation.y = Math.atan2(dx, dz);
      jet.group.rotation.z = this.reducedMotion ? 0 : Math.sin(t * Math.PI * 2) * 0.075;

      const distance = jet.group.position.distanceTo(playerPosition);
      if (!jet.sounded && distance < 52) {
        jet.sounded = true;
        this.onJetFlyby?.(jet.group.position, Math.max(0.35, 1 - distance / 80));
      }
      if (!jet.exploded && t >= 0.64) {
        jet.exploded = true;
        this.spawnBlast(jet.target);
      }
      if (t >= 1) {
        jet.group.removeFromParent();
        this.jets.splice(index, 1);
      }
    }

    for (let index = this.blasts.length - 1; index >= 0; index -= 1) {
      const blast = this.blasts[index]!;
      blast.elapsed += delta;
      const t = Math.min(1, blast.elapsed / blast.duration);
      const burst = Math.sin(Math.min(1, t * 1.7) * Math.PI * 0.5);
      blast.core.scale.setScalar(0.4 + burst * 3.4);
      blast.core.material.opacity = Math.max(0, 1 - t * 1.25);
      blast.ring.scale.setScalar(0.7 + t * 6.5);
      blast.ring.material.opacity = Math.max(0, 0.72 - t * 0.72);
      blast.light.intensity = (1 - t) * 3.2;
      blast.smoke.forEach((cloud, cloudIndex) => {
        const drift = t * (1.3 + cloudIndex * 0.22);
        cloud.position.y = 0.7 + drift * 2.2;
        cloud.position.x += delta * (cloudIndex - 1) * 0.18;
        cloud.scale.setScalar(0.55 + drift * 1.45);
        cloud.material.opacity = Math.max(0, 0.42 * (1 - t));
      });
      if (t >= 1) {
        this.disposeBlast(blast);
        this.blasts.splice(index, 1);
      }
    }
  }

  public getDebugStats(): { active: boolean; jets: number; blasts: number } {
    return { active: this.active, jets: this.jets.length, blasts: this.blasts.length };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearActiveEffects();
    this.root.removeFromParent();
    this.jetBodyGeometry.dispose();
    this.jetNoseGeometry.dispose();
    this.jetWingGeometry.dispose();
    this.jetTailGeometry.dispose();
    this.jetMaterial.dispose();
    this.jetAccentMaterial.dispose();
    this.blastSphereGeometry.dispose();
    this.blastRingGeometry.dispose();
  }

  private spawnJet(): void {
    const leftToRight = this.random() >= 0.5;
    // Stay within the normal horizon framing while still rewarding players
    // who tilt the camera upward to follow the flyby.
    const height = 11 + this.random() * 7;
    const start = new Vector3(leftToRight ? -74 : 74, height, -2 + this.random() * 11);
    const end = new Vector3(
      leftToRight ? 74 : -74,
      height + (this.random() - 0.5) * 4,
      12 + this.random() * 12,
    );
    const target = new Vector3(
      (this.random() >= 0.5 ? 1 : -1) * (22 + this.random() * 17),
      0,
      20 + this.random() * 24,
    );
    target.y = this.heightAt(target.x, target.z) + 0.35;

    const group = new Group();
    group.name = 'wti-pastel-jet';
    group.scale.setScalar(1.35);
    const body = new Mesh(this.jetBodyGeometry, this.jetMaterial);
    body.rotation.x = Math.PI * 0.5;
    const nose = new Mesh(this.jetNoseGeometry, this.jetAccentMaterial);
    nose.position.z = 2.03;
    nose.rotation.x = Math.PI * 0.5;
    const wing = new Mesh(this.jetWingGeometry, this.jetMaterial);
    wing.position.z = -0.1;
    const tail = new Mesh(this.jetTailGeometry, this.jetAccentMaterial);
    tail.position.set(0, 0.42, -1.35);
    for (const mesh of [body, nose, wing, tail]) mesh.castShadow = true;
    group.add(body, nose, wing, tail);
    group.position.copy(start);
    this.root.add(group);
    this.jets.push({
      group,
      start,
      end,
      target,
      elapsed: 0,
      duration: 7.5 + this.random() * 2.4,
      sounded: false,
      exploded: false,
    });
  }

  private spawnBlast(position: Vector3): void {
    while (this.blasts.length >= 4) {
      const oldest = this.blasts.shift();
      if (oldest) this.disposeBlast(oldest);
    }
    const group = new Group();
    group.name = 'wti-distant-blast';
    group.position.copy(position);
    const coreMaterial = new MeshBasicMaterial({ color: 0xffc873, transparent: true, opacity: 0.95 });
    const ringMaterial = new MeshBasicMaterial({ color: 0xf38f68, transparent: true, opacity: 0.72 });
    const core = new Mesh(this.blastSphereGeometry, coreMaterial);
    const ring = new Mesh(this.blastRingGeometry, ringMaterial);
    ring.rotation.x = Math.PI * 0.5;
    const smoke = [0, 1, 2].map((index) => {
      const smokeMaterial = new MeshStandardMaterial({
        color: index === 1 ? 0x756d68 : 0x8c827a,
        emissive: 0x503b34,
        emissiveIntensity: 0.08,
        transparent: true,
        opacity: 0.4,
        roughness: 1,
        depthWrite: false,
      });
      const cloud = new Mesh(this.blastSphereGeometry, smokeMaterial);
      cloud.position.set((index - 1) * 0.65, 0.7 + index * 0.15, (index % 2 - 0.5) * 0.7);
      return cloud;
    });
    const light = new PointLight(0xffa760, 3.2, 21, 2);
    light.position.y = 2.2;
    group.add(core, ring, ...smoke, light);
    this.root.add(group);
    const blast: OilBlast = {
      group,
      core,
      ring,
      smoke,
      light,
      elapsed: 0,
      duration: this.reducedMotion ? 1.35 : 2.2,
    };
    this.blasts.push(blast);
    this.onExplosion?.(position, 0.72 + this.random() * 0.25);
  }

  private disposeBlast(blast: OilBlast): void {
    blast.group.removeFromParent();
    blast.core.material.dispose();
    blast.ring.material.dispose();
    blast.smoke.forEach((cloud) => cloud.material.dispose());
  }

  private clearActiveEffects(): void {
    for (const jet of this.jets) jet.group.removeFromParent();
    this.jets.length = 0;
    for (const blast of this.blasts) this.disposeBlast(blast);
    this.blasts.length = 0;
  }

  private random(): number {
    this.randomState = Math.imul(this.randomState ^ (this.randomState >>> 15), 1 | this.randomState);
    this.randomState ^= this.randomState + Math.imul(this.randomState ^ (this.randomState >>> 7), 61 | this.randomState);
    return ((this.randomState ^ (this.randomState >>> 14)) >>> 0) / 4_294_967_296;
  }
}
