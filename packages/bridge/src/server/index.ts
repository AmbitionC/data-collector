import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { WebSocket, type RawData } from 'ws';
import {
  jobResultPayloadSchema,
  wsEnvelopeSchema,
  type CollectedDocument,
  type JobRecord,
  type WsEnvelope,
} from '@data-collector/shared';
import { PairingManager } from '../auth.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { JobStore } from '../jobs/store.js';
import { MarkdownLibrary } from '../library/index.js';
import { organize } from '../organize/index.js';
import { attachExtensionWebSocket } from './websocket.js';
import { bearerToken, HttpError, isLoopback, readJson, sendJson } from './http.js';

const pairSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const createJobSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  url: z.string().url().max(4096),
  requestedBy: z.enum(['codex', 'cli', 'extension']).default('cli'),
});
const progressSchema = z.object({ stage: z.enum(['collecting']) });
const errorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1000),
  needsAttention: z.boolean().optional(),
});

export interface StartBridgeOptions extends ConfigOverrides {
  fetch?: typeof fetch;
}

export interface BridgeHandle {
  url: string;
  wsUrl: string;
  pairingCode: string;
  close(): Promise<void>;
}

function envelope<T>(type: string, requestId: string, payload: T): WsEnvelope<string, T> {
  return {
    protocolVersion: 1,
    type,
    requestId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function messageText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

export async function startBridge(options: StartBridgeOptions = {}): Promise<BridgeHandle> {
  const config = loadConfig(options);
  const pairing = await PairingManager.open(config.authFile);
  const pairingCode = pairing.createPairingCode().code;
  const jobs = await JobStore.open(config.jobsFile);
  await jobs.recover();
  const library = new MarkdownLibrary({
    root: config.libraryRoot,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let extensionSocket: WebSocket | undefined;
  let extensionReady = false;

  const dispatch = async (job: JobRecord): Promise<void> => {
    if (!extensionReady || extensionSocket?.readyState !== WebSocket.OPEN || job.status !== 'queued') return;
    await jobs.transition(job.id, 'dispatched');
    extensionSocket.send(JSON.stringify(envelope('job.collect', job.id, { url: job.url })));
  };

  const dispatchQueued = async (): Promise<void> => {
    for (const job of jobs.list('queued')) await dispatch(job);
  };

  const handleSocketMessage = async (socket: WebSocket, data: RawData): Promise<void> => {
    const parsedEnvelope = wsEnvelopeSchema.parse(JSON.parse(messageText(data)));
    if (parsedEnvelope.type === 'extension.hello') {
      if (!extensionReady) await jobs.recover();
      extensionReady = true;
      await dispatchQueued();
      return;
    }
    if (parsedEnvelope.type === 'bridge.ping') {
      socket.send(JSON.stringify(envelope('bridge.pong', parsedEnvelope.requestId, {})));
      return;
    }
    const job = jobs.get(parsedEnvelope.requestId);
    if (!job) throw new Error(`任务不存在：${parsedEnvelope.requestId}`);
    if (parsedEnvelope.type === 'job.progress') {
      progressSchema.parse(parsedEnvelope.payload);
      if (job.status === 'dispatched') await jobs.transition(job.id, 'collecting');
      return;
    }
    if (parsedEnvelope.type === 'job.result') {
      if (job.status === 'saved') return;
      const result = jobResultPayloadSchema.parse(parsedEnvelope.payload);
      if (job.status === 'dispatched') await jobs.transition(job.id, 'collecting');
      const saved = await library.save(organize(result.document as CollectedDocument));
      await jobs.transition(job.id, 'saved', { outputPath: saved.markdownPath });
      socket.send(JSON.stringify(envelope('job.saved', job.id, saved)));
      return;
    }
    if (parsedEnvelope.type === 'job.error') {
      const error = errorSchema.parse(parsedEnvelope.payload);
      const status = error.needsAttention ? 'needs_attention' : 'failed';
      await jobs.transition(job.id, status, {
        errorCode: error.code,
        errorMessage: error.message,
      });
      return;
    }
    throw new Error(`不支持的 WebSocket 消息：${parsedEnvelope.type}`);
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopback(request)) throw new HttpError(403, 'LOOPBACK_ONLY', '只允许本机访问');
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      return sendJson(response, 200, {
        ok: true,
        version: '0.1.0',
        extensionConnected: extensionReady && extensionSocket?.readyState === WebSocket.OPEN,
      });
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/pair') {
      const input = pairSchema.parse(await readJson(request));
      return sendJson(response, 200, { token: await pairing.exchange(input.code) });
    }
    const token = bearerToken(request) ?? '';
    if (!pairing.verify(token)) throw new HttpError(401, 'UNAUTHORIZED', '访问令牌无效');

    if (request.method === 'POST' && requestUrl.pathname === '/v1/jobs') {
      const input = createJobSchema.parse(await readJson(request));
      const job = await jobs.create({
        url: input.url,
        requestedBy: input.requestedBy,
        ...(input.id ? { id: input.id } : {}),
      });
      sendJson(response, 202, job);
      await dispatch(job);
      return;
    }
    const jobMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (request.method === 'GET' && jobMatch?.[1]) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在');
      return sendJson(response, 200, job);
    }
    throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  };

  const server = createServer((request, response) => {
    void route(request, response).catch(error => {
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const code = error instanceof HttpError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : '未知错误';
      sendJson(response, status, { error: { code, message } });
    });
  });

  const websocketServer = attachExtensionWebSocket({
    server,
    pairing,
    onConnection: socket => {
      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        extensionSocket.close(1012, 'replaced');
      }
      extensionSocket = socket;
      extensionReady = false;
      socket.on('message', data => {
        void handleSocketMessage(socket, data).catch(error => {
          socket.send(
            JSON.stringify(
              envelope('protocol.error', 'protocol', {
                code: 'INVALID_MESSAGE',
                message: error instanceof Error ? error.message : '消息无效',
              }),
            ),
          );
        });
      });
      socket.once('close', () => {
        if (extensionSocket === socket) {
          extensionSocket = undefined;
          extensionReady = false;
        }
      });
    },
  });

  server.listen(config.port, config.host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const url = `http://${config.host}:${address.port}`;
  return {
    url,
    wsUrl: `ws://${config.host}:${address.port}/v1/extension`,
    pairingCode,
    async close() {
      extensionSocket?.close(1001, 'server shutdown');
      websocketServer.close();
      server.close();
      await once(server, 'close');
    },
  };
}
