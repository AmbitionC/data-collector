import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectedDocument } from '@data-collector/shared';
import { scoreFeJourneyCandidate } from '../../packages/bridge/src/feJourney/quality.js';

export const PROJECTION_NOW = '2026-10-14T17:00:00.000Z';
export const PUBLISHED_COMMIT = 'd'.repeat(40);
export const SOURCE_ID = '0123456789ab';
export const ARTICLE = 'interview/tencent/ai/tencent-ai-1.md';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const jsonBytes = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export async function identityProjectionFixture(directory: string, aliases = false) {
  const root = await realpath(directory), resource = join(root, 'resource'), library = join(root, 'library');
  await mkdir(join(resource, 'interview/tencent/ai'), { recursive: true });
  await mkdir(join(library, '_catalog'), { recursive: true });
  const tree = [{ key: 'tencent', children: [{ key: 'tencent-ai-1', filePath: 'tencent/ai', isLeaf: true }] }];
  const treeBytes = jsonBytes(tree), articleBytes = '# 腾讯 Agent 面经\n\n来源问了工具调用与错误重试。\n';
  await writeFile(join(resource, 'interview/_tree.json'), treeBytes);
  await writeFile(join(resource, ARTICLE), articleBytes);
  await writeFile(join(resource, '.collector-published-snapshot.json'), jsonBytes({ schemaVersion: 1,
    commit: PUBLISHED_COMMIT, treeSha256: digest(treeBytes) }));
  await writeFile(join(library, '_catalog/index.json'), '[]');
  const sourceIds = aliases ? [SOURCE_ID, 'abcdef012345'] : [SOURCE_ID];
  const records: Record<string, any> = {}, sourceSha256: Record<string, string> = {};
  for (const [index, id] of sourceIds.entries()) {
    const url = `https://www.nowcoder.com/discuss/${1001 + index}`;
    const text = '我参加了腾讯 AI 应用开发一面。1.Agent Loop 怎么设计？2.Tool 如何定义？3.Memory 如何实现？';
    const base: CollectedDocument = { schemaVersion: 1, source: 'nowcoder', kind: 'post', url, canonicalUrl: url,
      title: '腾讯 AI 应用开发一面面经', publishedAt: '2026-10-13T04:00:00.000Z', collectedAt: PROJECTION_NOW,
      text, html: '<p>真实可见来源</p>', images: [], sourceMetadata: { contentAccess: 'full' } };
    const score = scoreFeJourneyCandidate(base);
    const document = { ...base, feJourney: { ...score, clusterId: 'captured-runtime-cluster' } };
    const capturePath = join(root, id + '.source.private.json'), captureBytes = jsonBytes({ document });
    await writeFile(capturePath, captureBytes); sourceSha256[id] = digest(captureBytes);
    records[id] = { source: 'nowcoder', url, status: 'prepared', evidenceGrade: 'B-partial', articleKey: 'tencent-ai-1',
      bodySha256: 'b'.repeat(64), processUnitId: 'editorial-process-only', editorialLimits: '仅可见片段；保留缺项',
      processedAt: '2026-10-13', originalBodyEvidenceFile: capturePath, originalBodySha256: digest(captureBytes),
      originalBodyDocumentJson: true };
  }
  const rawPath = join(root, 'source-history.raw.private.json');
  const raw = { schemaVersion: 1, updatedAt: PROJECTION_NOW, records };
  const receiptPath = join(root, 'binding-review.private.json');
  const receipt = { schemaVersion: 1, kind: 'nowcoder-source-binding-review', reviewer: 'test reviewer',
    reviewedAt: PROJECTION_NOW, entries: [{ articleKey: 'tencent-ai-1', path: ARTICLE, articleSha256: digest(articleBytes),
      sourceIds, sourceSha256, decision: 'verified', reason: 'Fixture explicitly binds this source; this is identity review only.' }] };
  const projectionPath = join(root, 'identity-projection.private.json');
  const projection = { schemaVersion: 2, kind: 'nowcoder-identity-projection', generatedAt: PROJECTION_NOW,
    rawHistory: { path: rawPath, sha256: '' }, published: { commit: PUBLISHED_COMMIT, treeSha256: digest(treeBytes) },
    bindings: [{ articleKey: 'tencent-ai-1', path: ARTICLE, articleSha256: digest(articleBytes), sourceIds,
      review: { status: 'verified', receipt: { path: receiptPath, sha256: '' } } as any }] };
  const save = async () => {
    const rawBytes = jsonBytes(raw), receiptBytes = jsonBytes(receipt);
    await writeFile(rawPath, rawBytes); await writeFile(receiptPath, receiptBytes);
    projection.rawHistory.sha256 = digest(rawBytes);
    if (projection.bindings[0]?.review.status === 'verified') projection.bindings[0].review.receipt.sha256 = digest(receiptBytes);
    await writeFile(projectionPath, jsonBytes(projection));
  };
  await save();
  return { root, resource, library, rawPath, raw, receiptPath, receipt, projectionPath, projection, save, sourceIds };
}
