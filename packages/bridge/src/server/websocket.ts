import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PairingManager } from '../auth.js';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function attachExtensionWebSocket(options: {
  server: HttpServer;
  pairing: PairingManager;
  onConnection: (socket: WebSocket) => void;
}): WebSocketServer {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  options.server.on('upgrade', (request, socket, head) => {
    const host = request.headers.host ?? '127.0.0.1';
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname !== '/v1/extension') return reject(socket, 404, 'Not Found');
    const token = url.searchParams.get('token') ?? '';
    const origin = request.headers.origin ?? '';
    if (!EXTENSION_ORIGIN.test(origin) || !options.pairing.verify(token)) {
      return reject(socket, 401, 'Unauthorized');
    }
    websocketServer.handleUpgrade(request, socket, head, websocket => {
      websocketServer.emit('connection', websocket, request);
    });
  });
  websocketServer.on('connection', options.onConnection);
  return websocketServer;
}
