import { Group, InstancedMesh, MeshStandardMaterial, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { NetPlayerState } from '../shared/src/index.js';
import {
  RemoteAvatarSystem,
  clipSpeech,
  interpolateAngle,
  interpolateRemotePose,
  socialLabelOpacity,
} from '../src/social';

function remote(actorId: string, x: number, updatedAt = 1): NetPlayerState {
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
    animal: 'fox',
    skin: 'base',
    username: null,
    updatedAt,
  };
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
    expect(pools).toHaveLength(9);
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
      drawCalls: 9,
      geometries: 4,
      materials: 1,
      labels: 4,
    });

    system.setBlockedActors(new Set(['near']));
    expect(system.getDebugStats().active).toBe(1);
    system.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
