import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';

interface Particle {
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly color: Color;
  life: number;
  maxLife: number;
}

export class SparklePool {
  readonly points: Points<BufferGeometry, PointsMaterial>;

  private readonly particles: Particle[];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private sequence = 0;

  constructor(capacity = 24) {
    const safeCapacity = Math.max(1, Math.floor(capacity));
    const geometry = new BufferGeometry();
    this.positions = new Float32Array(safeCapacity * 3);
    this.colors = new Float32Array(safeCapacity * 3);

    const positionAttribute = new BufferAttribute(this.positions, 3);
    const colorAttribute = new BufferAttribute(this.colors, 3);
    positionAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setDrawRange(0, 0);

    const material = new PointsMaterial({
      size: 0.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      vertexColors: true,
    });

    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.particles = Array.from({ length: safeCapacity }, () => ({
      position: new Vector3(),
      velocity: new Vector3(),
      color: new Color(),
      life: 0,
      maxLife: 0,
    }));
  }

  burst(color: Color, upward: boolean, strength = 1): void {
    const count = Math.min(7, Math.max(3, Math.round(3 + strength * 2)));
    for (let i = 0; i < count; i += 1) {
      const particle = this.particles.find((candidate) => candidate.life <= 0);
      if (!particle) {
        break;
      }

      const phase = (this.sequence++ * 2.399963 + i * 1.7) % (Math.PI * 2);
      const radial = 1.6 + ((this.sequence * 37) % 13) / 20;
      particle.position.set(
        Math.cos(phase) * radial,
        2.1 + ((this.sequence * 17) % 11) * 0.14,
        Math.sin(phase) * 0.42,
      );
      particle.velocity.set(
        Math.cos(phase) * 0.32,
        (upward ? 1 : 0.55) + ((this.sequence * 11) % 7) * 0.07,
        Math.sin(phase) * 0.2,
      );
      particle.color.copy(color).lerp(new Color(0xfff1cf), 0.42);
      particle.maxLife = 0.7 + ((this.sequence * 19) % 9) * 0.035;
      particle.life = particle.maxLife;
    }
  }

  update(deltaSeconds: number): void {
    const delta = Math.min(0.05, Math.max(0, deltaSeconds));
    let activeCount = 0;

    for (const particle of this.particles) {
      if (particle.life <= 0) {
        continue;
      }

      particle.life -= delta;
      if (particle.life <= 0) {
        continue;
      }

      particle.velocity.y -= delta * 0.85;
      particle.position.addScaledVector(particle.velocity, delta);
      const fade = Math.min(1, particle.life / Math.max(0.001, particle.maxLife) * 1.5);
      const offset = activeCount * 3;
      this.positions[offset] = particle.position.x;
      this.positions[offset + 1] = particle.position.y;
      this.positions[offset + 2] = particle.position.z;
      this.colors[offset] = particle.color.r * fade;
      this.colors[offset + 1] = particle.color.g * fade;
      this.colors[offset + 2] = particle.color.b * fade;
      activeCount += 1;
    }

    this.points.geometry.setDrawRange(0, activeCount);
    const positionAttribute = this.points.geometry.getAttribute('position');
    const colorAttribute = this.points.geometry.getAttribute('color');
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    this.points.visible = activeCount > 0;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
