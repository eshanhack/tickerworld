import * as THREE from 'three';

export const POSTCARD_WIDTH = 1_200;
export const POSTCARD_HEIGHT = 675;

export interface PostcardMetadata {
  readonly market: string;
  readonly price: number | null;
  readonly provider: string;
  readonly capturedAt: number;
  readonly partyUrl?: string | null;
}

export interface PostcardCaptureOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly metadata: PostcardMetadata;
  readonly frame?: {
    readonly player: Readonly<THREE.Vector3>;
    readonly shrine: Readonly<THREE.Vector3>;
  };
  /** Hide remote labels/chat or other private overlays; returns a restore hook. */
  readonly beforeCapture?: () => (() => void) | void;
}

export interface PostcardCameraPose {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
}

export function calculatePostcardCamera(
  player: Readonly<THREE.Vector3>,
  shrine: Readonly<THREE.Vector3>,
): PostcardCameraPose {
  const separation = Math.hypot(player.x - shrine.x, player.z - shrine.z);
  const direction = new THREE.Vector3(player.x - shrine.x, 0, player.z - shrine.z);
  if (direction.lengthSq() < 0.01) direction.set(0.42, 0, 1);
  direction.normalize();
  const target = new THREE.Vector3(
    THREE.MathUtils.lerp(shrine.x, player.x, 0.42),
    Math.max(shrine.y, player.y) + 3.1,
    THREE.MathUtils.lerp(shrine.z, player.z, 0.42),
  );
  const distance = THREE.MathUtils.clamp(18 + separation * 0.72, 18, 78);
  const position = target.clone()
    .addScaledVector(direction, distance)
    .add(new THREE.Vector3(0, THREE.MathUtils.clamp(9 + separation * 0.16, 9, 22), 0));
  return { position, target };
}

export function flipRgbaRows(
  source: Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const target = new Uint8ClampedArray(source.length);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    target.set(source.subarray(y * stride, (y + 1) * stride), (height - y - 1) * stride);
  }
  return target;
}

export function formatPostcardPrice(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return '—';
  if (price >= 1_000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${price.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`;
}

export async function capturePostcard(options: PostcardCaptureOptions): Promise<Blob> {
  const { renderer, scene, camera } = options;
  const previousTarget = renderer.getRenderTarget();
  const previousAspect = camera.aspect;
  const previousPosition = camera.position.clone();
  const previousQuaternion = camera.quaternion.clone();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const target = new THREE.WebGLRenderTarget(POSTCARD_WIDTH, POSTCARD_HEIGHT, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const pixels = new Uint8Array(POSTCARD_WIDTH * POSTCARD_HEIGHT * 4);
  let restorePrivateState: (() => void) | undefined;

  try {
    restorePrivateState = options.beforeCapture?.() || undefined;
    camera.aspect = POSTCARD_WIDTH / POSTCARD_HEIGHT;
    if (options.frame) {
      const pose = calculatePostcardCamera(options.frame.player, options.frame.shrine);
      camera.position.copy(pose.position);
      camera.lookAt(pose.target);
    }
    camera.updateProjectionMatrix();
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, POSTCARD_WIDTH, POSTCARD_HEIGHT);
    renderer.setScissorTest(false);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, POSTCARD_WIDTH, POSTCARD_HEIGHT, pixels);
  } finally {
    restorePrivateState?.();
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    camera.aspect = previousAspect;
    camera.position.copy(previousPosition);
    camera.quaternion.copy(previousQuaternion);
    camera.updateProjectionMatrix();
    target.dispose();
  }

  const canvas = document.createElement('canvas');
  canvas.width = POSTCARD_WIDTH;
  canvas.height = POSTCARD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Postcard canvas is unavailable.');
  const image = context.createImageData(POSTCARD_WIDTH, POSTCARD_HEIGHT);
  image.data.set(flipRgbaRows(pixels, POSTCARD_WIDTH, POSTCARD_HEIGHT));
  context.putImageData(image, 0, 0);
  drawMetadata(context, options.metadata);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the postcard.')), 'image/png');
  });
}

function drawMetadata(context: CanvasRenderingContext2D, metadata: PostcardMetadata): void {
  const gradient = context.createLinearGradient(0, POSTCARD_HEIGHT - 190, 0, POSTCARD_HEIGHT);
  gradient.addColorStop(0, 'rgba(35, 47, 58, 0)');
  gradient.addColorStop(1, 'rgba(35, 47, 58, 0.76)');
  context.fillStyle = gradient;
  context.fillRect(0, POSTCARD_HEIGHT - 210, POSTCARD_WIDTH, 210);

  context.fillStyle = '#fff1cf';
  context.font = '700 42px Nunito, system-ui, sans-serif';
  context.fillText(`${metadata.market.toUpperCase()}  ${formatPostcardPrice(metadata.price)}`, 54, POSTCARD_HEIGHT - 76);
  context.font = '700 19px Nunito, system-ui, sans-serif';
  context.fillStyle = 'rgba(255, 241, 207, 0.88)';
  const provider = metadata.provider.toUpperCase();
  const timestamp = new Date(metadata.capturedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  context.fillText(`${provider} · ${timestamp}`, 56, POSTCARD_HEIGHT - 42);
  context.textAlign = 'right';
  context.font = '700 24px Nunito, system-ui, sans-serif';
  context.fillStyle = '#fff1cf';
  context.fillText('tickerworld.io', POSTCARD_WIDTH - 54, POSTCARD_HEIGHT - 74);
  if (metadata.partyUrl) {
    context.font = '700 14px Nunito, system-ui, sans-serif';
    context.fillStyle = 'rgba(255, 241, 207, 0.78)';
    context.fillText(metadata.partyUrl, POSTCARD_WIDTH - 54, POSTCARD_HEIGHT - 43, 500);
  }
  context.textAlign = 'left';
}
