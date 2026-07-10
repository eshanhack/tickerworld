import * as THREE from 'three';
import { PALETTE } from './config';
import './styles.css';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) throw new Error('Tickerworld could not find its app root.');

const supportsWebGL = (() => {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
})();

if (!supportsWebGL) {
  root.innerHTML = `
    <main class="unsupported-screen">
      <div class="unsupported-card">
        <span aria-hidden="true">🦊</span>
        <h1>This little world needs WebGL</h1>
        <p>Try opening Tickerworld in a recent version of Chrome, Edge, Firefox, or Safari.</p>
      </div>
    </main>`;
} else {
  startFoundation(root);
}

function startFoundation(container: HTMLDivElement): void {
  container.innerHTML = `
    <div class="game-shell">
      <div class="brand-chip"><span class="brand-dot"></span><strong>Tickerworld</strong><span>growing gently</span></div>
      <div class="foundation-note">A small living market world</div>
    </div>`;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.skyDay);
  scene.fog = new THREE.Fog(PALETTE.skyDay, 40, 145);

  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 260);
  camera.position.set(25, 17, 30);
  camera.lookAt(0, 2, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.prepend(renderer.domElement);

  const ambient = new THREE.HemisphereLight(PALETTE.cream, 0x607c68, 2.1);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffdfaa, 3.2);
  sun.position.set(-28, 38, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  scene.add(sun);

  const groundGeometry = new THREE.PlaneGeometry(180, 180, 54, 54);
  groundGeometry.rotateX(-Math.PI / 2);
  const positions = groundGeometry.attributes.position;
  if (positions) {
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index);
      const z = positions.getZ(index);
      const edge = Math.min(1, Math.max(0, (80 - Math.hypot(x, z)) / 22));
      const height = (Math.sin(x * 0.075) * 0.7 + Math.cos(z * 0.064) * 0.55 + Math.sin((x + z) * 0.035) * 0.35) * edge;
      positions.setY(index, height);
    }
    positions.needsUpdate = true;
  }
  groundGeometry.computeVertexNormals();
  const ground = new THREE.Mesh(
    groundGeometry,
    new THREE.MeshStandardMaterial({ color: PALETTE.grass, roughness: 0.92, flatShading: true }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const path = new THREE.Mesh(
    new THREE.PlaneGeometry(13, 76, 1, 12),
    new THREE.MeshStandardMaterial({ color: PALETTE.sand, roughness: 0.96, flatShading: true }),
  );
  path.rotation.set(-Math.PI / 2, 0, -0.52);
  path.position.set(4, 0.15, 1);
  path.receiveShadow = true;
  scene.add(path);

  const trunkGeometry = new THREE.CylinderGeometry(0.45, 0.62, 3.6, 7);
  const crownGeometry = new THREE.IcosahedronGeometry(2.4, 1);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x9a765c, roughness: 1, flatShading: true });
  const crownMaterials = [0x6f9f76, 0x7cad82, 0x84ad78].map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true }),
  );

  const trees: THREE.Group[] = [];
  const treePositions: ReadonlyArray<readonly [number, number, number]> = [
    [-13, 0, -8], [12, 0, -12], [-20, 0, 13], [23, 0, 9], [6, 0, 22], [-31, 0, -22], [34, 0, -18],
  ];
  treePositions.forEach(([x, y, z], index) => {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    trunk.position.y = 1.8;
    trunk.castShadow = true;
    const crown = new THREE.Mesh(crownGeometry, crownMaterials[index % crownMaterials.length]);
    crown.position.y = 4.45;
    crown.scale.set(1, 1.08 + (index % 3) * 0.08, 1);
    crown.castShadow = true;
    tree.add(trunk, crown);
    tree.position.set(x, y, z);
    tree.rotation.y = index * 1.37;
    scene.add(tree);
    trees.push(tree);
  });

  const clock = new THREE.Clock();
  let visible = true;

  const animate = (): void => {
    if (!visible) return;
    const elapsed = clock.getElapsedTime();
    trees.forEach((tree, index) => {
      tree.rotation.z = Math.sin(elapsed * 0.55 + index) * 0.018;
    });
    camera.position.x = Math.cos(elapsed * 0.035) * 36;
    camera.position.z = Math.sin(elapsed * 0.035) * 36;
    camera.lookAt(0, 2.2, 0);
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };

  const resize = (): void => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
  };

  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (visible) {
      clock.getDelta();
      requestAnimationFrame(animate);
    }
  });
  requestAnimationFrame(animate);
}
