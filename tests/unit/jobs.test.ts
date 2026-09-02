import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/bridge/src/config.js';
import { JobStateError, JobStore } from '../../packages/bridge/src/jobs/store.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const WECHAT_URL = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g';
const NOW = '2026-07-18T00:00:00.000Z';
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

async function temporaryDirectory(): Promise<string> {
  return temporaryDirectories.create('data-collector-jobs-');
}

describe('bridge configuration', () => {
  it('resolves local paths and rejects a non-loopback host', async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({ libraryRoot: root, port: 0 });

    expect(config.host).toBe('127.0.0.1');
    expect(config.jobsFile).toBe(join(root, '_catalog', 'jobs.json'));
    expect(() => loadConfig({ libraryRoot: root, host: '0.0.0.0' })).toThrow(
      /只允许监听 127\.0\.0\.1/,
    );
  });
});

describe('durable jobs', () => {
  it('keeps active and attention jobs plus only the newest 1000 terminal jobs', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const terminal = Array.from({ length: 1_005 }, (_, index) => ({
      id: `terminal-${String(index).padStart(4, '0')}`,
      url: `https://www.nowcoder.com/discuss/${10_000 + index}`,
      requestedBy: 'codex' as const,
      status: index % 2 === 0 ? 'saved' as const : 'failed' as const,
      createdAt: `2026-08-20T00:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      updatedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    const protectedJobs = ['queued', 'dispatched', 'collecting', 'needs_attention'].map((status, index) => ({
      id: `protected-${status}`,
      url: `https://www.nowcoder.com/discuss/${20_000 + index}`,
      requestedBy: 'codex' as const,
      status,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }));
    await writeFile(path, `${JSON.stringify({ version: 1, jobs: [...terminal, ...protectedJobs] })}\n`);

    const jobs = await JobStore.open(path);

    expect(jobs.list()).toHaveLength(1_004);
    for (const item of protectedJobs) expect(jobs.get(item.id)).toBeDefined();
    expect(jobs.get('terminal-0000')).toBeUndefined();
    expect(jobs.get('terminal-0004')).toBeUndefined();
    expect(jobs.get('terminal-0005')).toBeDefined();
    expect((JSON.parse(await readFile(path, 'utf8')) as { jobs: unknown[] }).jobs).toHaveLength(1_004);
  });

  it('propagates an ENOENT from the startup prune write instead of treating it as an absent jobs file', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const terminal = Array.from({ length: 1_001 }, (_, index) => ({
      id: `startup-prune-${String(index).padStart(4, '0')}`,
      url: `https://www.nowcoder.com/discuss/${50_000 + index}`,
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
      updatedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    await writeFile(path, `${JSON.stringify({
      version: 1,
      jobs: terminal,
      directedPinsBootstrapped: true,
      directedPins: [],
    })}\n`);
    const persistError = Object.assign(new Error('startup prune destination disappeared'), { code: 'ENOENT' });

    await expect(JobStore.open(path, {
      atomicWrite: async () => { throw persistError; },
    })).rejects.toBe(persistError);
  });

  it('retains a persistent active directed proof beyond 1000 terminal jobs, then prunes after unpin', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const attempt = '0123456789abcdef';
    const pinned = {
      id: 'directed-old-proof',
      url: 'https://www.nowcoder.com/discuss/9999',
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      directedRunId: 'active-run',
      directedRunAttempt: attempt,
    };
    const newer = Array.from({ length: 1_005 }, (_, index) => ({
      id: `newer-${String(index).padStart(4, '0')}`,
      url: `https://www.nowcoder.com/discuss/${20_000 + index}`,
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
      updatedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    await writeFile(path, `${JSON.stringify({
      version: 1,
      jobs: [pinned, ...newer],
      directedPins: [{ runId: 'active-run', attempt, jobIds: [pinned.id] }],
    })}\n`);

    const reopened = await JobStore.open(path);
    expect(reopened.get(pinned.id)).toMatchObject({
      directedRunId: 'active-run',
      directedRunAttempt: attempt,
      status: 'saved',
    });
    expect(reopened.list()).toHaveLength(1_001);

    await reopened.reconcileDirectedPins([]);
    expect(reopened.get(pinned.id)).toBeUndefined();
    expect(reopened.list()).toHaveLength(1_000);
    expect((await JobStore.open(path)).get(pinned.id)).toBeUndefined();
  });

  it('defers legacy pruning until active directed pins have been durably bootstrapped', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const attempt = '0123456789abcdef';
    const activeProof = {
      id: 'legacy-active-proof',
      url: 'https://www.nowcoder.com/discuss/9998',
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      directedRunId: 'legacy-active-run',
      directedRunAttempt: attempt,
    };
    const newer = Array.from({ length: 1_005 }, (_, index) => ({
      id: `legacy-newer-${String(index).padStart(4, '0')}`,
      url: `https://www.nowcoder.com/discuss/${30_000 + index}`,
      requestedBy: 'codex' as const,
      status: 'saved' as const,
      createdAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
      updatedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    await writeFile(path, `${JSON.stringify({
      version: 1,
      jobs: [activeProof, ...newer],
    })}\n`);

    // Legacy callers cannot know whether the directed store still owns one of these jobs.
    // Absence of the durable pins field must therefore defer pruning by default.
    const bootstrapping = await JobStore.open(path);
    expect(bootstrapping.get(activeProof.id)).toMatchObject({
      directedRunId: 'legacy-active-run',
      directedRunAttempt: attempt,
    });
    expect(bootstrapping.list()).toHaveLength(1_006);

    // An unrelated mutation during startup must not accidentally advertise an empty,
    // fully-reconciled pin set and make the next process prune the active proof.
    await bootstrapping.create({
      id: 'ordinary-startup-job',
      url: 'https://www.nowcoder.com/discuss/41000',
      requestedBy: 'codex',
    });
    const beforeReconcileRestart = await JobStore.open(path);
    expect(beforeReconcileRestart.get(activeProof.id)).toBeDefined();
    expect(beforeReconcileRestart.list()).toHaveLength(1_007);

    await beforeReconcileRestart.reconcileDirectedPins([{
      runId: 'legacy-active-run',
      attempt,
      jobIds: [activeProof.id],
    }]);
    expect(beforeReconcileRestart.get(activeProof.id)).toBeDefined();
    expect(beforeReconcileRestart.list()).toHaveLength(1_002);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      jobs: Array<{ id: string }>;
      directedPins: Array<{ runId: string; attempt: string; jobIds: string[] }>;
      directedPinsBootstrapped: boolean;
    };
    expect(persisted.jobs.some(job => job.id === activeProof.id)).toBe(true);
    expect(persisted.directedPinsBootstrapped).toBe(true);
    expect(persisted.directedPins).toEqual([{
      runId: 'legacy-active-run',
      attempt,
      jobIds: [activeProof.id],
    }]);

    await beforeReconcileRestart.reconcileDirectedPins([]);
    expect(beforeReconcileRestart.get(activeProof.id)).toBeUndefined();
    expect(beforeReconcileRestart.list()).toHaveLength(1_001);
  });

  it('persists legal transitions and refuses terminal-state reversal', async () => {
    const root = await temporaryDirectory();
    const path = join(root, '_catalog', 'jobs.json');
    const jobs = await JobStore.open(path, {
      now: () => NOW,
      id: () => 'job-1',
    });
    const job = await jobs.create({ url: WECHAT_URL, requestedBy: 'codex' });

    await jobs.transition(job.id, 'dispatched');
    await jobs.transition(job.id, 'collecting');
    await jobs.transition(job.id, 'saved', { outputPath: '/tmp/index.md' });
    await expect(jobs.transition(job.id, 'collecting')).rejects.toBeInstanceOf(JobStateError);

    const reopened = await JobStore.open(path);
    expect(reopened.get(job.id)).toMatchObject({
      status: 'saved',
      outputPath: '/tmp/index.md',
    });
  });

  it('persists paired directed ownership and rejects fixed-plan overlap', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const jobs = await JobStore.open(path, { now: () => NOW });
    const directed = await jobs.create({
      id: 'directed-job',
      url: 'https://www.nowcoder.com/feed/main/detail/owned',
      requestedBy: 'codex',
      directedRunId: 'run-1',
      directedRunAttempt: '0123456789abcdef',
    });

    expect((await JobStore.open(path)).get(directed.id)).toMatchObject({
      directedRunId: 'run-1',
      directedRunAttempt: '0123456789abcdef',
    });
    await expect(jobs.create({
      id: 'overlapping-job',
      url: 'https://www.nowcoder.com/feed/main/detail/overlap',
      requestedBy: 'codex',
      batchId: 'batch-1',
      planId: 'nowcoder-agent-market',
      directedRunId: 'run-1',
      directedRunAttempt: '0123456789abcdef',
    })).rejects.toThrow(/固定计划.*定向运行|不能同时/);
    await expect(jobs.create({
      id: 'half-owned-job',
      url: 'https://www.nowcoder.com/feed/main/detail/half-owned',
      requestedBy: 'codex',
      directedRunId: 'run-1',
    })).rejects.toThrow(/必须同时提供/);
  });

  it('rejects invalid directed ownership when reopening durable jobs', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const base = {
      id: 'corrupt-directed',
      url: 'https://www.nowcoder.com/feed/main/detail/corrupt',
      requestedBy: 'codex',
      status: 'queued',
      createdAt: NOW,
      updatedAt: NOW,
      directedRunId: 'run-1',
    };
    await writeFile(path, `${JSON.stringify({ version: 1, jobs: [base] })}\n`);
    await expect(JobStore.open(path)).rejects.toThrow(/任务文件格式无效/);

    await writeFile(path, `${JSON.stringify({
      version: 1,
      jobs: [{
        ...base,
        directedRunAttempt: '0123456789abcdef',
        batchId: 'batch-1',
        planId: 'nowcoder-agent-market',
      }],
    })}\n`);
    await expect(JobStore.open(path)).rejects.toThrow(/任务文件格式无效/);
  });

  it('rolls a create out of memory when durable persistence fails', async () => {
    const root = await temporaryDirectory();
    const blockingFile = join(root, 'becomes-a-file');
    await mkdir(blockingFile);
    const jobs = await JobStore.open(join(blockingFile, 'jobs.json'), { now: () => NOW });
    await rmdir(blockingFile);
    await writeFile(blockingFile, 'blocked');

    await expect(jobs.create({
      id: 'must-roll-back',
      url: WECHAT_URL,
      requestedBy: 'codex',
    })).rejects.toThrow();
    expect(jobs.get('must-roll-back')).toBeUndefined();
  });

  it('allows an extension current-page job to begin collecting without dispatch', async () => {
    const root = await temporaryDirectory();
    const jobs = await JobStore.open(join(root, '_catalog', 'jobs.json'), {
      now: () => NOW,
      id: () => 'current-page-job',
    });
    const job = await jobs.create({ url: WECHAT_URL, requestedBy: 'extension' });

    await jobs.transition(job.id, 'collecting');

    expect(jobs.get(job.id)?.status).toBe('collecting');
  });

  it('recovers in-flight work and creates duplicate request IDs idempotently', async () => {
    const root = await temporaryDirectory();
    const path = join(root, '_catalog', 'jobs.json');
    const jobs = await JobStore.open(path, { now: () => NOW, id: () => 'job-2' });
    const first = await jobs.create({
      id: 'request-42',
      url: `${WECHAT_URL}?scene=1`,
      requestedBy: 'cli',
    });
    const duplicate = await jobs.create({
      id: 'request-42',
      url: WECHAT_URL,
      requestedBy: 'cli',
    });
    expect(duplicate).toEqual(first);

    await jobs.transition(first.id, 'dispatched');
    await jobs.recover();
    expect(jobs.get(first.id)?.status).toBe('queued');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('bounds fixed Nowcoder recovery, safely terminalizes legacy work, and preserves other recovery paths', async () => {
    const root = await temporaryDirectory();
    const path = join(root, '_catalog', 'jobs.json');
    const jobs = await JobStore.open(path, { now: () => NOW });
    const nowcoder = await jobs.create({
      id: 'nowcoder-recovery',
      url: 'https://www.nowcoder.com/discuss/8101',
      requestedBy: 'codex',
      batchId: 'nowcoder-batch',
      planId: 'nowcoder-agent-market',
      planAttempt: '0123456789abcdef',
    });
    const zsxq = await jobs.create({
      id: 'zsxq-recovery',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
      requestedBy: 'codex',
      batchId: 'zsxq-batch',
      planId: 'zsxq-chen-teacher',
      planAttempt: 'fedcba9876543210',
    });
    const directed = await jobs.create({
      id: 'directed-recovery',
      url: 'https://www.nowcoder.com/discuss/8102',
      requestedBy: 'codex',
      directedRunId: 'run-recovery',
      directedRunAttempt: '1111111111111111',
    });
    const extensionOwnedNowcoder = await jobs.create({
      id: 'extension-owned-nowcoder-recovery',
      url: 'https://www.nowcoder.com/discuss/8102-extension',
      requestedBy: 'extension',
    });
    expect(zsxq).not.toHaveProperty('recoveryCount');
    expect(directed).not.toHaveProperty('recoveryCount');
    expect(extensionOwnedNowcoder).not.toHaveProperty('recoveryCount');
    await jobs.transition(nowcoder.id, 'dispatched');
    await jobs.transition(zsxq.id, 'dispatched');
    await jobs.transition(directed.id, 'dispatched');

    const first = await jobs.recover(new Set([directed.id]));
    expect(first.requeued.map(job => job.id)).toContain(nowcoder.id);
    expect(jobs.get(nowcoder.id)).toMatchObject({ status: 'queued', recoveryCount: 1 });
    expect(jobs.get(zsxq.id)).toMatchObject({ status: 'queued' });
    expect(jobs.get(directed.id)).toMatchObject({ status: 'dispatched' });

    await jobs.transition(nowcoder.id, 'dispatched');
    const second = await jobs.recover(new Set([directed.id]));
    expect(second.terminalized.map(job => job.id)).toContain(nowcoder.id);
    expect(jobs.get(nowcoder.id)).toMatchObject({
      status: 'needs_attention',
      errorCode: 'RECOVERY_LIMIT_EXCEEDED',
      recoveryCount: 1,
    });

    await expect(jobs.retry(nowcoder.id)).resolves.toMatchObject({
      status: 'queued',
      recoveryCount: 0,
    });

    const legacyPath = join(root, '_catalog', 'legacy-jobs.json');
    await writeFile(legacyPath, `${JSON.stringify({ version: 1, jobs: [{
      id: 'legacy-nowcoder',
      url: 'https://www.nowcoder.com/discuss/8103',
      requestedBy: 'codex',
      status: 'collecting',
      createdAt: NOW,
      updatedAt: NOW,
      batchId: 'legacy-batch',
      planId: 'nowcoder-agent-market',
      planAttempt: '2222222222222222',
    }] })}\n`);
    const legacy = await JobStore.open(legacyPath, { now: () => NOW });
    const legacyRecovery = await legacy.recover();
    expect(legacyRecovery.terminalized.map(job => job.id)).toEqual(['legacy-nowcoder']);
    expect(legacy.get('legacy-nowcoder')).toMatchObject({
      status: 'needs_attention',
      errorCode: 'RECOVERY_LIMIT_EXCEEDED',
    });
  });

  it('bounds every Bridge-owned ordinary Nowcoder recovery and stops legacy work on upgrade', async () => {
    const root = await temporaryDirectory();
    const path = join(root, '_catalog', 'jobs.json');
    const jobs = await JobStore.open(path, { now: () => NOW });
    const ordinary = await jobs.create({
      id: 'ordinary-nowcoder-recovery',
      url: 'https://nowcoder.com/discuss/8104',
      requestedBy: 'codex',
    });
    expect(ordinary).toMatchObject({ recoveryCount: 0 });

    await jobs.transition(ordinary.id, 'dispatched');
    await jobs.recover();
    expect(jobs.get(ordinary.id)).toMatchObject({ status: 'queued', recoveryCount: 1 });
    await jobs.transition(ordinary.id, 'dispatched');
    const exhausted = await jobs.recover();
    expect(exhausted.terminalized.map(job => job.id)).toContain(ordinary.id);
    expect(jobs.get(ordinary.id)).toMatchObject({
      status: 'needs_attention',
      errorCode: 'RECOVERY_LIMIT_EXCEEDED',
      recoveryCount: 1,
    });
    await expect(jobs.retry(ordinary.id)).resolves.toMatchObject({
      status: 'queued',
      recoveryCount: 0,
    });

    const legacyPath = join(root, '_catalog', 'legacy-ordinary-jobs.json');
    const legacyJobs = (['queued', 'dispatched', 'collecting'] as const).map(status => ({
      id: `legacy-ordinary-nowcoder-${status}`,
      url: `https://www.nowcoder.com/discuss/8105-${status}`,
      requestedBy: 'codex',
      status,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    await writeFile(legacyPath, `${JSON.stringify({ version: 1, jobs: legacyJobs })}\n`);
    const legacy = await JobStore.open(legacyPath, { now: () => NOW });
    const legacyRecovery = await legacy.recover();
    expect(legacyRecovery.terminalized.map(job => job.id)).toEqual(
      legacyJobs.map(job => job.id),
    );
    for (const legacyJob of legacyJobs) {
      expect(legacy.get(legacyJob.id)).toMatchObject({
        status: 'needs_attention',
        errorCode: 'RECOVERY_LIMIT_EXCEEDED',
      });
    }
  });

  it('requeues ordinary and fixed jobs on socket reconnect without consuming recovery budget', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'socket-reconnect-jobs.json');
    const ordinaryDispatched = {
      id: 'socket-ordinary-dispatched',
      url: 'https://mp.weixin.qq.com/s/socket-ordinary-dispatched',
      requestedBy: 'cli',
      status: 'dispatched',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const ordinaryCollecting = {
      id: 'socket-ordinary-collecting',
      url: 'https://mp.weixin.qq.com/s/socket-ordinary-collecting',
      requestedBy: 'cli',
      status: 'collecting',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const fixedWithoutCounter = {
      id: 'socket-fixed-without-counter',
      url: 'https://www.nowcoder.com/discuss/socket-fixed-without-counter',
      requestedBy: 'codex',
      status: 'collecting',
      createdAt: NOW,
      updatedAt: NOW,
      batchId: 'socket-fixed-batch',
      planId: 'nowcoder-agent-market',
    };
    const fixedWithCounter = {
      id: 'socket-fixed-with-counter',
      url: 'https://www.nowcoder.com/discuss/socket-fixed-with-counter',
      requestedBy: 'codex',
      status: 'dispatched',
      createdAt: NOW,
      updatedAt: NOW,
      batchId: 'socket-fixed-batch',
      planId: 'nowcoder-agent-market',
      recoveryCount: 1,
    };
    const ordinaryNowcoder = {
      id: 'socket-ordinary-nowcoder',
      url: 'https://nowcoder.com/discuss/socket-ordinary-nowcoder',
      requestedBy: 'cli',
      status: 'dispatched',
      createdAt: NOW,
      updatedAt: NOW,
      recoveryCount: 0,
    };
    const excluded = {
      id: 'socket-excluded',
      url: 'https://mp.weixin.qq.com/s/socket-excluded',
      requestedBy: 'cli',
      status: 'collecting',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const extensionOwned = {
      id: 'socket-extension-owned',
      url: 'https://mp.weixin.qq.com/s/socket-extension-owned',
      requestedBy: 'extension',
      status: 'collecting',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await writeFile(path, `${JSON.stringify({
      version: 1,
      jobs: [
        ordinaryDispatched,
        ordinaryCollecting,
        fixedWithoutCounter,
        fixedWithCounter,
        ordinaryNowcoder,
        excluded,
        extensionOwned,
      ],
    })}\n`);

    const jobs = await JobStore.open(path, { now: () => NOW });
    const recovery = await jobs.recover(new Set([excluded.id]), 'socket-reconnect');

    expect(recovery.terminalized).toEqual([]);
    expect(recovery.requeued.map(job => job.id)).toEqual([
      ordinaryDispatched.id,
      ordinaryCollecting.id,
      fixedWithoutCounter.id,
      fixedWithCounter.id,
      ordinaryNowcoder.id,
    ]);
    expect(jobs.get(ordinaryDispatched.id)?.status).toBe('queued');
    expect(jobs.get(ordinaryCollecting.id)?.status).toBe('queued');
    expect(jobs.get(fixedWithoutCounter.id)).toMatchObject({ status: 'queued' });
    expect(jobs.get(fixedWithoutCounter.id)).not.toHaveProperty('recoveryCount');
    expect(jobs.get(fixedWithCounter.id)).toMatchObject({ status: 'queued', recoveryCount: 1 });
    expect(jobs.get(ordinaryNowcoder.id)).toMatchObject({ status: 'queued', recoveryCount: 0 });
    expect(jobs.get(excluded.id)?.status).toBe('collecting');
    expect(jobs.get(extensionOwned.id)?.status).toBe('collecting');
  });

  it('does not requeue a job whose result is still being persisted in this Bridge process', async () => {
    const root = await temporaryDirectory();
    const jobs = await JobStore.open(join(root, '_catalog', 'jobs.json'), {
      now: () => NOW,
      id: () => 'unused',
    });
    const persisting = await jobs.create({ id: 'persisting', url: WECHAT_URL, requestedBy: 'cli' });
    const abandoned = await jobs.create({
      id: 'abandoned',
      url: 'https://mp.weixin.qq.com/s/abandoned',
      requestedBy: 'cli',
    });
    await jobs.transition(persisting.id, 'dispatched');
    await jobs.transition(persisting.id, 'collecting');
    await jobs.transition(abandoned.id, 'dispatched');
    await jobs.transition(abandoned.id, 'collecting');

    await jobs.recover(new Set([persisting.id]));

    expect(jobs.get(persisting.id)?.status).toBe('collecting');
    expect(jobs.get(abandoned.id)?.status).toBe('queued');
  });

  it('rejects a duplicate ID that points to different content', async () => {
    const root = await temporaryDirectory();
    const jobs = await JobStore.open(join(root, 'jobs.json'), {
      now: () => NOW,
      id: () => 'job-3',
    });
    await jobs.create({ id: 'same', url: WECHAT_URL, requestedBy: 'cli' });

    await expect(
      jobs.create({
        id: 'same',
        url: 'https://mp.weixin.qq.com/s/different',
        requestedBy: 'cli',
      }),
    ).rejects.toThrow(/任务 ID 已用于其他地址/);
  });

  it('serializes concurrent creates and transitions without losing durable jobs', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const jobs = await JobStore.open(path, { now: () => NOW });
    const ids = Array.from({ length: 40 }, (_, index) => `parallel-${index}`);

    await Promise.all(
      ids.map((id, index) =>
        jobs.create({
          id,
          url: `https://mp.weixin.qq.com/s/parallel-${index}`,
          requestedBy: 'codex',
        }),
      ),
    );
    await Promise.all(ids.map(id => jobs.transition(id, 'dispatched')));

    const reopened = await JobStore.open(path);
    expect(reopened.list()).toHaveLength(ids.length);
    expect(reopened.list().every(job => job.status === 'dispatched')).toBe(true);
  });

  it('retries only failed or attention-needed jobs and clears stale result fields', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    let timestamp = 0;
    const jobs = await JobStore.open(path, {
      now: () => `2026-08-20T00:00:0${timestamp++}.000Z`,
    });

    const failed = await jobs.create({
      id: 'retry-failed',
      url: 'https://www.nowcoder.com/discuss/9101',
      requestedBy: 'codex',
    });
    await jobs.transition(failed.id, 'failed', {
      errorCode: 'EXTRACT_FAILED',
      errorMessage: 'temporary extraction failure',
      outputPath: '/tmp/stale.md',
      markdownOutput: { sinkId: 'markdown', outputPath: '/tmp/stale.md' },
    });
    expect(await jobs.retry(failed.id)).toMatchObject({
      id: failed.id,
      status: 'queued',
      createdAt: failed.createdAt,
    });
    expect(jobs.get(failed.id)).not.toHaveProperty('errorCode');
    expect(jobs.get(failed.id)).not.toHaveProperty('markdownOutput');
    expect(jobs.get(failed.id)).not.toHaveProperty('errorMessage');
    expect(jobs.get(failed.id)).not.toHaveProperty('outputPath');

    const attention = await jobs.create({
      id: 'retry-attention',
      url: 'https://www.nowcoder.com/discuss/9102',
      requestedBy: 'codex',
    });
    await jobs.transition(attention.id, 'dispatched');
    await jobs.transition(attention.id, 'needs_attention', {
      errorCode: 'LOGIN_REQUIRED',
      errorMessage: 'login expired',
    });
    await expect(jobs.retry(attention.id)).resolves.toMatchObject({ status: 'queued' });

    const saved = await jobs.create({
      id: 'do-not-retry-saved',
      url: 'https://www.nowcoder.com/discuss/9103',
      requestedBy: 'codex',
    });
    await jobs.transition(saved.id, 'collecting');
    await jobs.transition(saved.id, 'saved', { outputPath: '/tmp/current.md' });
    await expect(jobs.retry(saved.id)).rejects.toBeInstanceOf(JobStateError);
  });
});
