import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ANIMAL_KINDS, MAX_SPRINT_SPEED, type AnimalKind } from '../shared/src/index.js';
import {
  ANIMAL_MOTION_PROFILES,
  FoxPlayer,
  PlayerInputController,
} from '../src/player';

const SIGNATURE_FEATURE: Readonly<Record<AnimalKind, string>> = {
  fox: 'FoxTailTip',
  penguin: 'PenguinBeak',
  frog: 'FrogEyeBulbLeft',
  duck: 'DuckBill',
  bear: 'BearMuzzle',
  rabbit: 'RabbitEarLeft',
  cat: 'CatWhiskerLeft1',
  axolotl: 'AxolotlGillLeft1',
};

function create(animal: AnimalKind): FoxPlayer {
  return new FoxPlayer({
    animal,
    input: new PlayerInputController({ target: null, document: null }),
  });
}

function advance(player: FoxPlayer, frames: number, sprint = false): void {
  player.setVirtualInput(0, 1, sprint);
  for (let frame = 0; frame < frames; frame += 1) {
    player.update(1 / 60, 0, () => 0, () => 'grass');
  }
}

describe('distinct playable animal characters', () => {
  it('uses one full canonical species model and no charm crest for every animal', () => {
    for (const animal of ANIMAL_KINDS) {
      const player = create(animal);
      expect(player.group.getObjectByName(SIGNATURE_FEATURE[animal])).toBeInstanceOf(THREE.Mesh);
      expect(player.group.getObjectByName('PremiumAnimalCrest')).toBeUndefined();
      if (animal === 'fox') {
        expect(player.group.getObjectByName('AnimalModel-fox')).toBeUndefined();
        expect(player.group.getObjectByName('FoxTorso')?.visible).toBe(true);
      } else {
        expect(player.group.getObjectByName(`AnimalModel-${animal}`)).toBeInstanceOf(THREE.Group);
        expect(player.group.getObjectByName('FoxTorso')?.visible).toBe(false);
      }
      player.dispose();
    }
  });

  it('preserves playful size contrast and a wide network-safe speed range', () => {
    expect(ANIMAL_MOTION_PROFILES.frog.modelScale).toBeLessThan(ANIMAL_MOTION_PROFILES.rabbit.modelScale);
    expect(ANIMAL_MOTION_PROFILES.rabbit.modelScale).toBeLessThan(ANIMAL_MOTION_PROFILES.fox.modelScale);
    expect(ANIMAL_MOTION_PROFILES.fox.modelScale).toBeLessThan(ANIMAL_MOTION_PROFILES.bear.modelScale);
    expect(Math.max(...ANIMAL_KINDS.map((animal) => ANIMAL_MOTION_PROFILES[animal].sprintSpeed)))
      .toBeLessThanOrEqual(MAX_SPRINT_SPEED);
    expect(ANIMAL_MOTION_PROFILES.rabbit.sprintSpeed).toBeGreaterThanOrEqual(8.3);
    expect(ANIMAL_MOTION_PROFILES.frog.sprintSpeed).toBeGreaterThanOrEqual(8);
    expect(ANIMAL_MOTION_PROFILES.cat.sprintSpeed).toBeGreaterThanOrEqual(7.8);
    expect(ANIMAL_MOTION_PROFILES.rabbit.sprintSpeed - ANIMAL_MOTION_PROFILES.bear.sprintSpeed)
      .toBeGreaterThan(3.8);
    expect(new Set(ANIMAL_KINDS.map((animal) => (
      ANIMAL_MOTION_PROFILES[animal].doubleJumpTurns.join(':')
    ))).size).toBe(8);
    expect(ANIMAL_MOTION_PROFILES.frog.jumpImpulse).toBeGreaterThan(ANIMAL_MOTION_PROFILES.bear.jumpImpulse);
    expect(ANIMAL_MOTION_PROFILES.frog.accelerationScale).toBeGreaterThan(ANIMAL_MOTION_PROFILES.bear.accelerationScale);

    for (const animal of ANIMAL_KINDS) {
      const player = create(animal);
      const model = player.group.getObjectByName('FoxModel')!;
      expect(model.scale.x).toBeCloseTo(ANIMAL_MOTION_PROFILES[animal].modelScale, 6);
      player.dispose();
    }
  });

  it('makes the frog faster and substantially higher-jumping than the bear', () => {
    const frog = create('frog');
    const bear = create('bear');
    advance(frog, 90, true);
    advance(bear, 90, true);
    expect(Math.abs(frog.position.z)).toBeGreaterThan(Math.abs(bear.position.z) + 1.3);

    frog.setVirtualInput(0, 0);
    bear.setVirtualInput(0, 0);
    frog.requestJump();
    bear.requestJump();
    let frogApex = frog.position.y;
    let bearApex = bear.position.y;
    for (let frame = 0; frame < 120; frame += 1) {
      frog.update(1 / 60, 0, () => 0, () => 'grass');
      bear.update(1 / 60, 0, () => 0, () => 'grass');
      frogApex = Math.max(frogApex, frog.position.y);
      bearApex = Math.max(bearApex, bear.position.y);
    }
    expect(frogApex).toBeGreaterThan(bearApex + 0.75);
    frog.dispose();
    bear.dispose();
  });

  it('makes the lightweight rabbit, frog, and cat outrun the baseline fox', () => {
    const fox = create('fox');
    const lightweightKinds: readonly AnimalKind[] = ['rabbit', 'frog', 'cat'];
    const lightweight = lightweightKinds.map(create);
    advance(fox, 150, true);
    lightweight.forEach((player) => advance(player, 150, true));
    for (const player of lightweight) {
      expect(Math.abs(player.position.z)).toBeGreaterThan(Math.abs(fox.position.z) + 0.75);
      player.dispose();
    }
    fox.dispose();
  });

  it('gives species visibly different double-jump flips', () => {
    const samples = new Map<AnimalKind, THREE.Vector3>();
    for (const animal of ANIMAL_KINDS) {
      const player = create(animal);
      player.update(1 / 60, 0, () => 0, () => 'grass');
      player.requestJump();
      for (let frame = 0; frame < 12 && player.snapshot.jumpsUsed === 0; frame += 1) {
        player.update(1 / 60, 0, () => 0, () => 'grass');
      }
      player.requestJump();
      for (let frame = 0; frame < 9; frame += 1) {
        player.update(1 / 60, 0, () => 0, () => 'grass');
      }
      const pivot = player.group.getObjectByName('AnimalAerialPivot')!;
      samples.set(animal, new THREE.Vector3(pivot.rotation.x, pivot.rotation.y, pivot.rotation.z));
      expect(samples.get(animal)!.length()).toBeGreaterThan(0.45);
      player.dispose();
    }

    expect(Math.abs(samples.get('fox')!.x)).toBeGreaterThan(Math.abs(samples.get('fox')!.z) + 0.4);
    expect(Math.abs(samples.get('penguin')!.z)).toBeGreaterThan(Math.abs(samples.get('penguin')!.x) + 0.4);
    expect(samples.get('frog')!.x).toBeLessThan(0);
    expect(samples.get('duck')!.z).toBeLessThan(0);
    expect(Math.abs(samples.get('cat')!.x)).toBeGreaterThan(0.4);
    expect(Math.abs(samples.get('cat')!.y)).toBeGreaterThan(0.4);
  });
});
