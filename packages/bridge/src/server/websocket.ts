import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { TRUSTED_EXTENSION_ORIGINS } from '@data-collector/shared';
import type { AccessTokenManager } from '../auth.js';

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function attachExtensionWebSocket(options: {
  server: HttpServer;
  access: AccessTokenManager;
  onConnection: (socket: WebSocket, authorization: { bootstrapToken?: string }) => void;
}): WebSocketServer {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  options.server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const host = request.headers.host ?? '127.0.0.1';
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname !== '/v1/extension') return reject(socket, 404, 'Not Found');
      const origin = request.headers.origin ?? '';
      if (!TRUSTED_EXTENSION_ORIGINS.has(origin)) return reject(socket, 401, 'Unauthorized');

      const token = url.searchParams.get('token') ?? '';
      let bootstrapToken: string | undefined;
      if (!options.access.verify(token)) {
        if (url.searchParams.get('bootstrap') !== '1') return reject(socket, 401, 'Unauthorized');
        bootstrapToken = await options.access.ensureToken();
      }

      websocketServer.handleUpgrade(request, socket, head, websocket => {
        websocketServer.emit('connection', websocket, request);
        options.onConnection(websocket, { ...(bootstrapToken ? { bootstrapToken } : {}) });
      });
    })().catch(() => {
      if (!socket.destroyed) reject(socket, 500, 'Internal Server Error');
    });
  });
  return websocketServer;
}
