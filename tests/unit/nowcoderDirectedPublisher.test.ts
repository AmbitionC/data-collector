import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  stableContentId,
  type CollectedDocument,
  type NowcoderSearchCandidate,
} from '@data-collector/shared';
import { ArtifactReaderCoordinator } from '../../packages/bridge/src/artifactReaderCoordinator.js';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { NowcoderDirectedPublisher } from '../../packages/bridge/src/nowcoderDirected/publisher.js';
import { NowcoderDirectedService } from '../../packages/bridge/src/nowcoderDirected/service.js';
import { nowcoderDirectedJobId } from '../../packages/bridge/src/nowcoderDirected/jobIdentity.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
import { SinkRouter } from '../../packages/bridge/src/sinks/router.js';

const NOW = '2026-08-30T00:00:00.000Z';
const ATTEMPT = '0123456789abcdef';
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

async function fixture(target = 2) {
  const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-publisher-'));
  const libraryRoot = join(root, 'library');
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const router = SinkRouter.build({
    sinks: {
      markdown: { type: 'markdown' },
      'fe-journey': {
        type: 'repo-inbox',
        repoPath: repoRoot,
        commit: false,
        push: false,
      },
    },
    routes: { nowcoder: ['fe-journey'] },
  }, { libraryRoot });
  const candidates: NowcoderSearchCandidate[] = [];
  for (let index = 0; index < target; index += 1) {
    const url = `https://www.nowcoder.com/feed/main/detail/publish-${index + 1}`;
    const document: CollectedDocument = {
      schemaVersion: 1,
      source: 'nowcoder',
      kind: 'post',
      url,
      canonicalUrl: url,
      title: `Agent 研发面经 ${index + 1}`,
      collectedAt: NOW,
      publishedAt: `2026-08-${String(29 - index).padStart(2, '0')}T00:00:00.000Z`,
      html: '<p>Agent Loop、RAG 检索与工具调用。</p>',
      text: 'Agent Loop、RAG 检索与工具调用。',
      images: [],
      truncated: false,
      sourceMetadata: { evidenceGrade: 'A', agentRelevant: true },
    };
    await router.save(organize(document));
    candidates.push({
      id: `candidate-${index + 1}`,
      canonicalUrl: url,
      contentType: 'post',
      matchedQueries: ['Agent'],
      page: 1,
      rank: index + 1,
      publishedAt: document.publishedAt!,
    });
  }
  const storePath = join(root, 'directed.json');
  const store = await NowcoderDirectedStore.open(storePath, {
    now: () => NOW,
    id: () => 'run-publisher',
    attempt: () => ATTEMPT,
  });
  await store.createSession({
    id: 'session-publisher',
    queries: ['Agent'],
    queryHash: 'a'.repeat(64),
    requestedSort: 'latest',
    provider: 'nowcoder-json',
    sortVerified: true,
    createdAt: NOW,
    expiresAt: '2026-08-30T00:30:00.000Z',
    candidates,
  }, { target });
  const run = await store.startRun({
    searchSessionId: 'session-publisher',
    selectedCandidateIds: candidates.map(candidate => candidate.id),
    idempotencyKey: 'publisher-key',
    deliveryAuthorized: true,
  }, RUN_EVIDENCE);
  const jobIds = candidates.map(candidate => nowcoderDirectedJobId(
    run.id,
    run.attempt,
    candidate.canonicalUrl,
  ));
  const deliveryItems = candidates.map((candidate, index) => ({
    jobId: jobIds[index]!,
    stableContentId: stableContentId(candidate.canonicalUrl),
    canonicalUrl: candidate.canonicalUrl,
    contentHash: String(index + 1).repeat(16),
    clusterId: `cluster-${index + 1}`,
  }));
  await store.checkpointCurrentRun(run.id, run.attempt, {
    phase: 'staging',
    candidateCursor: target,
    currentJobIds: jobIds,
    currentRoundJobIds: jobIds,
    accepted: target,
    deliveryItems,
    privateRejections: [],
    progress: {
      discovered: target,
      detailScheduled: target,
      detailSaved: target,
      inspected: target,
      qualified: target,
      accepted: target,
      delivered: 0,
      rejectionCounts: [],
      companies: [
        { company: 'bytedance', count: 0 },
        { company: 'tencent', count: 0 },
        { company: 'alibaba', count: 0 },
        { company: 'ant', count: 0 },
        { company: 'other', count: target },
      ],
    },
  });
  for (const jobId of jobIds) {
    await store.recordDispatchedJobCurrent(run.id, run.attempt, jobId);
    await store.recordTabClearEvidenceCurrent(
      run.id,
      run.attempt,
      jobId,
      'remote_terminal_after_close',
    );
  }
  return { root, libraryRoot, repoRoot, router, storePath, store, run, jobIds, deliveryItems };
}

function recoveryContext(store: NowcoderDirectedStore) {
  return {
    run: store.reconciliationSnapshots()[0]!,
    jobs: [],
    markerVerified: false as const,
  };
}

describe('minimal directed publisher', () => {
  it('crosses the cutoff only after exact tab-clear proof and syncs exactly the target', async () => {
    const context = await fixture(2);
    const publisher = new NowcoderDirectedPublisher({
      store: context.store,
      libraryRoot: context.libraryRoot,
      resolveTarget: source => context.router.syncTarget(source),
      now: () => NOW,
      finalizePublished: (runId, attempt) =>
        context.store.completePublishedCurrent(runId, attempt),
    });

    const completed = await publisher.recover(recoveryContext(context.store));

    expect(completed).toMatchObject({
      status: 'completed',
      delivered: 2,
      deliveryIds: context.deliveryItems.map(item => item.stableContentId),
    });
    const inbox = join(context.repoRoot, '_inbox', 'nowcoder');
    const entries = await readdir(inbox);
    expect(entries).toHaveLength(2);
    for (const directory of entries) {
      const meta = JSON.parse(await readFile(join(inbox, directory, 'meta.json'), 'utf8')) as {
        sourceMetadata: Record<string, unknown>;
      };
      expect(meta.sourceMetadata).toMatchObject({
        deliveryBatchId: context.run.id,
        deliveryKind: 'nowcoder-directed',
      });
    }
  });

  it('keeps a failed exact sync in publishing and succeeds on a later retry', async () => {
    const context = await fixture(2);
    let targetAvailable = false;
    const publisher = new NowcoderDirectedPublisher({
      store: context.store,
      libraryRoot: context.libraryRoot,
      resolveTarget: source => targetAvailable ? context.router.syncTarget(source) : undefined,
      now: () => NOW,
      finalizePublished: (runId, attempt) =>
        context.store.completePublishedCurrent(runId, attempt),
    });

    await expect(publisher.recover(recoveryContext(context.store)))
      .rejects.toThrow('精确同步');
    expect(context.store.getRun(context.run.id)).toMatchObject({
      status: 'publishing',
      delivered: 0,
      deliveryIds: [],
    });

    targetAvailable = true;
    await expect(publisher.recover(recoveryContext(context.store))).resolves.toMatchObject({
      status: 'completed',
      delivered: 2,
    });
  });

  it('re-runs the same exact sync after a post-cutoff restart without duplicate inbox entries', async () => {
    const context = await fixture(2);
    await context.store.beginPublishingCurrent(context.run.id, context.run.attempt);
    const crashingPublisher = new NowcoderDirectedPublisher({
      store: context.store,
      libraryRoot: context.libraryRoot,
      resolveTarget: source => context.router.syncTarget(source),
      now: () => NOW,
      finalizePublished: async () => { throw new Error('simulated Bridge restart'); },
    });
    await expect(crashingPublisher.recover(recoveryContext(context.store)))
      .rejects.toThrow('simulated Bridge restart');
    expect(context.store.getRun(context.run.id)?.status).toBe('publishing');

    const reopened = await NowcoderDirectedStore.open(context.storePath, { now: () => NOW });
    const restartedPublisher = new NowcoderDirectedPublisher({
      store: reopened,
      libraryRoot: context.libraryRoot,
      resolveTarget: source => context.router.syncTarget(source),
      now: () => NOW,
      finalizePublished: (runId, attempt) => reopened.completePublishedCurrent(runId, attempt),
    });
    await expect(restartedPublisher.recover(recoveryContext(reopened))).resolves.toMatchObject({
      status: 'completed',
      delivered: 2,
    });
    expect(await readdir(join(context.repoRoot, '_inbox', 'nowcoder'))).toHaveLength(2);
  });

  it('service finalization releases the run reader and durable JobStore pins', async () => {
    const context = await fixture(1);
    await context.store.beginPublishingCurrent(context.run.id, context.run.attempt);
    const jobsPath = join(context.root, 'jobs.json');
    const jobs = await JobStore.open(jobsPath, { now: () => NOW });
    for (const [index, jobId] of context.jobIds.entries()) {
      await jobs.create({
        id: jobId,
        url: context.deliveryItems[index]!.canonicalUrl,
        requestedBy: 'codex',
        directedRunId: context.run.id,
        directedRunAttempt: context.run.attempt,
      });
      await jobs.transition(jobId, 'dispatched');
      await jobs.transition(jobId, 'collecting');
      await jobs.transition(jobId, 'saved', { outputPath: `/tmp/${jobId}/index.md` });
    }
    await jobs.setDirectedAttemptPins(context.run.id, context.run.attempt, context.jobIds);
    const physicalRelease = vi.fn(async () => undefined);
    const readers = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({ release: physicalRelease }),
    });
    const service = new NowcoderDirectedService({
      store: context.store,
      jobs,
      dispatch: async () => undefined,
      artifactReaders: readers,
    });
    await service.initialize();
    expect(readers.snapshot().activeReaders).toBe(1);

    await expect(service.finalizePublished(context.run.id, context.run.attempt))
      .resolves.toMatchObject({ status: 'completed' });

    expect(readers.snapshot().activeReaders).toBe(0);
    expect(physicalRelease).toHaveBeenCalledOnce();
    const persisted = JSON.parse(await readFile(jobsPath, 'utf8')) as { directedPins?: unknown[] };
    expect(persisted.directedPins).toEqual([]);
  });
});
