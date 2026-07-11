import { defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { MARKET_ROOM_NAME } from '@tickerworld/shared';
import { createServer } from 'node:http';
import { configureHttp } from './http.js';
import type { ServerRuntime } from './runtime.js';
import { MarketRoom } from './rooms/MarketRoom.js';
import { TRUSTED_PEER_HEADER } from './services/canonicalIp.js';

const peerCaptureInstalled = new WeakSet<object>();

export function createServerApp(runtime: ServerRuntime) {
  const server = createServer();
  return defineServer({
    transport: new WebSocketTransport({ server }),
    rooms: {
      [MARKET_ROOM_NAME]: defineRoom(MarketRoom)
        .filterBy(['market'])
        .sortBy({ clients: -1 }),
    },
    express: (app) => configureHttp(app, runtime),
  });
}

/**
 * Colyseus' Fetch-based matchmaking context does not expose the raw Node
 * socket. Install this before listen() so our listener is present before the
 * server can accept traffic. The new-listener hook keeps it first if
 * Colyseus subsequently prepends its router.
 */
export function installTrustedPeerCapture(app: ReturnType<typeof createServerApp>): boolean {
  const server = app.transport?.server;
  if (!server) return false;
  if (peerCaptureInstalled.has(server)) return true;
  peerCaptureInstalled.add(server);
  const capture = (request: import('node:http').IncomingMessage): void => {
    const peer = request.socket.remoteAddress;
    if (peer) request.headers[TRUSTED_PEER_HEADER] = peer;
    else delete request.headers[TRUSTED_PEER_HEADER];
  };
  let reorderQueued = false;
  server.on('newListener', (event, listener) => {
    if (event !== 'request' || listener === capture || reorderQueued) return;
    reorderQueued = true;
    queueMicrotask(() => {
      reorderQueued = false;
      server.removeListener('request', capture);
      server.prependListener('request', capture);
    });
  });
  server.prependListener('request', capture);
  return true;
}
