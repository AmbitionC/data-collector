import { dirname, join } from 'node:path';
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stableContentId, type CollectedDocument, type JobRecord, type NowcoderSearchCandidate } from '@data-collector/shared';
import {
  FeJourneyCandidateIndex,
  readDirectedCandidateCatalog,
} from '../../packages/bridge/src/feJourney/candidateIndex.js';
import { saveCollectedDocument } from '../../packages/bridge/src/feJourney/save.js';
import { processedNowcoderHistoryDigest } from '../../packages/bridge/src/plans/nowcoderProcessedHistory.js';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import {
  loadNowcoderDirectedDocuments,
  NowcoderDirectedDocumentError,
} from '../../packages/bridge/src/nowcoderDirected/documentLoader.js';
import { nowcoderDirectedJobId } from '../../packages/bridge/src/nowcoderDirected/jobIdentity.js';
import { NowcoderDirectedService } from '../../packages/bridge/src/nowcoderDirected/service.js';
import {
  nextNowcoderDirectedFillAction,
  NowcoderDirectedSelectionCoordinator,
} from '../../packages/bridge/src/nowcoderDirected/selection.js';
import {
  NowcoderDirectedStore,
  type NowcoderDirectedReconciliationSnapshot,
} from '../../packages/bridge/src/nowcoderDirected/store.js';
import { SinkRouter } from '../../packages/bridge/src/sinks/router.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  MarkdownLibrary,
  type DirectedTransactionBoundaryContext,
} from '../../packages/bridge/src/library/writer.js';
import { deliveryRevision } from '../../packages/bridge/src/library/deliveryRevision.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const NOW = '2026-08-30T00:00:00.000Z';
const ATTEMPT = '0123456789abcdef';
const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pendingAudit(
  candidates: readonly NowcoderSearchCandidate[],
  jobIds: readonly string[],
  discovered = candidates.length,
) {
  const message = '详情尚未形成可验证快照';
  return {
    accepted: 0,
    deliveryItems: [],
    privateRejections: candidates.map((candidate, index) => ({
      jobId: jobIds[index]!,
      url: candidate.canonicalUrl,
      code: 'DETAIL_NOT_SAVED' as const,
      message,
      detail: message,
    })),
    progress: {
      discovered,
      detailScheduled: candidates.length,
      detailSaved: 0,
      inspected: 0,
      qualified: 0,
      accepted: 0,
      delivered: 0,
      rejectionCounts: candidates.length === 0 ? [] : [{
        code: 'DETAIL_NOT_SAVED' as const,
        message,
        count: candidates.length,
      }],
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

function collected(url: string, sequence = 0): CollectedDocument {
  const questions = [
    `1. Agent Loop 状态机如何设计 ${sequence}？`, `2. RAG 召回如何评估 ${sequence}？`,
    `3. Tool Schema 如何约束 ${sequence}？`, `4. 长期记忆如何存储 ${sequence}？`,
    `5. 工具调用失败如何恢复 ${sequence}？`, `6. Agent 评测如何设计 ${sequence}？`,
  ].join('');
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: '字节 Agent 开发一面面经',
    author: `候选人-${sequence}`,
    publishedAt: '2026-08-29T00:00:00.000Z',
    collectedAt: NOW,
    html: `<p>我参加了字节 Agent 开发岗位一面。${questions}</p>`,
    text: `我参加了字节 Agent 开发岗位一面。${questions}`,
    images: [],
    sourceMetadata: {
      company: '字节', role: 'Agent 开发工程师', interviewStage: '一面',
      evidenceGrade: 'A', questionCount: 6,
    },
  };
}

function directedLocalEvidence(url: string, input: ReturnType<typeof organize>) {
  return {
    nowcoderDirected: {
      runId: 'run-orphan-no-clobber',
      attempt: ATTEMPT,
      currentJobId: nowcoderDirectedJobId('run-orphan-no-clobber', ATTEMPT, url),
      stableContentId: stableContentId(url),
      canonicalUrl: url,
      contentHash: '0123456789abcdef',
      clusterId: 'cluster-orphan-no-clobber',
      deliveryRevision: deliveryRevision(input),
    },
  };
}

type DirectedTransactionTestContext = DirectedTransactionBoundaryContext;

async function directedDocumentFixture(options: { omitDocumentPublishedAt?: boolean } = {}) {
  const root = await temporaryDirectories.create('nowcoder-directed-document-');
  await mkdir(join(root, '_catalog'), { recursive: true });
  const url = 'https://www.nowcoder.com/discuss/8001';
  const runId = 'run-document';
  const jobId = nowcoderDirectedJobId(runId, ATTEMPT, url);
  const router = SinkRouter.build(undefined, { libraryRoot: root });
  const index = await FeJourneyCandidateIndex.open(root);
  const document = collected(url);
  if (options.omitDocumentPublishedAt) delete document.publishedAt;
  const results = await saveCollectedDocument(router, index, document, undefined, {
    runId, attempt: ATTEMPT, currentJobId: jobId,
  });
  const markdown = results.find(result => result.sinkId === 'markdown' && result.ok);
  if (!markdown) throw new Error('missing markdown output');
  const jobs = await JobStore.open(join(root, '_catalog', 'jobs.json'), { now: () => NOW });
  let job = await jobs.create({
    id: jobId, url, requestedBy: 'codex', directedRunId: runId, directedRunAttempt: ATTEMPT,
  });
  job = await jobs.transition(job.id, 'collecting');
  job = await jobs.transition(job.id, 'saved', {
    outputPath: markdown.outputRef,
    markdownOutput: { sinkId: 'markdown', outputPath: markdown.outputRef },
  });
  const run: NowcoderDirectedReconciliationSnapshot = {
    id: runId,
    attempt: ATTEMPT,
    status: 'running',
    phase: 'selecting',
    spec: { target: 1, maxDetails: 24 },
    frozenCandidates: [{
      id: 'candidate-1', canonicalUrl: url, contentType: 'post', matchedQueries: ['Agent'],
      page: 1, rank: 1, publishedAt: '2026-08-29T00:00:00.000Z',
    }],
    candidateCursor: 1,
    currentJobIds: [jobId],
    currentRoundJobIds: [jobId],
    buildEvidence: {
      applicationVersion: '0.4.33', bridgeBuildId: 'build', artifactBuildId: 'build',
      extensionVersion: '0.4.33', extensionBuildId: 'build',
      extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'], frozenAt: NOW,
    },
    observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
    scheduledCandidateIds: ['candidate-1'],
    progress: {
      discovered: 1, detailScheduled: 1, detailSaved: 1, inspected: 0, qualified: 0,
      accepted: 0, delivered: 0, rejectionCounts: [],
      companies: [
        { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
        { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 }, { company: 'other', count: 0 },
      ],
    },
  };
  return { root, run, job, markdownPath: markdown.outputRef };
}

describe('directed Nowcoder exact current-run fill planning', () => {
  it.each([1, 7, 10])('opens eight details for target %i', target => {
    expect(nextNowcoderDirectedFillAction({
      target,
      candidateCursor: 0,
      frozenCandidateCount: 30,
      currentRoundTerminal: true,
      acceptedCount: 0,
    })).toEqual({ type: 'enqueue', count: 8 });
  });

  it('refills four at a time and hard-stops at the 24-detail budget', () => {
    for (const cursor of [8, 12, 16, 20]) {
      expect(nextNowcoderDirectedFillAction({
        target: 10,
        candidateCursor: cursor,
        frozenCandidateCount: 30,
        currentRoundTerminal: true,
        acceptedCount: 9,
      })).toEqual({ type: 'enqueue', count: 4 });
    }
    expect(nextNowcoderDirectedFillAction({
      target: 10,
      candidateCursor: 24,
      frozenCandidateCount: 30,
      currentRoundTerminal: true,
      acceptedCount: 9,
    })).toEqual({ type: 'attention' });
  });

  it('waits for the complete current round and stages only an exact target', () => {
    expect(nextNowcoderDirectedFillAction({
      target: 7,
      candidateCursor: 8,
      frozenCandidateCount: 30,
      currentRoundTerminal: false,
      acceptedCount: 7,
    })).toEqual({ type: 'wait' });
    expect(nextNowcoderDirectedFillAction({
      target: 7,
      candidateCursor: 8,
      frozenCandidateCount: 30,
      currentRoundTerminal: true,
      acceptedCount: 7,
    })).toEqual({ type: 'stage' });
  });

  it('loads only the exact saved current-attempt Markdown snapshot with complete lineage', async () => {
    const fixture = await directedDocumentFixture();
    const loaded = await loadNowcoderDirectedDocuments({
      libraryRoot: fixture.root, run: fixture.run, jobs: [fixture.job],
    });
    expect(loaded).toMatchObject({ detailSaved: 1, invalid: [] });
    expect(loaded.loaded.map(item => item.job.id)).toEqual(fixture.run.currentJobIds);
    const source = JSON.parse(await readFile(join(dirname(fixture.markdownPath), 'source.json'), 'utf8'));
    expect(source.localEvidence.nowcoderDirected).toMatchObject({
      runId: fixture.run.id, attempt: fixture.run.attempt, currentJobId: fixture.job.id,
    });
    expect(loaded.loaded[0]?.document).not.toHaveProperty('localEvidence');
  });

  it('uses the immutable search timestamp when the detail page omits publishedAt', async () => {
    const fixture = await directedDocumentFixture({ omitDocumentPublishedAt: true });
    const loaded = await loadNowcoderDirectedDocuments({
      libraryRoot: fixture.root, run: fixture.run, jobs: [fixture.job],
    });

    expect(loaded.loaded[0]?.document.publishedAt)
      .toBe(fixture.run.frozenCandidates[0]?.publishedAt);
  });

  it('does not load or count a saved foreign/old-attempt job and avoids catalog access', async () => {
    const root = join(await temporaryDirectories.create('nowcoder-directed-foreign-'), 'missing-library');
    const fixture = await directedDocumentFixture();
    const foreign: JobRecord = {
      ...fixture.job,
      id: nowcoderDirectedJobId('other-run', 'fedcba9876543210', fixture.job.url),
      directedRunId: 'other-run',
      directedRunAttempt: 'fedcba9876543210',
    };
    await expect(loadNowcoderDirectedDocuments({
      libraryRoot: root, run: fixture.run, jobs: [foreign],
    })).resolves.toEqual({ loaded: [], invalid: [], detailSaved: 0 });
  });

  it('rejects independently rehashed lineage and classifies catalog corruption as systemic', async () => {
    const fixture = await directedDocumentFixture();
    const sourcePath = join(dirname(fixture.markdownPath), 'source.json');
    const source = JSON.parse(await readFile(sourcePath, 'utf8')) as {
      localEvidence: { nowcoderDirected: { deliveryRevision: string } };
    };
    source.localEvidence.nowcoderDirected.deliveryRevision = 'f'.repeat(64);
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    const lineage = await loadNowcoderDirectedDocuments({
      libraryRoot: fixture.root, run: fixture.run, jobs: [fixture.job],
    });
    expect(lineage.loaded).toEqual([]);
    expect(lineage.invalid).toHaveLength(1);

    await writeFile(join(fixture.root, '_catalog', 'fe-journey.json'), '{"version":1,"entries":"bad"}\n');
    await expect(loadNowcoderDirectedDocuments({
      libraryRoot: fixture.root, run: fixture.run, jobs: [fixture.job],
    })).rejects.toBeInstanceOf(NowcoderDirectedDocumentError);
    await expect(loadNowcoderDirectedDocuments({
      libraryRoot: fixture.root, run: fixture.run, jobs: [fixture.job],
    })).rejects.toMatchObject({ code: 'DIRECTED_CANDIDATE_CATALOG_CORRUPT' });
  });

  it('revalidates current lineage after the staging guard and pauses without a checkpoint on overwrite', async () => {
    const fixture = await directedDocumentFixture();
    const sourcePath = join(dirname(fixture.markdownPath), 'source.json');
    const history = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
    const checkpointCurrentRun = vi.fn(async () => { throw new Error('must not checkpoint'); });
    const store = {
      persistHistorySnapshotCurrent: vi.fn(async () => ({
        snapshot: history,
        digest: processedNowcoderHistoryDigest(history),
      })),
      checkpointCurrentRun,
    } as unknown as NowcoderDirectedStore;
    const guardBoundary = vi.fn(async () => {
      const stored = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
      delete stored.localEvidence;
      await writeFile(sourcePath, `${JSON.stringify(stored, null, 2)}\n`);
      return true;
    });
    const service = { guardBoundary } as unknown as NowcoderDirectedService;
    const coordinator = new NowcoderDirectedSelectionCoordinator({
      store, service: () => service, libraryRoot: fixture.root, targetRoot: fixture.root, now: () => NOW,
    });

    await expect(coordinator.reconcile({ run: fixture.run, jobs: [fixture.job] }))
      .resolves.toEqual({ state: 'paused' });
    expect(guardBoundary).toHaveBeenCalledWith(fixture.run.id, fixture.run.attempt, 'before-staging');
    expect(checkpointCurrentRun).not.toHaveBeenCalled();
  });

  it('rebuilds the complete staging audit when an unaccepted snapshot changes during the guard', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-guard-audit-');
    await mkdir(join(root, '_catalog'), { recursive: true });
    const runId = 'run-guard-audit';
    const urls = [
      'https://www.nowcoder.com/discuss/8101',
      'https://www.nowcoder.com/discuss/8102',
    ];
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const index = await FeJourneyCandidateIndex.open(root);
    const jobs = await JobStore.open(join(root, '_catalog', 'jobs.json'), { now: () => NOW });
    const savedJobs: JobRecord[] = [];
    const markdownPaths: string[] = [];
    for (const [position, url] of urls.entries()) {
      const id = nowcoderDirectedJobId(runId, ATTEMPT, url);
      const results = await saveCollectedDocument(
        router,
        index,
        collected(url, position + 20),
        undefined,
        { runId, attempt: ATTEMPT, currentJobId: id },
      );
      const markdown = results.find(result => result.sinkId === 'markdown' && result.ok);
      if (!markdown) throw new Error('missing markdown output');
      markdownPaths.push(markdown.outputRef);
      let job = await jobs.create({
        id, url, requestedBy: 'codex', directedRunId: runId, directedRunAttempt: ATTEMPT,
      });
      job = await jobs.transition(id, 'collecting');
      savedJobs.push(await jobs.transition(id, 'saved', {
        outputPath: markdown.outputRef,
        markdownOutput: { sinkId: 'markdown', outputPath: markdown.outputRef },
      }));
    }
    const run: NowcoderDirectedReconciliationSnapshot = {
      id: runId,
      attempt: ATTEMPT,
      status: 'running',
      phase: 'selecting',
      spec: { target: 1, maxDetails: 24 },
      frozenCandidates: urls.map((canonicalUrl, index) => ({
        id: `guard-candidate-${index}`,
        canonicalUrl,
        contentType: 'post' as const,
        matchedQueries: ['Agent'],
        page: 1,
        rank: index + 1,
        publishedAt: '2026-08-29T00:00:00.000Z',
      })),
      candidateCursor: 2,
      currentJobIds: savedJobs.map(job => job.id),
      currentRoundJobIds: savedJobs.map(job => job.id),
      buildEvidence: {
        applicationVersion: '0.4.33', bridgeBuildId: 'build', artifactBuildId: 'build',
        extensionVersion: '0.4.33', extensionBuildId: 'build',
        extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'], frozenAt: NOW,
      },
      observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
      scheduledCandidateIds: ['guard-candidate-0', 'guard-candidate-1'],
      progress: {
        discovered: 2, detailScheduled: 2, detailSaved: 2, inspected: 0, qualified: 0,
        accepted: 0, delivered: 0, rejectionCounts: [],
        companies: [
          { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 }, { company: 'other', count: 0 },
        ],
      },
    };
    const history = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
    const checkpointCurrentRun = vi.fn(async () => ({}) as never);
    const store = {
      persistHistorySnapshotCurrent: vi.fn(async () => ({
        snapshot: history,
        digest: processedNowcoderHistoryDigest(history),
      })),
      checkpointCurrentRun,
      selectionCheckpointFingerprint: vi.fn(() => 'committed-guard-audit'),
    } as unknown as NowcoderDirectedStore;
    const guardBoundary = vi.fn(async () => {
      const sourcePath = join(dirname(markdownPaths[1]!), 'source.json');
      const stored = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
      delete stored.localEvidence;
      await writeFile(sourcePath, `${JSON.stringify(stored, null, 2)}\n`);
      return true;
    });
    const service = { guardBoundary } as unknown as NowcoderDirectedService;
    const coordinator = new NowcoderDirectedSelectionCoordinator({
      store, service: () => service, libraryRoot: root, targetRoot: root, now: () => NOW,
    });

    await expect(coordinator.reconcile({ run, jobs: savedJobs })).resolves.toEqual({
      state: 'committed',
      checkpointFingerprint: 'committed-guard-audit',
    });
    expect(checkpointCurrentRun).toHaveBeenCalledOnce();
    expect(checkpointCurrentRun.mock.calls[0]![2]).toMatchObject({
      phase: 'staging',
      progress: {
        detailScheduled: 2,
        detailSaved: 2,
        inspected: 1,
        accepted: 1,
        rejectionCounts: [{
          code: 'LOCAL_SNAPSHOT_INVALID',
          message: '本批详情快照校验失败',
          count: 1,
        }],
      },
      privateRejections: [{
        jobId: savedJobs[1]!.id,
        url: urls[1],
        code: 'LOCAL_SNAPSHOT_INVALID',
        message: '本批详情快照校验失败',
      }],
    });
  });

  it.each([
    ['local', 'DIRECTED_LOCAL_LIBRARY_CORRUPT'],
    ['candidate', 'DIRECTED_CANDIDATE_CATALOG_CORRUPT'],
    ['candidate-identity', 'DIRECTED_CANDIDATE_CATALOG_CORRUPT'],
  ] as const)('turns malformed %s catalog persistence into a directed systemic code', async (kind, code) => {
    const root = await temporaryDirectories.create(`nowcoder-directed-save-${kind}-`);
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const index = await FeJourneyCandidateIndex.open(root);
    const url = `https://www.nowcoder.com/discuss/save-${kind}`;
    const jobId = nowcoderDirectedJobId('run-save-corrupt', ATTEMPT, url);
    const catalogPath = kind === 'local'
      ? join(root, '_catalog', 'index.json')
      : join(root, '_catalog', 'fe-journey.json');
    await mkdir(dirname(catalogPath), { recursive: true });
    const corruptCatalog = kind === 'local'
      ? '[{"id":42}]\n'
      : kind === 'candidate'
        ? '{"version":1,"entries":"bad"}\n'
        : `${JSON.stringify({
          version: 1,
          entries: [{
            id: 'wrong-stable-id', source: 'nowcoder', url,
            contentHash: '0123456789abcdef', simHash: '1111111111111111',
            clusterId: 'cluster-corrupt', representativeId: 'wrong-stable-id',
            qualityScore: 1, updatedAt: '2026-08-30T00:00:00.000Z',
          }],
        })}\n`;
    await writeFile(catalogPath, corruptCatalog);

    await expect(saveCollectedDocument(router, index, collected(url), undefined, {
      runId: 'run-save-corrupt', attempt: ATTEMPT, currentJobId: jobId,
    })).rejects.toMatchObject({ code });
    expect(await readdir(join(root, '_catalog'))).not.toContain('fe-journey.lock');
  });

  it('maps every trusted directed local sink failure to the fixed local-library code', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-trusted-local-failure-');
    await mkdir(join(root, '_catalog'), { recursive: true });
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const index = await FeJourneyCandidateIndex.open(root);
    const url = 'https://www.nowcoder.com/discuss/trusted-local-failure';
    const failure = {
      sinkId: 'caller-controlled-name',
      ok: false,
      outputRef: '',
      detail: { error: 'EACCES' },
    };
    vi.spyOn(router, 'save').mockResolvedValue([failure]);
    vi.spyOn(router, 'isTrustedLocalEvidenceResult').mockImplementation(result => result === failure);

    await expect(saveCollectedDocument(router, index, collected(url), undefined, {
      runId: 'run-trusted-local-failure',
      attempt: ATTEMPT,
      currentJobId: nowcoderDirectedJobId('run-trusted-local-failure', ATTEMPT, url),
    })).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本地面经库无法安全读取',
    });
  });

  it('rejects a corrupt source sibling before creating the directed candidate lock', async () => {
    const workspace = await temporaryDirectories.create('nowcoder-directed-source-preflight-');
    const root = join(workspace, 'library');
    await mkdir(join(root, '_catalog'), { recursive: true });
    const candidateCatalogPath = join(root, '_catalog', 'fe-journey.json');
    await writeFile(candidateCatalogPath, '{"version":1,"entries":[]}\n');
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const existingUrl = 'https://www.nowcoder.com/discuss/source-preflight-existing';
    const [ordinary] = await router.save(organize(collected(existingUrl)));
    if (!ordinary?.ok) throw new Error('ordinary fixture save failed');
    const sourcePath = join(dirname(ordinary.outputRef), 'source.json');
    const outside = join(workspace, 'outside-source.json');
    await writeFile(outside, '{"outside":true}\n');
    await rm(sourcePath);
    await symlink(outside, sourcePath);
    const localCatalogPath = join(root, '_catalog', 'index.json');
    const localCatalog = await readFile(localCatalogPath, 'utf8');
    const candidateCatalog = await readFile(candidateCatalogPath, 'utf8');
    const catalogLeaves = (await readdir(join(root, '_catalog'))).sort();
    const index = await FeJourneyCandidateIndex.open(root);
    const nextUrl = 'https://www.nowcoder.com/discuss/source-preflight-next';

    await expect(saveCollectedDocument(router, index, collected(nextUrl), undefined, {
      runId: 'run-source-preflight',
      attempt: ATTEMPT,
      currentJobId: nowcoderDirectedJobId('run-source-preflight', ATTEMPT, nextUrl),
    })).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本地面经库无法安全读取',
    });
    expect(await readFile(localCatalogPath, 'utf8')).toBe(localCatalog);
    expect(await readFile(candidateCatalogPath, 'utf8')).toBe(candidateCatalog);
    expect(await readFile(outside, 'utf8')).toBe('{"outside":true}\n');
    expect((await readdir(join(root, '_catalog'))).sort()).toEqual(catalogLeaves);
  });

  it('preflights the deterministic orphan target source before creating the directed lock', async () => {
    const workspace = await temporaryDirectories.create('nowcoder-directed-orphan-source-preflight-');
    const root = join(workspace, 'library');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    const candidateCatalogPath = join(catalogDirectory, 'fe-journey.json');
    const candidateCatalog = '{"version":1,"entries":[]}\n';
    await writeFile(candidateCatalogPath, candidateCatalog);
    const url = 'https://www.nowcoder.com/discuss/source-preflight-orphan';
    const targetDirectory = join(
      root,
      '牛客网',
      '人工智能',
      '2026',
      `${stableContentId(url)}-字节-Agent-开发一面面经`,
    );
    await mkdir(targetDirectory, { recursive: true });
    const outside = join(workspace, 'outside-orphan-source.json');
    await writeFile(outside, '{"outside":true}\n');
    await symlink(outside, join(targetDirectory, 'source.json'));
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const index = await FeJourneyCandidateIndex.open(root);

    await expect(saveCollectedDocument(router, index, collected(url), undefined, {
      runId: 'run-orphan-source-preflight',
      attempt: ATTEMPT,
      currentJobId: nowcoderDirectedJobId('run-orphan-source-preflight', ATTEMPT, url),
    })).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本地面经库无法安全读取',
    });

    expect(await readFile(candidateCatalogPath, 'utf8')).toBe(candidateCatalog);
    expect(await readFile(outside, 'utf8')).toBe('{"outside":true}\n');
    expect(await readdir(catalogDirectory)).not.toContain('fe-journey.lock');
    expect(await readdir(targetDirectory)).toEqual(['source.json']);
  });

  it.each([
    ['regular index', async (indexPath: string) => { await writeFile(indexPath, 'orphan-index\n'); }],
    ['symlink index', async (indexPath: string, workspace: string) => {
      const outside = join(workspace, 'outside-orphan-index.md');
      await writeFile(outside, 'outside-index\n');
      await symlink(outside, indexPath);
    }],
    ['directory index', async (indexPath: string) => { await mkdir(indexPath); }],
    ['I/O-protected regular index', async (indexPath: string) => {
      await writeFile(indexPath, 'unreadable-index\n');
      await chmod(indexPath, 0o000);
    }],
  ] as const)(
    'rejects a deterministic orphan %s before the directed lock or any library mutation',
    async (_kind, arrange) => {
      const workspace = await temporaryDirectories.create('nowcoder-directed-orphan-index-preflight-');
      const root = join(workspace, 'library');
      const catalogDirectory = join(root, '_catalog');
      await mkdir(catalogDirectory, { recursive: true });
      const candidateCatalogPath = join(catalogDirectory, 'fe-journey.json');
      const candidateCatalog = '{"version":1,"entries":[]}\n';
      await writeFile(candidateCatalogPath, candidateCatalog);
      const url = 'https://www.nowcoder.com/discuss/orphan-index-preflight';
      const targetDirectory = join(
        root,
        '牛客网',
        '人工智能',
        '2026',
        `${stableContentId(url)}-字节-Agent-开发一面面经`,
      );
      await mkdir(targetDirectory, { recursive: true });
      const indexPath = join(targetDirectory, 'index.md');
      await arrange(indexPath, workspace);
      const beforeIndex = await lstat(indexPath);
      const router = SinkRouter.build(undefined, { libraryRoot: root });
      const index = await FeJourneyCandidateIndex.open(root);

      await expect(saveCollectedDocument(router, index, collected(url), undefined, {
        runId: 'run-orphan-index-preflight',
        attempt: ATTEMPT,
        currentJobId: nowcoderDirectedJobId('run-orphan-index-preflight', ATTEMPT, url),
      })).rejects.toMatchObject({
        code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
        message: '本地面经库无法安全读取',
      });

      const afterIndex = await lstat(indexPath);
      expect({ mode: afterIndex.mode, size: afterIndex.size, ino: afterIndex.ino })
        .toEqual({ mode: beforeIndex.mode, size: beforeIndex.size, ino: beforeIndex.ino });
      expect(await readFile(candidateCatalogPath, 'utf8')).toBe(candidateCatalog);
      expect(await readdir(catalogDirectory)).not.toContain('fe-journey.lock');
      expect(await readdir(targetDirectory)).toEqual(['index.md']);
    },
  );

  it('rejects an unmatched deterministic source artifact without adopting or rewriting it', async () => {
    const workspace = await temporaryDirectories.create('nowcoder-directed-orphan-source-identity-');
    const root = join(workspace, 'library');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    const localCatalogPath = join(catalogDirectory, 'index.json');
    const localCatalog = '[]\n';
    const candidateCatalogPath = join(catalogDirectory, 'fe-journey.json');
    const candidateCatalog = '{"version":1,"entries":[]}\n';
    await writeFile(localCatalogPath, localCatalog);
    await writeFile(candidateCatalogPath, candidateCatalog);
    const url = 'https://www.nowcoder.com/discuss/orphan-source-identity';
    const targetDirectory = join(
      root,
      '牛客网',
      '人工智能',
      '2026',
      `${stableContentId(url)}-字节-Agent-开发一面面经`,
    );
    await mkdir(targetDirectory, { recursive: true });
    const sourcePath = join(targetDirectory, 'source.json');
    const sourceBytes = `${JSON.stringify(
      organize(collected('https://www.nowcoder.com/discuss/foreign-source-identity')),
      null,
      2,
    )}\n`;
    await writeFile(sourcePath, sourceBytes);
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const index = await FeJourneyCandidateIndex.open(root);

    await expect(saveCollectedDocument(router, index, collected(url), undefined, {
      runId: 'run-orphan-source-identity',
      attempt: ATTEMPT,
      currentJobId: nowcoderDirectedJobId('run-orphan-source-identity', ATTEMPT, url),
    })).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本地面经库无法安全读取',
    });

    expect(await readFile(localCatalogPath, 'utf8')).toBe(localCatalog);
    expect(await readFile(candidateCatalogPath, 'utf8')).toBe(candidateCatalog);
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
    expect(await readdir(catalogDirectory)).not.toContain('fe-journey.lock');
    expect(await readdir(targetDirectory)).toEqual(['source.json']);
  });

  it('fails closed when a foreign directory wins immediately before a missing parent create', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-orphan-exclusive-parent-race-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    const catalogBytes = '[]\n';
    await writeFile(catalogPath, catalogBytes);
    const url = 'https://www.nowcoder.com/discuss/orphan-exclusive-parent-race';
    const input = organize(collected(url));
    let foreignDirectory = '';
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeExclusiveCreate: async (kind: string, path: string) => {
          if (kind !== 'directory' || foreignDirectory || path.includes('.directed-entry-')) return;
          foreignDirectory = path;
          await mkdir(path);
          await writeFile(join(path, 'foreign-marker.txt'), 'foreign-parent\n');
        },
      },
    });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect(await readFile(join(foreignDirectory, 'foreign-marker.txt'), 'utf8'))
      .toBe('foreign-parent\n');
    expect(await readdir(foreignDirectory)).toEqual(['foreign-marker.txt']);
    expect(await readFile(catalogPath, 'utf8')).toBe(catalogBytes);
  });

  it('keeps a new directed entry hidden in one unique staging directory until commit', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-staged-visibility-');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
    const fetchStarted = deferred<void>();
    const releaseFetch = deferred<void>();
    const url = 'https://www.nowcoder.com/discuss/staged-visibility';
    const input = organize(collected(url));
    input.sanitizedHtml += '<img src="https://img.example/staged.png" alt="staged">';
    input.document.images = [{ url: 'https://img.example/staged.png', alt: 'staged' }];
    const library = new MarkdownLibrary({
      root,
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async () => {
        fetchStarted.resolve();
        await releaseFetch.promise;
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      },
    });
    const saving = library.save(input, directedLocalEvidence(url, input));
    await fetchStarted.promise;
    const duringFetch = await readdir(catalogDirectory);
    expect(await readdir(root)).toEqual(['_catalog']);
    releaseFetch.resolve();
    const saved = await saving;

    expect(duringFetch.filter(name => name.startsWith('.directed-entry-'))).toHaveLength(1);
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-entry-')))
      .toEqual([]);
    expect(await readFile(saved.markdownPath, 'utf8')).toContain('字节 Agent 开发一面面经');
    expect(dirname(saved.markdownPath)).toContain(
      `${stableContentId(url)}-0123456789abcdef`,
    );
  });

  it('rejects a same-inode catalog mutation immediately before entry commit', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-catalog-same-inode-race-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    const before = await lstat(catalogPath);
    const mutatedCatalog = '[ ]\n';
    const url = 'https://www.nowcoder.com/discuss/catalog-same-inode-race';
    const input = organize(collected(url));
    let context: DirectedTransactionTestContext | undefined;
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeEntryCommit: async (value: DirectedTransactionTestContext) => {
          context = value;
          await writeFile(catalogPath, mutatedCatalog);
        },
      },
    });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect((await lstat(catalogPath)).ino).toBe(before.ino);
    expect(await readFile(catalogPath, 'utf8')).toBe(mutatedCatalog);
    await expect(lstat(context!.finalDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(context!.stagingDirectory)).isDirectory()).toBe(true);
    expect(await readFile(
      join(context!.stagingDirectory, '.data-collector-directed-transaction.json'),
      'utf8',
    )).toContain('"version": 1');
  });

  it('rejects an existing hard-linked catalog before any transaction artifact', async () => {
    const workspace = await temporaryDirectories.create('nowcoder-directed-catalog-hardlink-');
    const root = join(workspace, 'library');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    const aliasPath = join(workspace, 'catalog-alias.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    await link(catalogPath, aliasPath);
    const url = 'https://www.nowcoder.com/discuss/catalog-hardlink';
    const input = organize(collected(url));
    const library = new MarkdownLibrary({ root });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect(await readFile(catalogPath, 'utf8')).toBe('[]\n');
    expect(await readFile(aliasPath, 'utf8')).toBe('[]\n');
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('does not write through a replaced catalog parent at final commit', async () => {
    const workspace = await temporaryDirectories.create('nowcoder-directed-catalog-parent-commit-race-');
    const root = join(workspace, 'library');
    const catalogDirectory = join(root, '_catalog');
    const displacedCatalogDirectory = join(workspace, 'displaced-catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
    const foreignCatalog = '{"foreign":true}\n';
    const url = 'https://www.nowcoder.com/discuss/catalog-parent-commit-race';
    const input = organize(collected(url));
    let context: DirectedTransactionTestContext | undefined;
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeCatalogCommit: async (value: DirectedTransactionTestContext) => {
          context = value;
          await rename(catalogDirectory, displacedCatalogDirectory);
          await mkdir(catalogDirectory);
          await writeFile(join(catalogDirectory, 'index.json'), foreignCatalog);
          await writeFile(join(catalogDirectory, 'foreign-marker.txt'), 'foreign-parent\n');
        },
      },
    });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect(await readFile(join(catalogDirectory, 'index.json'), 'utf8')).toBe(foreignCatalog);
    expect(await readdir(catalogDirectory)).toEqual(['foreign-marker.txt', 'index.json']);
    expect((await lstat(context!.finalDirectory)).isDirectory()).toBe(true);
    expect(await readFile(
      join(context!.finalDirectory, '.data-collector-directed-transaction.json'),
      'utf8',
    )).toContain('"version": 1');
    expect((await readdir(displacedCatalogDirectory)).some(
      name => name.startsWith('.directed-journal-'),
    )).toBe(true);
  });

  it.each(['entry-index', 'catalog-temp'] as const)(
    'closes and removes a uniquely owned %s after exclusive-open initialization fails',
    async failedKind => {
      const root = await temporaryDirectories.create('nowcoder-directed-exclusive-init-failure-');
      const catalogDirectory = join(root, '_catalog');
      const catalogPath = join(catalogDirectory, 'index.json');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(catalogPath, '[]\n');
      const url = `https://www.nowcoder.com/discuss/exclusive-init-${failedKind}`;
      const input = organize(collected(url));
      const library = new MarkdownLibrary({
        root,
        directedTransactionIo: {
          afterExclusiveOpen: async (kind: string) => {
            if (kind === failedKind) throw new Error('injected exclusive initialization failure');
          },
        },
      });

      await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
        code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
        message: '本机目录格式无效',
      });

      expect(await readFile(catalogPath, 'utf8')).toBe('[]\n');
      expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
        .toEqual([]);
    },
  );

  it('retries a failed owned-handle close during cleanup before removing unique staging', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-close-retry-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    const url = 'https://www.nowcoder.com/discuss/close-retry';
    const input = organize(collected(url));
    let closeAttempts = 0;
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        afterExclusiveOpen: async (kind, _path, handle) => {
          if (kind !== 'entry-index') return;
          const close = handle.close.bind(handle);
          handle.close = async () => {
            closeAttempts += 1;
            if (closeAttempts === 1) throw new Error('injected first close failure');
            return await close();
          };
        },
      },
    });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect(closeAttempts).toBe(2);
    expect(await readFile(catalogPath, 'utf8')).toBe('[]\n');
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toHaveLength(3);
    await expect(new MarkdownLibrary({ root }).save(input, directedLocalEvidence(url, input)))
      .resolves.toMatchObject({ id: stableContentId(url) });
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('keeps an absent-catalog install successful after a post-commit diagnostic failure', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-post-commit-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    const url = 'https://www.nowcoder.com/discuss/post-commit-diagnostic';
    const input = organize(collected(url));
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        afterCatalogCommit: async () => {
          throw new Error('injected post-commit diagnostic failure');
        },
      },
    });

    const saved = await library.save(input, directedLocalEvidence(url, input));

    expect(await readFile(saved.markdownPath, 'utf8')).toContain('Agent');
    expect((await lstat(catalogPath)).nlink).toBe(1);
    expect(JSON.parse(await readFile(catalogPath, 'utf8'))).toEqual([
      expect.objectContaining({ id: stableContentId(url), url }),
    ]);
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('deduplicates repeated images that resolve to the same final asset filename', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-duplicate-asset-');
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(join(root, '_catalog', 'index.json'), '[]\n');
    const url = 'https://www.nowcoder.com/discuss/duplicate-asset';
    const imageUrl = 'https://img.example/duplicate.png';
    const input = organize(collected(url));
    input.sanitizedHtml += `<img src="${imageUrl}" alt="same"><img src="${imageUrl}" alt="same">`;
    input.document.images = [
      { url: imageUrl, alt: 'same' },
      { url: imageUrl, alt: 'same' },
    ];
    const library = new MarkdownLibrary({
      root,
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async () => new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    });

    const saved = await library.save(input, directedLocalEvidence(url, input));

    expect(saved).toMatchObject({ downloadedImages: 2, failedImages: 0 });
    expect(await readdir(join(dirname(saved.markdownPath), 'assets'))).toHaveLength(1);
  });

  it('leaves a foreign empty assets directory inside a replaced staging tree untouched', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-foreign-staging-assets-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    const url = 'https://www.nowcoder.com/discuss/foreign-staging-assets';
    const imageUrl = 'https://img.example/foreign-assets.png';
    const input = organize(collected(url));
    input.sanitizedHtml += `<img src="${imageUrl}" alt="foreign">`;
    input.document.images = [{ url: imageUrl, alt: 'foreign' }];
    let foreignAssetsPath = '';
    const library = new MarkdownLibrary({
      root,
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async () => new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
      directedTransactionIo: {
        beforeExclusiveCreate: async (kind: string, path: string) => {
          if (kind !== 'assets-directory' || !path.includes('.directed-entry-')) return;
          foreignAssetsPath = path;
          await mkdir(path);
        },
      },
    });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect(foreignAssetsPath).toContain(`${join('_catalog', '.directed-entry-')}`);
    expect(await readdir(foreignAssetsPath)).toEqual([]);
    expect(await readFile(catalogPath, 'utf8')).toBe('[]\n');
  });

  it('does not enter pathname cleanup after the staged journal becomes durable', async () => {
    const workspace = await temporaryDirectories.create('nowcoder-directed-unique-cleanup-race-');
    const root = join(workspace, 'library');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    const url = 'https://www.nowcoder.com/discuss/unique-cleanup-race';
    const imageUrl = 'https://img.example/cleanup.png';
    const input = organize(collected(url));
    input.sanitizedHtml += `<img src="${imageUrl}" alt="cleanup">`;
    input.document.images = [{ url: imageUrl, alt: 'cleanup' }];
    const displaced = join(workspace, 'displaced-owned-staging');
    let context: DirectedTransactionTestContext | undefined;
    let cleanupHookRan = false;
    const library = new MarkdownLibrary({
      root,
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async () => new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
      directedTransactionIo: {
        beforeEntryCommit: async (value: DirectedTransactionTestContext) => {
          context = value;
          throw new Error('injected post-asset failure');
        },
        beforeUniqueCleanup: async (path: string) => {
          if (path !== context?.stagingDirectory) return;
          cleanupHookRan = true;
          await rename(path, displaced);
          await mkdir(path);
          await writeFile(join(path, 'foreign-marker.txt'), 'foreign-staging\n');
        },
      },
    });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect(cleanupHookRan).toBe(false);
    await expect(lstat(displaced)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(
      join(context!.stagingDirectory, '.data-collector-directed-transaction.json'),
      'utf8',
    )).toContain('"version": 1');
    expect(await readFile(catalogPath, 'utf8')).toBe('[]\n');
    await expect(lstat(context!.finalDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the uniquely published journal recoverable when catalog commit fails', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-catalog-commit-failure-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    const url = 'https://www.nowcoder.com/discuss/catalog-commit-failure';
    const input = organize(collected(url));
    let context: DirectedTransactionTestContext | undefined;
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeCatalogCommit: async (value: DirectedTransactionTestContext) => {
          context = value;
          throw new Error('injected catalog commit failure');
        },
      },
    });

    await expect(library.save(input, directedLocalEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });

    expect(await readFile(catalogPath, 'utf8')).toBe('[]\n');
    expect((await lstat(context!.finalDirectory)).isDirectory()).toBe(true);
    expect(await readFile(
      join(context!.finalDirectory, '.data-collector-directed-transaction.json'),
      'utf8',
    )).toContain('"version": 1');
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toHaveLength(2);
    await expect(new MarkdownLibrary({ root }).save(input, directedLocalEvidence(url, input)))
      .resolves.toMatchObject({ id: stableContentId(url) });
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('stages a complete catalog and atomically replaces the old catalog after entry visibility', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-atomic-catalog-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    const url = 'https://www.nowcoder.com/discuss/atomic-catalog';
    const input = organize(collected(url));
    let observedOld = '';
    let observedStaged: unknown;
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeCatalogCommit: async (context: DirectedTransactionTestContext) => {
          observedOld = await readFile(context.catalogPath, 'utf8');
          observedStaged = JSON.parse(await readFile(context.catalogTemporaryPath!, 'utf8'));
          expect((await lstat(context.finalDirectory)).isDirectory()).toBe(true);
        },
      },
    });

    const saved = await library.save(input, directedLocalEvidence(url, input));

    expect(observedOld).toBe('[]\n');
    expect(observedStaged).toEqual([expect.objectContaining({
      id: stableContentId(url),
      url,
    })]);
    expect(JSON.parse(await readFile(catalogPath, 'utf8'))).toEqual([
      expect.objectContaining({ relativePath: expect.stringContaining('/index.md') }),
    ]);
    expect(await readFile(saved.markdownPath, 'utf8')).toContain('Agent');
  });

  it('runs the authoritative candidate prepare exactly once and only inside the directed critical section', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-single-prepare-');
    await mkdir(join(root, '_catalog'), { recursive: true });
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const index = await FeJourneyCandidateIndex.open(root);
    const prepare = vi.spyOn(index, 'prepare');
    const url = 'https://www.nowcoder.com/discuss/single-authoritative-prepare';

    await expect(saveCollectedDocument(router, index, collected(url), undefined, {
      runId: 'run-single-prepare',
      attempt: ATTEMPT,
      currentJobId: nowcoderDirectedJobId('run-single-prepare', ATTEMPT, url),
    })).resolves.toEqual([expect.objectContaining({ sinkId: 'markdown', ok: true })]);

    expect(prepare).toHaveBeenCalledOnce();
  });

  it('does not downgrade candidate-catalog ENOENT after the leaf was already observed', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-candidate-catalog-race-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'fe-journey.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '{"version":1,"entries":[]}\n');
    const canonicalRoot = await realpath(root);
    const canonicalCatalogPath = join(canonicalRoot, '_catalog', 'fe-journey.json');
    const disappeared = Object.assign(new Error('catalog disappeared after lstat'), { code: 'ENOENT' });

    await expect(readDirectedCandidateCatalog(canonicalRoot, {
      lstat,
      readFile,
      realpath: (async path => {
        if (String(path) === canonicalCatalogPath) throw disappeared;
        return await realpath(path);
      }) as typeof realpath,
    })).rejects.toMatchObject({
      code: 'DIRECTED_CANDIDATE_CATALOG_CORRUPT',
      message: 'fe-journey 候选索引格式无效',
    });
  });

  it('rejects a candidate catalog whose opened inode differs from the validated leaf', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-candidate-catalog-inode-race-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'fe-journey.json');
    const replacementPath = join(root, 'replacement.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '{"version":1,"entries":[]}\n');
    await writeFile(replacementPath, '{"version":1,"entries":[]}\n');
    const canonicalRoot = await realpath(root);

    await expect(readDirectedCandidateCatalog(canonicalRoot, {
      lstat,
      open: (async () => await open(replacementPath, 'r')) as typeof open,
      readFile,
      realpath,
    })).rejects.toMatchObject({
      code: 'DIRECTED_CANDIDATE_CATALOG_CORRUPT',
      message: 'fe-journey 候选索引格式无效',
    });
  });

  it('does not treat a missing candidate leaf under a replaced parent inode as an empty catalog', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-candidate-parent-race-');
    const catalogDirectory = join(root, '_catalog');
    const replacementDirectory = join(root, 'replacement-catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await mkdir(replacementDirectory);
    const canonicalRoot = await realpath(root);
    const canonicalCatalogDirectory = join(canonicalRoot, '_catalog');
    const replacementMetadata = await lstat(replacementDirectory);
    let parentReads = 0;

    await expect(readDirectedCandidateCatalog(canonicalRoot, {
      lstat: (async path => {
        if (String(path) === canonicalCatalogDirectory && ++parentReads === 2) {
          return replacementMetadata;
        }
        return await lstat(path);
      }) as typeof lstat,
      readFile,
      realpath,
    })).rejects.toMatchObject({
      code: 'DIRECTED_CANDIDATE_CATALOG_CORRUPT',
      message: 'fe-journey 候选索引格式无效',
    });
  });

  it('atomically routes a zero-candidate collecting run to selecting target-unavailable', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-zero-candidate-');
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
      now: () => NOW,
      id: () => 'run-zero-candidate',
      attempt: () => ATTEMPT,
    });
    await store.createSession({
      id: 'session-zero-candidate',
      queries: ['Agent'],
      queryHash: 'e'.repeat(64),
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
      candidates: [],
    }, { target: 1 });
    const run = await store.startRun({
      searchSessionId: 'session-zero-candidate',
      selectedCandidateIds: [],
      idempotencyKey: 'zero-candidate-key',
      deliveryAuthorized: true,
    }, {
      buildEvidence: {
        applicationVersion: '0.4.33', bridgeBuildId: 'build', artifactBuildId: 'build',
        extensionVersion: '0.4.33', extensionBuildId: 'build',
        extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'], frozenAt: NOW,
      },
      runtimeId: '11111111-1111-4111-8111-111111111111',
    });
    const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
    const service = new NowcoderDirectedService({ store, jobs, dispatch: async () => undefined });
    const coordinator = new NowcoderDirectedSelectionCoordinator({
      store, service: () => service, libraryRoot: root, targetRoot: root, now: () => NOW,
    });

    await expect(coordinator.reconcile({
      run: store.reconciliationSnapshots()[0]!,
      jobs: [],
    })).resolves.toMatchObject({ state: 'committed' });

    expect(store.getRun(run.id)).toMatchObject({
      status: 'completed_with_attention',
      phase: 'selecting',
      attentionReason: { code: 'DIRECTED_TARGET_UNAVAILABLE', phase: 'selecting' },
      accepted: 0,
      delivered: 0,
      progress: { detailScheduled: 0, accepted: 0, rejectionCounts: [] },
    });
  });

  it('attentions after nine exact current jobs even when twenty historical jobs are pending', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-nine-current-');
    const runId = 'run-nine-current';
    const candidates: NowcoderSearchCandidate[] = Array.from({ length: 9 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      canonicalUrl: `https://www.nowcoder.com/discuss/${9000 + index}`,
      contentType: 'post', matchedQueries: ['Agent'], page: 1, rank: index + 1,
      publishedAt: new Date(Date.parse('2026-08-29T00:00:00.000Z') - index * 60_000).toISOString(),
    }));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
      now: () => NOW, id: () => runId, attempt: () => ATTEMPT,
    });
    await store.createSession({
      id: 'session-nine', queries: ['Agent'], queryHash: 'a'.repeat(64), requestedSort: 'latest',
      provider: 'nowcoder-json', sortVerified: true, createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z', candidates,
    }, { target: 10 });
    const run = await store.startRun({
      searchSessionId: 'session-nine', selectedCandidateIds: [], idempotencyKey: 'nine-key', deliveryAuthorized: true,
    }, {
      buildEvidence: {
        applicationVersion: '0.4.33', bridgeBuildId: 'build', artifactBuildId: 'build',
        extensionVersion: '0.4.33', extensionBuildId: 'build',
        extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'], frozenAt: NOW,
      },
      runtimeId: '11111111-1111-4111-8111-111111111111',
    });
    const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
    await mkdir(join(root, '_catalog'), { recursive: true });
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const index = await FeJourneyCandidateIndex.open(root);
    const currentJobs: JobRecord[] = [];
    for (const [position, candidate] of candidates.entries()) {
      const id = nowcoderDirectedJobId(run.id, run.attempt, candidate.canonicalUrl);
      const results = await saveCollectedDocument(
        router, index, collected(candidate.canonicalUrl, position), undefined,
        { runId: run.id, attempt: run.attempt, currentJobId: id },
      );
      const markdown = results.find(result => result.sinkId === 'markdown' && result.ok);
      if (!markdown) throw new Error('missing markdown output');
      let job = await jobs.create({
        id, url: candidate.canonicalUrl, requestedBy: 'codex',
        directedRunId: run.id, directedRunAttempt: run.attempt,
      });
      job = await jobs.transition(job.id, 'collecting');
      currentJobs.push(await jobs.transition(job.id, 'saved', {
        outputPath: markdown.outputRef,
        markdownOutput: { sinkId: 'markdown', outputPath: markdown.outputRef },
      }));
    }
    const currentIds = currentJobs.map(job => job.id);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 9, currentJobIds: currentIds, currentRoundJobIds: [currentIds[8]!],
      ...pendingAudit(candidates, currentIds),
    });
    for (let index = 0; index < 20; index += 1) {
      await jobs.create({
        id: `historical-${index}`,
        url: `https://www.nowcoder.com/discuss/${10_000 + index}`,
        requestedBy: 'codex',
      });
    }
    const service = new NowcoderDirectedService({ store, jobs, dispatch: async () => undefined });
    await service.onJobTerminal(currentJobs[8]!);
    const coordinator = new NowcoderDirectedSelectionCoordinator({
      store, service: () => service, libraryRoot: root, targetRoot: root, now: () => NOW,
    });
    const snapshot = store.reconciliationSnapshots()[0]!;

    await coordinator.reconcile({ run: snapshot, jobs: currentJobs });

    const terminal = store.getRun(run.id)!;
    expect(terminal).toMatchObject({
      status: 'completed_with_attention', accepted: 9, delivered: 0,
      deliveryIds: [], publicDeliveryItems: [],
      attentionReason: {
        code: 'DIRECTED_TARGET_UNAVAILABLE',
        message: '在最多 24 篇详情中未筛得足量有效面经',
      },
      progress: { detailScheduled: 9, detailSaved: 9, inspected: 9, qualified: 9, accepted: 9 },
    });
    expect(JSON.stringify(terminal)).not.toMatch(/historical-|nowcoder-job-|\/Users\/|localEvidence/u);
  });

  it('recomputes systemic detailSaved from exactly eight current-attempt Markdown proofs', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-systemic-saved-');
    const candidates: NowcoderSearchCandidate[] = Array.from({ length: 8 }, (_, index) => ({
      id: `systemic-candidate-${index}`,
      canonicalUrl: `https://www.nowcoder.com/discuss/${8_200 + index}`,
      contentType: 'post', matchedQueries: ['Agent'], page: 1, rank: index + 1,
      publishedAt: '2026-08-29T00:00:00.000Z',
    }));
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
      now: () => NOW, id: () => 'run-systemic-saved', attempt: () => ATTEMPT,
    });
    await store.createSession({
      id: 'session-systemic-saved', queries: ['Agent'], queryHash: 'd'.repeat(64),
      requestedSort: 'latest', provider: 'nowcoder-json', sortVerified: true,
      createdAt: NOW, expiresAt: '2026-08-30T00:30:00.000Z', candidates,
    }, { target: 10 });
    const run = await store.startRun({
      searchSessionId: 'session-systemic-saved', selectedCandidateIds: [],
      idempotencyKey: 'systemic-saved-key', deliveryAuthorized: true,
    }, {
      buildEvidence: {
        applicationVersion: '0.4.33', bridgeBuildId: 'build', artifactBuildId: 'build',
        extensionVersion: '0.4.33', extensionBuildId: 'build',
        extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'], frozenAt: NOW,
      },
      runtimeId: '11111111-1111-4111-8111-111111111111',
    });
    const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
    const saved: JobRecord[] = [];
    for (const candidate of candidates) {
      const id = nowcoderDirectedJobId(run.id, run.attempt, candidate.canonicalUrl);
      let job = await jobs.create({
        id, url: candidate.canonicalUrl, requestedBy: 'codex',
        directedRunId: run.id, directedRunAttempt: run.attempt,
      });
      job = await jobs.transition(id, 'collecting');
      saved.push(await jobs.transition(id, 'saved', {
        outputPath: `/proof/${id}/index.md`,
        markdownOutput: { sinkId: 'markdown', outputPath: `/proof/${id}/index.md` },
      }));
    }
    const foreign = await jobs.create({
      id: 'foreign-systemic-proof',
      url: 'https://www.nowcoder.com/discuss/8999',
      requestedBy: 'codex',
    });
    await jobs.transition(foreign.id, 'collecting');
    await jobs.transition(foreign.id, 'saved', {
      outputPath: '/proof/foreign/index.md',
      markdownOutput: { sinkId: 'markdown', outputPath: '/proof/foreign/index.md' },
    });
    const ids = saved.map(job => job.id);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 8, currentJobIds: ids, currentRoundJobIds: ids,
      ...pendingAudit(candidates, ids),
    });
    const service = new NowcoderDirectedService({ store, jobs, dispatch: async () => undefined });
    await service.onJobTerminal(saved[7]!);

    await service.finalizeAttention(run.id, run.attempt, {
      code: 'DIRECTED_HISTORY_CORRUPT',
      message: '历史记录无法安全读取',
      at: NOW,
      phase: 'selecting',
    });

    expect(store.getRun(run.id)).toMatchObject({
      status: 'completed_with_attention',
      progress: { detailScheduled: 8, detailSaved: 8, rejectionCounts: [] },
      attentionReason: { code: 'DIRECTED_HISTORY_CORRUPT' },
    });
  });

  it('attentions on reopen when the persisted strict-history snapshot no longer matches its digest', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-history-tamper-');
    const directedPath = join(root, 'directed.json');
    const url = 'https://www.nowcoder.com/discuss/history-tamper';
    const store = await NowcoderDirectedStore.open(directedPath, {
      now: () => NOW, id: () => 'run-history-tamper', attempt: () => ATTEMPT,
    });
    await store.createSession({
      id: 'session-history', queries: ['Agent'], queryHash: 'b'.repeat(64), requestedSort: 'latest',
      provider: 'nowcoder-json', sortVerified: true, createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z', candidates: [{
        id: 'candidate-history', canonicalUrl: url, contentType: 'post', matchedQueries: ['Agent'],
        page: 1, rank: 1, publishedAt: '2026-08-29T00:00:00.000Z',
      }],
    }, { target: 1 });
    const run = await store.startRun({
      searchSessionId: 'session-history', selectedCandidateIds: [], idempotencyKey: 'history-key', deliveryAuthorized: true,
    }, {
      buildEvidence: {
        applicationVersion: '0.4.33', bridgeBuildId: 'build', artifactBuildId: 'build',
        extensionVersion: '0.4.33', extensionBuildId: 'build',
        extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'], frozenAt: NOW,
      },
      runtimeId: '11111111-1111-4111-8111-111111111111',
    });
    const jobId = nowcoderDirectedJobId(run.id, run.attempt, url);
    await store.checkpointCurrentRun(run.id, run.attempt, {
      phase: 'collecting', candidateCursor: 1, currentJobIds: [jobId], currentRoundJobIds: [jobId],
      ...pendingAudit(store.getSession('session-history')!.candidates, [jobId]),
    });
    const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
    const created = await jobs.create({
      id: jobId, url, requestedBy: 'codex', directedRunId: run.id, directedRunAttempt: run.attempt,
    });
    const failed = await jobs.transition(created.id, 'failed', { errorCode: 'EXTRACT_FAILED' });
    const liveService = new NowcoderDirectedService({ store, jobs, dispatch: async () => undefined });
    await liveService.onJobTerminal(failed);
    const snapshot = { version: 1 as const, hashesByUrl: [], clusterIds: [] };
    await store.persistHistorySnapshotCurrent(
      run.id, run.attempt, snapshot, processedNowcoderHistoryDigest(snapshot),
    );
    const envelope = JSON.parse(await readFile(directedPath, 'utf8')) as {
      runs: Array<{ historySnapshot: { clusterIds: string[] } }>;
    };
    envelope.runs[0]!.historySnapshot.clusterIds = ['tampered-cluster'];
    await writeFile(directedPath, `${JSON.stringify(envelope, null, 2)}\n`);
    const reopened = await NowcoderDirectedStore.open(directedPath, { now: () => NOW });
    expect(reopened.reconciliationSnapshots()).toEqual([]);

    expect(reopened.getRun(run.id)).toMatchObject({
      status: 'completed_with_attention', accepted: 0, delivered: 0,
      deliveryIds: [], publicDeliveryItems: [],
      progress: {
        rejectionCounts: [],
        companies: [
          { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 }, { company: 'other', count: 0 },
        ],
      },
      attentionReason: { code: 'DIRECTED_HISTORY_CORRUPT', message: '历史记录无法安全读取' },
    });
  });
});
