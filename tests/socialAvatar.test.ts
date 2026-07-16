import {
  BatchedMesh,
  BufferGeometry,
  Group,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { Text } from 'troika-three-text';
import { describe, expect, it } from 'vitest';
import { ANIMAL_KINDS, type AnimalKind, type NetPlayerState } from '../shared/src/index.js';
import { FoxRig } from '../src/player/FoxRig';
import {
  RemoteAvatarSystem,
  clipSpeech,
  interpolateAngle,
  interpolateRemotePose,
  socialLabelOpacity,
} from '../src/social';

function remote(
  actorId: string,
  x: number,
  updatedAt = 1,
  skin: NetPlayerState['skin'] = 'base',
  animal: NetPlayerState['animal'] = 'fox',
  username: string | null = null,
  overrides: Partial<NetPlayerState> = {},
): NetPlayerState {
  return {
    actorId,
    x,
    y: 0,
    z: -8,
    yaw: 0,
    speed: 2,
    verticalSpeed: 0,
    grounded: true,
    gait: 'walk',
    animal,
    skin,
    username,
    updatedAt,
    ...overrides,
  };
}

function createSystem(options: {
  maxPlayers?: number;
  now?: () => number;
  localPosition?: () => Readonly<Vector3>;
  localNameplate?: ConstructorParameters<typeof RemoteAvatarSystem>[0]['localNameplate'];
  occlusionBounds?: ConstructorParameters<typeof RemoteAvatarSystem>[0]['occlusionBounds'];
  detailDistance?: number;
  cullDistance?: number;
  heightAt?: (x: number, z: number) => number;
  reducedMotion?: boolean;
} = {}): { parent: Group; camera: PerspectiveCamera; system: RemoteAvatarSystem } {
  const parent = new Group();
  const camera = new PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(0, 3, 8);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);
  const system = new RemoteAvatarSystem({
    parent,
    camera,
    maxPlayers: options.maxPlayers,
    now: options.now,
    localPosition: options.localPosition ?? (() => new Vector3()),
    localNameplate: options.localNameplate,
    occlusionBounds: options.occlusionBounds,
    detailDistance: options.detailDistance,
    cullDistance: options.cullDistance,
    heightAt: options.heightAt,
    reducedMotion: options.reducedMotion,
    viewport: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  return { parent, camera, system };
}

function effectivelyVisible(object: Object3D, root: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function visibleMeshNames(root: Object3D): string[] {
  const names: string[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh && effectivelyVisible(object, root)) names.push(object.name);
  });
  return names.sort();
}

function disposeRig(rig: FoxRig): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  rig.root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
    else materials.add(object.material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

describe('remote avatar interpolation', () => {
  it('interpolates position and takes the shortest turn across the angle seam', () => {
    const pose = interpolateRemotePose(
      { x: 0, y: 1, z: 2, yaw: Math.PI - 0.1, speed: 0, verticalSpeed: 0, grounded: true, gait: 'idle' },
      { x: 10, y: 3, z: 6, yaw: -Math.PI + 0.1, speed: 4, verticalSpeed: 2, grounded: false, gait: 'air' },
      0.5,
    );
    expect(pose.x).toBe(5);
    expect(pose.y).toBe(2);
    expect(Math.abs(Math.abs(pose.yaw) - Math.PI)).toBeLessThan(0.001);
    expect(pose.grounded).toBe(true);
    expect(pose.gait).toBe('idle');
    expect(interpolateAngle(0, Math.PI, -3)).toBe(0);
  });

  it('interpolates replicated gait phase across wrap and delays discrete state until its sample', () => {
    const pose = interpolateRemotePose(
      {
        x: 0, y: 0, z: 0, yaw: 0, speed: 6, verticalSpeed: 1, grounded: false, gait: 'air',
        movementState: 'jump-rise', gaitPhase: 0.98, movementBlend: 0.8, runBlend: 0.7, airProgress: 0.4,
      },
      {
        x: 1, y: 1, z: 0, yaw: 0, speed: 6, verticalSpeed: -1, grounded: false, gait: 'air',
        movementState: 'apex', gaitPhase: 0.02, movementBlend: 1, runBlend: 0.9, airProgress: 0.8,
      },
      0.5,
    );
    expect(pose.gaitPhase === undefined ? 1 : Math.min(pose.gaitPhase, 1 - pose.gaitPhase)).toBeLessThan(0.001);
    expect(pose.movementState).toBe('jump-rise');
    expect(pose.airProgress).toBe(0.4);

    const flip = interpolateRemotePose(
      {
        x: 0, y: 1, z: 0, yaw: 0, speed: 5, verticalSpeed: 6, grounded: false, gait: 'air',
        movementState: 'double-jump', airProgress: 0.2,
      },
      {
        x: 1, y: 2, z: 0, yaw: 0.3, speed: 5, verticalSpeed: 2, grounded: false, gait: 'air',
        movementState: 'double-jump', airProgress: 0.8,
      },
      0.5,
    );
    expect(flip.airProgress).toBeCloseTo(0.5, 6);
  });

  it('switches short action counters on their exact replicated simulation tick', () => {
    const before = {
      x: 0, y: 0, z: 0, yaw: 0, speed: 7, verticalSpeed: 0, grounded: true, gait: 'run' as const,
      movementState: 'run' as const,
      simulationTick: 100,
      stateTransitionSequence: 7,
      stateTransitionTick: 96,
      doubleJumpSequence: 2,
      doubleJumpTick: 88,
      turnLean: -0.08,
      accelerationLean: 0.03,
      glideBank: 0,
    };
    const after = {
      ...before,
      y: 1,
      grounded: false,
      gait: 'air' as const,
      movementState: 'double-jump' as const,
      simulationTick: 106,
      stateTransitionSequence: 8,
      stateTransitionTick: 104,
      doubleJumpSequence: 3,
      doubleJumpTick: 103,
      turnLean: 0.16,
      accelerationLean: -0.05,
      glideBank: 0.7,
    };
    const early = interpolateRemotePose(before, after, 0.4);
    const event = interpolateRemotePose(before, after, 0.55);
    const state = interpolateRemotePose(before, after, 0.7);
    expect(early.doubleJumpSequence).toBe(2);
    expect(event.doubleJumpSequence).toBe(3);
    expect(event.movementState).toBe('run');
    expect(state.movementState).toBe('double-jump');
    expect(state.turnLean).toBeCloseTo(0.088, 3);
    expect(state.glideBank).toBeCloseTo(0.49, 3);
    expect(state.simulationTick).toBe(104);
  });

  it('clips bubbles without clipping the full room message', () => {
    const full = 'A '.repeat(70).trim();
    const bubble = clipSpeech(full, 30);
    expect(full.length).toBeGreaterThan(30);
    expect(bubble).toHaveLength(30);
    expect(bubble.endsWith('…')).toBe(true);
  });

  it('fades labels only when projected rectangles overlap the chart', () => {
    const chart = { left: 300, top: 120, right: 600, bottom: 440, depth: 16 };
    expect(socialLabelOpacity({ left: 350, top: 200, right: 450, bottom: 230, depth: 9 }, [chart])).toBe(0.05);
    expect(socialLabelOpacity({ left: 350, top: 200, right: 450, bottom: 230, depth: 22 }, [chart])).toBe(1);
    expect(socialLabelOpacity({ left: 20, top: 20, right: 120, bottom: 50 }, [chart])).toBe(1);
  });
});

describe('canonical remote avatar renderer', () => {
  it('uses one exact-geometry batch, takes nearest players, and removes blocked actors', () => {
    let now = 500;
    const { parent, system } = createSystem({
      maxPlayers: 2,
      now: () => now,
    });
    const batch = system.root.getObjectByName('remote-canonical-avatar-batch');
    expect(batch).toBeInstanceOf(BatchedMesh);
    expect(system.root.children.filter((child) => child instanceof BatchedMesh)).toHaveLength(1);

    system.setPlayers([remote('far', 30), remote('near', 2), remote('middle', 12)], now);
    now += 200;
    system.update(1 / 60);
    expect(system.getDebugStats()).toMatchObject({
      active: 2,
      rendered: 2,
      detailed: 2,
      capacity: 2,
      drawCalls: 1,
      materials: 1,
      labels: 4,
    });
    expect(system.getActorRenderRoot('near')).not.toBeNull();
    expect(system.getActorRenderRoot('middle')).not.toBeNull();
    expect(system.getActorRenderRoot('far')).toBeNull();

    system.setBlockedActors(new Set(['near']));
    expect(system.getDebugStats().active).toBe(1);
    system.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('uses the same canonical visible mesh set as the local rig for every animal', () => {
    let now = 500;
    const { system } = createSystem({ maxPlayers: ANIMAL_KINDS.length, now: () => now });
    system.setPlayers(ANIMAL_KINDS.map((animal, index) => (
      remote(`animal-${animal}`, 2 + index * 2, 1, 'base', animal)
    )), now);
    now += 200;
    system.update(1 / 60);

    for (const animal of ANIMAL_KINDS) {
      const remoteRoot = system.getActorRenderRoot(`animal-${animal}`);
      const remoteModel = remoteRoot?.getObjectByName('FoxModel');
      expect(remoteModel, animal).toBeDefined();
      const localRig = new FoxRig();
      localRig.setAnimal(animal, 'base');
      expect(visibleMeshNames(remoteModel!), animal).toEqual(visibleMeshNames(localRig.root));
      disposeRig(localRig);
    }

    expect(visibleMeshNames(system.getActorRenderRoot('animal-fox')!)).toContain('FoxTailSegment6');
    expect(visibleMeshNames(system.getActorRenderRoot('animal-rabbit')!)).toEqual(expect.arrayContaining([
      'RabbitInnerEarLeft', 'RabbitInnerEarRight',
    ]));
    expect(visibleMeshNames(system.getActorRenderRoot('animal-cat')!).filter((name) => name.startsWith('CatWhisker'))).toHaveLength(6);
    expect(visibleMeshNames(system.getActorRenderRoot('animal-axolotl')!).filter((name) => name.startsWith('AxolotlGill'))).toHaveLength(6);
    expect(visibleMeshNames(system.getActorRenderRoot('animal-frog')!).some((name) => name.includes('Ear'))).toBe(false);
    expect(visibleMeshNames(system.getActorRenderRoot('animal-penguin')!).some((name) => name.includes('Tail'))).toBe(false);
    expect(visibleMeshNames(system.getActorRenderRoot('animal-duck')!).some((name) => name.includes('Tail'))).toBe(false);
    expect(system.getDebugStats()).toMatchObject({
      active: ANIMAL_KINDS.length,
      rendered: ANIMAL_KINDS.length,
      detailed: ANIMAL_KINDS.length,
      drawCalls: 1,
      materials: 1,
    });
    system.dispose();
  });

  it('never swaps a distant visible player to a reduced proxy', () => {
    let now = 500;
    const { system } = createSystem({
      maxPlayers: 1,
      now: () => now,
      detailDistance: 12,
      cullDistance: 42,
    });
    system.setPlayers([remote('penguin', 8, 1, 'base', 'penguin')], now);
    now += 200;
    system.update(1 / 60);
    const nearParts = visibleMeshNames(system.getActorRenderRoot('penguin')!);
    expect(nearParts).toEqual(expect.arrayContaining(['PenguinFace', 'PenguinBeak', 'PenguinFlipperLeft']));

    system.setPlayers([remote('penguin', 28, 2, 'base', 'penguin')], now);
    now += 200;
    system.update(1 / 60);
    expect(visibleMeshNames(system.getActorRenderRoot('penguin')!)).toEqual(nearParts);
    expect(system.getDebugStats()).toMatchObject({ rendered: 1, detailed: 1, drawCalls: 1 });
    system.dispose();
  });

  it('drives the canonical articulated gait, glide, and inferred double-jump flourish', () => {
    let now = 1_000;
    const { system } = createSystem({ maxPlayers: 1, now: () => now });
    system.setPlayers([remote('moving', 4, 1, 'base', 'fox')], now);
    now += 200;
    for (let index = 0; index < 10; index += 1) system.update(1 / 60);
    const root = system.getActorRenderRoot('moving')!;
    const hip = root.getObjectByName('FoxFrontLeftLegPivot')!;
    const initial = hip.rotation.x;

    system.setPlayers([remote('moving', 4, 2, 'base', 'fox', null, { speed: 7, gait: 'run' })], now);
    now += 200;
    for (let index = 0; index < 12; index += 1) system.update(1 / 60);
    expect(Math.abs(hip.rotation.x - initial)).toBeGreaterThan(0.03);

    system.setPlayers([remote('moving', 4, 3, 'base', 'fox', null, {
      y: 2,
      grounded: false,
      gait: 'glide',
      verticalSpeed: -2,
    })], now);
    now += 200;
    system.update(1 / 60);
    expect(root.getObjectByName('FoxTailJoint1')!.rotation.x).not.toBe(0);

    system.setPlayers([remote('moving', 4, 4, 'base', 'fox', null, {
      y: 2.2,
      grounded: false,
      gait: 'air',
      verticalSpeed: 8,
    })], now);
    now += 200;
    system.update(1 / 60);
    const aerial = root.getObjectByName('RemoteAerialPivot')!;
    expect(Math.abs(aerial.rotation.x)).toBeGreaterThan(0);
    expect(aerial.matrixWorld.elements.every(Number.isFinite)).toBe(true);
    system.dispose();
  });

  it('uses explicit replicated double-jump and landing poses without velocity inference', () => {
    let now = 1_000;
    const { system } = createSystem({ maxPlayers: 1, now: () => now });
    system.setPlayers([remote('exact', 3, 1, 'base', 'rabbit', null, {
      y: 2,
      grounded: false,
      gait: 'air',
      verticalSpeed: 0.2,
      movementState: 'double-jump',
      airProgress: 0.48,
      gaitPhase: 0.37,
      movementBlend: 1,
      runBlend: 1,
      simulationTick: 120,
    })], now);
    now += 200;
    system.update(1 / 60);
    const root = system.getActorRenderRoot('exact')!;
    const aerial = root.getObjectByName('RemoteAerialPivot')!;
    expect(Math.abs(aerial.rotation.x)).toBeGreaterThan(Math.PI * 1.5);

    system.setPlayers([remote('exact', 3, 2, 'base', 'rabbit', null, {
      grounded: true,
      gait: 'idle',
      movementState: 'land-heavy',
      airProgress: 0.15,
      simulationTick: 126,
    })], now);
    now += 200;
    system.update(1 / 60);
    expect(root.getObjectByName('FoxModel')!.position.y).toBeLessThan(0.02);
    system.dispose();
  });

  it('applies reduced-motion flips to remotes and updates the preference live', () => {
    let now = 1_000;
    const { system } = createSystem({ maxPlayers: 1, now: () => now, reducedMotion: true });
    const airborne = remote('gentle', 3, 1, 'base', 'rabbit', null, {
      y: 2,
      grounded: false,
      gait: 'air',
      verticalSpeed: 0.2,
      movementState: 'double-jump',
      airProgress: 0.48,
      movementBlend: 1,
      runBlend: 1,
    });
    system.setPlayers([airborne], now);
    now += 200;
    system.update(1 / 60);
    const aerial = system.getActorRenderRoot('gentle')!.getObjectByName('RemoteAerialPivot')!;
    expect(Math.abs(aerial.rotation.x)).toBeGreaterThan(0.5);
    expect(Math.abs(aerial.rotation.x)).toBeLessThan(Math.PI);

    system.setReducedMotion(false);
    system.setPlayers([{ ...airborne, updatedAt: 2 }], now);
    now += 200;
    system.update(1 / 60);
    expect(Math.abs(aerial.rotation.x)).toBeGreaterThan(Math.PI * 1.5);
    system.dispose();
  });

  it('plants every species from its actual canonical paw geometry on slopes', () => {
    let now = 1_000;
    const heightAt = (x: number, z: number): number => x * 0.11 + z * 0.045;
    const { system } = createSystem({ maxPlayers: 3, now: () => now, heightAt });
    const animals = ['frog', 'bear', 'rabbit'] as const;
    system.setPlayers(animals.map((animal, index) => {
      const x = index * 3 - 3;
      const z = -8;
      return remote(`slope-${animal}`, x, 1, 'base', animal, null, {
        y: heightAt(x, z),
        z,
        speed: 0,
        gait: 'idle',
      });
    }), now);
    now += 200;
    for (let frame = 0; frame < 30; frame += 1) system.update(1 / 60);

    for (const animal of animals) {
      const root = system.getActorRenderRoot(`slope-${animal}`)!;
      root.updateMatrixWorld(true);
      for (const name of [
        'FoxFrontLeftPaw',
        'FoxFrontRightPaw',
        'FoxHindLeftPaw',
        'FoxHindRightPaw',
      ]) {
        const paw = root.getObjectByName(name) as Mesh;
        const positions = paw.geometry.getAttribute('position');
        const vertex = new Vector3();
        let minimumClearance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < positions.count; index += 1) {
          vertex.fromBufferAttribute(positions, index).applyMatrix4(paw.matrixWorld);
          minimumClearance = Math.min(
            minimumClearance,
            vertex.y - heightAt(vertex.x, vertex.z),
          );
        }
        expect(minimumClearance).toBeGreaterThan(-0.045);
        expect(minimumClearance).toBeLessThan(0.2);
      }
    }
    system.dispose();
  });

  it('replays skipped short actions and exact lean from compact motion counters', () => {
    let now = 2_000;
    const { system } = createSystem({ maxPlayers: 1, now: () => now });
    system.setPlayers([remote('lossless', 2, 1, 'base', 'fox', null, {
      movementState: 'run',
      movementBlend: 1,
      runBlend: 1,
      simulationTick: 100,
      doubleJumpSequence: 3,
      doubleJumpTick: 92,
      turnLean: 0,
      accelerationLean: 0,
      velocityX: 0,
      velocityZ: -7,
    })], now);
    now += 200;
    system.update(1 / 60);

    // The next 10Hz sample has already moved on to fall; the monotonic action
    // serial still guarantees that the celebratory flip is rendered once.
    system.setPlayers([remote('lossless', 2.7, 2, 'base', 'fox', null, {
      y: 1.8,
      grounded: false,
      gait: 'air',
      movementState: 'fall',
      movementBlend: 1,
      runBlend: 1,
      simulationTick: 106,
      doubleJumpSequence: 4,
      doubleJumpTick: 103,
      turnLean: 0.2,
      accelerationLean: -0.06,
      velocityX: 4.4,
      velocityZ: -5.4,
    })], now);
    now += 200;
    for (let frame = 0; frame < 8; frame += 1) system.update(1 / 60);
    const root = system.getActorRenderRoot('lossless')!;
    const aerial = root.getObjectByName('RemoteAerialPivot')!;
    const model = root.getObjectByName('FoxModel')!;
    expect(Math.abs(aerial.rotation.x)).toBeGreaterThan(0.5);
    expect(model.rotation.z).toBeGreaterThan(0.08);
    expect(model.rotation.x).toBeLessThan(-0.01);
    system.dispose();
  });

  it('does not replay historical action counters after distance culling', () => {
    let now = 2_000;
    const { system } = createSystem({ maxPlayers: 1, now: () => now, cullDistance: 10 });
    system.setPlayers([remote('culled', 20, 1, 'base', 'fox', null, {
      grounded: false,
      gait: 'air',
      movementState: 'fall',
      verticalSpeed: -3,
      simulationTick: 100,
      doubleJumpSequence: 2,
      doubleJumpTick: 90,
    })], now);
    now += 200;
    system.update(1 / 60);
    expect(system.getDebugStats().rendered).toBe(0);

    system.setPlayers([remote('culled', 20, 2, 'base', 'fox', null, {
      grounded: false,
      gait: 'air',
      movementState: 'fall',
      verticalSpeed: -3,
      simulationTick: 106,
      doubleJumpSequence: 3,
      doubleJumpTick: 103,
    })], now);
    now += 200;
    system.update(1 / 60);

    system.setPlayers([remote('culled', 2, 3, 'base', 'fox', null, {
      grounded: false,
      gait: 'air',
      movementState: 'fall',
      verticalSpeed: -3,
      simulationTick: 112,
      doubleJumpSequence: 3,
      doubleJumpTick: 103,
    })], now);
    now += 200;
    system.update(1 / 60);
    expect(system.getDebugStats().rendered).toBe(1);
    const aerial = system.getActorRenderRoot('culled')!.getObjectByName('RemoteAerialPivot')!;
    expect(Math.abs(aerial.rotation.x)).toBeLessThan(0.3);
    system.dispose();
  });

  it('keeps a full 49-player room bounded to one character draw call', () => {
    let now = 1_000;
    const { system } = createSystem({ maxPlayers: 49, now: () => now });
    const players = Array.from({ length: 49 }, (_, index) => remote(
      `player-${index}`,
      (index % 7) * 2 - 6,
      1,
      'base',
      ANIMAL_KINDS[index % ANIMAL_KINDS.length] as AnimalKind,
      null,
      { z: -5 - Math.floor(index / 7) * 2 },
    ));
    system.setPlayers(players, now);
    now += 200;
    for (let index = 0; index < 60; index += 1) system.update(1 / 60);
    const stats = system.getDebugStats();
    expect(stats).toMatchObject({ active: 49, rendered: 49, detailed: 49, drawCalls: 1, materials: 1 });
    expect(stats.geometries).toBeGreaterThan(20);
    expect(stats.geometries).toBeLessThan(400);
    system.dispose();
  });

  it('renders a saved local username immediately and keeps it attached to the player', () => {
    const localPosition = new Vector3(4, 0.5, -2);
    let animal: NetPlayerState['animal'] = 'fox';
    const { parent, system } = createSystem({
      maxPlayers: 1,
      localPosition: () => localPosition,
      localNameplate: { actorId: 'local-player', animal: () => animal, username: null },
      occlusionBounds: () => [{ left: -10_000, top: -10_000, right: 10_000, bottom: 10_000, depth: 100 }],
    });
    const nameplate = system.root.getObjectByName('local-player-nameplate');
    expect(nameplate).toBeInstanceOf(Text);
    expect(nameplate?.visible).toBe(false);

    system.setLocalUsername('Magic_Fox');
    expect((nameplate as Text).text).toBe('Magic_Fox');
    expect(nameplate?.visible).toBe(true);
    system.update(1 / 60);
    expect(nameplate?.position.toArray()).toEqual([4, 2.5, -2]);
    expect((nameplate as Text).outlineOpacity).toBeCloseTo(0.05 * 0.96);

    localPosition.set(-3, 1, 6);
    animal = 'frog';
    system.update(1 / 60);
    expect(nameplate?.position.x).toBe(-3);
    expect(nameplate?.position.y).toBeCloseTo(2.2467);
    expect(nameplate?.position.z).toBe(6);
    expect(system.getDebugStats().labels).toBe(4);

    system.setLocalUsername(null);
    expect(nameplate?.visible).toBe(false);
    system.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('hides remote players for private view without hiding the local username', () => {
    let now = 500;
    const { system } = createSystem({
      maxPlayers: 1,
      now: () => now,
      localPosition: () => new Vector3(0, 0.5, 0),
      localNameplate: { actorId: 'local', animal: () => 'fox', username: 'Local_Fox' },
    });
    system.setPlayers([remote('friend', 3)], now);
    now += 200;
    system.update(1 / 60);
    const localNameplate = system.root.getObjectByName('local-player-nameplate');
    const batch = system.root.getObjectByName('remote-canonical-avatar-batch') as BatchedMesh;
    expect(localNameplate?.visible).toBe(true);
    expect(system.getDebugStats().rendered).toBe(1);
    expect(batch).toBeInstanceOf(BatchedMesh);

    system.setRemotePlayersVisible(false);
    expect(system.root.visible).toBe(true);
    expect(localNameplate?.visible).toBe(true);
    expect(system.getDebugStats()).toMatchObject({ active: 1, rendered: 0, detailed: 0, drawCalls: 0 });

    now += 200;
    system.update(1 / 60);
    expect(localNameplate?.visible).toBe(true);
    system.setRemotePlayersVisible(true);
    now += 200;
    system.update(1 / 60);
    expect(system.getDebugStats()).toMatchObject({ rendered: 1, detailed: 1, drawCalls: 1 });
    system.dispose();
  });

  it('renders the room-echoed local chat above the local head and expires it', () => {
    const localPosition = new Vector3(3, 0.5, -4);
    let now = 1_000;
    const { system } = createSystem({
      maxPlayers: 1,
      now: () => now,
      localPosition: () => localPosition,
      localNameplate: { actorId: 'me', animal: () => 'rabbit', username: null },
      occlusionBounds: () => [{ left: -10_000, top: -10_000, right: 10_000, bottom: 10_000, depth: 100 }],
    });

    system.showSpeech({ actorId: 'me', text: 'I can see my own bubble' });
    system.update(1 / 60);
    const speech = system.root.getObjectByName('local-player-speech');
    expect(speech).toBeInstanceOf(Text);
    expect((speech as Text).text).toBe('I can see my own bubble');
    expect(speech?.visible).toBe(true);
    expect(speech?.position.x).toBe(3);
    expect(speech?.position.y).toBeCloseTo(2.584);
    expect(speech?.position.z).toBe(-4);
    expect((speech as Text).outlineOpacity).toBeGreaterThanOrEqual(0.72 * 0.96);

    now += 5_001;
    system.update(1 / 60);
    expect(speech?.visible).toBe(false);
    expect((speech as Text).text).toBe('');
    system.dispose();
  });

  it('renders the complete Saylor tribute rather than a generic biped proxy', () => {
    let now = 500;
    const { system } = createSystem({ maxPlayers: 1, now: () => now });
    system.setPlayers([remote('btc-titan', 2, 1, 'base', 'saylor', 'Michael_Saylor')], now);
    now += 200;
    system.update(1 / 60);
    const root = system.getActorRenderRoot('btc-titan')!;
    const names = visibleMeshNames(root);
    expect(names).toEqual(expect.arrayContaining([
      'SaylorSuitTorso',
      'SaylorLapelLeft',
      'SaylorLapelRight',
      'SaylorOrangeTie',
      'SaylorBitcoinPin',
      'SaylorSilverBeard',
      'SaylorSilverMustache',
      'SaylorSilverHairCap',
      'SaylorSweptSilverHair',
      'SaylorShoeLeft',
      'SaylorShoeRight',
    ]));
    expect(names.some((name) => name.startsWith('FoxTail'))).toBe(false);
    const remoteNameplate = system.root.children.find((child) => (
      child instanceof Text && child.text === 'Michael_Saylor'
    )) as Text | undefined;
    expect(remoteNameplate).toBeDefined();
    expect(remoteNameplate?.position.y).toBeGreaterThan(root.getObjectByName('SaylorFace')!.getWorldPosition(new Vector3()).y);
    expect(system.getDebugStats()).toMatchObject({ active: 1, rendered: 1, detailed: 1, drawCalls: 1, materials: 1 });
    system.dispose();
  });

  it('keeps canonical matrices finite through appearance churn', () => {
    let now = 500;
    const { system } = createSystem({ maxPlayers: 1, now: () => now });
    const matrix = new Matrix4();
    for (let index = 0; index < ANIMAL_KINDS.length * 2; index += 1) {
      const animal = ANIMAL_KINDS[index % ANIMAL_KINDS.length] as AnimalKind;
      system.setPlayers([remote('shape-shifter', 3, index + 1, 'base', animal)], now);
      now += 200;
      system.update(1 / 60);
      const root = system.getActorRenderRoot('shape-shifter')!;
      root.updateMatrixWorld(true);
      root.traverse((object) => {
        if (!(object instanceof Mesh) || !effectivelyVisible(object, root)) return;
        matrix.copy(object.matrixWorld);
        expect(matrix.elements.every(Number.isFinite), `${animal}:${object.name}`).toBe(true);
      });
    }
    expect(system.getDebugStats().drawCalls).toBe(1);
    system.dispose();
  });
});
