import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  jobCancelEnvelopeSchema,
  jobCollectEnvelopeSchema,
  stableContentId,
} from '@data-collector/shared';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
import { nowcoderDirectedJobId } from '../../packages/bridge/src/nowcoderDirected/jobIdentity.js';
import { processedNowcoderHistoryDigest } from '../../packages/bridge/src/plans/nowcoderProcessedHistory.js';

const NOW = '2026-08-30T00:00:00.000Z';
const LATER = '2026-08-30T00:31:00.000Z';
const OLD_ATTEMPT = 'fedcba9876543210';
const RUNTIME = '11111111-1111-4111-8111-111111111111';
const RUN_EVIDENCE = {
  buildEvidence: {
    applicationVersion: '0.4.33',
    bridgeBuildId: 'v0.4.33 · abcdef1',
    artifactBuildId: 'v0.4.33 · abcdef1',
    extensionVersion: '0.4.33',
    extensionBuildId: 'v0.4.33 · abcdef1',
    extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
    frozenAt: NOW,
  },
  runtimeId: RUNTIME,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function candidates() {
  return [{
    id: 'candidate-1', canonicalUrl: 'https://www.nowcoder.com/feed/main/detail/one', contentType: 'post' as const,
    matchedQueries: ['Agent'], page: 1, rank: 1, publishedAt: '2026-08-29T00:00:00.000Z',
  }, {
    id: 'candidate-2', canonicalUrl: 'https://www.nowcoder.com/feed/main/detail/two', contentType: 'post' as const,
    matchedQueries: ['Agent'], page: 1, rank: 2, publishedAt: '2026-08-28T00:00:00.000Z',
  }];
}

async function session(store: NowcoderDirectedStore, target?: number) {
  return await store.createSession({
    id: 'session-1', queries: ['Agent'], queryHash: 'a'.repeat(64), requestedSort: 'latest',
    provider: 'nowcoder-json', sortVerified: true, createdAt: NOW, expiresAt: '2026-08-30T00:30:00.000Z',
    candidates: candidates(),
  }, target === undefined ? {} : { target });
}

async function storedEnvelope(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as {
    sessions: Array<{ session: { id: string; candidates: unknown[] }; target: number }>;
    runs: Array<{
      run: { id: string; attempt: string; status: string; retryOf?: string; spec: { idempotencyKey: string }; currentJobIds: string[]; idempotencyLineage: string[] };
      frozenCandidates: unknown[];
      candidateCursor: number;
      currentRoundJobIds: string[];
    }>;
    startIdempotency: Record<string, { fingerprint: string; runId: string }>;
    retryIdempotency: Record<string, { fingerprint: string; runId: string }>;
  };
}

async function startEnvelope(path: string, target?: number) {
  const store = await NowcoderDirectedStore.open(path, { now: () => NOW });
  await session(store, target);
  const run = await store.startRun({ searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true }, RUN_EVIDENCE);
  return { store, run, envelope: await storedEnvelope(path) };
}

function ownedJobId(run: { id: string; attempt: string }, canonicalUrl: string): string {
  return nowcoderDirectedJobId(run.id, run.attempt, canonicalUrl);
}

function rejection(
  run: { id: string; attempt: string },
  index: number,
  code: 'DETAIL_NOT_SAVED' | 'DETAIL_FAILED' = 'DETAIL_NOT_SAVED',
) {
  const candidate = candidates()[index]!;
  const message = code === 'DETAIL_NOT_SAVED' ? '详情尚未形成可验证快照' : '详情收集失败';
  return {
    jobId: ownedJobId(run, candidate.canonicalUrl),
    url: candidate.canonicalUrl,
    code,
    message,
    detail: message,
  } as const;
}

function auditedProgress(options: { accepted: number; scheduled: number; delivered?: number }) {
  const rejected = options.scheduled - options.accepted;
  return {
    discovered: 2,
    detailScheduled: options.scheduled,
    detailSaved: options.scheduled,
    inspected: options.scheduled,
    qualified: options.accepted,
    accepted: options.accepted,
    delivered: options.delivered ?? 0,
    rejectionCounts: rejected === 0 ? [] : [{
      code: 'DETAIL_NOT_SAVED' as const,
      message: '详情尚未形成可验证快照',
      count: rejected,
    }],
    companies: [
      { company: 'bytedance' as const, count: 0 },
      { company: 'tencent' as const, count: 0 },
      { company: 'alibaba' as const, count: 0 },
      { company: 'ant' as const, count: 0 },
      { company: 'other' as const, count: options.accepted },
    ],
  };
}

async function publishingEnvelope(path: string, withHistory = false) {
  const { store, run } = await startEnvelope(path, 1);
  const urls = candidates().map(candidate => candidate.canonicalUrl);
  const ids = urls.map(url => ownedJobId(run, url));
  const deliveryItems = [{
    jobId: ids[0]!,
    stableContentId: stableContentId(urls[0]!),
    canonicalUrl: urls[0]!,
    contentHash: '4444444444444444',
    clusterId: 'publishing-cluster',
  }];
  await store.checkpointCurrentRun(run.id, run.attempt, {
    phase: 'staging',
    candidateCursor: 2,
    currentJobIds: ids,
    currentRoundJobIds: ids,
    accepted: 1,
    progress: auditedProgress({ accepted: 1, scheduled: 2 }),
    deliveryItems,
    privateRejections: [rejection(run, 1)],
  });
  if (withHistory) {
    const snapshot = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
    await store.persistHistorySnapshotCurrent(
      run.id,
      run.attempt,
      snapshot,
      processedNowcoderHistoryDigest(snapshot),
    );
  }
  await store.beginPublishingCurrent(run.id, run.attempt);
  return { store, run, ids, urls, deliveryItems };
}

describe('NowcoderDirectedStore', () => {
  it('uses a fixed SHA-256 child identity for maximum-length lineage and reopens it exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-long-job-id-'));
    const path = join(root, 'directed.json');
    const runId = 'r'.repeat(200);
    const canonicalUrl = `https://www.nowcoder.com/feed/main/detail/${'x'.repeat(3500)}`;
    const store = await NowcoderDirectedStore.open(path, {
      now: () => NOW,
      id: () => runId,
      attempt: () => '0123456789abcdef',
    });
    await store.createSession({
      id: 'session-long', queries: ['Agent'], queryHash: 'a'.repeat(64), requestedSort: 'latest',
      provider: 'nowcoder-json', sortVerified: true, createdAt: NOW, expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [{
        id: 'candidate-long', canonicalUrl, contentType: 'post', matchedQueries: ['Agent'],
        page: 1, rank: 1, publishedAt: '2026-08-29T00:00:00.000Z',
      }],
    }, { target: 1 });
    const run = await store.startRun({
      searchSessionId: 'session-long', selectedCandidateIds: [], idempotencyKey: 'long-key', deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const id = nowcoderDirectedJobId(run.id, run.attempt, canonicalUrl);
    expect(id).toMatch(/^nowcoder-job-[a-f0-9]{64}$/u);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(nowcoderDirectedJobId(run.id, run.attempt, `${canonicalUrl}y`)).not.toBe(id);
    expect(() => jobCollectEnvelopeSchema.parse({
      protocolVersion: 1,
      type: 'job.collect',
      requestId: id,
      timestamp: NOW,
      payload: {
        url: canonicalUrl,
        interactive: false,
        directedRunId: run.id,
        directedRunAttempt: run.attempt,
      },
    })).not.toThrow();
    expect(() => jobCancelEnvelopeSchema.parse({
      protocolVersion: 1,
      type: 'job.cancel',
      requestId: id,
      timestamp: NOW,
      payload: {
        directedRunId: run.id,
        directedRunAttempt: run.attempt,
      },
    })).not.toThrow();
    await store.checkpointCurrentRun(run.id, run.attempt, {
      candidateCursor: 1,
      currentJobIds: [id],
      currentRoundJobIds: [id],
      accepted: 0,
      progress: {
        discovered: 1, detailScheduled: 1, detailSaved: 0, inspected: 0,
        qualified: 0, accepted: 0, delivered: 0,
        rejectionCounts: [{
          code: 'DETAIL_NOT_SAVED', message: '详情尚未形成可验证快照', count: 1,
        }],
        companies: [
          { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 },
          { company: 'other', count: 0 },
        ],
      },
      deliveryItems: [],
      privateRejections: [{
        jobId: id, url: canonicalUrl, code: 'DETAIL_NOT_SAVED',
        message: '详情尚未形成可验证快照', detail: '详情尚未形成可验证快照',
      }],
    });
    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });
    expect(reopened.reconciliationSnapshots()[0]?.currentJobIds).toEqual([id]);
  });

  it('accepts only the fixed thirty-minute search-session TTL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-ttl-'));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), { now: () => NOW });

    await expect(store.createSession({
      id: 'session-too-long', queries: ['Agent'], queryHash: 'a'.repeat(64), requestedSort: 'latest',
      provider: 'nowcoder-json', sortVerified: true, createdAt: NOW, expiresAt: '2026-08-30T01:00:00.000Z',
      candidates: candidates(),
    })).rejects.toThrow('30 分钟');
  });

  it('persists frozen session candidate order in a private 0600 versioned envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-store-'));
    const path = join(root, 'directed.json');
    const store = await NowcoderDirectedStore.open(path, { now: () => NOW });
    await session(store);
    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

    expect(reopened.getSession('session-1')?.candidates.map(candidate => candidate.id))
      .toEqual(['candidate-1', 'candidate-2']);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('rejects an expired first start but permits an existing run retry after expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-expiry-'));
    const path = join(root, 'directed.json');
    const store = await NowcoderDirectedStore.open(path, { now: () => NOW, id: (() => {
      const ids = ['run-1', 'run-2']; return () => ids.shift() ?? 'run-more';
    })(), attempt: (() => { const attempts = ['0123456789abcdef', 'fedcba9876543210']; return () => attempts.shift() ?? '1111111111111111'; })() });
    await session(store);
    const first = await store.startRun({ searchSessionId: 'session-1', selectedCandidateIds: ['candidate-2'], idempotencyKey: 'start-key', deliveryAuthorized: true }, RUN_EVIDENCE);
    await store.markTerminalCurrent(first.id, first.attempt, 'failed');
    const expired = await NowcoderDirectedStore.open(path, { now: () => LATER });

    await expect(expired.startRun({ searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'other-key', deliveryAuthorized: true }, RUN_EVIDENCE))
      .rejects.toThrow('搜索会话已过期');
    const retry = await expired.retryRun(first.id, { idempotencyKey: 'retry-key' }, { ...RUN_EVIDENCE, runtimeId: '22222222-2222-4222-8222-222222222222' });
    expect((await storedEnvelope(path)).runs.find(item => item.run.id === retry.id)?.run.retryOf).toBe(first.id);
  });

  it('replays an identical start, rejects key reuse with a different body, and serializes active runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-idempotency-'));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), { now: () => NOW });
    await session(store);
    const request = { searchSessionId: 'session-1', selectedCandidateIds: ['candidate-2'], idempotencyKey: 'same-key', deliveryAuthorized: true };
    const first = await store.startRun(request, RUN_EVIDENCE);
    const replay = await store.startRun(request, RUN_EVIDENCE);

    expect(replay.id).toBe(first.id);
    await expect(store.startRun({ ...request, selectedCandidateIds: [], deliveryAuthorized: true }, RUN_EVIDENCE)).rejects.toThrow('幂等键已用于不同请求');
    await expect(store.startRun({ ...request, idempotencyKey: 'different-key' }, RUN_EVIDENCE)).rejects.toThrow('已有活跃定向运行');
  });

  it('returns an authoritative created flag from serialized start and retry mutations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-created-'));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), { now: () => NOW });
    await session(store);
    const request = {
      searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true as const,
    };

    const [first, replay] = await Promise.all([
      store.startRunAtomic(request, RUN_EVIDENCE),
      store.startRunAtomic(request, RUN_EVIDENCE),
    ]);
    expect([first.created, replay.created].sort()).toEqual([false, true]);
    expect(first.run.id).toBe(replay.run.id);
    await store.markTerminalCurrent(first.run.id, first.run.attempt, 'failed');

    const retryEvidence = { ...RUN_EVIDENCE, runtimeId: '22222222-2222-4222-8222-222222222222' };
    const [retry, retryReplay] = await Promise.all([
      store.retryRunAtomic(first.run.id, { idempotencyKey: 'retry-key' }, retryEvidence),
      store.retryRunAtomic(first.run.id, { idempotencyKey: 'retry-key' }, retryEvidence),
    ]);
    expect([retry.created, retryReplay.created].sort()).toEqual([false, true]);
    expect(retry.run.id).toBe(retryReplay.run.id);
  });

  it('does not expose a start replay until its atomic write commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-committed-start-'));
    const writeGate = deferred<void>();
    const writeEntered = deferred<void>();
    let blockWrite = false;
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
      now: () => NOW,
      atomicWrite: async () => {
        if (!blockWrite) return;
        writeEntered.resolve();
        await writeGate.promise;
      },
    });
    await session(store);
    const request = {
      searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true as const,
    };
    blockWrite = true;
    const first = store.startRunAtomic(request, RUN_EVIDENCE);
    await writeEntered.promise;
    let replaySettled = false;
    const replay = Promise.resolve(store.findStartReplay(request)).then(value => {
      replaySettled = true;
      return value;
    });

    await Promise.resolve();
    expect(replaySettled).toBe(false);
    writeGate.resolve();
    const created = await first;
    await expect(replay).resolves.toEqual(created.run);
  });

  it('rolls a failed uncommitted start replay back before permitting a new attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-rolled-back-start-'));
    const writeGate = deferred<void>();
    const writeEntered = deferred<void>();
    let blocked = false;
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
      now: () => NOW,
      atomicWrite: async () => {
        if (!blocked) return;
        blocked = false;
        writeEntered.resolve();
        await writeGate.promise;
      },
    });
    await session(store);
    const request = {
      searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true as const,
    };
    blocked = true;
    const first = store.startRunAtomic(request, RUN_EVIDENCE);
    await writeEntered.promise;
    const replay = Promise.resolve(store.findStartReplay(request));

    writeGate.reject(new Error('disk full'));
    await expect(first).rejects.toThrow('disk full');
    await expect(replay).resolves.toBeUndefined();
    await expect(store.startRunAtomic(request, RUN_EVIDENCE)).resolves.toMatchObject({ created: true });
  });

  it('does not expose a retry replay until its atomic write commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-committed-retry-'));
    const writeGate = deferred<void>();
    const writeEntered = deferred<void>();
    let blockWrite = false;
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
      now: () => NOW,
      atomicWrite: async () => {
        if (!blockWrite) return;
        writeEntered.resolve();
        await writeGate.promise;
      },
    });
    await session(store);
    const source = await store.startRun({
      searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    await store.markTerminalCurrent(source.id, source.attempt, 'failed');
    const request = { idempotencyKey: 'retry-key' };
    blockWrite = true;
    const first = store.retryRunAtomic(source.id, request, RUN_EVIDENCE);
    await writeEntered.promise;
    let replaySettled = false;
    const replay = Promise.resolve(store.findRetryReplay(source.id, request)).then(value => {
      replaySettled = true;
      return value;
    });

    await Promise.resolve();
    expect(replaySettled).toBe(false);
    writeGate.resolve();
    const created = await first;
    await expect(replay).resolves.toEqual(created.run);
  });

  it('rolls a failed uncommitted retry replay back before permitting a new attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-rolled-back-retry-'));
    const writeGate = deferred<void>();
    const writeEntered = deferred<void>();
    let blocked = false;
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
      now: () => NOW,
      atomicWrite: async () => {
        if (!blocked) return;
        blocked = false;
        writeEntered.resolve();
        await writeGate.promise;
      },
    });
    await session(store);
    const source = await store.startRun({
      searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    await store.markTerminalCurrent(source.id, source.attempt, 'failed');
    const request = { idempotencyKey: 'retry-key' };
    blocked = true;
    const first = store.retryRunAtomic(source.id, request, RUN_EVIDENCE);
    await writeEntered.promise;
    const replay = Promise.resolve(store.findRetryReplay(source.id, request));

    writeGate.reject(new Error('disk full'));
    await expect(first).rejects.toThrow('disk full');
    await expect(replay).resolves.toBeUndefined();
    await expect(store.retryRunAtomic(source.id, request, RUN_EVIDENCE)).resolves.toMatchObject({ created: true });
  });

  it('requires a fresh retry key and replays the created retry with preserved frozen candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-retry-'));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), { now: () => NOW });
    await session(store);
    const first = await store.startRun({ searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true }, RUN_EVIDENCE);

    await expect(store.retryRun(first.id, { idempotencyKey: 'start-key' }, RUN_EVIDENCE)).rejects.toThrow('新的幂等键');
    await store.markTerminalCurrent(first.id, first.attempt, 'failed');
    const retry = await store.retryRun(first.id, { idempotencyKey: 'retry-key' }, { ...RUN_EVIDENCE, runtimeId: '22222222-2222-4222-8222-222222222222' });
    const replay = await store.retryRun(first.id, { idempotencyKey: 'retry-key' }, { ...RUN_EVIDENCE, runtimeId: '22222222-2222-4222-8222-222222222222' });
    expect(retry.id).not.toBe(first.id);
    expect(replay.id).toBe(retry.id);
    expect(retry.buildEvidence).toEqual(RUN_EVIDENCE.buildEvidence);
    expect(store.privateRunEvidence(retry.id)?.observedRuntimeIds)
      .toEqual(['22222222-2222-4222-8222-222222222222']);
    expect((await storedEnvelope(join(root, 'directed.json'))).runs.find(item => item.run.id === retry.id)?.frozenCandidates
      .map(candidate => (candidate as { id: string }).id))
      .toEqual(['candidate-1', 'candidate-2']);
  });

  it('clears source-attempt attention state when retry freezes fresh evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-attention-retry-'));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), { now: () => NOW });
    await session(store);
    const first = await store.startRun({
      searchSessionId: 'session-1',
      selectedCandidateIds: [],
      idempotencyKey: 'start-key',
      deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    await store.markAttentionCurrent(first.id, first.attempt, {
      code: 'DIRECTED_EXTENSION_BUILD_CHANGED',
      message: 'source attempt stopped',
      at: NOW,
      phase: 'collecting',
    });

    const retry = await store.retryRun(first.id, { idempotencyKey: 'retry-key' }, {
      buildEvidence: { ...RUN_EVIDENCE.buildEvidence, frozenAt: '2026-08-30T00:01:00.000Z' },
      runtimeId: '22222222-2222-4222-8222-222222222222',
    });

    expect(retry).toMatchObject({ status: 'running', buildEvidence: { frozenAt: '2026-08-30T00:01:00.000Z' } });
    expect(retry).not.toHaveProperty('attentionReason');
  });

  it('rolls memory back if an atomic persistence write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-rollback-'));
    const path = join(root, 'directed.json');
    const store = await NowcoderDirectedStore.open(path, { now: () => NOW, atomicWrite: async () => { throw new Error('disk full'); } });

    await expect(session(store)).rejects.toThrow('disk full');
    expect(store.getSession('session-1')).toBeUndefined();
  });

  it('persists private cursor, current-job, and build checkpoints without leaking them publicly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-checkpoint-'));
    const path = join(root, 'directed.json');
    const store = await NowcoderDirectedStore.open(path, { now: () => NOW });
    await session(store);
    const run = await store.startRun({ searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true }, RUN_EVIDENCE);
    const ids = candidates().map(candidate => ownedJobId(run, candidate.canonicalUrl));

    await store.checkpointRun(run.id, {
      phase: 'collecting', candidateCursor: 2, currentRoundJobIds: [ids[1]!], currentJobIds: ids,
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 2 }),
      deliveryItems: [], privateRejections: [rejection(run, 0), rejection(run, 1)],
    });
    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

    expect((await storedEnvelope(path)).runs.find(item => item.run.id === run.id)).toMatchObject({
      candidateCursor: 2, currentRoundJobIds: [ids[1]],
      run: {
        currentJobIds: ids,
        phase: 'collecting',
        buildEvidence: RUN_EVIDENCE.buildEvidence,
        observedRuntimeIds: [RUNTIME],
      },
    });
    expect(reopened.getRun(run.id)).toMatchObject({ buildEvidence: RUN_EVIDENCE.buildEvidence });
    expect(reopened.getRun(run.id)).not.toHaveProperty('currentJobIds');
    expect(reopened.getRun(run.id)).not.toHaveProperty('observedRuntimeIds');
  });

  it('rejects an incomplete non-systemic rejection snapshot at terminal selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-rejection-totality-'));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), { now: () => NOW });
    await session(store);
    const run = await store.startRun({
      searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true,
    }, RUN_EVIDENCE);
    const ids = candidates().map(candidate => ownedJobId(run, candidate.canonicalUrl));
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 2, currentRoundJobIds: ids, currentJobIds: ids,
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 2 }),
      deliveryItems: [], privateRejections: [rejection(run, 0), rejection(run, 1)],
    });

    await expect(store.markSelectionAttentionCurrent(run.id, run.attempt, {
      code: 'DIRECTED_TARGET_UNAVAILABLE',
      message: '在最多 24 篇详情中未筛得足量有效面经',
      at: NOW,
      phase: 'selecting',
    }, {
      accepted: 1,
      progress: {
        discovered: 2, detailScheduled: 2, detailSaved: 1, inspected: 1, qualified: 1,
        accepted: 1, delivered: 0, rejectionCounts: [],
        companies: [
          { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 },
          { company: 'other', count: 1 },
        ],
      },
      privateRejections: [],
    })).rejects.toThrow('拒绝计数不完整');
    expect(store.getRun(run.id)?.status).toBe('running');
  });

  it('rejects target-unavailable terminal state that retains a private delivery item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-target-private-delivery-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path, 1);
    const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'selecting', candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first],
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 1 }),
      deliveryItems: [], privateRejections: [rejection(run, 0)],
    });
    await store.markSelectionAttentionCurrent(run.id, run.attempt, {
      code: 'DIRECTED_TARGET_UNAVAILABLE',
      message: '在最多 24 篇详情中未筛得足量有效面经',
      at: NOW,
      phase: 'selecting',
    }, {
      accepted: 0,
      progress: auditedProgress({ accepted: 0, scheduled: 1 }),
      privateRejections: [rejection(run, 0)],
    });
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ run: { deliveryItems: unknown[] } }>;
    };
    raw.runs[0]!.run.deliveryItems = [{
      jobId: first,
      stableContentId: stableContentId(candidates()[0]!.canonicalUrl),
      canonicalUrl: candidates()[0]!.canonicalUrl,
      contentHash: '5555555555555555',
      clusterId: 'forged-target-delivery',
    }];
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
      .rejects.toThrow('定向牛客状态文件格式无效');
  });

  it('requires an explicit complete audit as soon as a collecting prefix is scheduled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-audit-state-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const first = ownedJobId(run, candidates()[0]!.canonicalUrl);

    await expect(store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first],
    })).rejects.toThrow('筛选审计');
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first],
      accepted: 0,
      progress: auditedProgress({ accepted: 0, scheduled: 1 }),
      deliveryItems: [],
      privateRejections: [rejection(run, 0)],
    });
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
    await expect(store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'selecting',
    })).resolves.toMatchObject({ phase: 'selecting' });
  });

  it('migrates legacy collecting, staging, and target-unavailable rejection rows without trusting a stored message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-legacy-audit-'));
    const cases = ['collecting', 'staging', 'target-unavailable'] as const;
    for (const state of cases) {
      const path = join(root, `${state}.json`);
      const { store, run } = await startEnvelope(path, 1);
      const ids = candidates().map(candidate => ownedJobId(run, candidate.canonicalUrl));
      if (state === 'collecting') {
        await store.checkpointCurrentRun(run.id, run.attempt, {
          phase: 'collecting',
          candidateCursor: 1,
          currentJobIds: [ids[0]!],
          currentRoundJobIds: [ids[0]!],
          accepted: 0,
          progress: auditedProgress({ accepted: 0, scheduled: 1 }),
          deliveryItems: [],
          privateRejections: [rejection(run, 0)],
        });
      } else if (state === 'staging') {
        await store.checkpointCurrentRun(run.id, run.attempt, {
          phase: 'staging',
          candidateCursor: 2,
          currentJobIds: ids,
          currentRoundJobIds: ids,
          accepted: 1,
          progress: auditedProgress({ accepted: 1, scheduled: 2 }),
          deliveryItems: [{
            jobId: ids[0]!, stableContentId: stableContentId(candidates()[0]!.canonicalUrl),
            canonicalUrl: candidates()[0]!.canonicalUrl, contentHash: '2222222222222222',
            clusterId: 'legacy-staging-cluster',
          }],
          privateRejections: [rejection(run, 1)],
        });
      } else {
        await store.checkpointCurrentRun(run.id, run.attempt, {
          phase: 'selecting',
          candidateCursor: 1,
          currentJobIds: [ids[0]!],
          currentRoundJobIds: [ids[0]!],
          accepted: 0,
          progress: auditedProgress({ accepted: 0, scheduled: 1 }),
          deliveryItems: [],
          privateRejections: [rejection(run, 0)],
        });
        await store.markSelectionAttentionCurrent(run.id, run.attempt, {
          code: 'DIRECTED_TARGET_UNAVAILABLE',
          message: '在最多 24 篇详情中未筛得足量有效面经',
          at: NOW,
          phase: 'selecting',
        }, {
          accepted: 0,
          progress: auditedProgress({ accepted: 0, scheduled: 1 }),
          privateRejections: [rejection(run, 0)],
        });
      }

      const legacy = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{
          selectionAuditComplete?: boolean;
          privateRejections: Array<{ message?: string }>;
        }>;
      };
      delete legacy.runs[0]!.selectionAuditComplete;
      delete legacy.runs[0]!.privateRejections[0]!.message;
      await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');

      await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
      const migrated = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{
          selectionAuditComplete: boolean;
          privateRejections: Array<{ message: string }>;
        }>;
      };
      expect(migrated.runs[0]).toMatchObject({
        selectionAuditComplete: true,
        privateRejections: [{ message: '详情尚未形成可验证快照' }],
      });
    }
  });

  it.each(['running', 'cancelling', 'failed'] as const)(
    'migrates a pre-totality %s collecting checkpoint only after proving the scheduled prefix',
    async status => {
      const root = await mkdtemp(join(tmpdir(), `nowcoder-directed-pre-totality-${status}-`));
      const path = join(root, 'directed.json');
      const { store, run } = await startEnvelope(path, 1);
      const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
      await store.checkpointCurrentRun(run.id, run.attempt, {
        phase: 'collecting',
        candidateCursor: 1,
        currentJobIds: [first],
        currentRoundJobIds: [first],
        accepted: 0,
        progress: auditedProgress({ accepted: 0, scheduled: 1 }),
        deliveryItems: [],
        privateRejections: [rejection(run, 0)],
      });
      const legacy = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{
          selectionAuditComplete?: boolean;
          privateRejections?: unknown[];
          run: {
            status: string;
            progress: ReturnType<typeof auditedProgress>;
          };
        }>;
      };
      legacy.runs[0]!.run.status = status;
      legacy.runs[0]!.run.progress.detailSaved = 0;
      legacy.runs[0]!.run.progress.inspected = 0;
      legacy.runs[0]!.run.progress.qualified = 0;
      legacy.runs[0]!.run.progress.rejectionCounts = [];
      delete legacy.runs[0]!.selectionAuditComplete;
      delete legacy.runs[0]!.privateRejections;
      await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');

      const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

      expect(reopened.getRun(run.id)).toMatchObject({
        status,
        progress: {
          detailScheduled: 1,
          accepted: 0,
          rejectionCounts: [{
            code: 'DETAIL_NOT_SAVED',
            message: '详情尚未形成可验证快照',
            count: 1,
          }],
        },
      });
      const migratedBytes = await readFile(path, 'utf8');
      const migrated = JSON.parse(migratedBytes) as {
        runs: Array<{
          selectionAuditComplete: boolean;
          privateRejections: Array<{ jobId: string; url: string; code: string; message: string; detail: string }>;
        }>;
      };
      expect(migrated.runs[0]).toEqual(expect.objectContaining({
        selectionAuditComplete: true,
        privateRejections: [{
          jobId: first,
          url: candidates()[0]!.canonicalUrl,
          code: 'DETAIL_NOT_SAVED',
          message: '详情尚未形成可验证快照',
          detail: '详情尚未形成可验证快照',
        }],
      }));
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
      expect(await readFile(path, 'utf8')).toBe(migratedBytes);
    },
  );

  it.each([
    ['running', 'detailSaved', { detailSaved: 1, inspected: 0, qualified: 0 }],
    ['running', 'inspected', { detailSaved: 1, inspected: 1, qualified: 0 }],
    ['running', 'qualified', { detailSaved: 1, inspected: 1, qualified: 1 }],
    ['cancelling', 'detailSaved', { detailSaved: 1, inspected: 0, qualified: 0 }],
    ['cancelling', 'inspected', { detailSaved: 1, inspected: 1, qualified: 0 }],
    ['cancelling', 'qualified', { detailSaved: 1, inspected: 1, qualified: 1 }],
    ['failed', 'detailSaved', { detailSaved: 1, inspected: 0, qualified: 0 }],
    ['failed', 'inspected', { detailSaved: 1, inspected: 1, qualified: 0 }],
    ['failed', 'qualified', { detailSaved: 1, inspected: 1, qualified: 1 }],
  ] as const)(
    'does not guess a legacy %s rejection reason after %s progress exists',
    async (status, _unsafeField, unsafeProgress) => {
      const root = await mkdtemp(join(tmpdir(), `nowcoder-directed-unsafe-totality-${status}-`));
      const path = join(root, 'directed.json');
      const { store, run } = await startEnvelope(path, 1);
      const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
      await store.checkpointCurrentRun(run.id, run.attempt, {
        phase: 'collecting',
        candidateCursor: 1,
        currentJobIds: [first],
        currentRoundJobIds: [first],
        accepted: 0,
        progress: auditedProgress({ accepted: 0, scheduled: 1 }),
        deliveryItems: [],
        privateRejections: [rejection(run, 0)],
      });
      const legacy = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{
          selectionAuditComplete?: boolean;
          privateRejections?: unknown[];
          run: {
            status: string;
            progress: ReturnType<typeof auditedProgress>;
          };
        }>;
      };
      legacy.runs[0]!.run.status = status;
      legacy.runs[0]!.run.progress = {
        ...legacy.runs[0]!.run.progress,
        ...unsafeProgress,
        rejectionCounts: [],
      };
      delete legacy.runs[0]!.selectionAuditComplete;
      delete legacy.runs[0]!.privateRejections;
      const legacyBytes = `${JSON.stringify(legacy)}\n`;
      await writeFile(path, legacyBytes, 'utf8');

      await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
        .rejects.toThrow('定向牛客状态文件格式无效');
      expect(await readFile(path, 'utf8')).toBe(legacyBytes);
    },
  );

  it('does not invent a legacy rejection partition when an accepted candidate has no private identity proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-pre-totality-accepted-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path, 1);
    const ids = candidates().map(candidate => ownedJobId(run, candidate.canonicalUrl));
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'staging', candidateCursor: 2, currentJobIds: ids, currentRoundJobIds: ids,
      accepted: 1, progress: auditedProgress({ accepted: 1, scheduled: 2 }),
      deliveryItems: [{
        jobId: ids[0]!, stableContentId: stableContentId(candidates()[0]!.canonicalUrl),
        canonicalUrl: candidates()[0]!.canonicalUrl, contentHash: '9999999999999999',
        clusterId: 'legacy-accepted-without-proof',
      }],
      privateRejections: [rejection(run, 1)],
    });
    const legacy = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        selectionAuditComplete?: boolean;
        privateRejections?: unknown[];
        run: { progress: ReturnType<typeof auditedProgress> };
      }>;
    };
    legacy.runs[0]!.run.progress.rejectionCounts = [];
    delete legacy.runs[0]!.selectionAuditComplete;
    delete legacy.runs[0]!.privateRejections;
    const legacyBytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(path, legacyBytes, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
      .rejects.toThrow('定向牛客状态文件格式无效');
    expect(await readFile(path, 'utf8')).toBe(legacyBytes);
  });

  it.each(['selecting', 'staging'] as const)(
    'preserves inspected progress when completing cancellation from %s',
    async phase => {
      const root = await mkdtemp(join(tmpdir(), `nowcoder-directed-cancel-inspected-${phase}-`));
      const path = join(root, 'directed.json');
      const { store, run } = await startEnvelope(path, 1);
      const ids = candidates().map(candidate => ownedJobId(run, candidate.canonicalUrl));
      if (phase === 'selecting') {
        await store.checkpointCurrentRun(run.id, run.attempt, {
          phase,
          candidateCursor: 1,
          currentJobIds: [ids[0]!],
          currentRoundJobIds: [ids[0]!],
          accepted: 0,
          progress: auditedProgress({ accepted: 0, scheduled: 1 }),
          deliveryItems: [],
          privateRejections: [rejection(run, 0)],
        });
      } else {
        await store.checkpointCurrentRun(run.id, run.attempt, {
          phase,
          candidateCursor: 2,
          currentJobIds: ids,
          currentRoundJobIds: ids,
          accepted: 1,
          progress: auditedProgress({ accepted: 1, scheduled: 2 }),
          deliveryItems: [{
            jobId: ids[0]!, stableContentId: stableContentId(candidates()[0]!.canonicalUrl),
            canonicalUrl: candidates()[0]!.canonicalUrl, contentHash: '8888888888888888',
            clusterId: 'cancel-inspected-staging',
          }],
          privateRejections: [rejection(run, 1)],
        });
      }
      await store.beginCancellationCurrent(run.id, run.attempt);
      for (const id of phase === 'selecting' ? [ids[0]!] : ids) {
        await store.recordTabClearEvidenceCurrent(
          run.id,
          run.attempt,
          id,
          'never_dispatched',
        );
      }
      const cancelled = await store.completeCancellationCurrent(
        run.id,
        run.attempt,
        phase === 'selecting' ? 1 : 2,
      );

      expect(cancelled).toMatchObject({
        status: 'cancelled',
        scheduledCandidateIds: phase === 'selecting' ? ['candidate-1'] : ['candidate-1', 'candidate-2'],
        progress: {
          discovered: 2,
          detailScheduled: phase === 'selecting' ? 1 : 2,
          detailSaved: phase === 'selecting' ? 1 : 2,
          inspected: phase === 'selecting' ? 1 : 2,
          qualified: 0,
          accepted: 0,
          delivered: 0,
          rejectionCounts: [],
        },
      });
      const persisted = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{
          candidateCursor: number;
          currentRoundJobIds: string[];
          run: { currentJobIds: string[] };
        }>;
      };
      const expectedIds = phase === 'selecting' ? [ids[0]!] : ids;
      expect(persisted.runs[0]).toMatchObject({
        candidateCursor: expectedIds.length,
        currentRoundJobIds: expectedIds,
        run: { currentJobIds: expectedIds },
      });
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
    },
  );

  it('linearizes cancellation against publishing and rejects every generic post-intent mutation', async () => {
    const cancelFirstRoot = await mkdtemp(join(tmpdir(), 'nowcoder-directed-cancel-first-'));
    const cancelFirst = await publishingEnvelope(join(cancelFirstRoot, 'directed.json'));
    // Recreate the exact staging checkpoint because publishingEnvelope already crossed the cutoff.
    const raw = JSON.parse(await readFile(join(cancelFirstRoot, 'directed.json'), 'utf8')) as {
      runs: Array<{ run: { status: string; phase: string } }>;
    };
    raw.runs[0]!.run.status = 'running';
    raw.runs[0]!.run.phase = 'staging';
    await writeFile(join(cancelFirstRoot, 'directed.json'), `${JSON.stringify(raw)}\n`, 'utf8');
    const staging = await NowcoderDirectedStore.open(join(cancelFirstRoot, 'directed.json'), { now: () => NOW });

    const cancelling = await staging.beginCancellationCurrent(
      cancelFirst.run.id,
      cancelFirst.run.attempt,
    );
    expect(cancelling).toMatchObject({ status: 'cancelling', phase: 'staging' });
    await expect(staging.beginPublishingCurrent(cancelFirst.run.id, cancelFirst.run.attempt))
      .rejects.toThrow('发布截止点');
    await expect(staging.checkpointCurrentRun(cancelFirst.run.id, cancelFirst.run.attempt, {
      phase: 'collecting',
    })).rejects.toThrow('尝试已过期');
    await expect(staging.recordObservedRuntime(
      cancelFirst.run.id,
      cancelFirst.run.attempt,
      '22222222-2222-4222-8222-222222222222',
    )).rejects.toThrow('尝试已过期');
    const history = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
    await expect(staging.persistHistorySnapshotCurrent(
      cancelFirst.run.id,
      cancelFirst.run.attempt,
      history,
      processedNowcoderHistoryDigest(history),
    )).rejects.toThrow('尝试已过期');
    await expect(staging.markAttentionCurrent(
      cancelFirst.run.id,
      cancelFirst.run.attempt,
      {
        code: 'DIRECTED_EXTENSION_OFFLINE',
        message: '扩展已离线',
        at: NOW,
        phase: 'staging',
      },
    )).rejects.toThrow('尝试已过期');
    await expect(staging.markSelectionAttentionCurrent(
      cancelFirst.run.id,
      cancelFirst.run.attempt,
      {
        code: 'DIRECTED_TARGET_UNAVAILABLE',
        message: '目标不足',
        at: NOW,
        phase: 'selecting',
      },
      {
        progress: cancelling.progress,
        accepted: cancelling.accepted,
        privateRejections: [],
      },
    )).rejects.toThrow('尝试已过期');
    await expect(staging.markTerminalCurrent(
      cancelFirst.run.id,
      cancelFirst.run.attempt,
      'failed',
    )).rejects.toThrow('尝试已过期');

    const publishFirstRoot = await mkdtemp(join(tmpdir(), 'nowcoder-directed-publish-first-'));
    const publishFirst = await publishingEnvelope(join(publishFirstRoot, 'directed.json'));
    await expect(publishFirst.store.beginCancellationCurrent(
      publishFirst.run.id,
      publishFirst.run.attempt,
    )).rejects.toThrow(/取消|状态|截止点/u);
    expect(publishFirst.store.getRun(publishFirst.run.id)?.status).toBe('publishing');
  });

  it('attempt-fences exact publishing completion and exposes only deterministic public delivery proofs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-published-current-'));
    const path = join(root, 'directed.json');
    const fixture = await publishingEnvelope(path);

    const completed = await fixture.store.completePublishedCurrent(
      fixture.run.id,
      fixture.run.attempt,
    );

    expect(completed).toMatchObject({
      id: fixture.run.id,
      attempt: fixture.run.attempt,
      status: 'completed',
      phase: 'publishing',
      accepted: 1,
      delivered: 1,
      activeOwnedTabs: 0,
      terminalOwnedTabs: 0,
      deliveryIds: [fixture.deliveryItems[0]!.stableContentId],
      publicDeliveryItems: [{
        stableContentId: fixture.deliveryItems[0]!.stableContentId,
        canonicalUrl: fixture.deliveryItems[0]!.canonicalUrl,
        contentHash: fixture.deliveryItems[0]!.contentHash,
        clusterId: fixture.deliveryItems[0]!.clusterId,
        lineageId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }],
      publishReceipt: {
        deliveryIds: [fixture.deliveryItems[0]!.stableContentId],
        entryHashes: [fixture.deliveryItems[0]!.contentHash],
        markerHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        publishedAt: NOW,
      },
      progress: { delivered: 1 },
    });
    const publicJson = JSON.stringify(completed);
    expect(publicJson).not.toContain('jobId');
    expect(publicJson).not.toContain(fixture.ids[0]!);
    expect(publicJson).not.toContain('/tmp/');

    const reopened = await NowcoderDirectedStore.open(path, { now: () => LATER });
    expect(await reopened.completePublishedCurrent(fixture.run.id, fixture.run.attempt))
      .toEqual(completed);
    await expect(reopened.completePublishedCurrent(fixture.run.id, OLD_ATTEMPT))
      .rejects.toThrow('尝试已过期');
  });

  it('returns exact private delivery items only for the current publisher attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-publisher-snapshot-'));
    const fixture = await publishingEnvelope(join(root, 'directed.json'));

    expect(fixture.store.publisherSnapshotCurrent(fixture.run.id, fixture.run.attempt)).toEqual({
      id: fixture.run.id,
      attempt: fixture.run.attempt,
      status: 'publishing',
      phase: 'publishing',
      target: 1,
      deliveryItems: fixture.deliveryItems,
    });
    expect(() => fixture.store.publisherSnapshotCurrent(fixture.run.id, OLD_ATTEMPT))
      .toThrow('尝试已过期');
  });

  it('does not misclassify an ENOENT from the legacy migration write as an absent store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-legacy-write-enoent-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path, 1);
    const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first],
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 1 }),
      deliveryItems: [], privateRejections: [rejection(run, 0)],
    });
    const legacy = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        selectionAuditComplete?: boolean;
        privateRejections: Array<{ message?: string }>;
      }>;
    };
    delete legacy.runs[0]!.selectionAuditComplete;
    delete legacy.runs[0]!.privateRejections[0]!.message;
    await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');
    const migrationError = Object.assign(new Error('迁移目标在写入时消失'), { code: 'ENOENT' });

    await expect(NowcoderDirectedStore.open(path, {
      now: () => NOW,
      atomicWrite: async () => { throw migrationError; },
    })).rejects.toBe(migrationError);
  });

  it('migrates marker-verified attention to a complete retained selection audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-marker-attention-audit-'));
    const path = join(root, 'directed.json');
    const fixture = await publishingEnvelope(path);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        selectionAuditComplete?: boolean;
        run: {
          status: string;
          delivered: number;
          deliveryIds: string[];
          publicDeliveryItems: unknown[];
          publishReceipt?: unknown;
          verifiedMarkerHash?: string;
          recovery?: unknown;
          attentionReason?: unknown;
          summary?: string;
          actionable?: string;
          progress: ReturnType<typeof auditedProgress>;
        };
      }>;
    };
    const item = raw.runs[0]!;
    const accepted = fixture.deliveryItems[0]!;
    const markerHash = 'd'.repeat(64);
    item.run.status = 'completed_with_attention';
    item.run.delivered = 1;
    item.run.deliveryIds = [accepted.stableContentId];
    item.run.publicDeliveryItems = [{
      stableContentId: accepted.stableContentId,
      canonicalUrl: accepted.canonicalUrl,
      contentHash: accepted.contentHash,
      clusterId: accepted.clusterId,
      lineageId: 'c'.repeat(64),
    }];
    item.run.publishReceipt = {
      deliveryIds: [accepted.stableContentId],
      entryHashes: [accepted.contentHash],
      markerHash,
      publishedAt: NOW,
    };
    item.run.verifiedMarkerHash = markerHash;
    item.run.recovery = {
      verifiedMarkerHash: markerHash,
      markerDeliveryIds: [accepted.stableContentId],
      markerEntryHashes: [accepted.contentHash],
    };
    item.run.progress = { ...item.run.progress, delivered: 1 };
    item.run.attentionReason = {
      code: 'DIRECTED_ARTIFACT_CHANGED', message: '扩展产物已变化', at: NOW, phase: 'publishing',
    };
    item.run.summary = '扩展产物已变化';
    item.run.actionable = '请确认发布结果';
    delete item.selectionAuditComplete;
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
    const migrated = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ selectionAuditComplete: boolean; privateRejections: unknown[] }>;
    };
    expect(migrated.runs[0]).toMatchObject({
      selectionAuditComplete: true,
      privateRejections: [expect.objectContaining({ code: 'DETAIL_NOT_SAVED' })],
    });
  });

  it.each(['systemic-attention', 'cancelled'] as const)(
    'migrates a legacy audit flag to false for exempt %s staging state',
    async state => {
      const root = await mkdtemp(join(tmpdir(), `nowcoder-directed-legacy-exempt-${state}-`));
      const path = join(root, 'directed.json');
      const { store, run } = await startEnvelope(path, 1);
      const ids = candidates().map(candidate => ownedJobId(run, candidate.canonicalUrl));
      await store.checkpointCurrentRun(run.id, run.attempt, {
        phase: 'staging',
        candidateCursor: 2,
        currentJobIds: ids,
        currentRoundJobIds: ids,
        accepted: 1,
        progress: auditedProgress({ accepted: 1, scheduled: 2 }),
        deliveryItems: [{
          jobId: ids[0]!, stableContentId: stableContentId(candidates()[0]!.canonicalUrl),
          canonicalUrl: candidates()[0]!.canonicalUrl, contentHash: '3333333333333333',
          clusterId: 'legacy-exempt-cluster',
        }],
        privateRejections: [rejection(run, 1)],
      });
      await store.markAttentionCurrent(run.id, run.attempt, {
        code: 'DIRECTED_ARTIFACT_CHANGED',
        message: '扩展产物已变化',
        at: NOW,
        phase: 'staging',
      });
      const legacy = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{
          selectionAuditComplete?: boolean;
          run: {
            status: string;
            attentionReason?: unknown;
            summary?: string;
            actionable?: string;
          };
        }>;
      };
      delete legacy.runs[0]!.selectionAuditComplete;
      if (state === 'cancelled') {
        legacy.runs[0]!.run.status = 'cancelled';
        delete legacy.runs[0]!.run.attentionReason;
        delete legacy.runs[0]!.run.summary;
        delete legacy.runs[0]!.run.actionable;
      }
      await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');

      await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
      const migrated = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{ selectionAuditComplete: boolean }>;
      };
      expect(migrated.runs[0]!.selectionAuditComplete).toBe(false);
    },
  );

  it('fails closed when a legacy private rejection has an invalid code or shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-legacy-audit-invalid-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path, 1);
    const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first],
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 1 }),
      deliveryItems: [], privateRejections: [rejection(run, 0)],
    });
    const valid = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ selectionAuditComplete?: boolean; privateRejections: Array<Record<string, unknown>> }>;
    };
    delete valid.runs[0]!.selectionAuditComplete;
    delete valid.runs[0]!.privateRejections[0]!.message;

    for (const corrupt of [
      (value: typeof valid) => { value.runs[0]!.privateRejections[0]!.code = 'NOT_A_REJECTION'; },
      (value: typeof valid) => { value.runs[0]!.privateRejections = [null as unknown as Record<string, unknown>]; },
      (value: typeof valid) => { value.runs[0]!.privateRejections[0]!.message = '伪造的拒绝文案'; },
    ]) {
      const candidate = structuredClone(valid);
      corrupt(candidate);
      await writeFile(path, `${JSON.stringify(candidate)}\n`, 'utf8');
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
        .rejects.toThrow('状态文件格式无效');
    }
  });

  it('validates private terminal rejection identity before writing and preserves the reopenable prior checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-private-audit-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const ids = candidates().map(candidate => ownedJobId(run, candidate.canonicalUrl));
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 2, currentJobIds: ids, currentRoundJobIds: ids,
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 2 }),
      deliveryItems: [], privateRejections: [rejection(run, 0), rejection(run, 1)],
    });
    const before = await readFile(path, 'utf8');

    await expect(store.markSelectionAttentionCurrent(run.id, run.attempt, {
      code: 'DIRECTED_TARGET_UNAVAILABLE',
      message: '在最多 24 篇详情中未筛得足量有效面经',
      at: NOW,
      phase: 'selecting',
    }, {
      accepted: 1,
      progress: {
        discovered: 2, detailScheduled: 2, detailSaved: 1, inspected: 1, qualified: 1,
        accepted: 1, delivered: 0,
        rejectionCounts: [{ code: 'DETAIL_FAILED', message: '详情收集失败', count: 1 }],
        companies: [
          { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 },
          { company: 'other', count: 1 },
        ],
      },
      privateRejections: [{
        jobId: ids[1]!,
        url: 'https://www.nowcoder.com/discuss/999999',
        code: 'DETAIL_FAILED',
        message: '详情收集失败',
        detail: '详情收集失败',
      }],
    })).rejects.toThrow('筛选审计');

    expect(await readFile(path, 'utf8')).toBe(before);
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
  });

  it('rejects foreign and incorrectly derived staging delivery identity and reserves publishing for the atomic cutoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-staging-identity-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const urls = candidates().map(candidate => candidate.canonicalUrl);
    const ids = urls.map(url => ownedJobId(run, url));
    const progress = {
      discovered: 2, detailScheduled: 2, detailSaved: 2, inspected: 2, qualified: 2,
      accepted: 2, delivered: 0, rejectionCounts: [],
      companies: [
        { company: 'bytedance' as const, count: 0 }, { company: 'tencent' as const, count: 0 },
        { company: 'alibaba' as const, count: 0 }, { company: 'ant' as const, count: 0 },
        { company: 'other' as const, count: 2 },
      ],
    };
    const validItems = urls.map((url, index) => ({
      jobId: ids[index]!, stableContentId: stableContentId(url), canonicalUrl: url,
      contentHash: `${index + 1}`.repeat(16), clusterId: `cluster-${index + 1}`,
    }));
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 2, currentJobIds: ids, currentRoundJobIds: ids,
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 2 }),
      deliveryItems: [], privateRejections: [rejection(run, 0), rejection(run, 1)],
    });

    await expect(store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'staging', progress, accepted: 2,
      deliveryItems: [{ ...validItems[0]!, jobId: 'foreign-job' }, validItems[1]!],
      privateRejections: [],
    })).rejects.toThrow('交付身份');
    await expect(store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'staging', progress, accepted: 2,
      deliveryItems: [{ ...validItems[0]!, stableContentId: 'wrong-id' }, validItems[1]!],
      privateRejections: [],
    })).rejects.toThrow('交付身份');
    await expect(store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'publishing',
    })).rejects.toThrow('发布截止点');
    expect(store.getRun(run.id)).toMatchObject({ status: 'running', phase: 'collecting' });
  });

  it('revalidates exact staging delivery identity after publishing cutover and on reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-publishing-identity-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const urls = candidates().map(candidate => candidate.canonicalUrl);
    const ids = urls.map(url => ownedJobId(run, url));
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 2, currentJobIds: ids, currentRoundJobIds: ids,
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 2 }),
      deliveryItems: [], privateRejections: [rejection(run, 0), rejection(run, 1)],
    });
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'staging',
      accepted: 2,
      progress: {
        discovered: 2, detailScheduled: 2, detailSaved: 2, inspected: 2, qualified: 2,
        accepted: 2, delivered: 0, rejectionCounts: [],
        companies: [
          { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 }, { company: 'other', count: 2 },
        ],
      },
      deliveryItems: urls.map((url, index) => ({
        jobId: ids[index]!,
        stableContentId: stableContentId(url),
        canonicalUrl: url,
        contentHash: `${index + 4}`.repeat(16),
        clusterId: `publishing-cluster-${index}`,
      })),
      privateRejections: [],
    });
    await store.beginPublishingCurrent(run.id, run.attempt);
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();

    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ run: { deliveryItems: Array<{ jobId: string }> } }>;
    };
    raw.runs[0]!.run.deliveryItems[0]!.jobId = 'foreign-publishing-job';
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
      .rejects.toThrow('交付身份');
  });

  it('rejects publishing with a non-publishing phase at reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-publishing-phase-'));
    const path = join(root, 'directed.json');
    await publishingEnvelope(path);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ run: { phase: string } }>;
    };
    raw.runs[0]!.run.phase = 'staging';
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
      .rejects.toThrow('状态文件格式无效');
  });

  it('rejects a cancelled envelope that retains private delivery state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-cancelled-private-'));
    const path = join(root, 'directed.json');
    await publishingEnvelope(path);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        selectionAuditComplete: boolean;
        privateRejections: unknown[];
        run: {
          status: string;
          phase: string;
          accepted: number;
          delivered: number;
          deliveryIds: string[];
          publicDeliveryItems: unknown[];
          publishReceipt?: unknown;
          progress: ReturnType<typeof auditedProgress>;
        };
      }>;
    };
    const item = raw.runs[0]!;
    item.run.status = 'cancelled';
    item.run.phase = 'staging';
    item.run.accepted = 0;
    item.run.delivered = 0;
    item.run.deliveryIds = [];
    item.run.publicDeliveryItems = [];
    delete item.run.publishReceipt;
    item.run.progress = {
      ...item.run.progress,
      qualified: 0,
      accepted: 0,
      delivered: 0,
      rejectionCounts: [],
      companies: item.run.progress.companies.map(company => ({ ...company, count: 0 })),
    };
    item.selectionAuditComplete = false;
    item.privateRejections = [];
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
      .rejects.toThrow('状态文件格式无效');
  });

  it('rejects a failed scheduled run whose private rejection partition was erased', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-failed-audit-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first],
      accepted: 0, progress: auditedProgress({ accepted: 0, scheduled: 1 }),
      deliveryItems: [], privateRejections: [rejection(run, 0)],
    });
    await store.markTerminalCurrent(run.id, run.attempt, 'failed');
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();

    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        selectionAuditComplete: boolean;
        privateRejections: unknown[];
        run: { progress: ReturnType<typeof auditedProgress> };
      }>;
    };
    const item = raw.runs[0]!;
    item.selectionAuditComplete = false;
    item.privateRejections = [];
    item.run.progress.rejectionCounts = [];
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
      .rejects.toThrow(/筛选审计|状态文件格式无效/);
  });

  it.each(['failed', 'cancelling'] as const)(
    'requires %s staged private delivery to retain its exact staging phase and partition',
    async status => {
      const root = await mkdtemp(join(tmpdir(), `nowcoder-directed-${status}-staging-exact-`));
      const path = join(root, 'directed.json');
      await publishingEnvelope(path);
      const original = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{
          privateRejections: Array<{ jobId: string; url: string }>;
          run: { status: string; phase: string; deliveryItems: Array<{ jobId: string; canonicalUrl: string }> };
        }>;
      };
      original.runs[0]!.run.status = status;
      original.runs[0]!.run.phase = 'staging';
      await writeFile(path, `${JSON.stringify(original)}\n`, 'utf8');
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();

      const wrongPhase = structuredClone(original);
      wrongPhase.runs[0]!.run.phase = 'collecting';
      await writeFile(path, `${JSON.stringify(wrongPhase)}\n`, 'utf8');
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
        .rejects.toThrow(/交付|状态文件格式无效/);

      const overlap = structuredClone(original);
      overlap.runs[0]!.privateRejections[0]!.jobId = overlap.runs[0]!.run.deliveryItems[0]!.jobId;
      overlap.runs[0]!.privateRejections[0]!.url = overlap.runs[0]!.run.deliveryItems[0]!.canonicalUrl;
      await writeFile(path, `${JSON.stringify(overlap)}\n`, 'utf8');
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
        .rejects.toThrow('交付与拒绝必须精确分割已调度候选');
    },
  );

  it('rejects a completed envelope whose accepted and rejected private partitions overlap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-completed-partition-'));
    const path = join(root, 'directed.json');
    const fixture = await publishingEnvelope(path);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        privateRejections: Array<{ jobId: string; url: string }>;
        run: {
          status: string;
          delivered: number;
          deliveryIds: string[];
          publicDeliveryItems: unknown[];
          publishReceipt?: unknown;
          verifiedMarkerHash?: string;
          progress: ReturnType<typeof auditedProgress>;
        };
      }>;
    };
    const item = raw.runs[0]!;
    const accepted = fixture.deliveryItems[0]!;
    item.run.status = 'completed';
    item.run.delivered = 1;
    item.run.progress = { ...item.run.progress, delivered: 1 };
    item.run.deliveryIds = [accepted.stableContentId];
    item.run.publicDeliveryItems = [{
      stableContentId: accepted.stableContentId,
      canonicalUrl: accepted.canonicalUrl,
      contentHash: accepted.contentHash,
      clusterId: accepted.clusterId,
      lineageId: 'c'.repeat(64),
    }];
    item.run.publishReceipt = {
      deliveryIds: [accepted.stableContentId],
      entryHashes: [accepted.contentHash],
      markerHash: 'd'.repeat(64),
      publishedAt: NOW,
    };
    item.run.verifiedMarkerHash = 'd'.repeat(64);
    item.privateRejections[0]!.jobId = accepted.jobId;
    item.privateRejections[0]!.url = accepted.canonicalUrl;
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
      .rejects.toThrow('交付与拒绝必须精确分割已调度候选');
  });

  it.each([
    ['digest', (value: { runs: Array<{ historySnapshot: { clusterIds: string[] } }> }) => {
      value.runs[0]!.historySnapshot.clusterIds = ['digest-mismatch'];
    }, 'DIRECTED_HISTORY_CORRUPT'],
    ['limit', (value: { runs: Array<{ historySnapshot: { clusterIds: string[] } }> }) => {
      value.runs[0]!.historySnapshot.clusterIds = Array.from(
        { length: 100_001 }, (_, index) => `cluster-${String(index).padStart(6, '0')}`,
      );
    }, 'DIRECTED_HISTORY_LIMIT_EXCEEDED'],
  ] as const)('atomically converges a reopened %s-invalid history checkpoint to fixed attention', async (_kind, corrupt, code) => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-history-reopen-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'selecting', candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first],
      accepted: 0,
      progress: auditedProgress({ accepted: 0, scheduled: 1 }),
      deliveryItems: [],
      privateRejections: [rejection(run, 0)],
    });
    const snapshot = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
    await store.persistHistorySnapshotCurrent(run.id, run.attempt, snapshot, processedNowcoderHistoryDigest(snapshot));
    const raw = JSON.parse(await readFile(path, 'utf8')) as { runs: Array<{ historySnapshot: { clusterIds: string[] } }> };
    corrupt(raw);
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

    expect(reopened.reconciliationSnapshots()).toEqual([]);
    expect(reopened.getRun(run.id)).toMatchObject({
      status: 'completed_with_attention', accepted: 0, delivered: 0,
      deliveryIds: [], publicDeliveryItems: [],
      attentionReason: { code },
      progress: { rejectionCounts: [] },
    });
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
  });

  it.each([
    ['null snapshot', (item: { historySnapshot: unknown; historyDigest: unknown }) => {
      item.historySnapshot = null;
    }],
    ['empty digest', (item: { historySnapshot: unknown; historyDigest: unknown }) => {
      item.historyDigest = '';
    }],
  ] as const)('converges a running checkpoint with a malformed %s pair', async (_kind, corrupt) => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-history-malformed-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const snapshot = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
    await store.persistHistorySnapshotCurrent(run.id, run.attempt, snapshot, processedNowcoderHistoryDigest(snapshot));
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ historySnapshot: unknown; historyDigest: unknown }>;
    };
    corrupt(raw.runs[0]!);
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

    expect(reopened.getRun(run.id)).toMatchObject({
      status: 'completed_with_attention',
      attentionReason: { code: 'DIRECTED_HISTORY_CORRUPT' },
    });
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).resolves.toBeDefined();
  });

  it('converges an invalid running staging history checkpoint before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-history-staging-'));
    const path = join(root, 'directed.json');
    const { run } = await publishingEnvelope(path, true);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ run: { status: string; phase: string }; historySnapshot: { clusterIds: string[] } }>;
    };
    raw.runs[0]!.run.status = 'running';
    raw.runs[0]!.run.phase = 'staging';
    raw.runs[0]!.historySnapshot.clusterIds = ['digest-mismatch'];
    await writeFile(path, `${JSON.stringify(raw)}\n`, 'utf8');

    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });
    expect(reopened.getRun(run.id)).toMatchObject({
      status: 'completed_with_attention',
      attentionReason: { code: 'DIRECTED_HISTORY_CORRUPT' },
    });
  });

  it.each(['cancelling', 'cancelled', 'failed'] as const)(
    'preserves %s state byte-for-byte when its no-longer-selectable history is invalid',
    async status => {
      const root = await mkdtemp(join(tmpdir(), `nowcoder-directed-history-${status}-`));
      const path = join(root, 'directed.json');
      const { store, run } = await startEnvelope(path, 1);
      const snapshot = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
      await store.persistHistorySnapshotCurrent(
        run.id,
        run.attempt,
        snapshot,
        processedNowcoderHistoryDigest(snapshot),
      );
      const raw = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{ run: { status: string }; historySnapshot: { clusterIds: string[] } }>;
      };
      raw.runs[0]!.run.status = status;
      raw.runs[0]!.historySnapshot.clusterIds = ['digest-mismatch'];
      const bytes = `${JSON.stringify(raw)}\n`;
      await writeFile(path, bytes, 'utf8');

      const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

      expect(reopened.getRun(run.id)?.status).toBe(status);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(reopened.reconciliationSnapshots().map(item => item.status))
        .toEqual(status === 'cancelling' ? ['cancelling'] : []);
    },
  );

  it.each(['cancelling', 'cancelled', 'failed'] as const)(
    'defers an incomplete %s history pair byte-for-byte without exposing it to recovery',
    async status => {
      const root = await mkdtemp(join(tmpdir(), `nowcoder-directed-history-pair-${status}-`));
      const path = join(root, 'directed.json');
      const { store, run } = await startEnvelope(path, 1);
      const snapshot = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
      await store.persistHistorySnapshotCurrent(
        run.id,
        run.attempt,
        snapshot,
        processedNowcoderHistoryDigest(snapshot),
      );
      const raw = JSON.parse(await readFile(path, 'utf8')) as {
        runs: Array<{ run: { status: string }; historyDigest?: string }>;
      };
      raw.runs[0]!.run.status = status;
      delete raw.runs[0]!.historyDigest;
      const bytes = `${JSON.stringify(raw)}\n`;
      await writeFile(path, bytes, 'utf8');

      const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

      expect(reopened.getRun(run.id)?.status).toBe(status);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      const recoverable = reopened.reconciliationSnapshots();
      expect(recoverable.map(item => item.status))
        .toEqual(status === 'cancelling' ? ['cancelling'] : []);
      if (recoverable[0]) {
        expect(recoverable[0]).not.toHaveProperty('historySnapshot');
        expect(recoverable[0]).not.toHaveProperty('historyDigest');
      }
    },
  );

  it('preserves publishing delivery evidence byte-for-byte and keeps publisher recovery routable when history is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-history-publishing-'));
    const path = join(root, 'directed.json');
    const { run, deliveryItems } = await publishingEnvelope(path, true);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        run: { status: string; phase: string; deliveryItems: unknown[] };
        historySnapshot: { clusterIds: string[] };
      }>;
    };
    raw.runs[0]!.historySnapshot.clusterIds = ['digest-mismatch'];
    const bytes = `${JSON.stringify(raw)}\n`;
    await writeFile(path, bytes, 'utf8');

    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

    expect(reopened.getRun(run.id)).toMatchObject({ status: 'publishing', phase: 'publishing' });
    expect(reopened.reconciliationSnapshots()).toEqual([
      expect.objectContaining({ id: run.id, status: 'publishing', phase: 'publishing' }),
    ]);
    expect(raw.runs[0]!.run.deliveryItems).toEqual(deliveryItems);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('preserves publishing evidence and recovery routing when the irrelevant history pair is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-history-publishing-pair-'));
    const path = join(root, 'directed.json');
    const { run, deliveryItems } = await publishingEnvelope(path, true);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{
        run: { deliveryItems: unknown[] };
        historyDigest?: string;
      }>;
    };
    delete raw.runs[0]!.historyDigest;
    const bytes = `${JSON.stringify(raw)}\n`;
    await writeFile(path, bytes, 'utf8');

    const reopened = await NowcoderDirectedStore.open(path, { now: () => NOW });

    expect(reopened.getRun(run.id)).toMatchObject({
      status: 'publishing',
      phase: 'publishing',
    });
    const [recovery] = reopened.reconciliationSnapshots();
    expect(recovery).toMatchObject({ id: run.id, status: 'publishing', phase: 'publishing' });
    expect(recovery).not.toHaveProperty('historySnapshot');
    expect(recovery).not.toHaveProperty('historyDigest');
    expect(raw.runs[0]!.run.deliveryItems).toEqual(deliveryItems);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('rejects corrupted reopened envelopes before exposing runs or sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-corrupt-'));
    const path = join(root, 'directed.json');
    const { envelope } = await startEnvelope(path);
    const cases: Array<(value: typeof envelope) => void> = [
      value => { value.sessions.push(structuredClone(value.sessions[0]) as typeof value.sessions[number]); },
      value => { value.runs.push(structuredClone(value.runs[0]) as typeof value.runs[number]); },
      value => { value.runs[0]!.candidateCursor = 3; },
      value => { value.sessions = []; },
      value => { value.runs[0]!.frozenCandidates = [value.runs[0]!.frozenCandidates[0], value.runs[0]!.frozenCandidates[0]]; },
      value => { value.runs[0]!.run.currentJobIds = ['job-1', 'job-1']; },
      value => { value.runs[0]!.run.currentJobIds = ['job-1']; value.runs[0]!.currentRoundJobIds = ['job-2']; },
      value => { value.runs.push({ ...structuredClone(value.runs[0]) as typeof value.runs[number], run: { ...value.runs[0]!.run, id: 'run-2', attempt: '1111111111111111', spec: { ...value.runs[0]!.run.spec, idempotencyKey: 'start-key-2' }, idempotencyLineage: ['start-key-2'] } }); },
      value => { value.retryIdempotency['start-key'] = structuredClone(value.startIdempotency['start-key']!); },
      value => { value.startIdempotency['start-key']!.runId = 'missing-run'; },
      value => { value.startIdempotency['start-key']!.fingerprint = '{}'; },
    ];

    for (const mutate of cases) {
      const candidate = structuredClone(envelope);
      mutate(candidate);
      await writeFile(path, `${JSON.stringify(candidate)}\n`, 'utf8');
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).rejects.toThrow('状态文件格式无效');
    }
  });

  it('rejects a retry envelope without a valid retry source and mismatched retry key details', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-retry-corrupt-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    await store.markTerminalCurrent(run.id, run.attempt, 'failed');
    await store.retryRun(run.id, { idempotencyKey: 'retry-key' }, { ...RUN_EVIDENCE, runtimeId: '22222222-2222-4222-8222-222222222222' });
    const envelope = await storedEnvelope(path);
    const retry = envelope.runs.find(item => item.run.id !== run.id)!;

    delete retry.run.retryOf;
    await writeFile(path, `${JSON.stringify(envelope)}\n`, 'utf8');
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).rejects.toThrow('状态文件格式无效');
  });

  it('does not allow checkpoint cursor regression, duplicate jobs, or a round outside current jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-monotonic-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    const first = ownedJobId(run, candidates()[0]!.canonicalUrl);
    await store.checkpointRun(run.id, {
      candidateCursor: 1, currentJobIds: [first], currentRoundJobIds: [first], accepted: 0,
      progress: auditedProgress({ accepted: 0, scheduled: 1 }), deliveryItems: [],
      privateRejections: [rejection(run, 0)],
    });

    await expect(store.checkpointRun(run.id, { candidateCursor: 0 })).rejects.toThrow('不能回退');
    await expect(store.checkpointRun(run.id, { currentJobIds: [first, first] })).rejects.toThrow('任务 ID 无效');
    await expect(store.checkpointRun(run.id, { currentRoundJobIds: ['job-2'] })).rejects.toThrow('当前轮任务');
    expect((await storedEnvelope(path)).runs[0]?.candidateCursor).toBe(1);
  });

  it('requires exact ordered candidate-derived ownership at mutation and reopen boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-derived-ownership-'));
    const mutationPath = join(root, 'mutation.json');
    const mutation = await startEnvelope(mutationPath);
    const [first, second] = candidates().map(candidate => ownedJobId(mutation.run, candidate.canonicalUrl));

    await expect(mutation.store.checkpointRun(mutation.run.id, {
      candidateCursor: 2,
      currentJobIds: [second!, first!],
      currentRoundJobIds: [second!, first!],
    })).rejects.toThrow(/冻结候选|任务归属|状态/);
    expect(mutation.store.reconciliationSnapshots()[0]).toMatchObject({
      candidateCursor: 0,
      currentJobIds: [],
      currentRoundJobIds: [],
    });

    const reopenCases: Array<{
      name: string;
      cursor: number;
      checkpoint: (ids: string[]) => { currentJobIds: string[]; currentRoundJobIds: string[] };
    }> = [
      { name: 'missing', cursor: 2, checkpoint: ids => ({ currentJobIds: [ids[0]!], currentRoundJobIds: [ids[0]!] }) },
      { name: 'reordered', cursor: 2, checkpoint: ids => ({ currentJobIds: [ids[1]!, ids[0]!], currentRoundJobIds: [ids[1]!, ids[0]!] }) },
      { name: 'wrong-derived', cursor: 1, checkpoint: ids => ({ currentJobIds: [ids[1]!], currentRoundJobIds: [ids[1]!] }) },
      { name: 'foreign', cursor: 1, checkpoint: () => ({ currentJobIds: ['foreign-job'], currentRoundJobIds: ['foreign-job'] }) },
      { name: 'round-not-suffix', cursor: 2, checkpoint: ids => ({ currentJobIds: ids, currentRoundJobIds: [ids[0]!] }) },
    ];
    for (const candidateCase of reopenCases) {
      const path = join(root, `${candidateCase.name}.json`);
      const { envelope } = await startEnvelope(path);
      const item = envelope.runs[0]!;
      const ids = candidates().map(candidate => ownedJobId(item.run, candidate.canonicalUrl));
      const checkpoint = candidateCase.checkpoint(ids);
      item.candidateCursor = candidateCase.cursor;
      item.run.currentJobIds = checkpoint.currentJobIds;
      item.currentRoundJobIds = checkpoint.currentRoundJobIds;
      await writeFile(path, `${JSON.stringify(envelope)}\n`, 'utf8');
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW }))
        .rejects.toThrow('状态文件格式无效');
    }
  });

  it('uses a private target as part of session replay identity and one idempotency key namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-identity-'));
    const path = join(root, 'directed.json');
    const store = await NowcoderDirectedStore.open(path, { now: () => NOW });
    const source = {
      id: 'session-1', queries: ['Agent'], queryHash: 'a'.repeat(64), requestedSort: 'latest' as const,
      provider: 'nowcoder-json' as const, sortVerified: true as const, createdAt: NOW, expiresAt: '2026-08-30T00:30:00.000Z', candidates: candidates(),
    };
    await store.createSession(source, { target: 1 });
    await expect(store.createSession(source, { target: 2 })).rejects.toThrow('不同请求');
    const first = await store.startRun({ searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true }, RUN_EVIDENCE);
    await store.markTerminalCurrent(first.id, first.attempt, 'failed');
    await store.retryRun(first.id, { idempotencyKey: 'retry-key' }, { ...RUN_EVIDENCE, runtimeId: '22222222-2222-4222-8222-222222222222' });
    await expect(store.startRun({ searchSessionId: 'session-1', selectedCandidateIds: [], idempotencyKey: 'retry-key', deliveryAuthorized: true }, RUN_EVIDENCE)).rejects.toThrow('幂等键');
  });

  it('rejects a start fingerprint crossed to an identical session and a non-root start lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-start-ownership-'));
    const path = join(root, 'directed.json');
    const { envelope } = await startEnvelope(path);
    const crossed = structuredClone(envelope);
    crossed.sessions.push({
      ...structuredClone(crossed.sessions[0])!,
      session: { ...structuredClone(crossed.sessions[0]!.session), id: 'session-2' },
    });
    crossed.startIdempotency['start-key']!.fingerprint = JSON.stringify({
      searchSessionId: 'session-2', selectedCandidateIds: [], idempotencyKey: 'start-key', deliveryAuthorized: true,
    });
    await writeFile(path, `${JSON.stringify(crossed)}\n`, 'utf8');
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).rejects.toThrow('状态文件格式无效');

    const nonRoot = structuredClone(envelope);
    nonRoot.runs[0]!.run.idempotencyLineage = ['extra-key', 'start-key'];
    await writeFile(path, `${JSON.stringify(nonRoot)}\n`, 'utf8');
    await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).rejects.toThrow('状态文件格式无效');
  });

  it('rejects retries whose source, exact spec, or lineage is not owned by the retry entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-retry-ownership-'));
    const path = join(root, 'directed.json');
    const { store, run } = await startEnvelope(path);
    await store.markTerminalCurrent(run.id, run.attempt, 'failed');
    const retryRun = await store.retryRun(run.id, { idempotencyKey: 'retry-key' }, { ...RUN_EVIDENCE, runtimeId: '22222222-2222-4222-8222-222222222222' });
    const valid = await storedEnvelope(path);
    const cases: Array<(value: typeof valid) => void> = [
      value => {
        const source = value.runs.find(item => item.run.id === run.id)!;
        const retry = value.runs.find(item => item.run.id === retryRun.id)!;
        source.run.status = 'running';
        retry.run.status = 'failed';
      },
      value => { value.runs.find(item => item.run.id === retryRun.id)!.run.idempotencyLineage = ['extra-key', 'start-key', 'retry-key']; },
      value => { value.runs.find(item => item.run.id === retryRun.id)!.run.idempotencyLineage = ['retry-key']; },
      value => { value.runs.find(item => item.run.id === retryRun.id)!.run.idempotencyLineage = ['retry-key', 'start-key']; },
      value => {
        value.sessions.push({
          ...structuredClone(value.sessions[0])!,
          session: { ...structuredClone(value.sessions[0]!.session), id: 'session-2' },
        });
        value.runs.find(item => item.run.id === retryRun.id)!.run.spec.searchSessionId = 'session-2';
      },
    ];
    for (const mutate of cases) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      await writeFile(path, `${JSON.stringify(candidate)}\n`, 'utf8');
      await expect(NowcoderDirectedStore.open(path, { now: () => NOW })).rejects.toThrow('状态文件格式无效');
    }
  });
});
