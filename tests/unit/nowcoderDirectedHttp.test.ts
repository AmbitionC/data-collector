import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  APP_VERSION,
  TRUSTED_EXTENSION_ID,
  type NowcoderSearchCandidate,
  type WsEnvelope,
} from '@data-collector/shared';
import { loadConfig } from '../../packages/bridge/src/config.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/server/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const BUILD = 'v0.4.33 · abcdef1';
const RUNTIME_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '0123456789abcdef';
const OTHER_ATTEMPT = 'fedcba9876543210';
const CANDIDATE_URL = 'https://www.nowcoder.com/feed/main/detail/http-candidate';
const temporaryDirectories = createTemporaryDirectoryTracker();
const bridges: BridgeHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(bridges.splice(0).map(async bridge => await bridge.close()));
  await temporaryDirectories.cleanup();
});

function candidate(): NowcoderSearchCandidate {
  return {
    id: 'candidate-http',
    canonicalUrl: CANDIDATE_URL,
    contentType: 'post',
    matchedQueries: ['Agent'],
    page: 1,
    rank: 1,
    publishedAt: '2026-08-29T00:00:00.000Z',
  };
}

function searchResponse(records: Array<{ url: string; createTime: number }>): Response {
  return Response.json({
    success: true,
    code: 0,
    data: { totalPage: 1, records: records.map(contentData => ({ contentData })) },
  });
}

function envelope<T>(type: string, requestId: string, payload: T): string {
  return JSON.stringify({
    protocolVersion: 1,
    type,
    requestId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

async function nextMessage<T>(socket: WebSocket): Promise<WsEnvelope<string, T>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 5_000);
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('message', data => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as WsEnvelope<string, T>);
    });
  });
}

async function waitForMessageType(socket: WebSocket, type: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${type} timeout`)), 5_000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as WsEnvelope;
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve();
    };
    socket.on('message', onMessage);
  });
}

async function authorizeOnly(bridge: BridgeHandle): Promise<{ socket: WebSocket; token: string }> {
  const socket = new WebSocket(`${bridge.wsUrl}?bootstrap=1`, {
    origin: `chrome-extension://${TRUSTED_EXTENSION_ID}`,
  });
  sockets.push(socket);
  const authorized = await nextMessage<{ token: string }>(socket);
  return { socket, token: authorized.payload.token };
}

async function connectDirected(bridge: BridgeHandle): Promise<{ socket: WebSocket; token: string }> {
  const { socket, token } = await authorizeOnly(bridge);
  const barrier = waitForMessageType(socket, 'bridge.pong');
  socket.send(envelope('extension.hello', 'http-hello', {
    version: APP_VERSION,
    buildId: BUILD,
    runtimeId: RUNTIME_ID,
    capabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
  }));
  socket.send(envelope('bridge.ping', 'http-hello-barrier', {}));
  await barrier;
  return { socket, token };
}

async function request(
  bridge: BridgeHandle,
  token: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${bridge.url}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

async function createStoredSession(
  root: string,
  configDir: string,
): Promise<{ store: NowcoderDirectedStore; sessionId: string }> {
  const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
  const now = new Date();
  const createdAt = now.toISOString();
  const store = await NowcoderDirectedStore.open(
    join(config.configDir, 'nowcoder-directed.json'),
    { now: () => createdAt, id: () => 'source-run', attempt: () => ATTEMPT },
  );
  const sessionId = 'session-http';
  await store.createSession({
    id: sessionId,
    queries: ['Agent'],
    queryHash: 'a'.repeat(64),
    requestedSort: 'latest',
    provider: 'nowcoder-json',
    sortVerified: true,
    createdAt,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    candidates: [candidate()],
  }, { target: 1 });
  return { store, sessionId };
}

describe('minimal directed Nowcoder HTTP routes', () => {
  it('keeps preview/session routes behind bearer auth and redacts search failures', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-http-preview-');
    const configDir = join(root, '.config');
    const privateFailure = `${root}/private-token-value`;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query === 'fail') throw new Error(privateFailure);
      return searchResponse([{ url: CANDIDATE_URL, createTime: Date.parse('2026-08-29T00:00:00.000Z') }]);
    });
    const bridge = await startBridge({ libraryRoot: root, configDir, port: 0, fetch: fetcher });
    bridges.push(bridge);
    const { token } = await authorizeOnly(bridge);
    const input = JSON.stringify({ queries: [' Agent '], target: 1, sort: 'latest' });

    const unauthorized = await request(bridge, undefined, '/v1/nowcoder/search-sessions', {
      method: 'POST', body: input,
    });
    expect(unauthorized.response.status).toBe(401);
    expect(unauthorized.body).toEqual({ error: { code: 'UNAUTHORIZED', message: '访问令牌无效' } });

    const created = await request(bridge, token, '/v1/nowcoder/search-sessions', {
      method: 'POST', body: input,
    });
    expect(created.response.status).toBe(201);
    const session = created.body.session as { id: string; candidates: unknown[] };
    expect(session.candidates).toHaveLength(1);
    const loaded = await request(
      bridge,
      token,
      `/v1/nowcoder/search-sessions/${encodeURIComponent(session.id)}`,
    );
    expect(loaded.response.status).toBe(200);
    expect(loaded.body).toEqual(created.body);

    const missing = await request(bridge, token, '/v1/nowcoder/search-sessions/missing');
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({
      error: { code: 'NOWCODER_SESSION_NOT_FOUND', message: '牛客搜索会话不存在' },
    });

    const failed = await request(bridge, token, '/v1/nowcoder/search-sessions', {
      method: 'POST',
      body: JSON.stringify({ queries: ['fail'], target: 1, sort: 'latest' }),
    });
    expect(failed.response.status).toBe(503);
    expect(failed.body).toEqual({
      error: { code: 'NOWCODER_SEARCH_UNAVAILABLE', message: '牛客最新搜索暂时不可用' },
    });
    expect(JSON.stringify(failed.body)).not.toContain(privateFailure);
  });

  it('starts/replays/reads a run and cancels only its exact attempt', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-http-run-');
    const configDir = join(root, '.config');
    const { sessionId } = await createStoredSession(root, configDir);
    const bridge = await startBridge({
      libraryRoot: root,
      configDir,
      port: 0,
      repoRoot: root,
      enableAutoUpdate: false,
      readArtifactBuildId: async () => BUILD,
    });
    bridges.push(bridge);
    const { token } = await connectDirected(bridge);
    const startBody = JSON.stringify({
      searchSessionId: sessionId,
      selectedCandidateIds: ['candidate-http'],
      idempotencyKey: 'http-start-key',
      deliveryAuthorized: true,
    });

    const started = await request(bridge, token, '/v1/nowcoder/runs', {
      method: 'POST', body: startBody,
    });
    expect(started.response.status).toBe(202);
    const run = started.body.run as { id: string; attempt: string };
    const replay = await request(bridge, token, '/v1/nowcoder/runs', {
      method: 'POST', body: startBody,
    });
    expect(replay.response.status).toBe(200);
    expect((replay.body.run as { id: string }).id).toBe(run.id);
    const loaded = await request(bridge, token, `/v1/nowcoder/runs/${encodeURIComponent(run.id)}`);
    expect(loaded.response.status).toBe(200);
    expect((loaded.body.run as { id: string }).id).toBe(run.id);

    const stale = await request(
      bridge,
      token,
      `/v1/nowcoder/runs/${encodeURIComponent(run.id)}/cancel`,
      { method: 'POST', body: JSON.stringify({ attempt: OTHER_ATTEMPT }) },
    );
    expect(stale.response.status).toBe(409);
    expect(stale.body).toEqual({
      error: { code: 'NOWCODER_ATTEMPT_STALE', message: '牛客定向运行尝试已过期' },
    });

    const cancelled = await request(
      bridge,
      token,
      `/v1/nowcoder/runs/${encodeURIComponent(run.id)}/cancel`,
      { method: 'POST', body: JSON.stringify({ attempt: run.attempt }) },
    );
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.body.run).toMatchObject({ id: run.id, attempt: run.attempt, status: 'cancelling' });
  });

  it('retries a terminal exact run with 202/200 idempotency semantics', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-http-retry-');
    const configDir = join(root, '.config');
    const { store, sessionId } = await createStoredSession(root, configDir);
    const source = await store.startRun({
      searchSessionId: sessionId,
      selectedCandidateIds: [],
      idempotencyKey: 'source-key',
      deliveryAuthorized: true,
    }, {
      buildEvidence: {
        applicationVersion: APP_VERSION,
        bridgeBuildId: BUILD,
        artifactBuildId: BUILD,
        extensionVersion: APP_VERSION,
        extensionBuildId: BUILD,
        extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
        frozenAt: new Date().toISOString(),
      },
      runtimeId: RUNTIME_ID,
    });
    await store.beginCancellationCurrent(source.id, source.attempt);
    await store.completeCancellationCurrent(source.id, source.attempt, 0);
    const bridge = await startBridge({
      libraryRoot: root,
      configDir,
      port: 0,
      repoRoot: root,
      enableAutoUpdate: false,
      readArtifactBuildId: async () => BUILD,
    });
    bridges.push(bridge);
    const { token } = await connectDirected(bridge);
    const retryBody = JSON.stringify({ idempotencyKey: 'retry-key' });

    const retried = await request(
      bridge,
      token,
      `/v1/nowcoder/runs/${encodeURIComponent(source.id)}/retry`,
      { method: 'POST', body: retryBody },
    );
    expect(retried.response.status).toBe(202);
    const retryRun = retried.body.run as { id: string };
    expect(retryRun.id).not.toBe(source.id);
    const replay = await request(
      bridge,
      token,
      `/v1/nowcoder/runs/${encodeURIComponent(source.id)}/retry`,
      { method: 'POST', body: retryBody },
    );
    expect(replay.response.status).toBe(200);
    expect((replay.body.run as { id: string }).id).toBe(retryRun.id);
  });

  it('returns a redacted 503 when directed state is unavailable', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-http-unavailable-');
    const configDir = join(root, '.config');
    const privateState = `${root}/private-directed-state`;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'nowcoder-directed.json'), JSON.stringify({ privateState }), 'utf8');
    const bridge = await startBridge({ libraryRoot: root, configDir, port: 0 });
    bridges.push(bridge);
    const { token } = await authorizeOnly(bridge);

    const result = await request(bridge, token, '/v1/nowcoder/runs/missing');

    expect(result.response.status).toBe(503);
    expect(result.body).toEqual({
      error: { code: 'NOWCODER_DIRECTED_UNAVAILABLE', message: '牛客定向服务暂时不可用' },
    });
    expect(JSON.stringify(result.body)).not.toContain(privateState);
    expect(JSON.stringify(result.body)).not.toContain(root);
  });
});
