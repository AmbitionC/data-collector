import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { WebSocket, type RawData } from 'ws';
import {
  APP_VERSION,
  EXTENSION_REPLACED_CLOSE_CODE,
  EXTENSION_REPLACED_CLOSE_REASON,
  TRUSTED_EXTENSION_ID,
  bridgeAuthorizedPayloadSchema,
  jobResultPayloadSchema,
  wsEnvelopeSchema,
  type CollectedDocument,
  type JobRecord,
  type WsEnvelope,
} from '@data-collector/shared';
import { AccessTokenManager } from '../auth.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { JobStore } from '../jobs/store.js';
import type { ResolveAddresses } from '../library/assets.js';
import { organize } from '../organize/index.js';
import { loadSinksConfig, SinkRouter } from '../sinks/index.js';
import { attachExtensionWebSocket } from './websocket.js';
import { bearerToken, HttpError, isLoopback, readJson, sendJson } from './http.js';

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
const revealSchema = z.object({ path: z.string().trim().min(1).max(4096) });

export interface StartBridgeOptions extends ConfigOverrides {
  fetch?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  reveal?: (path: string) => Promise<void>;
}

export interface BridgeHandle {
  url: string;
  wsUrl: string;
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

async function defaultReveal(path: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', path]]
      : process.platform === 'win32'
        ? ['explorer.exe', [`/select,${path}`]]
        : ['xdg-open', [dirname(path)]];
  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveSpawn();
    });
  });
}

async function verifiedLibraryPath(root: string, requestedPath: string): Promise<string> {
  const candidate = resolve(requestedPath);
  const lexicalRelative = relative(root, candidate);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new HttpError(400, 'INVALID_LIBRARY_PATH', '只能打开知识库内的文件');
  }
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    const realRelative = relative(realRoot, realCandidate);
    if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
      throw new HttpError(400, 'INVALID_LIBRARY_PATH', '路径通过符号链接离开了知识库');
    }
    return candidate;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_LIBRARY_PATH', '知识库文件不存在');
  }
}

export async function startBridge(options: StartBridgeOptions = {}): Promise<BridgeHandle> {
  const config = loadConfig(options);
  const access = await AccessTokenManager.open(config.authFile);
  const jobs = await JobStore.open(config.jobsFile);
  await jobs.recover();
  const sinksConfig = await loadSinksConfig(config.sinksFile);
  const router = SinkRouter.build(
    sinksConfig,
    {
      libraryRoot: config.libraryRoot,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
    },
    message => console.warn(`[sinks] ${message}`),
  );
  const reveal = options.reveal ?? defaultReveal;
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
      if (
        job.status === 'dispatched' ||
        (job.status === 'queued' && job.requestedBy === 'extension')
      ) {
        await jobs.transition(job.id, 'collecting');
      }
      return;
    }
    if (parsedEnvelope.type === 'job.result') {
      if (job.status === 'saved') return;
      const result = jobResultPayloadSchema.parse(parsedEnvelope.payload);
      if (result.document.canonicalUrl !== job.url) {
        throw new Error('回传内容 URL 与采集任务不一致');
      }
      if (job.status === 'dispatched') await jobs.transition(job.id, 'collecting');
      const sinkResults = await router.save(organize(result.document as CollectedDocument));
      const succeeded = sinkResults.filter(sinkResult => sinkResult.ok);
      if (succeeded.length === 0) {
        const detail = sinkResults
          .map(sinkResult => `${sinkResult.sinkId}: ${sinkResult.detail?.error ?? '失败'}`)
          .join('；');
        throw new Error(`所有落地目标均失败：${detail || '无可用目标'}`);
      }
      const primary = succeeded[0]!;
      await jobs.transition(job.id, 'saved', { outputPath: primary.outputRef });
      socket.send(
        JSON.stringify(
          envelope('job.saved', job.id, { outputPath: primary.outputRef, results: sinkResults }),
        ),
      );
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
        version: APP_VERSION,
        trustedExtensionId: TRUSTED_EXTENSION_ID,
        extensionConnected: extensionReady && extensionSocket?.readyState === WebSocket.OPEN,
        routes: router.describeRoutes(),
      });
    }
    const jobMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    const isProtectedRoute =
      (request.method === 'POST' && requestUrl.pathname === '/v1/jobs') ||
      (request.method === 'POST' && requestUrl.pathname === '/v1/reveal') ||
      (request.method === 'GET' && Boolean(jobMatch?.[1]));
    if (!isProtectedRoute) throw new HttpError(404, 'NOT_FOUND', '接口不存在');

    const token = bearerToken(request) ?? '';
    if (!access.verify(token)) throw new HttpError(401, 'UNAUTHORIZED', '访问令牌无效');

    if (request.method === 'POST' && requestUrl.pathname === '/v1/jobs') {
      const input = createJobSchema.parse(await readJson(request));
      const job = await jobs.create({
        url: input.url,
        requestedBy: input.requestedBy,
        ...(input.id ? { id: input.id } : {}),
      });
      sendJson(response, 202, job);
      if (job.requestedBy !== 'extension') await dispatch(job);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/reveal') {
      const input = revealSchema.parse(await readJson(request));
      const path = await verifiedLibraryPath(config.libraryRoot, input.path);
      await reveal(path);
      return sendJson(response, 200, { ok: true });
    }
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
    access,
    onConnection: (socket, authorization) => {
      if (authorization.bootstrapToken) {
        socket.send(
          JSON.stringify(
            envelope(
              'bridge.authorized',
              'authorization',
              bridgeAuthorizedPayloadSchema.parse({ token: authorization.bootstrapToken }),
            ),
          ),
        );
      }
      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        extensionSocket.close(
          EXTENSION_REPLACED_CLOSE_CODE,
          EXTENSION_REPLACED_CLOSE_REASON,
        );
      }
      extensionSocket = socket;
      extensionReady = false;
      let messageQueue: Promise<void> = Promise.resolve();
      let policyViolated = false;
      socket.on('message', data => {
        messageQueue = messageQueue
          .then(() => handleSocketMessage(socket, data))
          .catch(error => {
            if (policyViolated) return;
            policyViolated = true;
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify(
                  envelope('protocol.error', 'protocol', {
                    code: 'INVALID_MESSAGE',
                    message: error instanceof Error ? error.message : '消息无效',
                  }),
                ),
              );
              socket.close(1008, 'invalid protocol message');
            }
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
    async close() {
      extensionSocket?.close(1001, 'server shutdown');
      websocketServer.close();
      server.close();
      await once(server, 'close');
    },
  };
}
