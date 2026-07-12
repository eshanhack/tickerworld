import app, { runtime } from './app.config.js';
import { installTrustedPeerCapture } from './app.js';

let disposed = false;
app.onBeforeShutdown(async () => {
  if (disposed) return;
  disposed = true;
  await runtime.dispose();
});

type IpcProcess = NodeJS.Process & {
  send?: (message: unknown, ...args: unknown[]) => boolean;
};
const ipcProcess = process as IpcProcess;
const originalSend = ipcProcess.send?.bind(process);
const peerCaptureReady = installTrustedPeerCapture(app);
if (runtime.config.nodeEnv === 'production' && !peerCaptureReady) {
  throw new Error('Production transport does not expose a trusted peer capture hook');
}
// @colyseus/tools emits `ready` as soon as its socket binds on Cloud. Hold that
// one message until the listening socket is ready; trusted-peer capture was
// installed above, before the server could accept traffic. All other IPC
// continues to flow normally.
if (process.env.COLYSEUS_CLOUD !== undefined && originalSend) {
  ipcProcess.send = (message: unknown, ...args: unknown[]): boolean => (
    message === 'ready' ? true : originalSend(message, ...args)
  );
}
try {
  await app.listen(runtime.config.port);
} finally {
  if (originalSend) ipcProcess.send = originalSend;
}
runtime.logger.info('server_listening', { port: runtime.config.port, status: 'ready' });
// PM2's wait_ready gate must not release traffic until configuration,
// migrations, provider initialization, and the listening socket all succeed.
originalSend?.('ready');
