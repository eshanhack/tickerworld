import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  TorusGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { AssetSymbol } from '../types';
import { MEDALLION_CENTER, MEDALLION_DEPTH, MEDALLION_RADIUS, PLINTH_BOUNDS } from './monumentGeometry';

export type MonumentKind = 'grand' | 'echo';

const COLORS = {
  cream: 0xfff1cf,
  stoneDark: 0x81796f,
  btc: 0xf4b56f,
  eth: 0xb9afe8,
  solA: 0x8dd9c4,
  solB: 0xd6a8e4,
  solC: 0xf2a7bc,
  xrp: 0x9bcbd1,
  doge: 0xe7c77c,
  bnb: 0xf3ce72,
  link: 0x91addf,
  avax: 0xea8d86,
  wti: 0x66746e,
  wtiBand: 0xe0b96c,
  test: 0xd58ddd,
  pump: 0xe58eaf,
  ansem: 0x756b82,
  shfl: 0x78add4,
} as const;

function material(color: number, emissiveIntensity = 0.04): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity,
    roughness: 0.7,
    metalness: 0.02,
    flatShading: true,
  });
}

function addMesh(
  group: Group,
  geometry: BoxGeometry | ConeGeometry | CylinderGeometry | OctahedronGeometry | RoundedBoxGeometry | TorusGeometry,
  meshMaterial: MeshStandardMaterial,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): Mesh {
  const mesh = new Mesh(geometry, meshMaterial);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function addRaisedBar(
  group: Group,
  cream: MeshStandardMaterial,
  width: number,
  height: number,
  x: number,
  y: number,
  rotationZ = 0,
  z = MEDALLION_CENTER.z + MEDALLION_DEPTH * 0.5 + 0.16,
): void {
  addMesh(
    group,
    new RoundedBoxGeometry(width, height, 0.28, 2, 0.09),
    cream,
    [x, y, z],
    [0, 0, rotationZ],
  );
}

function addCoin(group: Group, coinMaterial: MeshStandardMaterial, radius = MEDALLION_RADIUS): void {
  addMesh(
    group,
    new CylinderGeometry(radius, radius, MEDALLION_DEPTH, 32),
    coinMaterial,
    [MEDALLION_CENTER.x, MEDALLION_CENTER.y, MEDALLION_CENTER.z],
    [Math.PI * 0.5, 0, 0],
  );
  addMesh(
    group,
    new TorusGeometry(radius * 0.82, 0.1, 6, 36),
    material(COLORS.cream, 0.08),
    [MEDALLION_CENTER.x, MEDALLION_CENTER.y, MEDALLION_CENTER.z + MEDALLION_DEPTH * 0.5 + 0.05],
  );
}

function buildBtc(group: Group, simplified: boolean): void {
  const cream = material(COLORS.cream, 0.1);
  addCoin(group, material(COLORS.btc, 0.08));
  if (!simplified) {
    addMesh(
      group,
      new TorusGeometry(MEDALLION_RADIUS * 0.62, 0.035, 5, 32),
      cream,
      [0, MEDALLION_CENTER.y, MEDALLION_CENTER.z + MEDALLION_DEPTH * 0.5 + 0.08],
    );
  }
  const glyphHeight = simplified ? 3.25 : 3.75;
  // Two stems plus squared lobes make the Bitcoin mark legible from the
  // default camera without relying on a platform-specific currency glyph.
  addRaisedBar(group, cream, 0.2, glyphHeight, -0.52, MEDALLION_CENTER.y);
  addRaisedBar(group, cream, 0.2, glyphHeight, -0.16, MEDALLION_CENTER.y);
  addRaisedBar(group, cream, 1.72, 0.3, 0.08, 5.48);
  addRaisedBar(group, cream, 1.82, 0.3, 0.12, 4.48);
  addRaisedBar(group, cream, 1.72, 0.3, 0.08, 3.48);
  addRaisedBar(group, cream, 0.34, 0.78, 0.76, 4.98);
  addRaisedBar(group, cream, 0.34, 0.78, 0.76, 3.98);
}

function buildEth(group: Group, simplified: boolean): void {
  const purple = material(COLORS.eth, 0.09);
  const cream = material(COLORS.cream, 0.07);
  addMesh(
    group,
    new OctahedronGeometry(simplified ? 2.45 : 2.75, 0),
    purple,
    [0, MEDALLION_CENTER.y, MEDALLION_CENTER.z],
    [0, 0, 0],
    [1, 1, 0.24],
  );
  if (!simplified) {
    addMesh(group, new ConeGeometry(1.55, 2.45, 4), cream, [0, 5.08, -0.98], [0, Math.PI * 0.25, 0], [0.94, 1, 0.28]);
    addMesh(group, new ConeGeometry(1.28, 1.8, 4), material(0x8c82c4, 0.08), [0, 3.55, -0.98], [Math.PI, Math.PI * 0.25, 0], [0.94, 1, 0.28]);
  }
}

function buildSol(group: Group, simplified: boolean): void {
  const colors = [COLORS.solA, COLORS.solB, COLORS.solC] as const;
  const ys = simplified ? [5.25, 4.48, 3.71] : [5.35, 4.48, 3.61];
  ys.forEach((y, index) => {
    addMesh(
      group,
      new RoundedBoxGeometry(simplified ? 4.0 : 4.75, 0.64, 0.6, 3, 0.18),
      material(colors[index] ?? COLORS.solA, 0.1),
      [index % 2 === 0 ? 0.22 : -0.22, y, MEDALLION_CENTER.z],
      [0, 0, -0.12],
    );
  });
}

function buildXrp(group: Group, simplified: boolean): void {
  const xrp = material(COLORS.xrp, 0.1);
  const arc = Math.PI * (simplified ? 0.72 : 0.82);
  addMesh(group, new TorusGeometry(1.62, 0.24, 8, 24, arc), xrp, [-0.04, 5.18, MEDALLION_CENTER.z], [0, 0, 0.14]);
  addMesh(group, new TorusGeometry(1.62, 0.24, 8, 24, arc), xrp, [0.04, 3.78, MEDALLION_CENTER.z], [0, 0, Math.PI + 0.14]);
  addRaisedBar(group, xrp, 0.42, 2.25, -0.62, 4.48, -0.72, MEDALLION_CENTER.z + 0.35);
  addRaisedBar(group, xrp, 0.42, 2.25, 0.62, 4.48, 0.72, MEDALLION_CENTER.z + 0.35);
}

function buildDoge(group: Group, simplified: boolean): void {
  const cream = material(COLORS.cream, 0.1);
  addCoin(group, material(COLORS.doge, 0.08), simplified ? 2.75 : MEDALLION_RADIUS);
  const z = MEDALLION_CENTER.z + MEDALLION_DEPTH * 0.5 + 0.19;
  addMesh(group, new TorusGeometry(1.23, 0.32, 9, 28), cream, [0.15, MEDALLION_CENTER.y, z], [0, 0, 0], [1.02, 1.2, 1]);
  addRaisedBar(group, cream, 0.42, 3.25, -0.73, MEDALLION_CENTER.y);
  addRaisedBar(group, cream, 2.05, 0.28, -0.3, MEDALLION_CENTER.y + 0.08);
}

function buildBnb(group: Group, simplified: boolean): void {
  const gold = material(COLORS.bnb, 0.1);
  const size = simplified ? 0.82 : 0.96;
  const positions: ReadonlyArray<readonly [number, number]> = [[0, 4.48], [-1.35, 4.48], [1.35, 4.48], [0, 5.83], [0, 3.13]];
  for (const [x, y] of positions) {
    addMesh(group, new BoxGeometry(size, size, 0.62), gold, [x, y, MEDALLION_CENTER.z], [0, 0, Math.PI * 0.25]);
  }
  if (!simplified) {
    const cream = material(COLORS.cream, 0.08);
    for (const [x, y] of [[-0.67, 5.15], [0.67, 5.15], [-0.67, 3.81], [0.67, 3.81]] as const) {
      addMesh(group, new BoxGeometry(0.5, 0.5, 0.68), cream, [x, y, -1.48], [0, 0, Math.PI * 0.25]);
    }
  }
}

function buildLink(group: Group, simplified: boolean): void {
  const blue = material(COLORS.link, 0.1);
  addMesh(
    group,
    new TorusGeometry(simplified ? 1.95 : 2.25, simplified ? 0.4 : 0.48, 4, 6),
    blue,
    [0, MEDALLION_CENTER.y, MEDALLION_CENTER.z],
    [0, 0, Math.PI / 6],
  );
}

function buildAvax(group: Group, simplified: boolean): void {
  const coral = material(COLORS.avax, 0.1);
  addRaisedBar(group, coral, simplified ? 0.62 : 0.76, simplified ? 3.8 : 4.45, -0.88, 4.55, -0.48, MEDALLION_CENTER.z + 0.25);
  addRaisedBar(group, coral, simplified ? 0.62 : 0.76, simplified ? 3.8 : 4.45, 0.88, 4.55, 0.48, MEDALLION_CENTER.z + 0.25);
  addMesh(group, new ConeGeometry(0.58, 0.95, 3), material(COLORS.cream, 0.08), [0, 3.5, -1.1], [0, 0, Math.PI]);
}

/** A toy-scale oil barrel replaces the usual coin crest in WTI world. */
function buildWti(group: Group, simplified: boolean): void {
  const barrel = material(COLORS.wti, 0.07);
  const band = material(COLORS.wtiBand, 0.1);
  const height = simplified ? 4.4 : 5.15;
  const radius = simplified ? 1.9 : 2.25;
  addMesh(
    group,
    new CylinderGeometry(radius, radius * 1.04, height, 20),
    barrel,
    [0, 4.25, MEDALLION_CENTER.z],
  );
  for (const y of [4.25 - height * 0.38, 4.25, 4.25 + height * 0.38]) {
    addMesh(
      group,
      new TorusGeometry(radius * 1.015, simplified ? 0.11 : 0.15, 6, 28),
      band,
      [0, y, MEDALLION_CENTER.z],
      [Math.PI * 0.5, 0, 0],
    );
  }
  if (!simplified) {
    // A simple raised drop reads clearly without relying on texture assets.
    addMesh(group, new ConeGeometry(0.62, 1.35, 16), band, [0, 4.58, -2.15], [0, 0, Math.PI]);
    addMesh(group, new CylinderGeometry(0.62, 0.62, 0.72, 16), band, [0, 3.82, -2.15]);
  }
}

function buildTest(group: Group, simplified: boolean): void {
  const violet = material(COLORS.test, 0.16);
  const cream = material(COLORS.cream, 0.13);
  addMesh(
    group,
    new OctahedronGeometry(simplified ? 2.15 : 2.55, 1),
    violet,
    [0, MEDALLION_CENTER.y, MEDALLION_CENTER.z],
    [0, Math.PI * 0.25, 0],
    [1, 1, 0.58],
  );
  addRaisedBar(group, cream, 0.55, simplified ? 2.8 : 3.35, -0.48, 4.95, -0.54);
  addRaisedBar(group, cream, 0.55, simplified ? 2.5 : 3.0, 0.5, 4.02, -0.54);
}

function buildPump(group: Group, simplified: boolean): void {
  const cream = material(COLORS.cream, 0.12);
  addCoin(group, material(COLORS.pump, 0.12), simplified ? 2.7 : MEDALLION_RADIUS);
  addRaisedBar(group, cream, 0.5, simplified ? 3.0 : 3.7, -0.65, MEDALLION_CENTER.y);
  addMesh(
    group,
    new TorusGeometry(simplified ? 0.92 : 1.12, 0.32, 8, 24, Math.PI * 1.4),
    cream,
    [0.02, 5.05, MEDALLION_CENTER.z + 0.35],
    [0, 0, -0.72],
  );
}

function buildAnsem(group: Group, simplified: boolean): void {
  const ink = material(COLORS.ansem, 0.1);
  const cream = material(COLORS.cream, 0.1);
  addMesh(group, new OctahedronGeometry(simplified ? 2.35 : 2.7, 1), ink,
    [0, MEDALLION_CENTER.y, MEDALLION_CENTER.z], [0, Math.PI * 0.25, 0], [1, 1, 0.45]);
  addRaisedBar(group, cream, 0.48, simplified ? 3.3 : 4.0, -0.75, 4.45, -0.42);
  addRaisedBar(group, cream, 0.48, simplified ? 3.3 : 4.0, 0.75, 4.45, 0.42);
  addRaisedBar(group, cream, 1.65, 0.34, 0, 4.25);
  if (!simplified) {
    addMesh(group, new ConeGeometry(0.55, 1.5, 12), cream, [-1.5, 5.9, -1.25], [0, 0, -0.65]);
    addMesh(group, new ConeGeometry(0.55, 1.5, 12), cream, [1.5, 5.9, -1.25], [0, 0, 0.65]);
  }
}

function buildShfl(group: Group, simplified: boolean): void {
  const blue = material(COLORS.shfl, 0.11);
  const cream = material(COLORS.cream, 0.1);
  const cards = simplified ? 2 : 3;
  for (let index = 0; index < cards; index += 1) {
    const offset = (index - (cards - 1) * 0.5) * 0.72;
    addMesh(
      group,
      new RoundedBoxGeometry(2.45, 3.65, 0.32, 3, 0.16),
      index === cards - 1 ? cream : blue,
      [offset, MEDALLION_CENTER.y + Math.abs(offset) * 0.12, MEDALLION_CENTER.z + index * 0.18],
      [0, 0, offset * 0.18],
    );
  }
}

export function buildMedallion(symbol: AssetSymbol, kind: MonumentKind): Group {
  const group = new Group();
  group.name = `${symbol.toLowerCase()}-${kind}-medallion`;
  const simplified = kind === 'echo';

  const plinth = addMesh(
    group,
    new RoundedBoxGeometry(
      PLINTH_BOUNDS.halfX * 2,
      PLINTH_BOUNDS.halfY * 2,
      PLINTH_BOUNDS.halfZ * 2,
      3,
      0.2,
    ),
    material(COLORS.stoneDark),
    [PLINTH_BOUNDS.centerX, PLINTH_BOUNDS.centerY, PLINTH_BOUNDS.centerZ],
  );
  plinth.name = `${symbol.toLowerCase()}-medallion-plinth`;

  switch (symbol) {
    case 'BTC': buildBtc(group, simplified); break;
    case 'ETH': buildEth(group, simplified); break;
    case 'SOL': buildSol(group, simplified); break;
    case 'XRP': buildXrp(group, simplified); break;
    case 'DOGE': buildDoge(group, simplified); break;
    case 'BNB': buildBnb(group, simplified); break;
    case 'LINK': buildLink(group, simplified); break;
    case 'AVAX': buildAvax(group, simplified); break;
    case 'WTI': buildWti(group, simplified); break;
    case 'TEST': buildTest(group, simplified); break;
    case 'PUMP': buildPump(group, simplified); break;
    case 'ANSEM': buildAnsem(group, simplified); break;
    case 'SHFL': buildShfl(group, simplified); break;
  }

  return group;
}
