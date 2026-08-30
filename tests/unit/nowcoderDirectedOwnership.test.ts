import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import {
  APP_VERSION,
  NOWCODER_DIRECTED_REJECTION_MESSAGES,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  TRUSTED_EXTENSION_ID,
  stableContentId,
  type CollectedDocument,
  type NowcoderSearchCandidate,
  type WsEnvelope,
} from '@data-collector/shared';
import { loadConfig } from '../../packages/bridge/src/config.js';
import {
  ArtifactReaderCoordinator,
  type ArtifactReaderCoordinatorLike,
} from '../../packages/bridge/src/artifactReaderCoordinator.js';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import { CollectionPlanService } from '../../packages/bridge/src/plans/index.js';
import { NowcoderDirectedService } from '../../packages/bridge/src/nowcoderDirected/service.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
import { nowcoderDirectedJobId } from '../../packages/bridge/src/nowcoderDirected/jobIdentity.js';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/server/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const NOW = '2026-08-30T00:00:00.000Z';
const CURRENT_ATTEMPT = '0123456789abcdef';
const OLD_ATTEMPT = 'fedcba9876543210';
const URL = 'https://www.nowcoder.com/feed/main/detail/same-canonical-url';
const BUILD = 'v0.4.33 · abcdef1';
const RUN_EVIDENCE = {
  buildEvidence: {
    applicationVersion: APP_VERSION,
    bridgeBuildId: BUILD,
    artifactBuildId: BUILD,
    extensionVersion: APP_VERSION,
    extensionBuildId: BUILD,
    extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
    frozenAt: NOW,
  },
  runtimeId: '11111111-1111-4111-8111-111111111111',
};

const DIRECTED_HELLO = {
  version: APP_VERSION,
  buildId: BUILD,
  runtimeId: RUN_EVIDENCE.runtimeId,
  capabilities: RUN_EVIDENCE.buildEvidence.extensionCapabilities,
};
const temporaryDirectories = createTemporaryDirectoryTracker();
const bridges: BridgeHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  await temporaryDirectories.cleanup();
});

function candidate(): NowcoderSearchCandidate {
  return {
    id: 'candidate-1',
    canonicalUrl: URL,
    contentType: 'post',
    matchedQueries: ['Agent'],
    page: 1,
    rank: 1,
    publishedAt: '2026-08-29T00:00:00.000Z',
  };
}

function pendingSingleAudit(jobId: string) {
  const message = NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED;
  return {
    accepted: 0,
    deliveryItems: [],
    privateRejections: [{
      jobId,
      url: URL,
      code: 'DETAIL_NOT_SAVED' as const,
      message,
      detail: message,
    }],
    progress: {
      discovered: 1,
      detailScheduled: 1,
      detailSaved: 0,
      inspected: 0,
      qualified: 0,
      accepted: 0,
      delivered: 0,
      rejectionCounts: [{ code: 'DETAIL_NOT_SAVED' as const, message, count: 1 }],
      companies: [
        { company: 'bytedance' as const, count: 0 },
        { company: 'tencent' as const, count: 0 },
        { company: 'alibaba' as const, count: 0 },
        { company: 'ant' as const, count: 0 },
        { company: 'other' as const, count: 0 },
      ],
    },
  };
}

async function fixture() {
  const root = await temporaryDirectories.create('nowcoder-directed-ownership-');
  const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
    now: () => NOW,
    id: () => 'run-current',
    attempt: () => CURRENT_ATTEMPT,
  });
  await store.createSession({
    id: 'session-1',
    queries: ['Agent'],
    queryHash: 'a'.repeat(64),
    requestedSort: 'latest',
    provider: 'nowcoder-json',
    sortVerified: true,
    createdAt: NOW,
    expiresAt: '2026-08-30T00:30:00.000Z',
    candidates: [candidate()],
  }, { target: 1 });
  const run = await store.startRun({
    searchSessionId: 'session-1',
    selectedCandidateIds: ['candidate-1'],
    idempotencyKey: 'start-key',
    deliveryAuthorized: true,
  }, RUN_EVIDENCE);
  const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
  const dispatched: string[] = [];
  const reconcileSelection = vi.fn(async () => undefined);
  const recoverPublisher = vi.fn(async () => undefined);
  const service = new NowcoderDirectedService({
    store,
    jobs,
    dispatch: async job => { dispatched.push(job.id); },
    reconcileSelection,
    recoverPublisher,
  });
  return {
    root,
    store,
    jobs,
    run,
    service,
    dispatched,
    reconcileSelection,
    recoverPublisher,
  };
}

function envelope<T>(type: string, requestId: string, payload: T): string {
  return JSON.stringify({
    protocolVersion: 1,
    type,
    requestId,
    timestamp: NOW,
    payload,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString()) as WsEnvelope;
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve();
    };
    socket.on('message', onMessage);
  });
}

async function authorize(bridge: BridgeHandle): Promise<{ socket: WebSocket; token: string }> {
  const socket = new WebSocket(`${bridge.wsUrl}?bootstrap=1`, {
    origin: `chrome-extension://${TRUSTED_EXTENSION_ID}`,
  });
  sockets.push(socket);
  const authorized = await nextMessage<{ token: string }>(socket);
  expect(authorized.type).toBe('bridge.authorized');
  return { socket, token: authorized.payload.token };
}

async function connect(bridge: BridgeHandle, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`${bridge.wsUrl}?token=${encodeURIComponent(token)}`, {
    origin: `chrome-extension://${TRUSTED_EXTENSION_ID}`,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function health(bridge: BridgeHandle): Promise<Record<string, unknown>> {
  const response = await fetch(`${bridge.url}/health`);
  return await response.json() as Record<string, unknown>;
}

function nowcoderDocument(): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url: URL,
    canonicalUrl: URL,
    title: '旧尝试不得落库',
    collectedAt: NOW,
    html: '<p>Agent RAG MCP 面试问题</p>',
    text: 'Agent RAG MCP 面试问题',
    images: [],
  };
}

function zsxqDocument(url: string): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'zsxq',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: '知识星球完整正文',
    collectedAt: NOW,
    html: '<p>完整正文</p>',
    text: '完整正文',
    images: [],
    truncated: false,
    sourceMetadata: {
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
      contentCompletenessBuildId: BUILD,
    },
  };
}

describe('directed Nowcoder job ownership', () => {
  it('bootstraps legacy active proof pins before real server startup pruning', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-legacy-pin-startup-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'legacy-active-run', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'legacy-pin-session',
      queries: ['Agent'],
      queryHash: 'f'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'legacy-pin-session',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'legacy-pin-startup-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const activeId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    const message = NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED;
    await directedStore.checkpointRun(run.id, {
      phase: 'collecting',
      candidateCursor: 1,
      currentJobIds: [activeId],
      currentRoundJobIds: [activeId],
      progress: {
        discovered: 1,
        detailScheduled: 1,
        detailSaved: 1,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [{ code: 'DETAIL_NOT_SAVED', message, count: 1 }],
        companies: [
          { company: 'bytedance', count: 0 },
          { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 },
          { company: 'ant', count: 0 },
          { company: 'other', count: 0 },
        ],
      },
      accepted: 0,
      privateRejections: [{
        jobId: activeId,
        url: URL,
        code: 'DETAIL_NOT_SAVED',
        message,
        detail: message,
      }],
    });
    const activeProof = {
      id: activeId,
      url: URL,
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
    };
    const newer = Array.from({ length: 1_005 }, (_, index) => ({
      id: `startup-newer-${String(index).padStart(4, '0')}`,
      url: `https://www.nowcoder.com/discuss/${40_000 + index}`,
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
      updatedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(config.jobsFile, `${JSON.stringify({ version: 1, jobs: [activeProof, ...newer] })}\n`);

    const bridge = await startBridge({ libraryRoot: root, configDir, port: 0 });
    bridges.push(bridge);

    const reopened = await JobStore.open(config.jobsFile);
    expect(reopened.get(activeId)).toMatchObject({
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
      status: 'saved',
    });
    expect(reopened.list()).toHaveLength(1_001);
    expect((JSON.parse(await readFile(config.jobsFile, 'utf8')) as {
      directedPins: Array<{ runId: string; attempt: string; jobIds: string[] }>;
    }).directedPins).toEqual([{
      runId: run.id,
      attempt: run.attempt,
      jobIds: [activeId],
    }]);
  });

  it('defers pruning and preserves existing pins when the directed store is unavailable at startup', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-pin-quarantine-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(root, '_catalog'), { recursive: true });
    const activeId = nowcoderDirectedJobId('quarantined-run', CURRENT_ATTEMPT, URL);
    const activeProof = {
      id: activeId,
      url: URL,
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      directedRunId: 'quarantined-run',
      directedRunAttempt: CURRENT_ATTEMPT,
    };
    const newer = Array.from({ length: 1_005 }, (_, index) => ({
      id: `quarantine-newer-${String(index).padStart(4, '0')}`,
      url: `https://www.nowcoder.com/discuss/${50_000 + index}`,
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: new Date(Date.parse('2026-08-21T00:00:00.000Z') + index * 1_000).toISOString(),
      updatedAt: new Date(Date.parse('2026-08-21T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    const pins = [{ runId: 'quarantined-run', attempt: CURRENT_ATTEMPT, jobIds: [activeId] }];
    await writeFile(config.jobsFile, `${JSON.stringify({ version: 1, jobs: [activeProof, ...newer], directedPins: pins })}\n`);
    await writeFile(join(configDir, 'nowcoder-directed.json'), '{not-json\n');

    const bridge = await startBridge({ libraryRoot: root, configDir, port: 0 });
    bridges.push(bridge);

    const persisted = JSON.parse(await readFile(config.jobsFile, 'utf8')) as {
      jobs: Array<{ id: string }>;
      directedPins: Array<{ runId: string; attempt: string; jobIds: string[] }>;
    };
    expect(persisted.jobs).toHaveLength(1_006);
    expect(persisted.jobs.some(job => job.id === activeId)).toBe(true);
    expect(persisted.directedPins).toEqual(pins);
  });

  it('checkpoints an exact attempt-scoped child before dispatching it', async () => {
    const context = await fixture();

    const [job] = await context.service.enqueueRound(
      context.run.id,
      context.run.attempt,
      1,
    );

    const expectedId = nowcoderDirectedJobId(context.run.id, CURRENT_ATTEMPT, URL);
    expect(job).toMatchObject({
      id: expectedId,
      url: URL,
      directedRunId: context.run.id,
      directedRunAttempt: CURRENT_ATTEMPT,
      status: 'queued',
    });
    expect(context.dispatched).toEqual([expectedId]);
    expect(context.store.reconciliationSnapshots()).toEqual([
      expect.objectContaining({
        id: context.run.id,
        attempt: CURRENT_ATTEMPT,
        candidateCursor: 1,
        currentJobIds: [expectedId],
        currentRoundJobIds: [expectedId],
      }),
    ]);

    const reopened = await JobStore.open(context.jobs.path);
    expect(reopened.get(expectedId)).toMatchObject({
      directedRunId: context.run.id,
      directedRunAttempt: CURRENT_ATTEMPT,
    });
  });

  it('ignores an old-attempt terminal for the same canonical URL as run evidence', async () => {
    const context = await fixture();
    const [current] = await context.service.enqueueRound(
      context.run.id,
      context.run.attempt,
      1,
    );
    const old = await context.jobs.create({
      id: `${context.run.id}-${OLD_ATTEMPT}-${stableContentId(URL)}`,
      url: URL,
      requestedBy: 'codex',
      directedRunId: context.run.id,
      directedRunAttempt: OLD_ATTEMPT,
    });
    await context.jobs.transition(old.id, 'collecting');
    const oldSaved = await context.jobs.transition(old.id, 'saved', {
      outputPath: '/tmp/old-attempt-local-evidence/index.md',
    });
    const before = context.store.reconciliationSnapshots();

    expect(context.service.acceptsResult(oldSaved)).toBe(false);
    await context.service.onJobTerminal(oldSaved);

    expect(context.store.reconciliationSnapshots()).toEqual(before);
    expect(context.jobs.get(old.id)?.outputPath).toBe('/tmp/old-attempt-local-evidence/index.md');
    expect(context.reconcileSelection).not.toHaveBeenCalled();
    expect(context.recoverPublisher).not.toHaveBeenCalled();

    await context.jobs.transition(current!.id, 'collecting');
    const currentSaved = await context.jobs.transition(current!.id, 'saved', {
      outputPath: '/tmp/current-attempt/index.md',
    });
    expect(context.service.acceptsResult(currentSaved)).toBe(true);
    await context.service.onJobTerminal(currentSaved);

    expect(context.store.getRun(context.run.id)?.phase).toBe('selecting');
    expect(context.reconcileSelection).toHaveBeenCalledOnce();
    expect(context.recoverPublisher).not.toHaveBeenCalled();
  });

  it('rejects a current-attempt job whose URL does not match its frozen derived ID', async () => {
    const context = await fixture();
    const [job] = await context.service.enqueueRound(context.run.id, context.run.attempt, 1);
    const mismatched = {
      ...job!,
      url: 'https://www.nowcoder.com/feed/main/detail/wrong-current-url',
    };

    expect(context.service.ownsCurrentJob(mismatched)).toBe(false);
    expect(context.service.acceptsResult(mismatched)).toBe(false);
  });

  it('fences an old-attempt WebSocket result before Markdown and candidate-index persistence', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-server-fence-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-server',
      queries: ['Agent'],
      queryHash: 'b'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'session-server',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'server-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const currentId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    await directedStore.checkpointRun(run.id, {
      candidateCursor: 1,
      currentJobIds: [currentId],
      currentRoundJobIds: [currentId],
      ...pendingSingleAudit(currentId),
    });
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    const oldId = `${run.id}-${OLD_ATTEMPT}-${stableContentId(URL)}`;
    await jobs.create({
      id: oldId,
      url: URL,
      requestedBy: 'codex',
      directedRunId: run.id,
      directedRunAttempt: OLD_ATTEMPT,
    });

    const bridge = await startBridge({
      libraryRoot: root,
      configDir,
      port: 0,
      repoRoot: root,
      enableAutoUpdate: false,
      readArtifactBuildId: async () => BUILD,
    });
    bridges.push(bridge);
    const { socket } = await authorize(bridge);
    const collected: WsEnvelope[] = [];
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as WsEnvelope;
      if (message.type === 'job.collect') collected.push(message);
    });
    socket.send(envelope('extension.hello', 'hello', DIRECTED_HELLO));
    const handled = waitForMessageType(socket, 'bridge.pong');
    socket.send(envelope('job.result', oldId, { document: nowcoderDocument() }));
    socket.send(envelope('bridge.ping', 'stale-result-barrier', {}));
    await handled;

    const reopened = await JobStore.open(config.jobsFile);
    expect(collected).toEqual([expect.objectContaining({
      requestId: currentId,
      payload: expect.objectContaining({
        interactive: false,
        directedRunId: run.id,
        directedRunAttempt: run.attempt,
      }),
    })]);
    expect(reopened.get(oldId)).toMatchObject({ status: 'queued' });
    expect(reopened.get(oldId)).not.toHaveProperty('outputPath');
  });

  it('attentions current artifact drift before a directed result can acquire persistence or write sinks', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-result-drift-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-result-drift',
      queries: ['Agent'],
      queryHash: 'c'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'session-result-drift',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'result-drift-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const currentId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    await directedStore.checkpointRun(run.id, {
      candidateCursor: 1,
      currentJobIds: [currentId],
      currentRoundJobIds: [currentId],
      ...pendingSingleAudit(currentId),
    });
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    await jobs.create({
      id: currentId,
      url: URL,
      requestedBy: 'codex',
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
    });
    let diskBuild = BUILD;
    const logicalRoles: string[] = [];
    const concreteCoordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({ release: async () => undefined }),
    });
    const artifactReaderCoordinator: ArtifactReaderCoordinatorLike = {
      tryBeginStart: () => concreteCoordinator.tryBeginStart(),
      tryBeginUpdate: activeRun => concreteCoordinator.tryBeginUpdate(activeRun),
      snapshot: () => concreteCoordinator.snapshot(),
      setOnIdle: handler => concreteCoordinator.setOnIdle(handler),
      close: () => concreteCoordinator.close(),
      acquireReader: async role => {
        logicalRoles.push(role);
        return await concreteCoordinator.acquireReader(role);
      },
    };
    const bridge = await startBridge({
      libraryRoot: root,
      configDir,
      port: 0,
      repoRoot: root,
      enableAutoUpdate: false,
      readArtifactBuildId: async () => diskBuild,
      artifactReaderCoordinator,
    });
    bridges.push(bridge);
    const { socket } = await authorize(bridge);
    const collected = waitForMessageType(socket, 'job.collect');
    socket.send(envelope('extension.hello', 'result-drift-hello', DIRECTED_HELLO));
    await collected;

    diskBuild = 'v0.4.33 · changed';
    const handled = waitForMessageType(socket, 'bridge.pong');
    socket.send(envelope('job.result', currentId, { document: nowcoderDocument() }));
    socket.send(envelope('bridge.ping', 'result-drift-barrier', {}));
    await handled;

    const reopenedJobs = await JobStore.open(config.jobsFile);
    const reopenedDirected = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
    );
    expect(reopenedJobs.get(currentId)).toMatchObject({ status: 'dispatched' });
    expect(reopenedJobs.get(currentId)).not.toHaveProperty('outputPath');
    expect(reopenedDirected.getRun(run.id)).toMatchObject({
      status: 'completed_with_attention',
      deliveryIds: [],
      publicDeliveryItems: [],
      attentionReason: { code: 'DIRECTED_ARTIFACT_CHANGED' },
    });
    expect(logicalRoles).toEqual(['nowcoder-directed-run']);
  });

  it('does not redispatch a directed result while its sink and index persistence is in flight', async () => {
    const helloEvents: string[] = [];
    const readerEvents: string[] = [];
    const physicalAcquire = vi.fn(async () => ({
      release: async () => { readerEvents.push('physical:release'); },
    }));
    const concreteCoordinator = new ArtifactReaderCoordinator({ acquirePhysical: physicalAcquire });
    const artifactReaderCoordinator: ArtifactReaderCoordinatorLike = {
      tryBeginStart: () => concreteCoordinator.tryBeginStart(),
      tryBeginUpdate: activeRun => concreteCoordinator.tryBeginUpdate(activeRun),
      snapshot: () => concreteCoordinator.snapshot(),
      setOnIdle: handler => concreteCoordinator.setOnIdle(handler),
      close: () => concreteCoordinator.close(),
      acquireReader: async role => {
        readerEvents.push(`logical:acquire:${role}`);
        const handle = await concreteCoordinator.acquireReader(role);
        return {
          release: async () => {
            readerEvents.push(`logical:release:${role}`);
            await handle.release();
          },
        };
      },
    };
    let releaseImage!: () => void;
    let markImageStarted!: () => void;
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise<void>(resolve => { markImageStarted = resolve; });
    const root = await temporaryDirectories.create('nowcoder-directed-persistence-race-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-persistence-race',
      queries: ['Agent'],
      queryHash: 'd'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'session-persistence-race',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'persistence-race-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const currentId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    await directedStore.checkpointRun(run.id, {
      candidateCursor: 1,
      currentJobIds: [currentId],
      currentRoundJobIds: [currentId],
      ...pendingSingleAudit(currentId),
    });
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    await jobs.create({
      id: currentId,
      url: URL,
      requestedBy: 'codex',
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
    });

    let observeCalls = 0;
    let markReplacementObserved!: () => void;
    const replacementObserved = new Promise<void>(resolve => { markReplacementObserved = resolve; });
    const originalObserveExtensionEvidence = NowcoderDirectedService.prototype.observeExtensionEvidence;
    const observeSpy = vi.spyOn(NowcoderDirectedService.prototype, 'observeExtensionEvidence')
      .mockImplementation(async function (this: NowcoderDirectedService) {
        await originalObserveExtensionEvidence.call(this);
        observeCalls += 1;
        helloEvents.push(`directed:evidence:${observeCalls}`);
        if (observeCalls === 2) markReplacementObserved();
      });
    let planReconnectCalls = 0;
    let replacementPlanConnected = false;
    const originalPlanReconnect = CollectionPlanService.prototype.onExtensionConnected;
    const planReconnectSpy = vi.spyOn(CollectionPlanService.prototype, 'onExtensionConnected')
      .mockImplementation(async function (this: CollectionPlanService, ...args) {
        await originalPlanReconnect.apply(this, args);
        planReconnectCalls += 1;
        if (planReconnectCalls === 2) {
          replacementPlanConnected = true;
          helloEvents.push('fixed-plan:reconnected');
        }
      });
    const originalDirectedReconcile = NowcoderDirectedService.prototype.reconcileAll;
    const directedReconcileSpy = vi.spyOn(NowcoderDirectedService.prototype, 'reconcileAll')
      .mockImplementation(function (this: NowcoderDirectedService) {
        const result = originalDirectedReconcile.call(this);
        if (replacementPlanConnected) {
          void result.then(() => { helloEvents.push('directed:reconciled'); });
        }
        return result;
      });
    try {
      const bridge = await startBridge({
        libraryRoot: root,
        configDir,
        port: 0,
        repoRoot: root,
        enableAutoUpdate: false,
        readArtifactBuildId: async () => BUILD,
        artifactReaderCoordinator,
        fetch: async () => {
          markImageStarted();
          await imageGate;
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { 'content-type': 'image/png', 'content-length': '4' },
          });
        },
        resolveAddresses: async () => ['93.184.216.34'],
      });
      bridges.push(bridge);
      const first = await authorize(bridge);
      const dispatched: string[] = [];
      first.socket.on('message', data => {
        const message = JSON.parse(data.toString()) as WsEnvelope;
        if (message.type === 'job.collect') dispatched.push(message.requestId);
      });
      first.socket.send(envelope('extension.hello', 'persistence-race-first', DIRECTED_HELLO));
      await vi.waitFor(() => expect(dispatched).toEqual([currentId]));

      first.socket.send(envelope('job.result', currentId, {
        document: {
          ...nowcoderDocument(),
          html: '<p>Agent RAG MCP 面试问题</p><img src="https://images.example/slow.png">',
          images: [{ url: 'https://images.example/slow.png' }],
        },
      }));
      await imageStarted;
      expect(readerEvents).toContain('logical:acquire:nowcoder-directed-persistence');
      expect(readerEvents).not.toContain('logical:release:nowcoder-directed-persistence');
      expect(physicalAcquire).toHaveBeenCalledOnce();

      const replacement = await connect(bridge, first.token);
      replacement.on('message', data => {
        const message = JSON.parse(data.toString()) as WsEnvelope;
        if (message.type === 'job.collect') dispatched.push(message.requestId);
        if (message.type === 'job.saved') helloEvents.push('notice:flushed');
        if (message.type === 'bridge.pong') helloEvents.push('hello:complete');
      });
      replacement.send(envelope('extension.hello', 'persistence-race-replacement', DIRECTED_HELLO));
      // Full hello ordering deliberately validates evidence before waiting for persistence drain,
      // and only reconciles after that drain. Observing evidence proves the replacement hello is
      // parked at the drain without relying on package timing or a sleep.
      await replacementObserved;
      expect(dispatched).toEqual([currentId]);
      expect(readerEvents).not.toContain('logical:release:nowcoder-directed-persistence');
      const helloCompleted = waitForMessageType(replacement, 'bridge.pong');
      replacement.send(envelope('bridge.ping', 'replacement-hello-barrier', {}));
      releaseImage();
      await helloCompleted;
      expect(helloEvents.indexOf('directed:evidence:2'))
        .toBeLessThan(helloEvents.indexOf('fixed-plan:reconnected'));
      expect(helloEvents.indexOf('fixed-plan:reconnected'))
        .toBeLessThan(helloEvents.indexOf('directed:reconciled'));
      expect(helloEvents.indexOf('notice:flushed'))
        .toBeLessThan(helloEvents.indexOf('hello:complete'));

      await vi.waitFor(async () => {
        const reopened = await JobStore.open(config.jobsFile);
        expect(reopened.get(currentId)).toMatchObject({
          status: 'saved',
          outputPath: expect.stringMatching(/index\.md$/),
    });
  });

      expect(dispatched).toEqual([currentId]);
      expect(readerEvents).toEqual(expect.arrayContaining([
        'logical:acquire:nowcoder-directed-run',
        'logical:acquire:nowcoder-directed-persistence',
        'logical:release:nowcoder-directed-persistence',
      ]));
      expect(concreteCoordinator.snapshot()).toMatchObject({ activeReaders: 0 });
      expect(readerEvents).toContain('physical:release');
    } finally {
      releaseImage();
      observeSpy.mockRestore();
      planReconnectSpy.mockRestore();
      directedReconcileSpy.mockRestore();
    }
  });

  it('replays a proven pre-JobStore terminal after Bridge restart and then acknowledges it', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-terminal-ack-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-terminal-ack',
      queries: ['Agent'],
      queryHash: 'd'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'session-terminal-ack',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'terminal-ack-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const currentId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    await directedStore.checkpointCurrentRun(run.id, run.attempt, {
      candidateCursor: 1,
      currentJobIds: [currentId],
      currentRoundJobIds: [currentId],
      ...pendingSingleAudit(currentId),
    });
    await directedStore.recordDispatchedJobCurrent(run.id, run.attempt, currentId);
    await directedStore.recordTabClearEvidenceCurrent(
      run.id,
      run.attempt,
      currentId,
      'remote_terminal_after_close',
    );
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    await jobs.create({
      id: currentId,
      url: URL,
      requestedBy: 'codex',
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
    });
    await jobs.transition(currentId, 'dispatched');
    await jobs.transition(currentId, 'collecting');

    const bridge = await startBridge({
      libraryRoot: root,
      configDir,
      port: 0,
      repoRoot: root,
      enableAutoUpdate: false,
      readArtifactBuildId: async () => BUILD,
    });
    bridges.push(bridge);
    const { socket } = await authorize(bridge);
    const collect = nextMessage<{ directedRunId: string; directedRunAttempt: string }>(socket);
    socket.send(envelope('extension.hello', 'terminal-ack-hello', DIRECTED_HELLO));
    expect(await collect).toMatchObject({
      type: 'job.collect',
      requestId: currentId,
      payload: {
        directedRunId: run.id,
        directedRunAttempt: run.attempt,
        interactive: false,
      },
    });

    const acknowledgement = nextMessage<{ code: string; message: string }>(socket);
    socket.send(envelope('job.error', currentId, {
      code: 'AUTH_REQUIRED',
      message: '登录态已失效',
      needsAttention: true,
    }));
    expect(await acknowledgement).toMatchObject({
      type: 'job.failed',
      requestId: currentId,
      payload: { code: 'AUTH_REQUIRED', message: '登录态已失效' },
    });

    const persistedJobs = await JobStore.open(config.jobsFile);
    expect(persistedJobs.get(currentId)).toMatchObject({
      status: 'needs_attention',
      errorCode: 'AUTH_REQUIRED',
    });
    const raw = JSON.parse(await readFile(join(configDir, 'nowcoder-directed.json'), 'utf8')) as {
      runs: Array<{
        dispatchedJobIds: string[];
        tabClearEvidence: Array<{ jobId: string; kind: string }>;
      }>;
    };
    expect(raw.runs[0]).toMatchObject({
      dispatchedJobIds: [currentId],
      tabClearEvidence: [{ jobId: currentId, kind: 'remote_terminal_after_close' }],
    });
  });

  it('shares one physical lease between an active directed run and ZSXQ result persistence', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-zsxq-reader-share-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-zsxq-reader-share',
      queries: ['Agent'],
      queryHash: 'f'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    await directedStore.startRun({
      searchSessionId: 'session-zsxq-reader-share',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'zsxq-reader-share-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const zsxqUrl = 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111';
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    const zsxqJob = await jobs.create({
      id: 'zsxq-while-directed-active',
      url: zsxqUrl,
      requestedBy: 'codex',
    });

    const logicalEvents: string[] = [];
    const physicalRelease = vi.fn(async () => undefined);
    const physicalAcquire = vi.fn(async () => ({ release: physicalRelease }));
    const concreteCoordinator = new ArtifactReaderCoordinator({ acquirePhysical: physicalAcquire });
    const artifactReaderCoordinator: ArtifactReaderCoordinatorLike = {
      tryBeginStart: () => concreteCoordinator.tryBeginStart(),
      tryBeginUpdate: activeRun => concreteCoordinator.tryBeginUpdate(activeRun),
      snapshot: () => concreteCoordinator.snapshot(),
      setOnIdle: handler => concreteCoordinator.setOnIdle(handler),
      close: () => concreteCoordinator.close(),
      acquireReader: async role => {
        logicalEvents.push(`acquire:${role}`);
        const handle = await concreteCoordinator.acquireReader(role);
        return {
          release: async () => {
            logicalEvents.push(`release:${role}`);
            await handle.release();
          },
        };
      },
    };
    const bridge = await startBridge({
      libraryRoot: root,
      configDir,
      port: 0,
      repoRoot: root,
      enableAutoUpdate: false,
      readArtifactBuildId: async () => BUILD,
      artifactReaderCoordinator,
    });
    bridges.push(bridge);
    expect(await health(bridge)).toMatchObject({ directedRunActive: true });
    expect(JSON.stringify(await health(bridge))).not.toContain(RUN_EVIDENCE.runtimeId);

    const { socket } = await authorize(bridge);
    const collected = waitForMessageType(socket, 'job.collect');
    socket.send(envelope('extension.hello', 'zsxq-reader-share-hello', DIRECTED_HELLO));
    await collected;
    const handled = waitForMessageType(socket, 'bridge.pong');
    socket.send(envelope('job.result', zsxqJob.id, { document: zsxqDocument(zsxqUrl) }));
    socket.send(envelope('bridge.ping', 'zsxq-reader-share-barrier', {}));
    await handled;

    const reopened = await JobStore.open(config.jobsFile);
    expect(reopened.get(zsxqJob.id)).toMatchObject({
      status: 'saved',
      outputPath: expect.stringMatching(/index\.md$/),
    });
    expect(logicalEvents).toEqual(expect.arrayContaining([
      'acquire:nowcoder-directed-run',
      'acquire:zsxq-persistence',
      'release:zsxq-persistence',
    ]));
    expect(physicalAcquire).toHaveBeenCalledOnce();
    expect(physicalRelease).not.toHaveBeenCalled();
    expect(concreteCoordinator.snapshot()).toMatchObject({ activeReaders: 1 });

    await bridge.close();
    expect(physicalRelease).toHaveBeenCalledOnce();
  });

  it('keeps update and restart excluded until terminal persistence releases its physical reader', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-terminal-reader-order-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-terminal-reader-order',
      queries: ['Agent'],
      queryHash: '2'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'session-terminal-reader-order',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'terminal-reader-order-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const currentId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    await directedStore.checkpointRun(run.id, {
      candidateCursor: 1,
      currentJobIds: [currentId],
      currentRoundJobIds: [currentId],
      ...pendingSingleAudit(currentId),
    });
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    await jobs.create({
      id: currentId,
      url: URL,
      requestedBy: 'codex',
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
    });
    const events: string[] = [];
    const physicalReleaseStarted = deferred<void>();
    const physicalReleaseGate = deferred<void>();
    const physicalReleaseFinished = deferred<void>();
    const concreteCoordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({
        release: async () => {
          events.push('physical:release:start');
          physicalReleaseStarted.resolve();
          await physicalReleaseGate.promise;
          events.push('physical:release:end');
          physicalReleaseFinished.resolve();
        },
      }),
    });
    const artifactReaderCoordinator: ArtifactReaderCoordinatorLike = {
      tryBeginStart: () => concreteCoordinator.tryBeginStart(),
      tryBeginUpdate: activeRun => concreteCoordinator.tryBeginUpdate(activeRun),
      snapshot: () => concreteCoordinator.snapshot(),
      setOnIdle: handler => concreteCoordinator.setOnIdle(handler),
      close: () => concreteCoordinator.close(),
      acquireReader: async role => {
        events.push(`logical:acquire:${role}`);
        const handle = await concreteCoordinator.acquireReader(role);
        return {
          release: async () => {
            events.push(`logical:release:${role}`);
            await handle.release();
          },
        };
      },
    };
    const updateStarted = deferred<void>();
    const runUpdate = vi.fn(async () => {
      events.push('update:start');
      updateStarted.resolve();
      return {
        changed: true,
        commit: 'abcdef123456',
        message: 'updated',
        checkedAt: NOW,
      };
    });
    const exited = deferred<void>();
    const exit = vi.fn(() => {
      events.push('restart:exit');
      exited.resolve();
    });
    const originalOnJobTerminal = NowcoderDirectedService.prototype.onJobTerminal;
    const terminalSpy = vi.spyOn(NowcoderDirectedService.prototype, 'onJobTerminal')
      .mockImplementation(async function (this: NowcoderDirectedService, job) {
        if (job.id !== currentId) {
          await originalOnJobTerminal.call(this, job);
          return;
        }
        events.push('directed:terminal');
        await this.finalizeRun(run.id, run.attempt, 'failed');
        events.push('directed:run-reader-released');
      });
    try {
      const bridge = await startBridge({
        libraryRoot: root,
        configDir,
        port: 0,
        repoRoot: root,
        enableAutoUpdate: true,
        updateIntervalMs: 60_000,
        readArtifactBuildId: async () => BUILD,
        artifactReaderCoordinator,
        runUpdate,
        exit,
      });
      bridges.push(bridge);
      const first = await authorize(bridge);
      const collected = waitForMessageType(first.socket, 'job.collect');
      first.socket.send(envelope('extension.hello', 'terminal-reader-first', DIRECTED_HELLO));
      await collected;
      first.socket.send(envelope('job.result', currentId, { document: nowcoderDocument() }));
      await physicalReleaseStarted.promise;

      expect(events).toEqual(expect.arrayContaining([
        'logical:acquire:nowcoder-directed-run',
        'logical:acquire:nowcoder-directed-persistence',
        'directed:terminal',
        'logical:release:nowcoder-directed-run',
        'directed:run-reader-released',
        'logical:release:nowcoder-directed-persistence',
        'physical:release:start',
      ]));
      expect(events.indexOf('logical:release:nowcoder-directed-run'))
        .toBeLessThan(events.indexOf('logical:release:nowcoder-directed-persistence'));
      expect(runUpdate).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      const replacement = await connect(bridge, first.token);
      const persistenceDrained = waitForMessageType(replacement, 'bridge.pong');
      replacement.send(envelope('extension.hello', 'terminal-reader-replacement', DIRECTED_HELLO));
      replacement.send(envelope('bridge.ping', 'terminal-reader-drain-barrier', {}));
      await persistenceDrained;
      events.push('persistence:drained');
      expect(events.indexOf('physical:release:start'))
        .toBeLessThan(events.indexOf('persistence:drained'));
      expect(events).not.toContain('physical:release:end');
      expect(runUpdate).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      physicalReleaseGate.resolve();
      await physicalReleaseFinished.promise;
      await updateStarted.promise;
      replacement.close();
      await exited.promise;

      expect(events.indexOf('physical:release:end')).toBeLessThan(events.indexOf('update:start'));
      expect(events.indexOf('update:start')).toBeLessThan(events.indexOf('restart:exit'));
      expect(runUpdate).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
    } finally {
      physicalReleaseGate.resolve();
      terminalSpy.mockRestore();
    }
  });

  it('keeps a rejected physical release quarantined from deferred server update and restart', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-release-quarantine-');
    const configDir = join(root, '.config');
    const events: string[] = [];
    const updateStarted = deferred<void>();
    const updateGate = deferred<void>();
    const releaseGate = deferred<void>();
    const releaseStarted = deferred<void>();
    const concreteCoordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({
        release: async () => {
          events.push('physical:release:start');
          releaseStarted.resolve();
          await releaseGate.promise;
        },
      }),
    });
    let wakeArtifactIdle = (): void => undefined;
    let updateIntentReleased = false;
    const artifactReaderCoordinator: ArtifactReaderCoordinatorLike = {
      tryBeginStart: () => concreteCoordinator.tryBeginStart(),
      // The updater path is real; this seam isolates the server's restart wake guard from the
      // coordinator arbitration already covered by its focused tests.
      tryBeginUpdate: () => {
        events.push('update:intent');
        return {
          handoffToRestart: () => {
            events.push('restart:pending');
          },
          release: () => {
            if (updateIntentReleased) return;
            updateIntentReleased = true;
            events.push('restart:intent:release');
          },
        };
      },
      acquireReader: role => concreteCoordinator.acquireReader(role),
      snapshot: () => concreteCoordinator.snapshot(),
      setOnIdle: handler => {
        wakeArtifactIdle = handler;
        concreteCoordinator.setOnIdle(handler);
      },
      close: async () => {
        events.push('coordinator:close');
        await concreteCoordinator.close();
      },
    };
    const runUpdate = vi.fn(async () => {
      events.push('update:start');
      updateStarted.resolve();
      await updateGate.promise;
      events.push('update:changed');
      return {
        changed: true,
        commit: 'abcdef123456',
        message: 'updated',
        checkedAt: NOW,
      };
    });
    const exit = vi.fn(() => { events.push('restart:exit'); });
    const bridge = await startBridge({
      libraryRoot: root,
      configDir,
      port: 0,
      repoRoot: root,
      enableAutoUpdate: true,
      updateIntervalMs: 60_000,
      readArtifactBuildId: async () => BUILD,
      artifactReaderCoordinator,
      runUpdate,
      exit,
    });
    bridges.push(bridge);
    try {
      await updateStarted.promise;
      const { socket } = await authorize(bridge);
      const blocker = await concreteCoordinator.acquireReader('real-restart-blocker');
      const releasing = blocker.release();
      await releaseStarted.promise;
      const releaseRejected = expect(releasing).rejects.toThrow();
      updateGate.resolve();
      await vi.waitFor(() => expect(events).toContain('restart:pending'));
      expect(events.indexOf('update:changed')).toBeLessThan(events.indexOf('restart:pending'));
      expect(exit).not.toHaveBeenCalled();

      releaseGate.reject(new Error('cross-process ownership uncertain'));
      await releaseRejected;
      expect(concreteCoordinator.snapshot()).toMatchObject({
        physicalBusy: true,
        physicalFaulted: true,
      });

      // Exercise the server's explicit artifact-idle wake and the socket-close wake. Removing the
      // production physical-busy restart guard makes the second wake call exit here.
      wakeArtifactIdle();
      await new Promise<void>(resolve => setImmediate(resolve));
      socket.close();
      await new Promise<void>(resolve => socket.once('close', () => resolve()));
      wakeArtifactIdle();
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(events).toContain('restart:pending');
      expect(runUpdate).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      bridges.splice(bridges.indexOf(bridge), 1);
      await expect(bridge.close())
        .rejects.toThrow('本机服务未能安全关闭');
      expect(events.indexOf('restart:intent:release'))
        .toBeLessThan(events.indexOf('coordinator:close'));
      expect(exit).not.toHaveBeenCalled();
    } finally {
      updateGate.resolve();
      releaseGate.reject(new Error('cross-process ownership uncertain'));
      const index = bridges.indexOf(bridge);
      if (index >= 0) bridges.splice(index, 1);
      await bridge.close().catch(() => undefined);
    }
  });

  it('attempts restart and coordinator cleanup after directed service close rejects', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-server-close-cleanup-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-server-close-cleanup',
      queries: ['Agent'],
      queryHash: '9'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    await directedStore.startRun({
      searchSessionId: 'session-server-close-cleanup',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'server-close-cleanup-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const events: string[] = [];
    const updateStarted = deferred<void>();
    const updateGate = deferred<void>();
    const restartPending = deferred<void>();
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    let readerRelease: Promise<void> | undefined;
    const restartRelease = vi.fn(() => { events.push('restart:intent:release'); });
    const coordinatorClose = vi.fn(async () => {
      events.push('coordinator:close');
      throw new Error('private coordinator close failure');
    });
    const artifactReaderCoordinator: ArtifactReaderCoordinatorLike = {
      tryBeginStart: () => undefined,
      tryBeginUpdate: () => ({
        handoffToRestart: () => {
          events.push('restart:pending');
          restartPending.resolve();
        },
        release: restartRelease,
      }),
      acquireReader: async role => {
        expect(role).toBe('nowcoder-directed-run');
        events.push('reader:acquire');
        return {
          release: () => {
            readerRelease ??= (async () => {
              events.push('reader:release:start');
              releaseStarted.resolve();
              await releaseGate.promise;
            })();
            return readerRelease;
          },
        };
      },
      snapshot: () => ({
        startIntents: 0,
        pendingReaders: 0,
        activeReaders: 0,
        physicalBusy: false,
        updateState: 'idle',
      }),
      setOnIdle: () => undefined,
      close: coordinatorClose,
    };
    const runUpdate = vi.fn(async () => {
      events.push('update:start');
      updateStarted.resolve();
      await updateGate.promise;
      events.push('update:changed');
      return {
        changed: true,
        commit: 'abcdef123456',
        message: 'updated',
        checkedAt: NOW,
      };
    });
    const exit = vi.fn(() => { events.push('restart:exit'); });
    const hasActiveRun = vi.spyOn(NowcoderDirectedService.prototype, 'hasActiveRun')
      .mockReturnValue(false);
    let bridge: BridgeHandle | undefined;
    try {
      bridge = await startBridge({
        libraryRoot: root,
        configDir,
        port: 0,
        repoRoot: root,
        enableAutoUpdate: true,
        updateIntervalMs: 60_000,
        readArtifactBuildId: async () => BUILD,
        artifactReaderCoordinator,
        runUpdate,
        exit,
      });
      bridges.push(bridge);
      await updateStarted.promise;
      const { socket } = await authorize(bridge);
      updateGate.resolve();
      await restartPending.promise;
      expect(exit).not.toHaveBeenCalled();
      const socketClosed = new Promise<void>(resolve => {
        socket.once('close', () => {
          events.push('socket:closed');
          resolve();
        });
      });
      bridges.splice(bridges.indexOf(bridge), 1);
      const closing = bridge.close();
      expect(bridge.close()).toBe(closing);
      const closeSettlement = closing.then(
        () => ({ status: 'fulfilled' as const }),
        reason => ({ status: 'rejected' as const, reason }),
      );
      await releaseStarted.promise;
      await socketClosed;
      expect(restartRelease).not.toHaveBeenCalled();
      expect(coordinatorClose).not.toHaveBeenCalled();

      releaseGate.reject(new Error('private directed reader release failure'));
      const closeResult = await closeSettlement;

      expect(closeResult).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: '本机服务未能安全关闭' }),
      });
      if (closeResult.status !== 'rejected') throw new Error('server close unexpectedly fulfilled');
      expect(closeResult.reason.message).not.toContain('private directed reader release failure');
      expect(closeResult.reason.message).not.toContain('private coordinator close failure');
      expect(restartRelease).toHaveBeenCalledOnce();
      expect(coordinatorClose).toHaveBeenCalledOnce();
      expect(events.indexOf('reader:release:start'))
        .toBeLessThan(events.indexOf('restart:intent:release'));
      expect(events.indexOf('restart:intent:release'))
        .toBeLessThan(events.indexOf('coordinator:close'));
      expect(runUpdate).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      expect(bridge.close()).toBe(closing);
      await expect(bridge.close()).rejects.toBe(closeResult.reason);
    } finally {
      updateGate.resolve();
      releaseGate.reject(new Error('private directed reader release failure'));
      hasActiveRun.mockRestore();
      if (bridge) {
        const index = bridges.indexOf(bridge);
        if (index >= 0) bridges.splice(index, 1);
        await bridge.close().catch(() => undefined);
      }
    }
  });

  it('terminally fences a directed job when the final pre-send run check fails', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-final-dispatch-fence-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-final-dispatch-fence',
      queries: ['Agent'],
      queryHash: 'e'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'session-final-dispatch-fence',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'final-dispatch-fence-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const currentId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    await directedStore.checkpointRun(run.id, {
      candidateCursor: 1,
      currentJobIds: [currentId],
      currentRoundJobIds: [currentId],
      ...pendingSingleAudit(currentId),
    });
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    await jobs.create({
      id: currentId,
      url: URL,
      requestedBy: 'codex',
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
    });

    const canDispatchSpy = vi.spyOn(NowcoderDirectedService.prototype, 'canDispatch')
      .mockReturnValue(true);
    const acceptsResultSpy = vi.spyOn(NowcoderDirectedService.prototype, 'acceptsResult')
      .mockReturnValue(false);
    try {
      const bridge = await startBridge({
        libraryRoot: root,
        configDir,
        port: 0,
        repoRoot: root,
        enableAutoUpdate: false,
        readArtifactBuildId: async () => BUILD,
      });
      bridges.push(bridge);
      const { socket } = await authorize(bridge);
      const collected: string[] = [];
      socket.on('message', data => {
        const message = JSON.parse(data.toString()) as WsEnvelope;
        if (message.type === 'job.collect') collected.push(message.requestId);
      });
      socket.send(envelope('extension.hello', 'final-dispatch-fence-hello', DIRECTED_HELLO));
      const handled = waitForMessageType(socket, 'bridge.pong');
      socket.send(envelope('bridge.ping', 'final-dispatch-fence-barrier', {}));
      await handled;

      const reopened = await JobStore.open(config.jobsFile);
      expect(reopened.get(currentId)).toMatchObject({
        status: 'failed',
        errorCode: 'STALE_DIRECTED_RUN',
      });
      expect(collected).toEqual([]);
      expect(directedStore.reconciliationSnapshots()[0]).toMatchObject({
        phase: 'collecting',
        currentJobIds: [currentId],
      });
    } finally {
      canDispatchSpy.mockRestore();
      acceptsResultSpy.mockRestore();
    }
  });

  it('requeues a directed job when its socket is replaced during the final evidence read', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-stale-socket-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const directedStore = await NowcoderDirectedStore.open(
      join(configDir, 'nowcoder-directed.json'),
      { now: () => NOW, id: () => 'run-current', attempt: () => CURRENT_ATTEMPT },
    );
    await directedStore.createSession({
      id: 'session-stale-socket',
      queries: ['Agent'],
      queryHash: '1'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [candidate()],
    }, { target: 1 });
    const run = await directedStore.startRun({
      searchSessionId: 'session-stale-socket',
      selectedCandidateIds: ['candidate-1'],
      idempotencyKey: 'stale-socket-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const currentId = nowcoderDirectedJobId(run.id, run.attempt, URL);
    await directedStore.checkpointRun(run.id, {
      candidateCursor: 1,
      currentJobIds: [currentId],
      currentRoundJobIds: [currentId],
      ...pendingSingleAudit(currentId),
    });
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    await jobs.create({
      id: currentId,
      url: URL,
      requestedBy: 'codex',
      directedRunId: run.id,
      directedRunAttempt: run.attempt,
    });
    const evidenceStarted = deferred<void>();
    const evidenceGate = deferred<void>();
    const requeued = deferred<void>();
    let blockNextEvidence = false;
    const originalTransition = JobStore.prototype.transition;
    const transitionSpy = vi.spyOn(JobStore.prototype, 'transition').mockImplementation(async function (
      this: JobStore,
      id,
      status,
      patch,
    ) {
      const transitioned = await originalTransition.call(this, id, status, patch);
      if (id === currentId && status === 'dispatched') blockNextEvidence = true;
      if (id === currentId && status === 'queued') requeued.resolve();
      return transitioned;
    });
    try {
      const bridge = await startBridge({
        libraryRoot: root,
        configDir,
        port: 0,
        repoRoot: root,
        enableAutoUpdate: false,
        readArtifactBuildId: async () => {
          if (blockNextEvidence) {
            blockNextEvidence = false;
            evidenceStarted.resolve();
            await evidenceGate.promise;
          }
          return BUILD;
        },
      });
      bridges.push(bridge);
      const first = await authorize(bridge);
      const staleFrames: string[] = [];
      first.socket.on('message', data => {
        const message = JSON.parse(data.toString()) as WsEnvelope;
        if (message.type === 'job.collect') staleFrames.push(message.requestId);
      });
      first.socket.send(envelope('extension.hello', 'stale-socket-first', DIRECTED_HELLO));
      await evidenceStarted.promise;

      await connect(bridge, first.token);
      evidenceGate.resolve();
      await requeued.promise;

      expect(staleFrames).toEqual([]);
      const reopened = await JobStore.open(config.jobsFile);
      expect(reopened.get(currentId)).toMatchObject({ status: 'queued' });
      expect(directedStore.getRun(run.id)).toMatchObject({ status: 'running' });
    } finally {
      evidenceGate.resolve();
      transitionSpy.mockRestore();
    }
  });

  it('quarantines hello-time directed recovery failure while ordinary work stays available', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-hello-quarantine-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    const ordinary = await jobs.create({
      id: 'ordinary-after-directed-recovery-failure',
      url: 'https://mp.weixin.qq.com/s/ordinary-after-directed-recovery-failure',
      requestedBy: 'codex',
    });
    const reconcileSpy = vi.spyOn(NowcoderDirectedService.prototype, 'reconcileAll')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('PRIVATE_DIRECTED_STATE'));
    try {
      const bridge = await startBridge({ libraryRoot: root, configDir, port: 0 });
      bridges.push(bridge);
      const { socket } = await authorize(bridge);
      const collected: string[] = [];
      socket.on('message', data => {
        const message = JSON.parse(data.toString()) as WsEnvelope;
        if (message.type === 'job.collect') collected.push(message.requestId);
      });
      socket.send(envelope('extension.hello', 'directed-recovery-failure', { version: APP_VERSION }));

      await vi.waitFor(async () => {
        expect(await health(bridge)).toMatchObject({
          extensionConnected: true,
          directedError: {
            code: 'DIRECTED_RECOVERY_FAILED',
            message: '牛客定向运行恢复不可用',
          },
        });
        expect(collected).toEqual([ordinary.id]);
      });
      expect(JSON.stringify(await health(bridge))).not.toContain('PRIVATE_DIRECTED_STATE');
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  it('reports a redacted directed health error when the private store cannot open', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-store-quarantine-');
    const configDir = join(root, '.config');
    const config = loadConfig({ libraryRoot: root, configDir, port: 0 });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'nowcoder-directed.json'), '{"private":"state"}\n', 'utf8');
    const jobs = await JobStore.open(config.jobsFile, { now: () => NOW });
    const ordinary = await jobs.create({
      id: 'ordinary-after-directed-store-failure',
      url: 'https://mp.weixin.qq.com/s/ordinary-after-directed-store-failure',
      requestedBy: 'codex',
    });

    const bridge = await startBridge({ libraryRoot: root, configDir, port: 0 });
    bridges.push(bridge);
    const { socket } = await authorize(bridge);
    const collected: string[] = [];
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as WsEnvelope;
      if (message.type === 'job.collect') collected.push(message.requestId);
    });
    socket.send(envelope('extension.hello', 'directed-store-failure', { version: APP_VERSION }));

    await vi.waitFor(async () => {
      expect(await health(bridge)).toMatchObject({
        extensionConnected: true,
        directedError: {
          code: 'DIRECTED_STORE_UNAVAILABLE',
          message: '牛客定向状态不可用',
        },
      });
      expect(collected).toEqual([ordinary.id]);
    });
    expect(JSON.stringify(await health(bridge))).not.toContain(configDir);
  });
});
