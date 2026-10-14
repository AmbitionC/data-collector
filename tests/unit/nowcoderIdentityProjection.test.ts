import { stableContentId } from '@data-collector/shared';
import { knownNowcoderSources } from '../../packages/bridge/src/nowcoderDirected/knownSources.js';
import { scoreFeJourneyCandidate } from '../../packages/bridge/src/feJourney/quality.js';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCompanyInventory } from '../../packages/bridge/src/plans/nowcoderInventory.js';
import { auditNowcoderIdentityProjection, loadNowcoderIdentityProjection } from '../../packages/bridge/src/plans/nowcoderIdentityProjection.js';
import { loadStrictProcessedNowcoderHistory } from '../../packages/bridge/src/plans/nowcoderProcessedHistory.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
import { ARTICLE, SOURCE_ID, PUBLISHED_COMMIT, PROJECTION_NOW, digest, jsonBytes, identityProjectionFixture } from '../helpers/identityProjection.js';

const temporary = createTemporaryDirectoryTracker();
afterEach(() => temporary.cleanup());
const fixture = async (aliases = false) => identityProjectionFixture(await temporary.create('identity-projection-'), aliases);
const inventory = (f: Awaited<ReturnType<typeof fixture>>, commit = PUBLISHED_COMMIT) =>
  readCompanyInventory(f.resource, f.library, PROJECTION_NOW, f.projectionPath, commit);

describe('versioned private Nowcoder identities', () => {
  it.each(['status', 'evidenceGrade'] as const)('rejects a non-string raw %s at the audit and every operational consumer', async field => {
    const f = await fixture();
    f.raw.records[SOURCE_ID][field] = [f.raw.records[SOURCE_ID][field]];
    await f.save();
    const results = await Promise.allSettled([
      auditNowcoderIdentityProjection(f.resource, f.projectionPath, PUBLISHED_COMMIT),
      loadNowcoderIdentityProjection(f.resource, f.projectionPath, PUBLISHED_COMMIT),
      loadStrictProcessedNowcoderHistory(f.resource, f.projectionPath, PUBLISHED_COMMIT),
      inventory(f),
      knownNowcoderSources({ libraryRoot: f.library, historyRoot: f.resource,
        historyPath: f.projectionPath, historyCommit: PUBLISHED_COMMIT, jobs: [] }),
    ]);
    expect(results.map(result => result.status)).toEqual(Array(5).fill('rejected'));
  });

  it('reads actual captured identity separately from editorial SHA/process and preserves prepared/partial raw evidence', async () => {
    const f = await fixture(), before = await readFile(f.rawPath, 'utf8');
    const result = await loadStrictProcessedNowcoderHistory(f.resource, f.projectionPath, PUBLISHED_COMMIT);
    expect(result.snapshot.hashesByUrl).toEqual([{ url: 'https://www.nowcoder.com/discuss/1001', hashes: ['2a738c3a9a258f6c'] }]);
    expect(result.snapshot.clusterIds).toEqual(['captured-runtime-cluster']);
    expect(await inventory(f)).toMatchObject({ tencent: { published: 1, qualifiedPending: 0 } });
    expect(await readFile(f.rawPath, 'utf8')).toBe(before);
    expect(f.raw.records[SOURCE_ID]).toMatchObject({ status: 'prepared', evidenceGrade: 'B-partial', processUnitId: 'editorial-process-only' });
  });

  it('keeps distinct source aliases and deduplicates their real capture cluster', async () => {
    const f = await fixture(true);
    const result = await loadStrictProcessedNowcoderHistory(f.resource, f.projectionPath, PUBLISHED_COMMIT);
    expect(result.snapshot.hashesByUrl.map(entry => entry.url)).toEqual(['https://www.nowcoder.com/discuss/1001', 'https://www.nowcoder.com/discuss/1002']);
    expect(result.snapshot.clusterIds).toEqual(['captured-runtime-cluster']);
  });

  it.each(['pending', 'missing', 'stale', 'dropped-alias'])('blocks incomplete current publication bindings even with an empty pending library: %s', async reason => {
    const f = await fixture(true);
    if (reason === 'pending') f.projection.bindings[0]!.review = { status: 'pending', reason: 'needs real review' };
    if (reason === 'missing') f.projection.bindings = [];
    if (reason === 'stale') f.receipt.entries[0]!.articleSha256 = 'e'.repeat(64);
    if (reason === 'dropped-alias') f.projection.bindings[0]!.sourceIds = [SOURCE_ID];
    await f.save(); await expect(inventory(f)).rejects.toThrow();
  });

  it.each(['expected-commit', 'snapshot-commit', 'tree', 'article'])('fails closed for a stale pinned publication snapshot: %s', async reason => {
    const f = await fixture();
    if (reason === 'snapshot-commit') await writeFile(join(f.resource, '.collector-published-snapshot.json'), jsonBytes({ schemaVersion: 1, commit: 'e'.repeat(40), treeSha256: f.projection.published.treeSha256 }));
    if (reason === 'tree') await writeFile(join(f.resource, 'interview/_tree.json'), '[]');
    if (reason === 'article') await writeFile(join(f.resource, ARTICLE), '# newer body');
    await expect(inventory(f, reason === 'expected-commit' ? 'e'.repeat(40) : PUBLISHED_COMMIT)).rejects.toThrow();
  });

  it('requires an explicit expected publication commit for the modern contract', async () => {
    const f = await fixture();
    await expect(readCompanyInventory(f.resource, f.library, PROJECTION_NOW, f.projectionPath)).rejects.toThrow();
  });

  it.each(['raw', 'original', 'runtime-identity', 'receipt-source'])('rejects mismatched or manufactured evidence: %s', async reason => {
    const f = await fixture();
    if (reason === 'raw') await writeFile(f.rawPath, '{}');
    if (reason === 'original') await writeFile(f.raw.records[SOURCE_ID].originalBodyEvidenceFile, '{}');
    if (reason === 'runtime-identity') {
      const path = f.raw.records[SOURCE_ID].originalBodyEvidenceFile;
      const capture = JSON.parse(await readFile(path, 'utf8')); delete capture.document.feJourney;
      const bytes = jsonBytes(capture); await writeFile(path, bytes); f.raw.records[SOURCE_ID].originalBodySha256 = digest(bytes); await f.save();
    }
    if (reason === 'receipt-source') { f.receipt.entries[0]!.sourceSha256[SOURCE_ID] = 'f'.repeat(64); await f.save(); }
    await expect(inventory(f)).rejects.toThrow();
  });

  it('rejects a symlinked raw evidence input', async () => {
    const f = await fixture(), link = join(f.root, 'raw-link.private.json'); await symlink(f.rawPath, link);
    f.projection.rawHistory.path = link; await f.save(); await expect(inventory(f)).rejects.toThrow();
  });
});


it('uses projected prepared/partial identities only for exclusion while counting a distinct real pending source', async () => {
  const f = await fixture();
  const original = JSON.parse(await readFile(f.raw.records[SOURCE_ID].originalBodyEvidenceFile, 'utf8')).document;
  const fresh = { ...original, url: 'https://www.nowcoder.com/discuss/2001', canonicalUrl: 'https://www.nowcoder.com/discuss/2001',
    text: '我参加了腾讯 AI 应用开发二面。1.RAG 召回怎么评测？2.MCP 工具参数失败怎么处理？3.模型流式输出断线怎么恢复？' };
  fresh.feJourney = { ...scoreFeJourneyCandidate(fresh), clusterId: 'fresh-capture-cluster' };
  const catalog = [];
  for (const doc of [original, fresh]) {
    const id = stableContentId(doc.canonicalUrl), relativePath = `nowcoder/${id}/index.md`;
    await mkdir(join(f.library, 'nowcoder', id), { recursive: true });
    await writeFile(join(f.library, relativePath), doc.text);
    await writeFile(join(f.library, 'nowcoder', id, 'source.json'), jsonBytes({ document: doc,
      sanitizedHtml: doc.html, summary: '', category: 'interview', tags: [] }));
    catalog.push({ id, source: 'nowcoder', title: doc.title, url: doc.canonicalUrl, category: 'interview', relativePath,
      updatedAt: PROJECTION_NOW, nowcoderReviewOnly: true, sync: { state: 'pending' } });
  }
  await writeFile(join(f.library, '_catalog/index.json'), jsonBytes(catalog));
  expect((await inventory(f)).tencent).toEqual({ published: 1, qualifiedPending: 1 });
  const known = await knownNowcoderSources({ libraryRoot: f.library, historyRoot: f.resource,
    historyPath: f.projectionPath, historyCommit: PUBLISHED_COMMIT, jobs: [] });
  expect([...known.urls].sort()).toEqual(['https://www.nowcoder.com/discuss/1001', 'https://www.nowcoder.com/discuss/2001']);
  f.projection.bindings[0]!.review = { status: 'pending', reason: 'current binding unverified' }; await f.save();
  await expect(knownNowcoderSources({ libraryRoot: f.library, historyRoot: f.resource,
    historyPath: f.projectionPath, historyCommit: PUBLISHED_COMMIT, jobs: [] })).rejects.toThrow();
});

it('rejects an oversized raw history without treating pending stock as zero', async () => {
  const f = await fixture(); await writeFile(f.rawPath, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  await expect(inventory(f)).rejects.toThrow();
});

it.each([['published', 'B', true], ['prepared', 'B-partial', false]])('reuses a genuine exact-current inline review without promoting raw status: %s/%s', async (status, grade, accepted) => {
  const f = await fixture(), record = f.raw.records[SOURCE_ID];
  record.status = status; record.evidenceGrade = grade;
  record.editorialReview = { decision: 'publishable_with_source_limits', editorialEvidenceGrade: grade,
    reviewedAt: PROJECTION_NOW, contentSha256: f.projection.bindings[0]!.articleSha256, reason: 'Existing source association reviewed with explicit limits.' };
  f.projection.bindings[0]!.review = { status: 'recorded', basis: 'raw-history' }; await f.save();
  if (accepted) expect((await inventory(f)).tencent).toEqual({ published: 1, qualifiedPending: 0 });
  else await expect(inventory(f)).rejects.toThrow();
});

it('reuses an actual legacy private receipt only when its frozen original and current article both match', async () => {
  const f = await fixture(), record = f.raw.records[SOURCE_ID]; record.status = 'published'; record.evidenceGrade = 'B';
  const capture = JSON.parse(await readFile(record.originalBodyEvidenceFile, 'utf8'));
  const frozenPath = join(f.root, 'existing-source-original.txt'); await writeFile(frozenPath, capture.document.text);
  const legacyPath = join(f.root, 'existing-independent-review.json');
  const legacy = { schemaVersion: 1, reviewedAtUTC: PROJECTION_NOW, reviewer: 'independent', contentConclusion: 'pass_after_repairs_for_reviewed_scope',
    interviews: [{ key: 'tencent-ai-1', verdict: 'pass_after_repairs', file: { sha256: f.projection.bindings[0]!.articleSha256 },
      frozenOriginal: { path: frozenPath, sha256: digest(capture.document.text) }, originalDocumentTextByteMatch: 'pass', questionCoverage: 'pass' }] };
  const bytes = jsonBytes(legacy); await writeFile(legacyPath, bytes);
  record.privateReviewStatus = 'approved'; record.reviewedArticleSha256 = f.projection.bindings[0]!.articleSha256;
  record.privateReviewReceiptFile = legacyPath; record.privateReviewReceiptSha256 = digest(bytes);
  f.projection.bindings[0]!.review = { status: 'recorded', basis: 'raw-history' }; await f.save();
  expect((await inventory(f)).tencent.published).toBe(1);
  await writeFile(frozenPath, 'unrelated original');
  await expect(inventory(f)).rejects.toThrow();
});
