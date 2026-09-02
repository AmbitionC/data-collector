import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION,
  EXTENSION_REPLACED_CLOSE_CODE,
  EXTENSION_REPLACED_CLOSE_REASON,
  TRUSTED_EXTENSION_ID,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  type CollectionBatch,
  type CollectedDocument,
  type WsEnvelope,
} from '@data-collector/shared';
import {
  startBridge,
  type BridgeHandle,
} from '../../packages/bridge/src/index.js';
import { loadConfig } from '../../packages/bridge/src/config.js';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import { CollectionPlanStore } from '../../packages/bridge/src/plans/store.js';
import { CollectionPlanService } from '../../packages/bridge/src/plans/service.js';
import { acquireArtifactLease } from '../../scripts/artifact-lease.mjs';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const URL = 'https://mp.weixin.qq.com/s/integration-test';
const EXTENSION_ORIGIN = `chrome-extension://${TRUSTED_EXTENSION_ID}`;
const handles: BridgeHandle[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories = createTemporaryDirectoryTracker();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function temporaryDirectory(): Promise<string> {
  return temporaryDirectories.create('data-collector-bridge-');
}

function document(overrides: Partial<CollectedDocument> = {}): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'wechat',
    kind: 'article',
    url: URL,
    canonicalUrl: URL,
    title: 'Bridge 集成测试文章',
    author: '测试公众号',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: '<p>Bridge 收到浏览器回传后，会清洗、归纳并写入本地 Markdown 知识库。</p>',
    text: 'Bridge 收到浏览器回传后，会清洗、归纳并写入本地 Markdown 知识库。',
    images: [],
    ...overrides,
  };
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function connect(bridge: BridgeHandle, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`${bridge.wsUrl}?token=${encodeURIComponent(token)}`, {
    origin: EXTENSION_ORIGIN,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function nextMessage<T>(socket: WebSocket): Promise<WsEnvelope<string, T>> {
  return new Promise((resolve, reject) => {
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

async function expectNoMessage(socket: WebSocket, milliseconds = 150): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected WebSocket message: ${data.toString()}`));
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, milliseconds);
    socket.once('message', onMessage);
  });
}

async function waitForExtensionReady(bridge: BridgeHandle): Promise<void> {
  await vi.waitFor(async () => {
    const health = await requestJson<{ extensionConnected: boolean }>(bridge.url, '/health');
    expect(health.body.extensionConnected).toBe(true);
  });
}

async function authorize(
  bridge: BridgeHandle,
  origin = `chrome-extension://${TRUSTED_EXTENSION_ID}`,
): Promise<{ socket: WebSocket; token: string }> {
  const socket = new WebSocket(`${bridge.wsUrl}?bootstrap=1`, { origin });
  sockets.push(socket);
  const message = await nextMessage<{ token: string }>(socket);
  expect(message.type).toBe('bridge.authorized');
  return { socket, token: message.payload.token };
}

async function expectWebSocketRejected(
  bridge: BridgeHandle,
  query: string,
  origin: string,
): Promise<void> {
  const socket = new WebSocket(`${bridge.wsUrl}${query}`, { origin });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error(`Unexpected WebSocket connection for ${origin}`)));
    socket.once('error', reject);
  });
  expect(status).toBe(401);
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

function dailyLedgerFacts(
  payload: { zsxqMode?: string; targetDays?: string[] },
  qualifying = 0,
): Record<string, unknown> {
  const mode = payload.zsxqMode === 'owner-history' ? 'owner-history' : 'daily-ledger';
  const targetDays = payload.targetDays ?? [];
  return {
    checkpoint: { mode, pagesFetched: 1, exhausted: true },
    dayDrafts: targetDays.map(day => ({
      day,
      rawOwnerCount: qualifying,
      qualifyingCount: qualifying,
      filteredCount: 0,
      exactDuplicateCount: qualifying,
      semanticDuplicateCount: 0,
      knownCompleteCount: qualifying,
      repairCount: 0,
      candidateCount: 0,
      savedCount: 0,
      failedCount: 0,
      crossedDayBoundary: true,
    })),
    ownerAudit: {
      mode,
      pagesFetched: 1,
      observed: qualifying,
      qualifying,
      exactDuplicates: qualifying,
      semanticDuplicates: 0,
      filtered: 0,
      knownComplete: qualifying,
      repaired: 0,
      saved: 0,
      failed: 0,
      exhausted: true,
      safetyCapReached: false,
      completedDays: qualifying > 0 ? targetDays.length : 0,
      emptyDays: qualifying > 0 ? 0 : targetDays.length,
      failedDays: 0,
    },
  };
}

function acknowledgePlanStart(
  socket: WebSocket,
  command: WsEnvelope<string, { batchId: string; attempt: string; planId?: string }>,
): void {
  socket.send(envelope('plan.started', command.requestId, {
    planId: command.payload.planId ?? 'zsxq-chen-teacher',
    batchId: command.payload.batchId,
    attempt: command.payload.attempt,
  }));
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const handle of handles.splice(0)) await handle.close();
  await temporaryDirectories.cleanup();
});

describe('local Bridge', () => {
  it('reports the connected extension version and exact running build only while it is online', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
    });
    handles.push(bridge);
    const { socket } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension-version', {
      version: '0.4.29',
      buildId: 'v0.4.29 · abc1234',
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));

    await vi.waitFor(async () => {
      const health = await requestJson<{
        extensionConnected: boolean;
        extensionVersion?: string;
        extensionBuildId?: string;
        extensionCapabilities?: string[];
      }>(bridge.url, '/health');
      expect(health.body).toMatchObject({
        extensionConnected: true,
        extensionVersion: '0.4.29',
        extensionBuildId: 'v0.4.29 · abc1234',
        extensionCapabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
      });
    });

    socket.close();
    await vi.waitFor(async () => {
      const health = await requestJson<{
        extensionConnected: boolean;
        extensionVersion?: string;
        extensionBuildId?: string;
        extensionCapabilities?: string[];
      }>(bridge.url, '/health');
      expect(health.body.extensionConnected).toBe(false);
      expect(health.body.extensionVersion).toBeUndefined();
      expect(health.body.extensionBuildId).toBeUndefined();
      expect(health.body.extensionCapabilities).toBeUndefined();
    });
  });

  it('does not let a replaced socket overwrite the current extension runtime after async recovery', async () => {
    let releaseRecovery!: () => void;
    const blockedRecovery = new Promise<void>(resolve => { releaseRecovery = resolve; });
    const originalRecover = JobStore.prototype.recover;
    const recoverSpy = vi.spyOn(JobStore.prototype, 'recover')
      .mockImplementation(function (this: JobStore) { return originalRecover.call(this); })
      // startBridge 自身先恢复一次；阻塞的是旧 socket 的 hello 恢复。
      .mockImplementationOnce(function (this: JobStore) { return originalRecover.call(this); })
      .mockImplementationOnce(() => blockedRecovery);
    try {
      const root = await temporaryDirectory();
      const bridge = await startBridge({
        port: 0,
        libraryRoot: root,
        configDir: join(root, '.config'),
      });
      handles.push(bridge);
      const legacy = await authorize(bridge);
      legacy.socket.send(envelope('extension.hello', 'blocked-legacy-hello', {
        version: '0.4.28',
        buildId: 'v0.4.28 · legacy',
      }));
      await vi.waitFor(() => expect(recoverSpy).toHaveBeenCalledTimes(2));

      const current = await connect(bridge, legacy.token);
      current.send(envelope('extension.hello', 'current-hello', {
        version: APP_VERSION,
        buildId: `v${APP_VERSION} · current`,
      }));
      await vi.waitFor(async () => {
        const health = await requestJson<{
          extensionVersion?: string;
          extensionBuildId?: string;
        }>(bridge.url, '/health');
        expect(health.body).toMatchObject({
          extensionVersion: APP_VERSION,
          extensionBuildId: `v${APP_VERSION} · current`,
        });
      });

      releaseRecovery();
      await new Promise(resolve => setTimeout(resolve, 50));
      const health = await requestJson<{
        extensionVersion?: string;
        extensionBuildId?: string;
      }>(bridge.url, '/health');
      expect(health.body).toMatchObject({
        extensionVersion: APP_VERSION,
        extensionBuildId: `v${APP_VERSION} · current`,
      });
    } finally {
      releaseRecovery();
      recoverSpy.mockRestore();
    }
  });

  it('finishes one slow result exactly once when the extension socket is replaced mid-persist', async () => {
    let releaseImage!: () => void;
    let markImageStarted!: () => void;
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise<void>(resolve => { markImageStarted = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      markImageStarted();
      await imageGate;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    });
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
      fetch: fetcher,
      resolveAddresses: async () => ['93.184.216.34'],
    });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'slow-result-first', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/899999999999999';
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: { url: topicUrl, requestedBy: 'extension' },
    });
    first.socket.send(envelope('job.progress', created.body.id, { stage: 'collecting' }));
    first.socket.send(envelope('job.result', created.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '慢图片入库竞态',
        html: '<p>完整正文</p><img src="https://images.example/slow.png">',
        text: '完整正文',
        images: [{ url: 'https://images.example/slow.png' }],
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        },
      }),
    }));
    await imageStarted;

    const replacement = await connect(bridge, first.token);
    const replacementMessages: Array<{ type?: string; requestId?: string }> = [];
    replacement.on('message', data => {
      replacementMessages.push(JSON.parse(data.toString()) as { type?: string; requestId?: string });
    });
    replacement.send(envelope('extension.hello', 'slow-result-replacement', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    releaseImage();

    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string; outputPath?: string }>(
        bridge.url,
        `/v1/jobs/${created.body.id}`,
        { token: first.token },
      );
      expect(job.body.status).toBe('saved');
      expect(job.body.outputPath).toMatch(/index\.md$/);
    });
    await waitForExtensionReady(bridge);
    expect(replacementMessages).not.toContainEqual(expect.objectContaining({
      type: 'job.collect',
      requestId: created.body.id,
    }));
    await vi.waitFor(() => {
      expect(replacementMessages).toContainEqual(expect.objectContaining({
        type: 'job.saved',
        requestId: created.body.id,
      }));
    });
    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as unknown[];
    expect(catalog).toHaveLength(1);
  });

  it('does not finish closing while an accepted WebSocket result is still persisting', async () => {
    let releaseImage!: () => void;
    let markImageStarted!: () => void;
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise<void>(resolve => { markImageStarted = resolve; });
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
      fetch: async () => {
        markImageStarted();
        await imageGate;
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        });
      },
      resolveAddresses: async () => ['93.184.216.34'],
    });
    let closePromise: Promise<void> | undefined;
    try {
      const authorized = await authorize(bridge);
      authorized.socket.send(envelope('extension.hello', 'close-drain-hello', {
        version: APP_VERSION,
      }));
      await waitForExtensionReady(bridge);
      const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
        method: 'POST',
        token: authorized.token,
        body: { url: URL, requestedBy: 'extension' },
      });
      authorized.socket.send(envelope('job.progress', created.body.id, { stage: 'collecting' }));
      authorized.socket.send(envelope('job.result', created.body.id, {
        document: document({
          html: '<p>关闭前必须完成持久化。</p><img src="https://images.example/close.png">',
          text: '关闭前必须完成持久化。',
          images: [{ url: 'https://images.example/close.png' }],
        }),
      }));
      await imageStarted;

      let closeSettled = false;
      closePromise = bridge.close().then(() => { closeSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(closeSettled).toBe(false);
    } finally {
      releaseImage();
      await closePromise;
    }
  });

  it('drains a routed HTTP operation even after its client disconnects', async () => {
    let releaseReveal!: () => void;
    let markRevealStarted!: () => void;
    const revealGate = new Promise<void>(resolve => { releaseReveal = resolve; });
    const revealStarted = new Promise<void>(resolve => { markRevealStarted = resolve; });
    const root = await temporaryDirectory();
    const target = join(root, 'entry.md');
    await writeFile(target, '# entry\n', 'utf8');
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
      reveal: async () => {
        markRevealStarted();
        await revealGate;
      },
    });
    let closePromise: Promise<void> | undefined;
    try {
      const authorized = await authorize(bridge);
      const controller = new AbortController();
      const request = fetch(`${bridge.url}/v1/reveal`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authorized.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ path: target }),
        signal: controller.signal,
      });
      await revealStarted;
      controller.abort();
      await expect(request).rejects.toThrow();

      let closeSettled = false;
      closePromise = bridge.close().then(() => { closeSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(closeSettled).toBe(false);
    } finally {
      releaseReveal();
      await closePromise;
    }
  });

  it('terminally fails a slow result and informs the replacement extension when the sink rejects', async () => {
    let releaseImage!: () => void;
    let markImageStarted!: () => void;
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise<void>(resolve => { markImageStarted = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      markImageStarted();
      await imageGate;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    });
    const root = await temporaryDirectory();
    const libraryRoot = join(root, 'library');
    const repoRoot = join(root, 'broken-repo');
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'sinks.json'), JSON.stringify({
      sinks: {
        markdown: { type: 'markdown' },
        broken: { type: 'repo-inbox', repoPath: repoRoot, commit: false, push: false },
      },
      routes: {},
    }), 'utf8');
    const bridge = await startBridge({
      port: 0,
      libraryRoot,
      configDir,
      fetch: fetcher,
      resolveAddresses: async () => ['93.184.216.34'],
    });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'slow-failure-first', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/877777777777777';
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: { url: topicUrl, requestedBy: 'extension', sinks: ['broken'] },
    });
    first.socket.send(envelope('job.result', created.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '慢保存失败竞态',
        html: '<p>完整正文</p><img src="https://images.example/slow.png">',
        text: '完整正文',
        images: [{ url: 'https://images.example/slow.png' }],
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        },
      }),
    }));
    await imageStarted;

    const replacement = await connect(bridge, first.token);
    const replacementMessages: Array<{ type?: string; requestId?: string; payload?: unknown }> = [];
    replacement.on('message', data => {
      replacementMessages.push(JSON.parse(data.toString()) as {
        type?: string;
        requestId?: string;
        payload?: unknown;
      });
    });
    replacement.send(envelope('extension.hello', 'slow-failure-replacement', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    await rm(repoRoot, { recursive: true, force: true });
    await writeFile(repoRoot, '阻止收件箱写入', 'utf8');
    releaseImage();

    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string; errorCode?: string; errorMessage?: string }>(
        bridge.url,
        `/v1/jobs/${created.body.id}`,
        { token: first.token },
      );
      expect(job.body).toMatchObject({
        status: 'failed',
        errorCode: 'SAVE_FAILED',
      });
    }, { timeout: 5_000 });
    await vi.waitFor(() => expect(replacementMessages).toContainEqual(expect.objectContaining({
      type: 'job.failed',
      requestId: created.body.id,
    })));
    expect(replacementMessages).not.toContainEqual(expect.objectContaining({
      type: 'job.collect',
      requestId: created.body.id,
    }));
  });

  it('keeps an offline fixed plan pending, dispatches it on extension hello, and records the result', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);

    const started = await requestJson<{ id: string; status: string }>(bridge.url, '/v1/plans/run', {
      method: 'POST',
      token,
      body: { planId: 'zsxq-chen-teacher', force: true },
    });
    expect(started).toMatchObject({ status: 202, body: { status: 'running' } });
    const pending = await requestJson<{ plans: Array<{ id: string; pending: boolean }> }>(
      bridge.url,
      '/v1/plans/status',
      { token },
    );
    expect(pending.body.plans.find(plan => plan.id === 'zsxq-chen-teacher')?.pending).toBe(true);

    socket.send(envelope('extension.hello', 'extension-plan', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    const command = await nextMessage<{ batchId: string; planId: string; attempt: string; force?: boolean }>(socket);
    expect(command).toMatchObject({
      type: 'plan.collect',
      payload: {
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: expect.stringMatching(/^[a-f0-9]{16}$/),
        force: true,
      },
    });
    acknowledgePlanStart(socket, command);
    socket.send(envelope('plan.result', command.requestId, {
      batchId: started.body.id,
      attempt: command.payload.attempt,
      discovered: 0,
      prepared: true,
      rejections: {},
      rejectionDetails: [],
      ...dailyLedgerFacts(command.payload),
    }));

    await vi.waitFor(async () => {
      const status = await requestJson<{
        plans: Array<{ id: string; latest?: { status: string } }>;
      }>(bridge.url, '/v1/plans/status', { token });
      expect(status.body.plans.find(plan => plan.id === 'zsxq-chen-teacher')?.latest?.status)
        .toBe('completed');
    });
  });

  it('keeps ZSXQ pending until a completeness-capable extension connects', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket: oldSocket, token } = await authorize(bridge);
    oldSocket.send(envelope('extension.hello', 'old-extension', {
      version: '0.4.28',
      buildId: 'v0.4.28 · legacy',
    }));
    await waitForExtensionReady(bridge);

    const noOldCommand = expectNoMessage(oldSocket);
    const started = await requestJson<{ id: string; status: string }>(bridge.url, '/v1/plans/run', {
      method: 'POST',
      token,
      body: { planId: 'zsxq-chen-teacher', force: true },
    });
    expect(started).toMatchObject({ status: 202, body: { status: 'running' } });
    await noOldCommand;

    const pending = await requestJson<{ plans: Array<{ id: string; pending: boolean }> }>(
      bridge.url,
      '/v1/plans/status',
      { token },
    );
    expect(pending.body.plans.find(plan => plan.id === 'zsxq-chen-teacher')?.pending).toBe(true);

    const sameVersionSocket = await connect(bridge, token);
    const noSameVersionCommand = expectNoMessage(sameVersionSocket);
    sameVersionSocket.send(envelope('extension.hello', 'same-version-without-capability', {
      version: APP_VERSION,
      buildId: `v${APP_VERSION} · old-build`,
    }));
    await noSameVersionCommand;

    const currentSocket = await connect(bridge, token);
    currentSocket.send(envelope('extension.hello', 'current-extension', {
      version: APP_VERSION,
      buildId: `v${APP_VERSION} · current`,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    const command = await nextMessage<{ batchId: string; planId: string; attempt: string }>(currentSocket);
    expect(command).toMatchObject({
      type: 'plan.collect',
      payload: {
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: expect.stringMatching(/^[a-f0-9]{16}$/),
      },
    });
    acknowledgePlanStart(currentSocket, command);
  });

  it('fences stale ZSXQ plan results and job snapshots after a worker restart rotates the attempt', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
    });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'attempt-A-extension', {
      version: APP_VERSION,
      runtimeId: '11111111-1111-4111-8111-111111111111',
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);

    const firstCommandPromise = nextMessage<{
      batchId: string;
      planId: string;
      attempt: string;
    }>(first.socket);
    const startedPromise = requestJson<{ id: string }>(bridge.url, '/v1/plans/run', {
      method: 'POST',
      token: first.token,
      body: { planId: 'zsxq-chen-teacher', force: true },
    });
    const firstCommand = await firstCommandPromise;
    acknowledgePlanStart(first.socket, firstCommand);
    const started = await startedPromise;
    const firstAttempt = firstCommand.payload.attempt;
    first.socket.send(envelope('plan.result', firstCommand.requestId, {
      batchId: started.body.id,
      attempt: firstAttempt,
      discovered: 1,
      prepared: false,
      rejections: {},
      rejectionDetails: [],
    }));

    const topicUrl = 'https://wx.zsxq.com/group/48844584441158/topic/833333333333333';
    const firstJob = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: {
        url: topicUrl,
        requestedBy: 'extension',
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: firstAttempt,
      },
    });
    expect(firstJob.status, JSON.stringify(firstJob.body)).toBe(202);

    const currentSocket = await connect(bridge, first.token);
    currentSocket.send(envelope('extension.hello', 'attempt-B-extension', {
      version: APP_VERSION,
      runtimeId: '22222222-2222-4222-8222-222222222222',
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    const currentCommand = await nextMessage<{
      batchId: string;
      planId: string;
      attempt: string;
    }>(currentSocket);
    const currentAttempt = currentCommand.payload.attempt;
    expect(currentCommand).toMatchObject({
      type: 'plan.collect',
      payload: {
        batchId: started.body.id,
        attempt: expect.stringMatching(/^[a-f0-9]{16}$/),
      },
    });
    acknowledgePlanStart(currentSocket, currentCommand);
    expect(currentAttempt).not.toBe(firstAttempt);

    currentSocket.send(envelope('plan.result', currentCommand.requestId, {
      batchId: started.body.id,
      attempt: firstAttempt,
      discovered: 1,
      prepared: true,
      rejections: {},
      rejectionDetails: [],
      ...dailyLedgerFacts(currentCommand.payload, 1),
    }));
    await vi.waitFor(async () => {
      const status = await requestJson<{
        plans: Array<{
          id: string;
          latest?: {
            status: string;
            preparationStatus?: string;
            preparationAttempt?: string;
            accepted: number;
          };
        }>;
      }>(bridge.url, '/v1/plans/status', { token: first.token });
      expect(status.body.plans.find(plan => plan.id === 'zsxq-chen-teacher')?.latest)
        .toMatchObject({
          status: 'running',
          preparationStatus: 'collecting',
          preparationAttempt: currentAttempt,
          accepted: 0,
        });
    });

    const staleCreation = await requestJson(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: {
        url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444444',
        requestedBy: 'extension',
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: firstAttempt,
      },
    });
    expect(staleCreation.status).toBe(409);

    const currentJob = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: {
        url: topicUrl,
        requestedBy: 'extension',
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: currentAttempt,
      },
    });
    expect(currentJob.status).toBe(202);
    expect(currentJob.body.id).not.toBe(firstJob.body.id);

    currentSocket.send(envelope('plan.result', currentCommand.requestId, {
      batchId: started.body.id,
      attempt: currentAttempt,
      discovered: 1,
      prepared: true,
      rejections: {},
      rejectionDetails: [],
      ...dailyLedgerFacts(currentCommand.payload, 1),
    }));
    currentSocket.send(envelope('job.result', firstJob.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '旧轮迟到快照',
        truncated: false,
        sourceMetadata: {
          authorRole: 'member',
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        },
      }),
    }));
    currentSocket.send(envelope('job.progress', currentJob.body.id, { stage: 'collecting' }));
    currentSocket.send(envelope('job.result', currentJob.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '当前轮完整正文',
        truncated: false,
        sourceMetadata: {
          authorRole: 'member',
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        },
      }),
    }));

    // job.saved 落盘后，固定计划还要异步核对 attempt、自动同步资格和 durable
    // delivery manifest；全套件并行时不能拿 waitFor 的 1s 缺省值冒充协议超时。
    await vi.waitFor(async () => {
      const current = await requestJson<{ status: string }>(
        bridge.url,
        `/v1/jobs/${currentJob.body.id}`,
        { token: first.token },
      );
      expect(current.body.status).toBe('saved');
      const batches = await requestJson<{
        batches: Array<{
          id: string;
          status: string;
          accepted: number;
          saved: number;
          deliveryIds: string[];
          error?: string;
        }>;
      }>(bridge.url, '/v1/plans/batches?planId=zsxq-chen-teacher', { token: first.token });
      expect(batches.body.batches.find(batch => batch.id === started.body.id)).toMatchObject({
        // 这个协议围栏用例故意回传 member，不能成为固定计划的自动交付证明。
        status: 'completed_with_attention',
        accepted: 1,
        saved: 1,
        deliveryIds: [],
        error: expect.stringContaining('未确认交付'),
      });
    }, { timeout: 10_000 });
    const library = await requestJson<{ entries: Array<{ title: string }> }>(
      bridge.url,
      '/v1/library',
      { token: first.token },
    );
    expect(library.body.entries).toEqual([
      expect.objectContaining({ title: '当前轮完整正文' }),
    ]);
  });

  it('gates recovered ZSXQ jobs and never saves an incomplete or unproven plan result', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const options = { port: 0, libraryRoot: root, configDir };
    const first = await startBridge(options);
    handles.push(first);
    const authorized = await authorize(first);
    authorized.socket.send(envelope('extension.hello', 'prepare-current-extension', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(first);

    const planCommandPromise = nextMessage<{
      batchId: string;
      planId: string;
      attempt: string;
    }>(authorized.socket);
    const startedPromise = requestJson<{ id: string }>(first.url, '/v1/plans/run', {
      method: 'POST',
      token: authorized.token,
      body: { planId: 'zsxq-chen-teacher', force: true },
    });
    const planCommand = await planCommandPromise;
    acknowledgePlanStart(authorized.socket, planCommand);
    const started = await startedPromise;
    const firstAttempt = planCommand.payload.attempt;
    authorized.socket.send(envelope('plan.result', planCommand.requestId, {
      batchId: started.body.id,
      attempt: firstAttempt,
      discovered: 1,
      prepared: false,
      rejections: {},
      rejectionDetails: [],
    }));
    await vi.waitFor(async () => {
      const status = await requestJson<{
        plans: Array<{ id: string; latest?: { discovered: number } }>;
      }>(first.url, '/v1/plans/status', { token: authorized.token });
      expect(status.body.plans.find(plan => plan.id === 'zsxq-chen-teacher')?.latest?.discovered)
        .toBe(1);
    });

    const topicUrl = 'https://wx.zsxq.com/group/48844584441158/topic/855555555555555';
    const created = await requestJson<{ id: string; status: string }>(first.url, '/v1/jobs', {
      method: 'POST',
      token: authorized.token,
      body: {
        url: topicUrl,
        requestedBy: 'extension',
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: firstAttempt,
      },
    });
    expect(created).toMatchObject({ status: 202, body: { status: 'queued' } });
    await first.close();
    handles.splice(handles.indexOf(first), 1);

    const restarted = await startBridge(options);
    handles.push(restarted);
    const legacy = await authorize(restarted);
    expect(legacy.token).toBe(authorized.token);
    const noLegacyDispatch = expectNoMessage(legacy.socket);
    legacy.socket.send(envelope('extension.hello', 'legacy-extension', { version: '0.4.28' }));
    await noLegacyDispatch;

    const rejectedCreation = await requestJson(restarted.url, '/v1/jobs', {
      method: 'POST',
      token: legacy.token,
      body: {
        url: 'https://wx.zsxq.com/group/48844584441158/topic/866666666666666',
        requestedBy: 'extension',
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: firstAttempt,
      },
    });
    expect(rejectedCreation.status).toBe(409);

    const legacyProtocolError = nextMessage(legacy.socket);
    legacy.socket.send(envelope('job.result', created.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '旧扩展回传的半篇正文',
        truncated: true,
        sourceMetadata: { authorRole: 'owner' },
      }),
    }));
    await expect(legacyProtocolError).resolves.toMatchObject({ type: 'protocol.error' });
    const beforeRecovery = await requestJson<{ entries: unknown[] }>(
      restarted.url,
      '/v1/library',
      { token: legacy.token },
    );
    expect(beforeRecovery.body.entries).toEqual([]);

    const current = await connect(restarted, legacy.token);
    const recoveredPlan = nextMessage<{
      batchId: string;
      planId: string;
      attempt: string;
    }>(current);
    current.send(envelope('extension.hello', 'recovery-current-extension', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    const currentPlan = await recoveredPlan;
    expect(currentPlan).toMatchObject({
      type: 'plan.collect',
      payload: {
        batchId: started.body.id,
        attempt: expect.stringMatching(/^[a-f0-9]{16}$/),
      },
    });
    acknowledgePlanStart(current, currentPlan);
    expect(currentPlan.payload.attempt).not.toBe(firstAttempt);
    const recovered = await requestJson<{ id: string; status: string }>(restarted.url, '/v1/jobs', {
      method: 'POST',
      token: legacy.token,
      body: {
        url: topicUrl,
        requestedBy: 'extension',
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: currentPlan.payload.attempt,
      },
    });
    expect(recovered).toMatchObject({ status: 202, body: { status: 'queued' } });
    current.send(envelope('plan.result', currentPlan.requestId, {
      batchId: started.body.id,
      attempt: currentPlan.payload.attempt,
      discovered: 1,
      prepared: true,
      rejections: {},
      rejectionDetails: [],
      ...dailyLedgerFacts(currentPlan.payload, 1),
    }));
    current.send(envelope('job.progress', recovered.body.id, { stage: 'collecting' }));
    current.send(envelope('job.result', recovered.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '新版扩展未声明完整的正文',
        sourceMetadata: { authorRole: 'owner' },
      }),
    }));

    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string; outputPath?: string }>(
        restarted.url,
        `/v1/jobs/${recovered.body.id}`,
        { token: legacy.token },
      );
      expect(job.body.status).toBe('needs_attention');
      expect(job.body.outputPath).toBeUndefined();
      const library = await requestJson<{ entries: unknown[] }>(
        restarted.url,
        '/v1/library',
        { token: legacy.token },
      );
      expect(library.body.entries).toEqual([]);
      const status = await requestJson<{
        plans: Array<{
          id: string;
          latest?: {
            status: string;
            deliveryIds: string[];
            needsAttention: number;
            rejections?: Record<string, number>;
            rejectionDetails?: Array<{ url: string; reason: string }>;
          };
        }>;
      }>(restarted.url, '/v1/plans/status', { token: legacy.token });
      expect(status.body.plans.find(plan => plan.id === 'zsxq-chen-teacher')?.latest)
        .toMatchObject({
          status: 'completed_with_attention',
          deliveryIds: [],
          needsAttention: 1,
          rejections: { '正文不完整': 1 },
          rejectionDetails: [{ url: topicUrl, reason: '正文不完整' }],
        });
    });
  });

  it('requires the completeness capability and explicit complete content for ordinary ZSXQ jobs', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
    });
    handles.push(bridge);
    const legacy = await authorize(bridge);
    legacy.socket.send(envelope('extension.hello', 'ordinary-without-capability', {
      version: APP_VERSION,
    }));
    await waitForExtensionReady(bridge);
    const firstUrl = 'https://wx.zsxq.com/group/1/topic/877777777777777';

    const blocked = await requestJson(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: legacy.token,
      body: { url: firstUrl, requestedBy: 'extension' },
    });
    expect(blocked.status).toBe(409);

    const current = await connect(bridge, legacy.token);
    current.send(envelope('extension.hello', 'ordinary-capable-extension', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    const unproven = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: legacy.token,
      body: { url: firstUrl, requestedBy: 'extension' },
    });
    expect(unproven.status).toBe(202);
    current.send(envelope('job.progress', unproven.body.id, { stage: 'collecting' }));
    const unprovenTerminal = nextMessage(current);
    const unprovenResult = envelope('job.result', unproven.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: firstUrl,
        canonicalUrl: firstUrl,
        title: '未证明完整的普通采集',
      }),
    });
    current.send(unprovenResult);
    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string; outputPath?: string }>(
        bridge.url,
        `/v1/jobs/${unproven.body.id}`,
        { token: legacy.token },
      );
      expect(job.body).toMatchObject({ status: 'needs_attention' });
      expect(job.body.outputPath).toBeUndefined();
    });
    await expect(unprovenTerminal).resolves.toMatchObject({
      type: 'job.failed',
      requestId: unproven.body.id,
      payload: { code: 'INCOMPLETE_CONTENT' },
    });
    const replayedUnprovenTerminal = nextMessage(current);
    current.send(unprovenResult);
    await expect(replayedUnprovenTerminal).resolves.toMatchObject({
      type: 'job.failed',
      requestId: unproven.body.id,
      payload: { code: 'INCOMPLETE_CONTENT' },
    });
    expect((await requestJson<{ entries: unknown[] }>(
      bridge.url,
      '/v1/library',
      { token: legacy.token },
    )).body.entries).toEqual([]);

    const falseOnlyUrl = 'https://wx.zsxq.com/group/1/topic/878787878787878';
    const falseOnly = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: legacy.token,
      body: { url: falseOnlyUrl, requestedBy: 'extension' },
    });
    current.send(envelope('job.progress', falseOnly.body.id, { stage: 'collecting' }));
    current.send(envelope('job.result', falseOnly.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: falseOnlyUrl,
        canonicalUrl: falseOnlyUrl,
        title: '只有 truncated false、没有协议证明',
        truncated: false,
      }),
    }));
    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string; outputPath?: string }>(
        bridge.url,
        `/v1/jobs/${falseOnly.body.id}`,
        { token: legacy.token },
      );
      expect(job.body).toMatchObject({ status: 'needs_attention' });
      expect(job.body.outputPath).toBeUndefined();
    });
    expect((await requestJson<{ entries: unknown[] }>(
      bridge.url,
      '/v1/library',
      { token: legacy.token },
    )).body.entries).toEqual([]);

    const completeUrl = 'https://wx.zsxq.com/group/1/topic/888888888888888';
    const complete = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: legacy.token,
      body: { url: completeUrl, requestedBy: 'extension' },
    });
    current.send(envelope('job.progress', complete.body.id, { stage: 'collecting' }));
    current.send(envelope('job.result', complete.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: completeUrl,
        canonicalUrl: completeUrl,
        title: '已明确验证完整的普通采集',
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        },
      }),
    }));
    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string }>(
        bridge.url,
        `/v1/jobs/${complete.body.id}`,
        { token: legacy.token },
      );
      expect(job.body.status).toBe('saved');
    });
    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ contentComplete?: boolean }>;
    expect(catalog).toEqual([expect.objectContaining({ contentComplete: true })]);

    const stale = await connect(bridge, legacy.token);
    stale.send(envelope('extension.hello', 'ordinary-stale-replay', { version: '0.4.28' }));
    await waitForExtensionReady(bridge);
    const staleTerminal = nextMessage(stale);
    stale.send(unprovenResult);
    await expect(staleTerminal).resolves.toMatchObject({
      type: 'job.failed',
      requestId: unproven.body.id,
      payload: { code: 'INCOMPLETE_CONTENT' },
    });
  });

  it('requires a ZSXQ sink attestation to match the exact artifact build when one is known', async () => {
    const root = await temporaryDirectory();
    const expectedBuild = `v${APP_VERSION} · sink-attestation-build`;
    await mkdir(join(root, 'artifacts', 'data-collector-extension'), { recursive: true });
    await writeFile(
      join(root, 'artifacts', 'data-collector-extension', 'build-id.txt'),
      `${expectedBuild}\n`,
      'utf8',
    );
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      runUpdate: async () => ({
        changed: false,
        commit: 'sink-attestation-build',
        message: '已是最新。',
        checkedAt: '2026-08-25T00:00:00.000Z',
      }),
    });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'sink-attestation-extension', {
      version: APP_VERSION,
      buildId: expectedBuild,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);

    const mismatchedUrl = 'https://wx.zsxq.com/group/1/topic/898989898989898';
    const mismatched = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: mismatchedUrl, requestedBy: 'extension' },
    });
    socket.send(envelope('job.result', mismatched.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: mismatchedUrl,
        canonicalUrl: mismatchedUrl,
        title: '构建证明不匹配',
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
          contentCompletenessBuildId: `v${APP_VERSION} · stale-build`,
        },
      }),
    }));
    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string; outputPath?: string }>(
        bridge.url,
        `/v1/jobs/${mismatched.body.id}`,
        { token },
      );
      expect(job.body).toMatchObject({ status: 'needs_attention' });
      expect(job.body.outputPath).toBeUndefined();
    });

    const exactUrl = 'https://wx.zsxq.com/group/1/topic/909090909090909';
    const exact = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: exactUrl, requestedBy: 'extension' },
    });
    socket.send(envelope('job.result', exact.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: exactUrl,
        canonicalUrl: exactUrl,
        title: '构建证明精确匹配',
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
          contentCompletenessBuildId: expectedBuild,
        },
      }),
    }));
    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string }>(
        bridge.url,
        `/v1/jobs/${exact.body.id}`,
        { token },
      );
      expect(job.body.status).toBe('saved');
    }, { timeout: 5_000 });
    const catalog = JSON.parse(
      await readFile(join(root, 'library', '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ contentComplete?: boolean }>;
    expect(catalog).toEqual([expect.objectContaining({ contentComplete: true })]);
  });

  it('serializes an artifact replacement with ZSXQ persistence so build A cannot write after B lands', async () => {
    const root = await temporaryDirectory();
    const libraryRoot = join(root, 'library');
    const artifacts = join(root, 'artifacts', 'data-collector-extension');
    const buildA = `v${APP_VERSION} · persistence-build-a`;
    const buildB = `v${APP_VERSION} · persistence-build-b`;
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'build-id.txt'), `${buildA}\n`, 'utf8');

    let markUpdateStarted!: () => void;
    let releaseUpdate!: () => void;
    let releaseImage!: () => void;
    const updateStarted = new Promise<void>(resolve => { markUpdateStarted = resolve; });
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      await imageGate;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    });
    const bridge = await startBridge({
      port: 0,
      libraryRoot,
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 60 * 60_000,
      exit: vi.fn(),
      fetch: fetcher,
      resolveAddresses: async () => ['93.184.216.34'],
      runUpdate: async () => {
        markUpdateStarted();
        await updateGate;
        await writeFile(join(artifacts, 'build-id.txt'), `${buildB}\n`, 'utf8');
        return {
          changed: true,
          commit: 'persistence-build-b',
          message: '已更新并完成构建。',
          checkedAt: '2026-08-25T00:00:00.000Z',
        };
      },
    });
    handles.push(bridge);
    await updateStarted;

    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'persistence-build-a', {
      version: APP_VERSION,
      buildId: buildA,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/909191919191919';
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: topicUrl, requestedBy: 'extension' },
    });
    socket.send(envelope('job.result', created.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '构建切换期间的旧正文',
        html: '<p>构建 A 的正文</p><img src="https://images.example/build-race.png">',
        text: '构建 A 的正文',
        images: [{ url: 'https://images.example/build-race.png' }],
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
          contentCompletenessBuildId: buildA,
        },
      }),
    }));

    // 旧实现会在 updater 仍持有 A→B 切换窗口时直接进入 sink，并卡在图片下载。
    await new Promise(resolve => setTimeout(resolve, 100));
    const sinkStartedBeforeUpdateFinished = fetcher.mock.calls.length > 0;
    releaseUpdate();
    releaseImage();

    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string; outputPath?: string }>(
        bridge.url,
        `/v1/jobs/${created.body.id}`,
        { token },
      );
      expect(job.body.status).toBe('needs_attention');
      expect(job.body.outputPath).toBeUndefined();
    });
    expect(sinkStartedBeforeUpdateFinished).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await requestJson<{ entries: unknown[] }>(
      bridge.url,
      '/v1/library',
      { token },
    )).body.entries).toEqual([]);
  });

  it('holds the cross-process artifact lease until a slow ZSXQ sink reaches its saved terminal state', async () => {
    const root = await temporaryDirectory();
    const libraryRoot = join(root, 'library');
    const artifacts = join(root, 'artifacts', 'data-collector-extension');
    const buildA = `v${APP_VERSION} · external-package-a`;
    const buildB = `v${APP_VERSION} · external-package-b`;
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'build-id.txt'), `${buildA}\n`, 'utf8');
    let markImageStarted!: () => void;
    let releaseImage!: () => void;
    const imageStarted = new Promise<void>(resolve => { markImageStarted = resolve; });
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      markImageStarted();
      await imageGate;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    });
    const bridge = await startBridge({
      port: 0,
      libraryRoot,
      configDir: join(root, '.config'),
      repoRoot: root,
      enableAutoUpdate: false,
      fetch: fetcher,
      resolveAddresses: async () => ['93.184.216.34'],
      runUpdate: async () => ({
        changed: false,
        commit: 'external-package-a',
        message: '已是最新。',
        checkedAt: '2026-08-25T00:00:00.000Z',
      }),
    });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'external-package-a', {
      version: APP_VERSION,
      buildId: buildA,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/939191919191919';
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: topicUrl, requestedBy: 'extension' },
    });
    socket.send(envelope('job.result', created.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '外部打包必须等待慢图片落库',
        html: '<p>构建 A 完整正文</p><img src="https://images.example/external-package.png">',
        text: '构建 A 完整正文',
        images: [{ url: 'https://images.example/external-package.png' }],
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
          contentCompletenessBuildId: buildA,
        },
      }),
    }));
    await imageStarted;

    let packageAcquired = false;
    let packageError = '';
    const leaseModule = new globalThis.URL('../../scripts/artifact-lease.mjs', import.meta.url).href;
    const externalPackage = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `
        import { writeFile } from 'node:fs/promises';
        import { acquireArtifactLease } from ${JSON.stringify(leaseModule)};
        const lease = await acquireArtifactLease(${JSON.stringify(root)}, {
          role: 'package', timeoutMs: 3_000, pollIntervalMs: 5,
        });
        process.stdout.write('acquired\\n');
        await writeFile(${JSON.stringify(join(artifacts, 'build-id.txt'))}, ${JSON.stringify(`${buildB}\n`)}, 'utf8');
        await lease.release();
      `,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
    externalPackage.stdout.on('data', data => {
      if (data.toString().includes('acquired')) packageAcquired = true;
    });
    externalPackage.stderr.on('data', data => { packageError += data.toString(); });
    const externalPackageExited = new Promise<void>((resolve, reject) => {
      externalPackage.once('error', reject);
      externalPackage.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`external package lease failed: code=${code} signal=${signal} ${packageError}`));
      });
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(packageAcquired).toBe(false);
    expect(await readFile(join(artifacts, 'build-id.txt'), 'utf8')).toBe(`${buildA}\n`);

    releaseImage();
    await vi.waitFor(async () => {
      const saved = await requestJson<{ status: string; outputPath?: string }>(
        bridge.url,
        `/v1/jobs/${created.body.id}`,
        { token },
      );
      expect(saved.body.status).toBe('saved');
      expect(saved.body.outputPath).toMatch(/index\.md$/u);
    });
    await externalPackageExited;
    expect(packageAcquired).toBe(true);
    expect(await readFile(join(artifacts, 'build-id.txt'), 'utf8')).toBe(`${buildB}\n`);
  });

  it('waits behind a package lease, then rereads build B and rejects build A before any ZSXQ sink', async () => {
    const root = await temporaryDirectory();
    const artifacts = join(root, 'artifacts', 'data-collector-extension');
    const buildA = `v${APP_VERSION} · package-first-a`;
    const buildB = `v${APP_VERSION} · package-first-b`;
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'build-id.txt'), `${buildA}\n`, 'utf8');
    const packageLease = await acquireArtifactLease(root, {
      role: 'package',
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const fetcher = vi.fn<typeof fetch>();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      enableAutoUpdate: false,
      fetch: fetcher,
      runUpdate: async () => ({
        changed: false,
        commit: 'package-first-a',
        message: '已是最新。',
        checkedAt: '2026-08-25T00:00:00.000Z',
      }),
    });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'package-first-a', {
      version: APP_VERSION,
      buildId: buildA,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/949191919191919';
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: topicUrl, requestedBy: 'extension' },
    });
    await writeFile(join(artifacts, 'build-id.txt'), `${buildB}\n`, 'utf8');
    const rejectedTerminal = nextMessage(socket);
    socket.send(envelope('job.result', created.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '打包先持锁时的旧构建正文',
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
          contentCompletenessBuildId: buildA,
        },
      }),
    }));

    await new Promise(resolve => setTimeout(resolve, 75));
    const waiting = await requestJson<{ status: string }>(
      bridge.url,
      `/v1/jobs/${created.body.id}`,
      { token },
    );
    expect(['queued', 'dispatched', 'collecting']).toContain(waiting.body.status);
    expect(fetcher).not.toHaveBeenCalled();

    await packageLease.release();
    await vi.waitFor(async () => {
      const rejected = await requestJson<{
        status: string;
        errorCode?: string;
        outputPath?: string;
      }>(bridge.url, `/v1/jobs/${created.body.id}`, { token });
      expect(rejected.body).toMatchObject({
        status: 'needs_attention',
        errorCode: 'EXTENSION_UPDATE_REQUIRED',
      });
      expect(rejected.body.outputPath).toBeUndefined();
    });
    await expect(rejectedTerminal).resolves.toMatchObject({
      type: 'job.failed',
      requestId: created.body.id,
      payload: { code: 'EXTENSION_UPDATE_REQUIRED' },
    });
    expect(fetcher).not.toHaveBeenCalled();
    const afterRejection = await acquireArtifactLease(root, {
      role: 'package',
      timeoutMs: 250,
      pollIntervalMs: 5,
    });
    await afterRejection.release();
  });

  it('does not make a non-ZSXQ result wait for the artifact lease', async () => {
    const root = await temporaryDirectory();
    const packageLease = await acquireArtifactLease(root, {
      role: 'package',
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      runUpdate: async () => ({
        changed: false,
        commit: 'non-zsxq',
        message: '已是最新。',
        checkedAt: '2026-08-25T00:00:00.000Z',
      }),
    });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'non-zsxq-result', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'extension' },
    });
    socket.send(envelope('job.result', created.body.id, { document: document() }));

    await vi.waitFor(async () => {
      const saved = await requestJson<{ status: string }>(
        bridge.url,
        `/v1/jobs/${created.body.id}`,
        { token },
      );
      expect(saved.body.status).toBe('saved');
    });
    await packageLease.release();
  });

  it('immediately fences a connected old extension when the artifact build changes on disk', async () => {
    const root = await temporaryDirectory();
    const artifacts = join(root, 'artifacts', 'data-collector-extension');
    const buildA = `v${APP_VERSION} · runtime-artifact-a`;
    const buildB = `v${APP_VERSION} · runtime-artifact-b`;
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'build-id.txt'), `${buildA}\n`, 'utf8');
    const runUpdate = vi.fn(async () => ({
      changed: false,
      commit: 'runtime-artifact-a',
      message: '已是最新。',
      checkedAt: '2026-08-25T00:00:00.000Z',
    }));
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      enableAutoUpdate: false,
      runUpdate,
    });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'runtime-artifact-a', {
      version: APP_VERSION,
      buildId: buildA,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);

    const inFlightUrl = 'https://wx.zsxq.com/group/1/topic/919191919191919';
    const dispatched = nextMessage<{ url: string }>(socket);
    const inFlight = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: inFlightUrl, requestedBy: 'cli' },
    });
    expect(inFlight.status).toBe(202);
    await expect(dispatched).resolves.toMatchObject({
      type: 'job.collect',
      requestId: inFlight.body.id,
    });
    const queuedUrl = 'https://wx.zsxq.com/group/1/topic/919292929292929';
    const queued = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: queuedUrl, requestedBy: 'extension' },
    });
    expect(queued.status).toBe(202);

    // Bridge 进程仍是启动时的 A，但磁盘 artifact 已被打包流程原地替换为 B。
    await writeFile(join(artifacts, 'build-id.txt'), `${buildB}\n`, 'utf8');

    const blocked = await requestJson<{ code?: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        url: 'https://wx.zsxq.com/group/1/topic/929292929292929',
        requestedBy: 'extension',
      },
    });
    expect(blocked).toMatchObject({
      status: 409,
      body: { error: { code: 'EXTENSION_UPDATE_REQUIRED' } },
    });

    // A 已经拿到的任务即使迟到回传完整性证明，也不能写进 sink。
    const rejectedTerminal = nextMessage(socket);
    socket.send(envelope('job.result', inFlight.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: inFlightUrl,
        canonicalUrl: inFlightUrl,
        title: '磁盘切换后旧构建迟到的正文',
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
          contentCompletenessBuildId: buildA,
        },
      }),
    }));
    await vi.waitFor(async () => {
      const job = await requestJson<{
        status: string;
        errorCode?: string;
        outputPath?: string;
      }>(bridge.url, `/v1/jobs/${inFlight.body.id}`, { token });
      expect(job.body).toMatchObject({
        status: 'needs_attention',
        errorCode: 'EXTENSION_UPDATE_REQUIRED',
      });
      expect(job.body.outputPath).toBeUndefined();
    });
    await expect(rejectedTerminal).resolves.toMatchObject({
      type: 'job.failed',
      requestId: inFlight.body.id,
      payload: { code: 'EXTENSION_UPDATE_REQUIRED' },
    });
    expect((await requestJson<{ entries: unknown[] }>(
      bridge.url,
      '/v1/library',
      { token },
    )).body.entries).toEqual([]);
    expect(runUpdate).not.toHaveBeenCalled();

    // 重连仍是旧 A 时，启动前已经排队的任务也不得被 dispatch。
    const staleReplacement = await connect(bridge, token);
    const noStaleDispatch = expectNoMessage(staleReplacement);
    staleReplacement.send(envelope('extension.hello', 'runtime-artifact-a-replacement', {
      version: APP_VERSION,
      buildId: buildA,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    await noStaleDispatch;
    const stillQueued = await requestJson<{ status: string }>(
      bridge.url,
      `/v1/jobs/${queued.body.id}`,
      { token },
    );
    expect(stillQueued.body.status).toBe('queued');
  });

  it('protects and validates fixed plan status, run, and batch history routes', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { token } = await authorize(bridge);

    expect((await requestJson(bridge.url, '/v1/plans/status')).status).toBe(401);
    expect((await requestJson(bridge.url, '/v1/plans/batches?limit=20')).status).toBe(401);
    expect((await requestJson(bridge.url, '/v1/plans/run', {
      method: 'POST', token, body: { planId: 'user-defined-plan' },
    })).status).toBe(400);
    expect((await requestJson(bridge.url, '/v1/plans/batches?limit=0', { token })).status).toBe(400);

    const run = await requestJson<{ id: string }>(bridge.url, '/v1/plans/run', {
      method: 'POST', token, body: { planId: 'nowcoder-agent-market', force: true },
    });
    expect(run.status).toBe(202);
    const batches = await requestJson<{ batches: Array<{ id: string; planId: string }> }>(
      bridge.url,
      '/v1/plans/batches?limit=1',
      { token },
    );
    expect(batches).toMatchObject({
      status: 200,
      body: { batches: [{ id: run.body.id, planId: 'nowcoder-agent-market' }] },
    });
  });

  it('fences a stopped fixed Nowcoder child and drops its late terminal frame idempotently', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const plans = await CollectionPlanStore.open(config.plansFile);
    const batch = await plans.start('nowcoder-agent-market');
    await plans.attention(batch.id, '用户关闭了牛客采集页面，已停止本次牛客运行');
    const jobs = await JobStore.open(config.jobsFile);
    const child = await jobs.create({
      id: 'stopped-fixed-nowcoder-child',
      url: 'https://www.nowcoder.com/discuss/98765',
      requestedBy: 'codex',
      batchId: batch.id,
      planId: 'nowcoder-agent-market',
    });

    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    const staleAck = nextMessage(socket);
    socket.send(envelope('extension.hello', 'stopped-fixed-hello', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await vi.waitFor(async () => {
      const current = await requestJson<{ status: string; errorCode?: string }>(
        bridge.url,
        `/v1/jobs/${child.id}`,
        { token },
      );
      expect(current.body).toMatchObject({ status: 'failed', errorCode: 'STALE_PLAN_RUN' });
    });
    expect(await staleAck).toMatchObject({
      type: 'job.failed', requestId: child.id, payload: { code: 'STALE_PLAN_RUN' },
    });

    const replayedAck = nextMessage(socket);
    socket.send(envelope('job.error', child.id, {
      code: 'TAB_CLOSED_BY_USER', message: '迟到的关页回执', needsAttention: false,
    }));
    await vi.waitFor(async () => {
      const current = await requestJson<{ status: string; errorCode?: string }>(
        bridge.url,
        `/v1/jobs/${child.id}`,
        { token },
      );
      expect(current.body).toMatchObject({ status: 'failed', errorCode: 'STALE_PLAN_RUN' });
    });
    expect(await replayedAck).toMatchObject({ type: 'job.failed', requestId: child.id });
  });

  it('checks the fixed parent synchronously inside collectFrame before sending job.collect', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const plans = await CollectionPlanStore.open(config.plansFile);
    const batch = await plans.start('nowcoder-agent-market');
    await plans.markSelectionPending(batch.id);
    const jobs = await JobStore.open(config.jobsFile);
    const child = await jobs.create({
      id: 'fixed-dispatch-final-fence',
      url: 'https://www.nowcoder.com/discuss/98768',
      requestedBy: 'codex', batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    await plans.attachRound(batch.id, [child.id]);
    let acceptsCalls = 0;
    const originalAccepts = CollectionPlanService.prototype.acceptsFixedNowcoderJob;
    const accepts = vi.spyOn(CollectionPlanService.prototype, 'acceptsFixedNowcoderJob');
    accepts.mockImplementation(function (job) {
      acceptsCalls += 1;
      // The first two checks are the ingress and awaitable final fence.  Only the synchronous
      // collectFrame check can observe this last-microtask parent change before socket.send.
      return acceptsCalls < 3 && originalAccepts.call(this, job);
    });
    const onTerminal = vi.spyOn(CollectionPlanService.prototype, 'onJobTerminal')
      .mockResolvedValue(undefined);
    try {
      const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
      handles.push(bridge);
      const { socket, token } = await authorize(bridge);
      const staleAck = nextMessage(socket);
      socket.send(envelope('extension.hello', 'fixed-dispatch-final-fence', { version: APP_VERSION }));
      expect(await staleAck).toMatchObject({ type: 'job.failed', requestId: child.id });
      const persisted = await requestJson<{ status: string; errorCode?: string }>(
        bridge.url, `/v1/jobs/${child.id}`, { token },
      );
      expect(persisted.body).toMatchObject({ status: 'failed', errorCode: 'STALE_PLAN_RUN' });
    } finally {
      onTerminal.mockRestore();
      accepts.mockRestore();
    }
  });

  it('commits a fixed result that already owns persistence despite a late non-durable acceptance flip', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const plans = await CollectionPlanStore.open(config.plansFile);
    const batch = await plans.start('nowcoder-agent-market');
    await plans.markSelectionPending(batch.id);
    const jobs = await JobStore.open(config.jobsFile);
    const child = await jobs.create({
      id: 'fixed-result-parent-stop',
      url: 'https://www.nowcoder.com/discuss/98766',
      requestedBy: 'codex', batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    await plans.attachRound(batch.id, [child.id]);
    const imageStarted = deferred<void>();
    const releaseImage = deferred<Response>();
    let parentStopped = false;
    const originalAccepts = CollectionPlanService.prototype.acceptsFixedNowcoderJob;
    const accepts = vi.spyOn(CollectionPlanService.prototype, 'acceptsFixedNowcoderJob');
    accepts.mockImplementation(function (job) {
      return !parentStopped && originalAccepts.call(this, job);
    });
    const onTerminal = vi.spyOn(CollectionPlanService.prototype, 'onJobTerminal')
      .mockResolvedValue(undefined);
    try {
      const bridge = await startBridge({
        port: 0, libraryRoot: root, configDir,
        fetch: async () => {
          imageStarted.resolve();
          return releaseImage.promise;
        },
        resolveAddresses: async () => ['93.184.216.34'],
      });
      handles.push(bridge);
      const { socket, token } = await authorize(bridge);
      const collect = nextMessage(socket);
      socket.send(envelope('extension.hello', 'fixed-result-parent-stop', { version: APP_VERSION }));
      expect(await collect).toMatchObject({ type: 'job.collect', requestId: child.id });

      socket.send(envelope('job.result', child.id, {
        document: document({
          source: 'nowcoder', kind: 'post', url: child.url, canonicalUrl: child.url,
          title: '固定计划围栏', author: '测试用户',
          html: '<p>正文</p><img src="https://example.com/fence.png">', text: '正文',
          images: [{ url: 'https://example.com/fence.png' }],
        }),
      }));
      await imageStarted.promise;
      parentStopped = true;
      releaseImage.resolve(new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      }));

      await vi.waitFor(async () => {
        const persisted = await requestJson<{ status: string; errorCode?: string }>(
          bridge.url, `/v1/jobs/${child.id}`, { token },
        );
        // The test flip is not a durable stop.  Once the persistence lease was acquired, sink
        // and saved transition are one linear operation; only a durable terminal parent fences it.
        expect(persisted.body).toMatchObject({ status: 'saved' });
      });
    } finally {
      onTerminal.mockRestore();
      accepts.mockRestore();
    }
  });

  it('does not enter a sink for a fixed Nowcoder result after the parent fence closes', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const plans = await CollectionPlanStore.open(config.plansFile);
    const batch = await plans.start('nowcoder-agent-market');
    await plans.markSelectionPending(batch.id);
    const jobs = await JobStore.open(config.jobsFile);
    const child = await jobs.create({
      id: 'fixed-result-pre-sink-stop',
      url: 'https://www.nowcoder.com/discuss/98767',
      requestedBy: 'codex', batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    await plans.attachRound(batch.id, [child.id]);
    let parentStopped = false;
    const originalAccepts = CollectionPlanService.prototype.acceptsFixedNowcoderJob;
    const accepts = vi.spyOn(CollectionPlanService.prototype, 'acceptsFixedNowcoderJob');
    accepts.mockImplementation(function (job) {
      return !parentStopped && originalAccepts.call(this, job);
    });
    const onTerminal = vi.spyOn(CollectionPlanService.prototype, 'onJobTerminal')
      .mockResolvedValue(undefined);
    const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png' },
    }));
    try {
      const bridge = await startBridge({
        port: 0, libraryRoot: root, configDir, fetch,
        resolveAddresses: async () => ['93.184.216.34'],
      });
      handles.push(bridge);
      const { socket, token } = await authorize(bridge);
      const collect = nextMessage(socket);
      socket.send(envelope('extension.hello', 'fixed-result-pre-sink-stop', { version: APP_VERSION }));
      expect(await collect).toMatchObject({ type: 'job.collect', requestId: child.id });
      parentStopped = true;
      socket.send(envelope('job.result', child.id, {
        document: document({
          source: 'nowcoder', kind: 'post', url: child.url, canonicalUrl: child.url,
          title: '预落盘围栏', author: '测试用户',
          html: '<p>正文</p><img src="https://example.com/pre-fence.png">', text: '正文',
          images: [{ url: 'https://example.com/pre-fence.png' }],
        }),
      }));
      await vi.waitFor(async () => {
        const persisted = await requestJson<{ status: string; errorCode?: string }>(
          bridge.url, `/v1/jobs/${child.id}`, { token },
        );
        expect(persisted.body).toMatchObject({ status: 'failed', errorCode: 'STALE_PLAN_RUN' });
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      onTerminal.mockRestore();
      accepts.mockRestore();
    }
  });

  it('keeps ordinary jobs dispatchable when the fixed-plan store is unavailable', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    await mkdir(configDir, { recursive: true });
    await writeFile(config.plansFile, '{not valid json', 'utf8');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    expect((await requestJson(bridge.url, '/v1/plans/status', { token })).status).toBe(409);
    socket.send(envelope('extension.hello', 'plans-unavailable-ordinary', { version: APP_VERSION }));
    const collect = nextMessage<{ url: string }>(socket);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST', token, body: { url: URL, requestedBy: 'codex' },
    });

    expect(await collect).toMatchObject({
      type: 'job.collect', requestId: created.body.id, payload: { url: URL },
    });
  });

  it('terminalizes every legacy ordinary Nowcoder job before extension reconnect can reopen it', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    await mkdir(join(root, '_catalog'), { recursive: true });
    const legacyJobs = Array.from({ length: 18 }, (_, index) => ({
      id: `legacy-fe-journey-nowcoder-${index + 1}`,
      url: `https://www.nowcoder.com/discuss/92456854821354${String(index).padStart(4, '0')}`,
      requestedBy: 'codex',
      status: (['queued', 'dispatched', 'collecting'] as const)[index % 3],
      createdAt: '2026-09-02T18:16:20.000Z',
      updatedAt: '2026-09-02T18:16:20.000Z',
    }));
    await writeFile(config.jobsFile, `${JSON.stringify({
      version: 1,
      jobs: legacyJobs,
    })}\n`, 'utf8');

    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket } = await authorize(bridge);
    const messages: Array<WsEnvelope<string, { code?: string }>> = [];
    socket.on('message', data => {
      messages.push(JSON.parse(data.toString()) as WsEnvelope<string, { code?: string }>);
    });
    socket.send(envelope('extension.hello', 'legacy-ordinary-nowcoder-upgrade', {
      version: APP_VERSION,
      runtimeId: '44444444-4444-4444-8444-444444444444',
    }));
    await vi.waitFor(() => expect(messages).toHaveLength(legacyJobs.length));
    expect(messages.every(message => message.type === 'job.failed')).toBe(true);
    expect(messages.every(message => message.payload.code === 'RECOVERY_LIMIT_EXCEEDED')).toBe(true);
    expect(messages.map(message => message.requestId).sort()).toEqual(
      legacyJobs.map(job => job.id).sort(),
    );
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'job.collect' }));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(messages).toHaveLength(legacyJobs.length);

    const persisted = JSON.parse(await readFile(config.jobsFile, 'utf8')) as {
      jobs: Array<{ status: string; errorCode?: string }>;
    };
    expect(persisted.jobs).toHaveLength(legacyJobs.length);
    expect(persisted.jobs.every(job => job.status === 'needs_attention')).toBe(true);
    expect(persisted.jobs.every(job => job.errorCode === 'RECOVERY_LIMIT_EXCEEDED')).toBe(true);
  });

  it('does not let the FeJourney scheduler implicitly run due collection plans', async () => {
    const root = await temporaryDirectory();
    const onExtensionConnected = vi.spyOn(CollectionPlanService.prototype, 'onExtensionConnected');
    try {
      const bridge = await startBridge({
        port: 0,
        libraryRoot: root,
        configDir: join(root, '.config'),
        enableFeJourneyScheduler: true,
        // Keep this scheduler-isolation test hermetic while exercising startup and shutdown.
        fetch: async () => new Response(null, { status: 503 }),
      });
      handles.push(bridge);
      const { socket } = await authorize(bridge);
      socket.send(envelope('extension.hello', 'fe-journey-without-plan-scheduler', {
        version: APP_VERSION,
        runtimeId: '45454545-4545-4545-8545-454545454545',
      }));
      await waitForExtensionReady(bridge);
      await vi.waitFor(() => {
        expect(onExtensionConnected).toHaveBeenCalledWith(expect.objectContaining({ runDue: false }));
      });
    } finally {
      onExtensionConnected.mockRestore();
    }
  });

  it('replays an ordinary error terminal without repeating its state transition', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
    });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'ordinary-error-replay', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'extension' },
    });
    const terminalFrame = envelope('job.error', created.body.id, {
      code: 'COLLECTION_FAILED', message: '普通任务采集失败', needsAttention: false,
    });
    const firstAck = nextMessage(socket);
    socket.send(terminalFrame);
    await expect(firstAck).resolves.toMatchObject({
      type: 'job.failed', requestId: created.body.id, payload: { code: 'COLLECTION_FAILED' },
    });

    const replayedAck = nextMessage(socket);
    socket.send(terminalFrame);
    await expect(replayedAck).resolves.toMatchObject({
      type: 'job.failed', requestId: created.body.id, payload: { code: 'COLLECTION_FAILED' },
    });
    expect((await requestJson<{ status: string; errorCode?: string }>(
      bridge.url,
      `/v1/jobs/${created.body.id}`,
      { token },
    )).body).toMatchObject({ status: 'failed', errorCode: 'COLLECTION_FAILED' });
  });

  it('redelivers the same fixed Nowcoder child across a same-runtime reconnect without spending recovery budget', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const plans = await CollectionPlanStore.open(config.plansFile);
    const batch = await plans.start('nowcoder-agent-market');
    await plans.markSelectionPending(batch.id);
    const jobs = await JobStore.open(config.jobsFile);
    const first = await jobs.create({
      id: 'same-runtime-first', url: 'https://www.nowcoder.com/discuss/701', requestedBy: 'codex',
      batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    const second = await jobs.create({
      id: 'same-runtime-second', url: 'https://www.nowcoder.com/discuss/702', requestedBy: 'codex',
      batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    await plans.attachRound(batch.id, [first.id, second.id]);
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket: original, token } = await authorize(bridge);
    const firstCollect = nextMessage(original);
    original.send(envelope('extension.hello', 'same-runtime-first-hello', {
      version: APP_VERSION, runtimeId: '11111111-1111-4111-8111-111111111111',
    }));
    expect(await firstCollect).toMatchObject({ type: 'job.collect', requestId: first.id });

    const replacement = await connect(bridge, token);
    const replayedCollect = nextMessage(replacement);
    replacement.send(envelope('extension.hello', 'same-runtime-second-hello', {
      version: APP_VERSION, runtimeId: '11111111-1111-4111-8111-111111111111',
    }));
    expect(await replayedCollect).toMatchObject({ type: 'job.collect', requestId: first.id });
    const afterReconnect = await requestJson<{ status: string; recoveryCount?: number }>(
      bridge.url, `/v1/jobs/${first.id}`, { token },
    );
    expect(afterReconnect.body).toMatchObject({ status: 'dispatched', recoveryCount: 0 });

    const firstAcknowledgement = nextMessage(replacement);
    replacement.send(envelope('job.error', first.id, {
      code: 'COLLECTION_FAILED', message: '测试终态', needsAttention: false,
    }));
    expect(await firstAcknowledgement).toMatchObject({
      type: 'job.failed', requestId: first.id, payload: { code: 'COLLECTION_FAILED' },
    });
    const secondCollect = nextMessage(replacement);
    expect(await secondCollect).toMatchObject({ type: 'job.collect', requestId: second.id });
  });

  it('recovers only the interrupted fixed child in a new Bridge and releases its sibling after terminal', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const plans = await CollectionPlanStore.open(config.plansFile);
    const batch = await plans.start('nowcoder-agent-market');
    await plans.markSelectionPending(batch.id);
    const jobs = await JobStore.open(config.jobsFile);
    const interrupted = await jobs.create({
      id: 'new-runtime-recovered-current', url: 'https://www.nowcoder.com/discuss/703', requestedBy: 'codex',
      batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    const sibling = await jobs.create({
      id: 'new-runtime-recovered-sibling', url: 'https://www.nowcoder.com/discuss/704', requestedBy: 'codex',
      batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    await plans.attachRound(batch.id, [interrupted.id, sibling.id]);
    await jobs.transition(interrupted.id, 'collecting');

    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    const recoveredCollect = nextMessage(socket);
    socket.send(envelope('extension.hello', 'new-runtime-recovery', {
      version: APP_VERSION, runtimeId: '33333333-3333-4333-8333-333333333333',
    }));
    expect(await recoveredCollect).toMatchObject({ type: 'job.collect', requestId: interrupted.id });
    const recovered = await requestJson<{ status: string; recoveryCount?: number }>(
      bridge.url, `/v1/jobs/${interrupted.id}`, { token },
    );
    expect(recovered.body).toMatchObject({ status: 'dispatched', recoveryCount: 1 });
    expect((await JobStore.open(config.jobsFile)).get(sibling.id)).toMatchObject({ status: 'queued' });

    const acknowledgement = nextMessage(socket);
    socket.send(envelope('job.error', interrupted.id, {
      code: 'COLLECTION_FAILED', message: '模拟已恢复任务终态', needsAttention: false,
    }));
    expect(await acknowledgement).toMatchObject({ type: 'job.failed', requestId: interrupted.id });
    expect(await nextMessage(socket)).toMatchObject({ type: 'job.collect', requestId: sibling.id });
  });

  it('stops a fixed batch on the second lost-worker recovery before any queued sibling dispatches', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const plans = await CollectionPlanStore.open(config.plansFile);
    const batch = await plans.start('nowcoder-agent-market');
    await plans.markSelectionPending(batch.id);
    const jobs = await JobStore.open(config.jobsFile);
    const interrupted = await jobs.create({
      id: 'recovery-limit-current', url: 'https://www.nowcoder.com/discuss/711', requestedBy: 'codex',
      batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    const sibling = await jobs.create({
      id: 'recovery-limit-sibling', url: 'https://www.nowcoder.com/discuss/712', requestedBy: 'codex',
      batchId: batch.id, planId: 'nowcoder-agent-market',
    });
    await plans.attachRound(batch.id, [interrupted.id, sibling.id]);
    await jobs.transition(interrupted.id, 'collecting');

    // First new Bridge process represents the first lost Service Worker: startup recovery
    // preserves this child as the sole one-time retry and dispatches no queued sibling.
    const firstBridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(firstBridge);
    const { socket: firstSocket, token } = await authorize(firstBridge);
    const firstCollect = nextMessage(firstSocket);
    firstSocket.send(envelope('extension.hello', 'first-lost-worker-recovery', {
      version: APP_VERSION, runtimeId: '11111111-1111-4111-8111-111111111111',
    }));
    expect(await firstCollect).toMatchObject({ type: 'job.collect', requestId: interrupted.id });
    const firstRecovery = await requestJson<{ status: string; recoveryCount?: number }>(
      firstBridge.url, `/v1/jobs/${interrupted.id}`, { token },
    );
    expect(firstRecovery.body).toMatchObject({ status: 'dispatched', recoveryCount: 1 });
    expect((await JobStore.open(config.jobsFile)).get(sibling.id)).toMatchObject({ status: 'queued' });
    await firstBridge.close();
    handles.splice(handles.indexOf(firstBridge), 1);

    // A second actual Bridge process is another lost Service Worker. It must terminalize the
    // recovered child and close the parent fence before any queued sibling can fan out.
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket, token: replacementToken } = await authorize(bridge);
    const recoveryLimitAck = nextMessage(socket);
    socket.send(envelope('extension.hello', 'second-lost-worker-recovery', {
      version: APP_VERSION, runtimeId: '22222222-2222-4222-8222-222222222222',
    }));
    expect(await recoveryLimitAck).toMatchObject({
      type: 'job.failed', requestId: interrupted.id, payload: { code: 'RECOVERY_LIMIT_EXCEEDED' },
    });
    await expectNoMessage(socket, 250);
    const recovered = await requestJson<{ status: string; errorCode?: string; recoveryCount?: number }>(
      bridge.url, `/v1/jobs/${interrupted.id}`, { token: replacementToken },
    );
    expect(recovered.body).toMatchObject({
      status: 'needs_attention', errorCode: 'RECOVERY_LIMIT_EXCEEDED', recoveryCount: 1,
    });
    const batches = await requestJson<{ batches: Array<{ status: string }> }>(
      bridge.url, '/v1/plans/batches?limit=1&planId=nowcoder-agent-market', { token: replacementToken },
    );
    expect(batches.body.batches[0]).toMatchObject({ status: 'completed_with_attention' });
    const persisted = await JobStore.open(config.jobsFile);
    expect(persisted.get(sibling.id)).toMatchObject({
      status: 'failed', errorCode: 'PLAN_STOPPED_AFTER_RECOVERY_LIMIT',
    });
  });

  it('stops the fixed Nowcoder batch when the extension reports its typed tab-close error', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir,
      fetch: async input => new Response([
        '<a href="/discuss/801">一</a>', '<a href="/discuss/802">二</a>',
        '<a href="/discuss/803">三</a>', '<a href="/discuss/804">四</a>',
        '<a href="/discuss/805">五</a>', '<a href="/discuss/806">六</a>',
        '<a href="/discuss/807">七</a>', '<a href="/discuss/808">八</a>',
      ].join('')),
    });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'typed-tab-close-fixed-plan', { version: APP_VERSION }));
    const collect = nextMessage(socket);
    const started = await requestJson<{ id: string }>(bridge.url, '/v1/plans/run', {
      method: 'POST', token, body: { planId: 'nowcoder-agent-market', force: true },
    });
    const active = await collect;
    expect(active).toMatchObject({ type: 'job.collect' });
    const acknowledgement = nextMessage(socket);
    socket.send(envelope('job.error', active.requestId, {
      code: 'TAB_CLOSED_BY_USER', message: '采集标签页已关闭', needsAttention: false,
    }));
    expect(await acknowledgement).toMatchObject({
      type: 'job.failed', requestId: active.requestId, payload: { code: 'TAB_CLOSED_BY_USER' },
    });
    await vi.waitFor(async () => {
      const batches = await requestJson<{ batches: Array<{ status: string; error?: string }> }>(
        bridge.url,
        '/v1/plans/batches?limit=1&planId=nowcoder-agent-market',
        { token },
      );
      expect(batches.body.batches[0]).toMatchObject({
        status: 'completed_with_attention', error: expect.stringContaining('用户关闭'),
      });
    });
    await expectNoMessage(socket, 250);
    const reconnect = await connect(bridge, token);
    const replayedStopAck = nextMessage(reconnect);
    reconnect.send(envelope('extension.hello', 'typed-tab-close-after-stop', { version: APP_VERSION }));
    await expect(replayedStopAck).resolves.toMatchObject({
      type: 'job.failed', requestId: active.requestId, payload: { code: 'TAB_CLOSED_BY_USER' },
    });
    await expectNoMessage(reconnect, 250);
    const persisted = await JobStore.open(join(root, '_catalog', 'jobs.json'));
    expect(persisted.list().filter(job => job.batchId === started.body.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: active.requestId, errorCode: 'TAB_CLOSED_BY_USER' }),
      expect.objectContaining({ errorCode: 'PLAN_STOPPED_BY_USER' }),
    ]));
  });

  it('stamps plan identity into every plan document before saving it', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension-plan-metadata', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));

    const planCommandPromise = nextMessage<{
      batchId: string;
      planId: string;
      attempt: string;
    }>(socket);
    const startedPromise = requestJson<{ id: string }>(bridge.url, '/v1/plans/run', {
      method: 'POST',
      token,
      body: { planId: 'zsxq-chen-teacher', force: true },
    });
    const planCommand = await planCommandPromise;
    acknowledgePlanStart(socket, planCommand);
    const started = await startedPromise;
    const topicUrl = 'https://wx.zsxq.com/group/48844584441158/topic/844444444444444';
    const dispatchedPlanJob = nextMessage<{ url: string; interactive: boolean }>(socket);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        url: topicUrl,
        requestedBy: 'codex',
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: planCommand.payload.attempt,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    await expect(dispatchedPlanJob).resolves.toMatchObject({
      requestId: created.body.id,
      payload: { url: topicUrl, interactive: false },
    });
    socket.send(envelope('job.progress', created.body.id, { stage: 'collecting' }));
    socket.send(envelope('job.result', created.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: topicUrl,
        canonicalUrl: topicUrl,
        title: '批次元数据测试',
        truncated: false,
        sourceMetadata: {
          authorRole: 'member',
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        },
      }),
    }));

    let outputPath: string | undefined;
    await vi.waitFor(async () => {
      const saved = await requestJson<{ status: string; outputPath?: string }>(
        bridge.url,
        `/v1/jobs/${created.body.id}`,
        { token },
      );
      expect(saved.body.status).toBe('saved');
      outputPath = saved.body.outputPath;
    });
    const source = JSON.parse(await readFile(join(outputPath!, '..', 'source.json'), 'utf8')) as {
      document: CollectedDocument;
    };
    expect(source.document.sourceMetadata).toMatchObject({
      authorRole: 'member',
      planId: 'zsxq-chen-teacher',
      batchId: started.body.id,
    });
  });


  it('keeps fe-journey collection disabled without its fixed sink', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'sinks.json'),
      JSON.stringify({ sinks: { markdown: { type: 'markdown' } }, routes: {} }),
    );
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { token } = await authorize(bridge);

    const status = await requestJson<{ enabled: boolean }>(
      bridge.url,
      '/v1/fe-journey/status',
      { token },
    );
    expect(status).toMatchObject({ status: 200, body: { enabled: false } });
    const unauthorized = await requestJson(bridge.url, '/v1/fe-journey/collect', {
      method: 'POST',
      body: { force: true },
    });
    expect(unauthorized.status).toBe(401);
    const disabled = await requestJson<{ error: { code: string } }>(
      bridge.url,
      '/v1/fe-journey/collect',
      { method: 'POST', token, body: { force: true } },
    );
    expect(disabled).toMatchObject({
      status: 409,
      body: { error: { code: 'FE_JOURNEY_DISABLED' } },
    });
  });

  it('keeps the Bridge available when the optional fe-journey candidate index is corrupt', async () => {
    const root = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(join(root, '_catalog'), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(root, '_catalog', 'fe-journey.json'), '{broken-json', 'utf8');
    await writeFile(
      join(configDir, 'sinks.json'),
      JSON.stringify({
        sinks: {
          markdown: { type: 'markdown' },
          'fe-journey': { type: 'repo-inbox', repoPath: repo, commit: false, push: false },
        },
        routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
      }),
    );
    const queued = await (await JobStore.open(join(root, '_catalog', 'jobs.json'))).create({
      id: 'queued-nowcoder-with-corrupt-index',
      url: 'https://nowcoder.com/discuss/9301',
      requestedBy: 'codex',
    });

    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { token } = await authorize(bridge);
    const health = await requestJson<{ ok: boolean }>(bridge.url, '/health');
    expect(health).toMatchObject({ status: 200, body: { ok: true } });
    const status = await requestJson<{ enabled: boolean; error?: string }>(
      bridge.url,
      '/v1/fe-journey/status',
      { token },
    );
    expect(status).toMatchObject({
      status: 200,
      body: {
        enabled: false,
        error: expect.stringContaining('候选索引'),
      },
    });

    const socket = sockets.at(-1)!;
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    await vi.waitFor(async () => {
      const failed = await requestJson<{ status: string; errorCode?: string }>(
        bridge.url,
        `/v1/jobs/${queued.id}`,
        { token },
      );
      expect(failed.body).toMatchObject({
        status: 'failed',
        errorCode: 'FE_JOURNEY_INDEX_UNAVAILABLE',
      });
    });
    await expectNoMessage(socket);

    const zsxqSocket = await connect(bridge, token);
    zsxqSocket.send(envelope('extension.hello', 'complete-content-extension', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);
    const zsxqUrl = 'https://wx.zsxq.com/group/1/topic/533333333333333';
    const dispatchedPromise = nextMessage<{ url: string; interactive: boolean }>(zsxqSocket);
    const zsxq = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: zsxqUrl, requestedBy: 'codex' },
    });
    await expect(dispatchedPromise).resolves.toMatchObject({
      type: 'job.collect',
      requestId: zsxq.body.id,
      payload: { url: zsxqUrl, interactive: true },
    });
    zsxqSocket.send(envelope('job.progress', zsxq.body.id, { stage: 'collecting' }));
    zsxqSocket.send(envelope('job.result', zsxq.body.id, {
      document: document({
        source: 'zsxq',
        kind: 'post',
        url: zsxqUrl,
        canonicalUrl: zsxqUrl,
        title: '索引损坏时仍可采集的知识星球帖子',
        truncated: false,
        sourceMetadata: {
          contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        },
      }),
    }));
    await vi.waitFor(async () => {
      const saved = await requestJson<{ status: string }>(
        bridge.url,
        `/v1/jobs/${zsxq.body.id}`,
        { token },
      );
      expect(saved.body.status).toBe('saved');
    });
    expect(zsxqSocket.readyState).toBe(WebSocket.OPEN);
  });

  it.each([
    ['invalid JSON', '{broken-json'],
    ['invalid source state', JSON.stringify({ version: 1, sources: { nowcoder: null, github: {} } })],
  ])('keeps the Bridge available when the optional fe-journey schedule state has %s', async (_label, state) => {
    const root = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'fe-journey-state.json'), state, 'utf8');
    await writeFile(
      join(configDir, 'sinks.json'),
      JSON.stringify({
        sinks: {
          markdown: { type: 'markdown' },
          'fe-journey': { type: 'repo-inbox', repoPath: repo, commit: false, push: false },
        },
        routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
      }),
    );

    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { token } = await authorize(bridge);
    expect(await requestJson<{ ok: boolean }>(bridge.url, '/health')).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(await requestJson<{ enabled: boolean; error?: string }>(
      bridge.url,
      '/v1/fe-journey/status',
      { token },
    )).toMatchObject({
      status: 200,
      body: {
        enabled: false,
        error: expect.stringContaining('采集状态'),
      },
    });
  });

  it('runs the fixed fe-journey preset and rejects caller-supplied search settings', async () => {
    const root = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'sinks.json'),
      JSON.stringify({
        sinks: {
          markdown: { type: 'markdown' },
          'fe-journey': {
            type: 'repo-inbox',
            repoPath: repo,
            commit: false,
            push: false,
          },
        },
        routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
      }),
    );
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new globalThis.URL(String(input));
      if (url.hostname === 'www.nowcoder.com') {
        return new Response('<a href="/discuss/9001?sourceSSR=search">真实形态面经</a>');
      }
      if (url.pathname === '/search/repositories') return Response.json({ items: [] });
      return new Response('unexpected', { status: 500 });
    });
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir, fetch: fetcher });
    handles.push(bridge);
    const { token } = await authorize(bridge);

    const rejected = await requestJson(bridge.url, '/v1/fe-journey/collect', {
      method: 'POST',
      token,
      body: { force: true, queries: ['自定义搜索'] },
    });
    expect(rejected.status).toBe(400);

    const collected = await requestJson<{
      sources: { nowcoder: { status: string; enqueued: number }; github: { status: string } };
    }>(bridge.url, '/v1/fe-journey/collect', {
      method: 'POST',
      token,
      body: { force: true },
    });
    expect(collected.status).toBe(200);
    expect(
      collected.body.sources.nowcoder,
      JSON.stringify(collected.body.sources),
    ).toMatchObject({ status: 'completed', enqueued: 1 });
    expect(
      collected.body.sources.github,
      JSON.stringify(collected.body.sources),
    ).toMatchObject({ status: 'completed' });
    const jobs = JSON.parse(await readFile(join(root, '_catalog', 'jobs.json'), 'utf8'));
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({
      url: 'https://www.nowcoder.com/discuss/9001',
      status: 'queued',
      requestedBy: 'codex',
    });
  });

  it('rediscovers and requeues a failed fixed-preset Nowcoder job', async () => {
    const root = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'sinks.json'),
      JSON.stringify({
        sinks: {
          markdown: { type: 'markdown' },
          'fe-journey': {
            type: 'repo-inbox',
            repoPath: repo,
            commit: false,
            push: false,
          },
        },
        routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
      }),
    );
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new globalThis.URL(String(input));
      if (url.hostname === 'www.nowcoder.com') {
        return new Response('<a href="/discuss/9201?sourceSSR=search">可重试面经</a>');
      }
      if (url.pathname === '/search/repositories') return Response.json({ items: [] });
      return new Response('unexpected', { status: 500 });
    });
    const options = { port: 0, libraryRoot: root, configDir, fetch: fetcher };
    const first = await startBridge(options);
    handles.push(first);
    const firstAuth = await authorize(first);
    const firstRun = await requestJson<{
      sources: { nowcoder: { enqueued: number } };
    }>(first.url, '/v1/fe-journey/collect', {
      method: 'POST',
      token: firstAuth.token,
      body: { force: true },
    });
    expect(firstRun.body.sources.nowcoder.enqueued).toBe(1);
    await first.close();
    handles.splice(handles.indexOf(first), 1);

    const jobsPath = join(root, '_catalog', 'jobs.json');
    const jobStore = await JobStore.open(jobsPath);
    const failedId = jobStore.list()[0]?.id;
    expect(failedId).toBeDefined();
    await jobStore.transition(failedId!, 'failed', {
      errorCode: 'EXTRACT_FAILED',
      errorMessage: 'temporary extraction failure',
    });

    const restarted = await startBridge(options);
    handles.push(restarted);
    const restartedAuth = await authorize(restarted);
    const retried = await requestJson<{
      sources: { nowcoder: { status: string; enqueued: number } };
    }>(restarted.url, '/v1/fe-journey/collect', {
      method: 'POST',
      token: restartedAuth.token,
      body: { force: true },
    });
    expect(retried.body.sources.nowcoder).toMatchObject({ status: 'completed', enqueued: 1 });
    const persisted = JSON.parse(await readFile(jobsPath, 'utf8')) as {
      jobs: Array<{ status: string; errorCode?: string; errorMessage?: string }>;
    };
    expect(persisted.jobs).toHaveLength(1);
    expect(persisted.jobs[0]).toMatchObject({ status: 'queued' });
    expect(persisted.jobs[0]).not.toHaveProperty('errorCode');
    expect(persisted.jobs[0]).not.toHaveProperty('errorMessage');
  });

  it('authenticates, dispatches, saves, and ignores a duplicate result', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'sinks.json'),
      `${JSON.stringify({ sinks: { markdown: { type: 'markdown' } }, routes: {} }, null, 2)}\n`,
      'utf8',
    );
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir,
      fetch: async () => new Response(null, { status: 404 }),
    });
    handles.push(bridge);

    const health = await requestJson<{
      ok: boolean;
      version: string;
      trustedExtensionId: string;
      extensionConnected: boolean;
      routing: { sinks: unknown[]; defaults: Record<string, string[]> };
    }>(bridge.url, '/health');
    expect(health).toEqual({
      status: 200,
      body: {
        ok: true,
        version: APP_VERSION,
        trustedExtensionId: TRUSTED_EXTENSION_ID,
        extensionConnected: false,
        directedRunActive: false,
        // 没有配置任何仓库去向时同步无处可去，如实给空表——绝不假装能同步。
        syncTargets: {},
        // 默认无 sinks.json：只有本机库，所有来源都回退到它；分类清单供侧栏下拉。
        routing: {
          sinks: [
            {
              id: 'markdown',
              label: '本机库',
              categories: [
                '前端开发', '人工智能', '产品与设计', '商业与投资',
                '效率与工具', '生活与随笔', '其他',
              ],
            },
          ],
          defaults: {
            wechat: ['markdown'],
            zsxq: ['markdown'],
            nowcoder: ['markdown'],
            github: ['markdown'],
          },
        },
      },
    });
    const unauthorized = await requestJson(bridge.url, '/v1/jobs', {
      method: 'POST',
      body: { url: URL },
    });
    expect(unauthorized.status).toBe(401);
    // 配对接口早已移除：**没令牌一律 401**（/v1/* 默认受保护，也不泄露有哪些接口）。
    const pairingWithoutToken = await requestJson(bridge.url, `/v1/${['pa', 'ir'].join('')}`, {
      method: 'POST',
      body: { code: '123456' },
    });
    expect(pairingWithoutToken.status).toBe(401);

    const { socket, token } = await authorize(bridge);
    // 带上令牌才看得出它是真的没了，而不是被鉴权挡住。
    const removedPairing = await requestJson(bridge.url, `/v1/${['pa', 'ir'].join('')}`, {
      method: 'POST',
      token,
      body: { code: '123456' },
    });
    expect(removedPairing.status).toBe(404);
    expect(token.length).toBeGreaterThanOrEqual(32);
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const dispatchedPromise = nextMessage<{ url: string; interactive: boolean }>(socket);
    const jobResponse = await requestJson<{ id: string; status: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'codex' },
    });
    expect(jobResponse.status).toBe(202);
    const job = jobResponse.body;
    const dispatched = await dispatchedPromise;
    expect(dispatched).toMatchObject({
      type: 'job.collect',
      requestId: job.id,
      payload: { url: URL, interactive: true },
    });

    socket.send(envelope('job.progress', job.id, { stage: 'collecting' }));
    socket.send(envelope('job.result', job.id, { document: document() }));

    let saved: { status: string; outputPath?: string } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await requestJson<typeof saved>(bridge.url, `/v1/jobs/${job.id}`, { token });
      saved = response.body;
      if (saved?.status === 'saved') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(saved?.status).toBe('saved');
    expect(saved?.outputPath).toMatch(/index\.md$/);
    expect(await readFile(saved!.outputPath!, 'utf8')).toContain('Bridge 集成测试文章');

    socket.send(envelope('job.result', job.id, { document: document() }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const catalog = JSON.parse(await readFile(join(root, '_catalog', 'index.json'), 'utf8')) as unknown[];
    expect(catalog).toHaveLength(1);
  });

  it('recovers a queued job after restart and dispatches it on extension reconnect', async () => {
    const root = await temporaryDirectory();
    const options = { port: 0, libraryRoot: root, configDir: join(root, '.config') };
    const first = await startBridge(options);
    handles.push(first);
    const { token } = await authorize(first);
    const job = await requestJson<{ id: string }>(first.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'cli' },
    });
    await first.close();
    handles.splice(handles.indexOf(first), 1);

    const restarted = await startBridge(options);
    handles.push(restarted);
    const authorized = await authorize(restarted);
    expect(authorized.token).toBe(token);
    const socket = authorized.socket;
    const dispatchedPromise = nextMessage<{ url: string }>(socket);
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const dispatched = await dispatchedPromise;

    expect(dispatched).toMatchObject({ type: 'job.collect', requestId: job.body.id });
  });

  it('requeues an in-flight job when the extension socket reconnects', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const authorized = await authorize(bridge);
    const token = authorized.token;
    const firstSocket = authorized.socket;
    firstSocket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const firstDispatch = nextMessage<{ url: string }>(firstSocket);
    const job = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'codex' },
    });
    await firstDispatch;
    firstSocket.close();
    await new Promise<void>(resolve => firstSocket.once('close', () => resolve()));

    const secondSocket = await connect(bridge, token);
    const redispatch = nextMessage<{ url: string }>(secondSocket);
    secondSocket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));

    expect(await redispatch).toMatchObject({ type: 'job.collect', requestId: job.body.id });
  });

  it('lets an extension-requested current-page job report progress and save without redispatch', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);

    const noDispatch = expectNoMessage(socket);
    const created = await requestJson<{ id: string; status: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'extension' },
    });
    expect(created).toMatchObject({ status: 202, body: { status: 'queued' } });
    await noDispatch;

    const savedMessage = nextMessage<{
      type: string;
      requestId: string;
      payload: { outputPath: string; results: { sinkId: string; ok: boolean }[] };
    }>(socket);
    socket.send(envelope('job.progress', created.body.id, { stage: 'collecting' }));
    socket.send(envelope('job.result', created.body.id, {
      document: document({ userCategory: '当前页分类', userTags: ['当前页', '覆盖值'] }),
    }));
    const saved = await savedMessage;

    // 侧边栏「已保存」屏依赖 job.saved 载荷里的 outputPath（多 sink 后的首要产出）。
    expect(saved).toMatchObject({ type: 'job.saved', requestId: created.body.id });
    expect(saved.payload.outputPath).toMatch(/index\.md$/);
    expect(saved.payload.results.some(result => result.sinkId === 'markdown' && result.ok)).toBe(true);
    const status = await requestJson<{ status: string; outputPath: string }>(
      bridge.url,
      `/v1/jobs/${created.body.id}`,
      { token },
    );
    expect(status.body.status).toBe('saved');
    const markdown = await readFile(status.body.outputPath, 'utf8');
    expect(markdown).toContain('category: "当前页分类"');
    expect(markdown).toContain('  - "当前页"');
    expect(markdown).toContain('  - "覆盖值"');
  });

  it('dispatches an abandoned extension-requested queued job after extension reconnect', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'extension', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);

    const noInitialDispatch = expectNoMessage(first.socket);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: { url: URL, requestedBy: 'extension' },
    });
    await noInitialDispatch;
    first.socket.close();
    await new Promise<void>(resolve => first.socket.once('close', () => resolve()));

    const second = await connect(bridge, first.token);
    const redispatch = nextMessage<{ url: string }>(second);
    second.send(envelope('extension.hello', 'extension', { version: APP_VERSION }));

    await expect(redispatch).resolves.toMatchObject({
      type: 'job.collect',
      requestId: created.body.id,
      payload: { url: URL },
    });
  });

  it('closes a peer that returns content for a different URL', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const dispatchedPromise = nextMessage<{ url: string }>(socket);
    const job = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'codex' },
    });
    await dispatchedPromise;
    const closed = new Promise<number>(resolve => {
      socket.once('close', code => resolve(code));
    });

    socket.send(
      envelope('job.result', job.body.id, {
        document: document({
          url: 'https://mp.weixin.qq.com/s/other',
          canonicalUrl: 'https://mp.weixin.qq.com/s/other',
        }),
      }),
    );

    await expect(closed).resolves.toBe(1008);
    const status = await requestJson<{ status: string }>(bridge.url, `/v1/jobs/${job.body.id}`, {
      token,
    });
    expect(status.body.status).not.toBe('saved');
  });

  it('reveals only an existing path inside the configured library', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'saved.md');
    await writeFile(target, 'saved');
    const reveal = vi.fn(async () => undefined);
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
      reveal,
    });
    handles.push(bridge);
    const { token } = await authorize(bridge);

    const accepted = await requestJson(bridge.url, '/v1/reveal', {
      method: 'POST',
      token,
      body: { path: target },
    });
    const rejected = await requestJson(bridge.url, '/v1/reveal', {
      method: 'POST',
      token,
      body: { path: join(root, '..', 'outside.md') },
    });

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(target);
  });

  it('reveals entries written into a configured repo inbox, not just the library', async () => {
    // 选了「只存到 xx 收件箱」时，产出路径根本不在本机库下。
    // 只认库根目录会把这些条目一律 400，用户点「在文件夹中查看」毫无反应。
    const root = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'sinks.json'),
      JSON.stringify({
        sinks: {
          markdown: { type: 'markdown' },
          'life-teachers': { type: 'repo-inbox', repoPath: repo, label: 'life-teachers 收件箱' },
        },
        routes: { zsxq: ['life-teachers'] },
      }),
    );
    const entry = join(repo, '_inbox', 'zsxq', 'x', 'original.md');
    await mkdir(join(entry, '..'), { recursive: true });
    await writeFile(entry, '正文');
    const outside = join(root, 'outside.md');
    await writeFile(outside, '库外文件');

    const reveal = vi.fn(async () => undefined);
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir, reveal });
    handles.push(bridge);
    const { token } = await authorize(bridge);

    const accepted = await requestJson(bridge.url, '/v1/reveal', {
      method: 'POST',
      token,
      body: { path: entry },
    });
    // 放行范围严格等于「我们自己写过内容的根目录」，不多一个。
    const rejected = await requestJson(bridge.url, '/v1/reveal', {
      method: 'POST',
      token,
      body: { path: join(repo, '..', 'elsewhere.md') },
    });

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it('已入库的读取与同步接口真的挂上了（不是静静地 404）', async () => {
    // 回归：这两个接口曾因为漏进「受保护路由白名单」而上线即 404，
    // 扩展把 404 解读成「这一条已经不在本机知识库里了」，指错了方向。
    // 单测直接调库函数是测不出这一层的——必须走 HTTP。
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
    });
    handles.push(bridge);
    const { token } = await authorize(bridge);

    // 空库：列表通、读取返回 404 但**带明确的业务错误码**，同步是空操作。
    const list = await requestJson<{ entries: unknown[] }>(bridge.url, '/v1/library', { token });
    expect(list.status).toBe(200);
    const zsxqIndex = await requestJson<{ entries: unknown[] }>(
      bridge.url,
      '/v1/library/zsxq-index',
      { token },
    );
    expect(zsxqIndex).toMatchObject({ status: 200, body: { entries: [] } });

    const missing = await requestJson<{ error: { code: string } }>(
      bridge.url,
      '/v1/library/entry?id=nope',
      { token },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ENTRY_NOT_FOUND');

    const sync = await requestJson<{ synced: number; failed: number }>(
      bridge.url,
      '/v1/library/sync',
      { method: 'POST', token, body: { ids: [] } },
    );
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ synced: 0, failed: 0 });

    // 没带令牌一律 401，绝不是 404——「默认受保护」这条不能因为改写而松掉。
    const unauthorized = await requestJson(bridge.url, '/v1/library/entry?id=nope', {});
    expect(unauthorized.status).toBe(401);
  });

  it('rejects untrusted bootstrap Origins without creating an access token', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);

    await expectWebSocketRejected(bridge, '?bootstrap=1', `chrome-extension://${'a'.repeat(32)}`);
    await expectWebSocketRejected(bridge, '?bootstrap=1', 'https://example.com');

    await expect(readFile(join(configDir, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires bootstrap or a valid token from a trusted Origin', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);

    await expectWebSocketRejected(bridge, '', EXTENSION_ORIGIN);
    await expectWebSocketRejected(bridge, '?token=invalid', EXTENSION_ORIGIN);

    const authorized = await authorize(bridge, `extension://${TRUSTED_EXTENSION_ID}`);
    expect(authorized.token.length).toBeGreaterThanOrEqual(32);
  });

  it('replaces an older extension peer with an application close while keeping the new peer usable', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'extension-a', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);
    const firstClosed = new Promise<{ code: number; reason: string }>(resolve => {
      first.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    const second = await connect(bridge, first.token);
    await expect(firstClosed).resolves.toEqual({
      code: EXTENSION_REPLACED_CLOSE_CODE,
      reason: EXTENSION_REPLACED_CLOSE_REASON,
    });
    second.send(envelope('extension.hello', 'extension-b', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);
    const pong = nextMessage(second);
    second.send(envelope('bridge.ping', 'replacement-check', {}));

    await expect(pong).resolves.toMatchObject({
      type: 'bridge.pong',
      requestId: 'replacement-check',
    });
    expect(second.readyState).toBe(WebSocket.OPEN);
  });
});

/**
 * 「插件是不是最新的」只有一个可靠依据：浏览器真正加载的那份产物里的构建标记。
 * 拿 git HEAD 去比是不行的——构建失败时 HEAD 已经往前走了而产物没动，
 * 插件会永远显示「有新版」，自动重载还会因此反复重启。
 */
describe('health 里的产物构建标记', () => {
  async function bridgeWithArtifacts(buildId?: string): Promise<BridgeHandle> {
    const root = await temporaryDirectory();
    if (buildId !== undefined) {
      await mkdir(join(root, 'artifacts', 'data-collector-extension'), { recursive: true });
      await writeFile(
        join(root, 'artifacts', 'data-collector-extension', 'build-id.txt'),
        `${buildId}\n`,
        'utf8',
      );
    }
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      // 别在测试里真去拉代码 / 真去构建。
      runUpdate: async () => ({
        changed: false,
        commit: 'abc1234',
        message: '已是最新。',
        checkedAt: '2026-08-19T00:00:00.000Z',
      }),
    });
    handles.push(bridge);
    return bridge;
  }

  it('把磁盘上那份产物的构建标记原样报出来', async () => {
    const bridge = await bridgeWithArtifacts('v0.4.6 · 9f3c210');
    const health = await requestJson<{ buildId?: string }>(bridge.url, '/health');
    expect(health.body.buildId).toBe('v0.4.6 · 9f3c210');
  });

  it('还没打包过就不报，绝不编一个', async () => {
    // 编一个就会让扩展以为「有新版」，自动重载一次又一次，永远对不上。
    const bridge = await bridgeWithArtifacts();
    const health = await requestJson<{ buildId?: string }>(bridge.url, '/health');
    expect(health.body.buildId).toBeUndefined();
  });

  it('does not run a ZSXQ plan until the connected extension build exactly matches the artifact', async () => {
    const expectedBuild = `v${APP_VERSION} · final-build`;
    const bridge = await bridgeWithArtifacts(expectedBuild);
    const { socket: staleSocket, token } = await authorize(bridge);
    staleSocket.send(envelope('extension.hello', 'stale-same-version', {
      version: APP_VERSION,
      buildId: `v${APP_VERSION} · earlier-dirty-build`,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    await waitForExtensionReady(bridge);

    const noStalePlan = expectNoMessage(staleSocket);
    const started = await requestJson<{ id: string }>(bridge.url, '/v1/plans/run', {
      method: 'POST',
      token,
      body: { planId: 'zsxq-chen-teacher', force: true },
    });
    expect(started.status).toBe(202);
    await noStalePlan;

    const currentSocket = await connect(bridge, token);
    currentSocket.send(envelope('extension.hello', 'exact-artifact-build', {
      version: APP_VERSION,
      buildId: expectedBuild,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    const command = await nextMessage<{ batchId: string; planId: string; attempt: string }>(currentSocket);
    expect(command).toMatchObject({
      type: 'plan.collect',
      payload: {
        batchId: started.body.id,
        planId: 'zsxq-chen-teacher',
        attempt: expect.stringMatching(/^[a-f0-9]{16}$/),
      },
    });
    acknowledgePlanStart(currentSocket, command);
  });
});

/**
 * 服务自己也得重启一次，拉下来的服务端代码才作数——进程跑的是内存里那份旧的。
 * 登录项会立刻把它拉起来，所以「退出」就等于「重启」。
 */
describe('自更新后的重启时机', () => {
  async function bridgeWithUpdate(
    exit: () => void,
    outcome: () => { changed: boolean; buildFailed?: boolean },
  ): Promise<BridgeHandle> {
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 20,
      exit,
      runUpdate: async () => ({
        commit: 'abc1234',
        message: '已更新并完成构建。',
        checkedAt: '2026-08-19T00:00:00.000Z',
        ...outcome(),
      }),
    });
    handles.push(bridge);
    return bridge;
  }

  it('没人连着、也没任务在跑时，构建完就重启', async () => {
    const exit = vi.fn();
    await bridgeWithUpdate(exit, () => ({ changed: true }));
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it('构建失败时不重启——产物还是旧的，换一次进程毫无意义', async () => {
    const exit = vi.fn();
    await bridgeWithUpdate(exit, () => ({ changed: true, buildFailed: true }));
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(exit).not.toHaveBeenCalled();
  });

  it('上一轮更新检查未结束时不会并发启动下一轮', async () => {
    const root = await temporaryDirectory();
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const runUpdate = vi.fn(async () => {
      await updateGate;
      return {
        changed: false,
        commit: 'abc1234',
        message: '已是最新。',
        checkedAt: '2026-08-25T00:00:00.000Z',
      };
    });
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 20,
      runUpdate,
    });
    handles.push(bridge);

    await vi.waitFor(() => expect(runUpdate).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(runUpdate).toHaveBeenCalledOnce();

    releaseUpdate();
  });

  it('扩展连着时绝不重启，等它断开再说', async () => {
    // 采集途中断掉 WebSocket，正在跑的那一批当场失败——绝不为了更新打断用户手头的事。
    const exit = vi.fn();
    let changed = false;
    const bridge = await bridgeWithUpdate(exit, () => ({ changed }));
    const { socket } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension-a', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);

    changed = true;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(exit).not.toHaveBeenCalled();

    socket.close();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it.each([
    { failure: 'target socket is replaced', mode: 'replace' as const },
    { failure: 'target socket disconnects', mode: 'disconnect' as const },
    { failure: 'artifact build drifts', mode: 'build-drift' as const },
  ])('fails the active ZSXQ attempt if $failure during artifact attestation', async ({ mode }) => {
    const root = await temporaryDirectory();
    const buildId = `v${APP_VERSION} · guarded-plan-dispatch-${mode}`;
    let currentBuildId = buildId;
    await mkdir(join(root, 'artifacts', 'data-collector-extension'), { recursive: true });
    await writeFile(
      join(root, 'artifacts', 'data-collector-extension', 'build-id.txt'),
      `${buildId}\n`,
      'utf8',
    );
    let dispatchReadsArmed = false;
    let armedReads = 0;
    let dispatchReadBlocked = false;
    let releaseDispatchRead!: () => void;
    const dispatchReadGate = new Promise<void>(resolve => { releaseDispatchRead = resolve; });
    let blockUpdate = false;
    let resumedUpdateFinished = false;
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const runUpdate = vi.fn(async () => {
      if (blockUpdate) {
        await updateGate;
        resumedUpdateFinished = true;
      }
      return {
        changed: false,
        commit: 'abc1234',
        message: '已是最新。',
        checkedAt: '2026-08-25T00:00:00.000Z',
      };
    });
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 20,
      runUpdate,
      readArtifactBuildId: async () => {
        if (dispatchReadsArmed && ++armedReads === 2) {
          dispatchReadBlocked = true;
          await dispatchReadGate;
        }
        return currentBuildId;
      },
    });
    handles.push(bridge);
    try {
      await vi.waitFor(() => expect(runUpdate).toHaveBeenCalled());
      const first = await authorize(bridge);
      first.socket.send(envelope('extension.hello', `guarded-plan-dispatch-${mode}-a`, {
        version: APP_VERSION,
        buildId,
        capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
      }));
      await waitForExtensionReady(bridge);
      const firstMessages: Array<{ type?: string }> = [];
      first.socket.on('message', data => {
        firstMessages.push(JSON.parse(data.toString()) as { type?: string });
      });

      dispatchReadsArmed = true;
      const runRequest = requestJson<CollectionBatch>(bridge.url, '/v1/plans/run', {
        method: 'POST',
        token: first.token,
        body: { planId: 'zsxq-chen-teacher', force: true },
      });
      await vi.waitFor(() => expect(dispatchReadBlocked).toBe(true));
      blockUpdate = true;
      const updateCallsAtAttemptStart = runUpdate.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(runUpdate).toHaveBeenCalledTimes(updateCallsAtAttemptStart);

      const replacementMessages: Array<{ type?: string }> = [];
      if (mode === 'replace') {
        const replacement = await connect(bridge, first.token);
        replacement.on('message', data => {
          replacementMessages.push(JSON.parse(data.toString()) as { type?: string });
        });
        replacement.send(envelope('extension.hello', 'guarded-plan-dispatch-replacement', {
          version: APP_VERSION,
          buildId,
          capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
        }));
        await waitForExtensionReady(bridge);
      } else if (mode === 'disconnect') {
        const closed = new Promise<void>(resolve => first.socket.once('close', () => resolve()));
        first.socket.close();
        await closed;
      } else {
        currentBuildId = `v${APP_VERSION} · drifted-before-plan-dispatch`;
      }
      releaseDispatchRead();

      const started = await runRequest;
      expect(started.status).toBe(202);
      await vi.waitFor(async () => {
        const batches = await requestJson<{ batches: CollectionBatch[] }>(
          bridge.url,
          '/v1/plans/batches?planId=zsxq-chen-teacher&limit=10',
          { token: first.token },
        );
        expect(batches.body.batches.find(batch => batch.id === started.body.id)).toMatchObject({
          status: 'failed',
          error: expect.stringContaining('未派发'),
        });
      });
      expect(firstMessages.some(message => message.type === 'plan.collect')).toBe(false);
      expect(replacementMessages.some(message => message.type === 'plan.collect')).toBe(false);
      await vi.waitFor(() => {
        expect(runUpdate).toHaveBeenCalledTimes(updateCallsAtAttemptStart + 1);
      });
      releaseUpdate();
      await vi.waitFor(() => expect(resumedUpdateFinished).toBe(true));
    } finally {
      releaseDispatchRead();
      releaseUpdate();
    }
  });

  it('defers artifact updates for the whole active ZSXQ attempt', async () => {
    const root = await temporaryDirectory();
    const buildId = `v${APP_VERSION} · attempt-wide-guard`;
    await mkdir(join(root, 'artifacts', 'data-collector-extension'), { recursive: true });
    await writeFile(
      join(root, 'artifacts', 'data-collector-extension', 'build-id.txt'),
      `${buildId}\n`,
      'utf8',
    );
    let releaseInitialUpdate!: () => void;
    const initialUpdateGate = new Promise<void>(resolve => { releaseInitialUpdate = resolve; });
    let blockResumedUpdate = false;
    let releaseResumedUpdate!: () => void;
    const resumedUpdateGate = new Promise<void>(resolve => { releaseResumedUpdate = resolve; });
    let resumedUpdateFinished = false;
    let updateRun = 0;
    const runUpdate = vi.fn(async () => {
      updateRun += 1;
      if (updateRun === 1) await initialUpdateGate;
      else if (blockResumedUpdate) {
        await resumedUpdateGate;
        resumedUpdateFinished = true;
      }
      return {
        changed: false,
        commit: 'abc1234',
        message: '已是最新。',
        checkedAt: '2026-08-25T00:00:00.000Z',
      };
    });
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 20,
      runUpdate,
    });
    handles.push(bridge);
    try {
      await vi.waitFor(() => expect(runUpdate).toHaveBeenCalledOnce());

      const authorized = await authorize(bridge);
      authorized.socket.send(envelope('extension.hello', 'attempt-wide-guard', {
        version: APP_VERSION,
        buildId,
        capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
      }));
      await waitForExtensionReady(bridge);
      const commandPromise = nextMessage<{
        batchId: string;
        attempt: string;
      }>(authorized.socket);
      const queued = await requestJson<CollectionBatch>(bridge.url, '/v1/plans/run', {
        method: 'POST',
        token: authorized.token,
        body: { planId: 'zsxq-chen-teacher', force: true },
      });
      expect(queued.body).toMatchObject({ status: 'running' });
      expect(queued.body.preparationAttempt).toBeUndefined();
      expect(runUpdate).toHaveBeenCalledOnce();

      releaseInitialUpdate();
      const command = await commandPromise;
      acknowledgePlanStart(authorized.socket, command);
      blockResumedUpdate = true;
      const updateCallsAtAttemptStart = runUpdate.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(runUpdate).toHaveBeenCalledTimes(updateCallsAtAttemptStart);

      authorized.socket.send(envelope('plan.result', command.requestId, {
        batchId: command.payload.batchId,
        attempt: command.payload.attempt,
        discovered: 0,
        error: '测试主动结束当前 attempt',
      }));
      await vi.waitFor(() => {
        expect(runUpdate).toHaveBeenCalledTimes(updateCallsAtAttemptStart + 1);
      });
      releaseResumedUpdate();
      await vi.waitFor(() => expect(resumedUpdateFinished).toBe(true));
    } finally {
      releaseInitialUpdate();
      releaseResumedUpdate();
    }
  });

  it('disconnect triggers the pending restart immediately even when a durable queued job remains', async () => {
    const root = await temporaryDirectory();
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const exit = vi.fn();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 60 * 60_000,
      exit,
      runUpdate: async () => {
        await updateGate;
        return {
          changed: true,
          commit: 'abc1234',
          message: '已更新并完成构建。',
          checkedAt: '2026-08-25T00:00:00.000Z',
        };
      },
    });
    handles.push(bridge);
    const authorized = await authorize(bridge);
    authorized.socket.send(envelope('extension.hello', 'restart-with-queued-job', {
      version: APP_VERSION,
    }));
    await waitForExtensionReady(bridge);
    await requestJson(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: authorized.token,
      body: { url: URL, requestedBy: 'extension' },
    });

    releaseUpdate();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(exit).not.toHaveBeenCalled();
    authorized.socket.close();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });

  it('waits for an active sink persistence after disconnect, then performs the pending restart', async () => {
    let releaseImage!: () => void;
    let markImageStarted!: () => void;
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise<void>(resolve => { markImageStarted = resolve; });
    const root = await temporaryDirectory();
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const exit = vi.fn();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 60 * 60_000,
      exit,
      runUpdate: async () => {
        await updateGate;
        return {
          changed: true,
          commit: 'abc1234',
          message: '已更新并完成构建。',
          checkedAt: '2026-08-25T00:00:00.000Z',
        };
      },
      fetch: async () => {
        markImageStarted();
        await imageGate;
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        });
      },
      resolveAddresses: async () => ['93.184.216.34'],
    });
    handles.push(bridge);
    const authorized = await authorize(bridge);
    authorized.socket.send(envelope('extension.hello', 'restart-after-persist', {
      version: APP_VERSION,
    }));
    await waitForExtensionReady(bridge);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: authorized.token,
      body: { url: URL, requestedBy: 'extension' },
    });
    authorized.socket.send(envelope('job.result', created.body.id, {
      document: document({
        images: [{ url: 'https://images.example/restart.png' }],
        html: '<p>正文完整</p><img src="https://images.example/restart.png">',
      }),
    }));
    await imageStarted;
    releaseUpdate();
    await new Promise(resolve => setTimeout(resolve, 50));
    authorized.socket.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(exit).not.toHaveBeenCalled();

    releaseImage();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });

  it('uses an updated extension replacement as a restart handoff only after sink persistence drains', async () => {
    let releaseImage!: () => void;
    let markImageStarted!: () => void;
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise<void>(resolve => { markImageStarted = resolve; });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const root = await temporaryDirectory();
    const exit = vi.fn();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 60 * 60_000,
      exit,
      runUpdate: async () => {
        await updateGate;
        return {
          changed: true,
          commit: 'updated-build',
          message: '已更新并完成构建。',
          checkedAt: '2026-08-25T00:00:00.000Z',
        };
      },
      fetch: async () => {
        markImageStarted();
        await imageGate;
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        });
      },
      resolveAddresses: async () => ['93.184.216.34'],
    });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'restart-handoff-a', {
      version: APP_VERSION,
    }));
    await waitForExtensionReady(bridge);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: { url: URL, requestedBy: 'extension' },
    });
    first.socket.send(envelope('job.result', created.body.id, {
      document: document({
        images: [{ url: 'https://images.example/restart-handoff.png' }],
        html: '<p>正文完整</p><img src="https://images.example/restart-handoff.png">',
      }),
    }));
    await imageStarted;

    releaseUpdate();
    await vi.waitFor(async () => {
      const health = await requestJson<{ update?: { changed: boolean } }>(bridge.url, '/health');
      expect(health.body.update?.changed).toBe(true);
    });
    expect(exit).not.toHaveBeenCalled();

    const firstClosed = new Promise<{ code: number; reason: string }>(resolve => {
      first.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const replacement = await connect(bridge, first.token);
    replacement.send(envelope('extension.hello', 'restart-handoff-b', {
      version: APP_VERSION,
    }));
    await expect(firstClosed).resolves.toEqual({
      code: EXTENSION_REPLACED_CLOSE_CODE,
      reason: EXTENSION_REPLACED_CLOSE_REASON,
    });
    await waitForExtensionReady(bridge);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(exit).not.toHaveBeenCalled();

    releaseImage();
    await vi.waitFor(async () => {
      const job = await requestJson<{ status: string }>(
        bridge.url,
        `/v1/jobs/${created.body.id}`,
        { token: first.token },
      );
      expect(job.body.status).toBe('saved');
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(exit).toHaveBeenCalledOnce();
  });

  it('recognizes a replacement matching a newly packaged artifact even before update checking returns', async () => {
    const root = await temporaryDirectory();
    const artifacts = join(root, 'artifacts', 'data-collector-extension');
    await mkdir(artifacts, { recursive: true });
    const oldBuild = `v${APP_VERSION} · old-build`;
    const newBuild = `v${APP_VERSION} · newly-packaged-build`;
    await writeFile(join(artifacts, 'build-id.txt'), `${oldBuild}\n`, 'utf8');

    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const exit = vi.fn();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir: join(root, '.config'),
      repoRoot: root,
      updateIntervalMs: 60 * 60_000,
      exit,
      runUpdate: async () => {
        await updateGate;
        return {
          // Dirty-tree/manual-package paths legitimately report no git change.
          changed: false,
          commit: 'unchanged-git-head',
          message: '已是最新。',
          checkedAt: '2026-08-25T00:00:00.000Z',
        };
      },
    });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'manual-package-old', {
      version: APP_VERSION,
      buildId: oldBuild,
    }));
    await waitForExtensionReady(bridge);

    await writeFile(join(artifacts, 'build-id.txt'), `${newBuild}\n`, 'utf8');
    const replacement = await connect(bridge, first.token);
    replacement.send(envelope('extension.hello', 'manual-package-new', {
      version: APP_VERSION,
      buildId: newBuild,
    }));
    await waitForExtensionReady(bridge);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(exit).not.toHaveBeenCalled();

    releaseUpdate();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(exit).toHaveBeenCalledOnce();
  });

  it('定时采集运行时不重启，采集完成后再退出', async () => {
    const root = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'sinks.json'), JSON.stringify({
      sinks: {
        markdown: { type: 'markdown' },
        'fe-journey': { type: 'repo-inbox', repoPath: repo, commit: false, push: false },
      },
      routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
    }));

    let releaseCollection!: () => void;
    const collectionGate = new Promise<void>(resolve => { releaseCollection = resolve; });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      await collectionGate;
      const url = new URL(String(input));
      if (url.hostname === 'www.nowcoder.com') return new Response('<html></html>');
      if (url.hostname === 'api.github.com') {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url.href}`);
    });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const exit = vi.fn();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: join(root, 'library'),
      configDir,
      repoRoot: root,
      enableFeJourneyScheduler: true,
      updateIntervalMs: 60_000,
      exit,
      fetch: fetcher,
      runUpdate: async () => {
        await updateGate;
        return {
          changed: true,
          commit: 'abc1234',
          message: '已更新并完成构建。',
          checkedAt: '2026-08-19T00:00:00.000Z',
        };
      },
    });
    handles.push(bridge);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    try {
      const scheduledHosts = fetcher.mock.calls
        .map(([input]) => new globalThis.URL(String(input)).hostname);
      expect(scheduledHosts).not.toContain('www.nowcoder.com');
      expect(scheduledHosts).toContain('api.github.com');
    } catch (error) {
      releaseUpdate();
      releaseCollection();
      throw error;
    }

    releaseUpdate();
    try {
      await vi.waitFor(async () => {
        const health = await requestJson<{ update?: { changed: boolean } }>(bridge.url, '/health');
        expect(health.body.update?.changed).toBe(true);
      });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      releaseCollection();
    }

    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });
});
