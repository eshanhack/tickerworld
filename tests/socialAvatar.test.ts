import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three';
import { Text } from 'troika-three-text';
import { describe, expect, it } from 'vitest';
import type { NetPlayerState } from '../shared/src/index.js';
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
  };
}

function pool(system: RemoteAvatarSystem, name: string): InstancedMesh {
  const candidate = system.root.getObjectByName(name);
  expect(candidate, name).toBeInstanceOf(InstancedMesh);
  return candidate as InstancedMesh;
}

function instanceTransform(mesh: InstancedMesh, index = 0): {
  readonly position: Vector3;
  readonly scale: Vector3;
} {
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  mesh.getMatrixAt(index, matrix);
  matrix.decompose(position, rotation, scale);
  return { position, scale };
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
    expect(interpolateAngle(0, Math.PI, -3)).toBe(0);
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

describe('pooled remote avatar renderer', () => {
  it('keeps resources bounded, takes nearest players, and removes blocked actors', () => {
    const parent = new Group();
    const camera = new PerspectiveCamera(52, 1, 0.1, 100);
    camera.position.set(0, 3, 8);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld(true);
    let now = 500;
    const system = new RemoteAvatarSystem({
      parent,
      camera,
      maxPlayers: 2,
      now: () => now,
      localPosition: () => new Vector3(),
      viewport: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    });

    const pools = system.root.children.filter((child): child is InstancedMesh => child instanceof InstancedMesh);
    expect(pools).toHaveLength(10);
    expect(pools.every((pool) => pool.instanceColor !== null)).toBe(true);
    expect(pools.every((pool) => pool.material instanceof MeshStandardMaterial
      && pool.material.vertexColors === false)).toBe(true);

    system.setPlayers([remote('far', 30), remote('near', 2), remote('middle', 12)], now);
    now += 200;
    system.update(1 / 60);
    expect(system.getDebugStats()).toMatchObject({
      active: 2,
      rendered: 2,
      capacity: 2,
      drawCalls: 10,
      geometries: 4,
      materials: 1,
      labels: 4,
    });

    system.setPlayers([
      remote('near', 2, 2, 'sunrise-fox'),
      remote('middle', 12, 2),
    ], now);
    now += 200;
    system.update(1 / 60);
    const crest = pools.find((pool) => pool.name === 'remote-crest-pool');
    const crestMatrix = new Matrix4();
    crest?.getMatrixAt(0, crestMatrix);
    expect(crest).toBeDefined();
    expect(Math.abs(crestMatrix.determinant())).toBe(0);

    system.setBlockedActors(new Set(['near']));
    expect(system.getDebugStats().active).toBe(1);
    system.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('renders a saved local username immediately and keeps it attached to the player', () => {
    const parent = new Group();
    const camera = new PerspectiveCamera(52, 1, 0.1, 100);
    camera.position.set(0, 3, 8);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld(true);
    const localPosition = new Vector3(4, 0.5, -2);
    let animal: NetPlayerState['animal'] = 'fox';
    const system = new RemoteAvatarSystem({
      parent,
      camera,
      maxPlayers: 1,
      localPosition: () => localPosition,
      localNameplate: { animal: () => animal, username: null },
      viewport: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      occlusionBounds: () => [{
        left: -10_000,
        top: -10_000,
        right: 10_000,
        bottom: 10_000,
        depth: 100,
      }],
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
    expect(system.getDebugStats().labels).toBe(3);

    system.setLocalUsername(null);
    expect(nameplate?.visible).toBe(false);
    system.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('renders remote Saylor as an upright suited biped within the fixed ten pools', () => {
    const parent = new Group();
    const camera = new PerspectiveCamera(52, 1, 0.1, 100);
    camera.position.set(0, 3, 8);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld(true);
    let now = 500;
    const system = new RemoteAvatarSystem({
      parent,
      camera,
      maxPlayers: 1,
      now: () => now,
      localPosition: () => new Vector3(),
      viewport: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    });

    system.setPlayers([remote('btc-titan', 2, 1, 'base', 'saylor', 'Michael_Saylor')], now);
    now += 200;
    system.update(1 / 60);

    expect(system.getDebugStats()).toMatchObject({
      active: 1,
      rendered: 1,
      drawCalls: 10,
      geometries: 4,
      materials: 1,
    });
    const body = pool(system, 'remote-body-pool');
    const head = pool(system, 'remote-head-pool');
    const armLeft = pool(system, 'remote-front-left-leg-pool');
    const armRight = pool(system, 'remote-front-right-leg-pool');
    const legLeft = pool(system, 'remote-hind-left-leg-pool');
    const legRight = pool(system, 'remote-hind-right-leg-pool');
    const earLeft = pool(system, 'remote-left-ear-pool');
    const earRight = pool(system, 'remote-right-ear-pool');
    const tail = pool(system, 'remote-tail-pool');
    const tie = pool(system, 'remote-crest-pool');

    const bodyTransform = instanceTransform(body);
    const headTransform = instanceTransform(head);
    const leftArmTransform = instanceTransform(armLeft);
    const rightArmTransform = instanceTransform(armRight);
    const leftLegTransform = instanceTransform(legLeft);
    const rightLegTransform = instanceTransform(legRight);
    const tieTransform = instanceTransform(tie);
    expect(headTransform.position.y).toBeGreaterThan(bodyTransform.position.y + 0.7);
    expect(leftLegTransform.position.y).toBeLessThan(bodyTransform.position.y);
    expect(rightLegTransform.position.y).toBeLessThan(bodyTransform.position.y);
    expect(leftArmTransform.position.x).toBeLessThan(bodyTransform.position.x);
    expect(rightArmTransform.position.x).toBeGreaterThan(bodyTransform.position.x);
    expect(tieTransform.position.y).toBeGreaterThan(bodyTransform.position.y);
    expect(tieTransform.position.z).toBeLessThan(bodyTransform.position.z);
    expect(Math.abs(tieTransform.scale.x * tieTransform.scale.y * tieTransform.scale.z)).toBeGreaterThan(0);

    for (const hidden of [earLeft, earRight, tail]) {
      const matrix = new Matrix4();
      hidden.getMatrixAt(0, matrix);
      expect(Math.abs(matrix.determinant())).toBe(0);
    }

    const bodyColor = new Color();
    const headColor = new Color();
    const tieColor = new Color();
    body.getColorAt(0, bodyColor);
    head.getColorAt(0, headColor);
    tie.getColorAt(0, tieColor);
    expect(bodyColor.getHex()).toBe(0x283746);
    expect(headColor.getHex()).toBe(0xd8a17a);
    expect(tieColor.getHex()).toBe(0xf29a3f);

    const remoteNameplate = system.root.children.find((child) => (
      child instanceof Text && child.text === 'Michael_Saylor'
    )) as Text | undefined;
    expect(remoteNameplate).toBeDefined();
    expect(remoteNameplate?.position.y).toBeGreaterThan(headTransform.position.y + 0.4);

    system.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
