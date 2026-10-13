import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableContentId, type CollectedDocument } from '@data-collector/shared';
import { scoreFeJourneyCandidate } from '../../packages/bridge/src/feJourney/quality.js';
import {
  readCompanyInventory, selectCompanyCandidates, type CompanyInventory,
} from '../../packages/bridge/src/plans/nowcoderInventory.js';
import type { NowcoderDiscoveryCandidate } from '../../packages/bridge/src/feJourney/nowcoderDiscovery.js';

const NOW = '2026-10-13T16:00:00.000Z';
const roots: string[] = [];
const labels = { bytedance: '字节', tencent: '腾讯', alibaba: '阿里', ant: '蚂蚁', other: '拼多多' } as const;
function zero(): CompanyInventory {
  return {
    bytedance: { published: 0, qualifiedPending: 0 }, tencent: { published: 0, qualifiedPending: 0 },
    alibaba: { published: 0, qualifiedPending: 0 }, ant: { published: 0, qualifiedPending: 0 },
    other: { published: 0, qualifiedPending: 0 },
  };
}
function interview(company: keyof typeof labels, id: number, suffix = ''): CollectedDocument {
  const label = labels[company];
  const url = `https://www.nowcoder.com/discuss/${id}`;
  const document: CollectedDocument = {
    schemaVersion: 1, source: 'nowcoder', kind: 'post', url, canonicalUrl: url,
    title: `${label} AI 应用开发一面面经`, author: `候选人${id}`,
    publishedAt: '2026-10-10T04:00:00.000Z', collectedAt: NOW,
    html: '<p>真实面经</p>', images: [],
    text: `我参加了${label} AI 应用开发一面。1.Agent Loop 怎么设计？2.Tool 如何定义？3.Memory 如何实现？${suffix}`,
    sourceMetadata: { contentAccess: 'full', nowcoderReviewOnly: true },
  };
  const score = scoreFeJourneyCandidate(document);
  return { ...document, feJourney: { ...score, clusterId: `cluster-${score.contentHash.slice(0, 12)}` } };
}
async function fixture(): Promise<{ resource: string; library: string; historyPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'nowcoder-inventory-')); roots.push(root);
  const resource = join(root, 'resource'), library = join(root, 'library');
  await mkdir(join(resource, 'interview'), { recursive: true });
  await mkdir(join(library, '_catalog'), { recursive: true });
  await mkdir(join(root, 'private'));
  const historyPath = join(await realpath(join(root, 'private')), 'interview-source-history.json');
  await writeFile(join(resource, 'interview', '_tree.json'), '[]');
  await writeFile(join(library, '_catalog', 'index.json'), '[]');
  return { resource, library, historyPath };
}
async function published(resource: string, companies: string[]): Promise<void> {
  const nodes = [];
  for (const [index, company] of companies.entries()) {
    const key = `${company}-ai-${index + 1}`;
    await mkdir(join(resource, 'interview', company, 'ai'), { recursive: true });
    await writeFile(join(resource, 'interview', company, 'ai', `${key}.md`), '### 已上架面经\n');
    nodes.push({ key: company, label: company, children: [{ key, isLeaf: true, filePath: `${company}/ai` }] });
  }
  await writeFile(join(resource, 'interview', '_tree.json'), JSON.stringify(nodes));
}
async function snapshots(library: string, documents: CollectedDocument[]): Promise<void> {
  const catalog = [];
  for (const document of documents) {
    const id = stableContentId(document.canonicalUrl), relativePath = `nowcoder/${id}/index.md`;
    const directory = join(library, 'nowcoder', id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.md'), document.text);
    await writeFile(join(directory, 'source.json'), JSON.stringify({
      document, sanitizedHtml: document.html, summary: '', category: 'interview', tags: [],
    }));
    catalog.push({ id, source: document.source, title: document.title, url: document.canonicalUrl,
      category: 'interview', relativePath, updatedAt: NOW, nowcoderReviewOnly: true, sync: { state: 'pending' } });
  }
  await writeFile(join(library, '_catalog', 'index.json'), JSON.stringify(catalog));
}
async function history(path: string, document: CollectedDocument): Promise<void> {
  await writeFile(path, JSON.stringify({
    schemaVersion: 1, updatedAt: '2026-10-13', records: { [stableContentId(document.canonicalUrl)]: {
      source: 'nowcoder', url: document.canonicalUrl, contentHash: document.feJourney!.contentHash,
      clusterId: document.feJourney!.clusterId, evidenceGrade: 'A', status: 'published',
      articleKey: 'tencent-ai-1', publicFiles: ['interview/tencent/ai/tencent-ai-1.md'],
      knowledgeKeys: [], processedAt: NOW,
    } },
  }));
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('company candidate selection', () => {
  it('uses temporary stock as it fills and keeps stable ties and actual discovery objects', () => {
    const inventory = zero(); inventory.bytedance.published = 51;
    const candidates: NowcoderDiscoveryCandidate[] = [
      { url: 'https://www.nowcoder.com/discuss/1', queryCompany: 'bytedance' },
      { url: 'https://www.nowcoder.com/discuss/2', queryCompany: 'tencent' },
      { url: 'https://www.nowcoder.com/discuss/3', queryCompany: 'tencent' },
      { url: 'https://www.nowcoder.com/discuss/4', queryCompany: 'ant' },
      { url: 'https://www.nowcoder.com/discuss/5', queryCompany: 'ant' },
      { url: 'https://www.nowcoder.com/discuss/6', queryCompany: 'alibaba' },
    ];
    const selected = selectCompanyCandidates(candidates, inventory, ['tencent', 'ant', 'bytedance'], 4);
    expect(selected.map(item => item.url)).toEqual([
      'https://www.nowcoder.com/discuss/2', 'https://www.nowcoder.com/discuss/4',
      'https://www.nowcoder.com/discuss/3', 'https://www.nowcoder.com/discuss/5',
    ]);
    expect(selected[0]).toBe(candidates[1]);
    expect(inventory.tencent.qualifiedPending).toBe(0);
  });

  it('deduplicates aliases of a real URL and excludes unconfigured companies', () => {
    const candidates: NowcoderDiscoveryCandidate[] = [
      { url: 'https://www.nowcoder.com/discuss/1?utm_source=test', queryCompany: 'tencent' },
      { url: 'https://nowcoder.com/discuss/1/#fragment', queryCompany: 'ant' },
      { url: 'https://www.nowcoder.com/discuss/2', queryCompany: 'other' },
    ];
    expect(selectCompanyCandidates(candidates, zero(), ['tencent', 'ant'], 10)).toEqual([candidates[0]]);
  });

  it('rejects invalid limits, repeated company order, and unavailable stock', () => {
    for (const limit of [-1, 0.5, Number.NaN]) expect(() => selectCompanyCandidates([], zero(), ['ant'], limit)).toThrow();
    expect(() => selectCompanyCandidates([], zero(), ['ant', 'ant'], 1)).toThrow();
    expect(() => selectCompanyCandidates([], { ...zero(), ant: undefined } as CompanyInventory, ['ant'], 1)).toThrow(/inventory/i);
  });
});

describe('grounded published and qualified pending company inventory', () => {
  it('counts tree leaves in departments and maps Antfin and known other companies explicitly', async () => {
    const { resource, library } = await fixture();
    await published(resource, ['bytedance', 'tencent', 'alibaba', 'antfin', 'vivo']);
    expect(await readCompanyInventory(resource, library, NOW)).toEqual({
      bytedance: { published: 1, qualifiedPending: 0 }, tencent: { published: 1, qualifiedPending: 0 },
      alibaba: { published: 1, qualifiedPending: 0 }, ant: { published: 1, qualifiedPending: 0 },
      other: { published: 1, qualifiedPending: 0 },
    });
  });

  it('counts only current A/B Agent source snapshots with the existing hard gates', async () => {
    const { resource, library } = await fixture();
    const b = interview('ant', 2); b.title = '蚂蚁工程一面面经';
    b.text = '我参加了蚂蚁技术一面。1.Agent Loop 怎么设计？2.Tool 如何定义？3.Memory 如何实现？';
    b.feJourney = { ...scoreFeJourneyCandidate(b), clusterId: 'grade-b-interview' };
    const stale = interview('bytedance', 3); stale.publishedAt = '2026-07-01T00:00:00.000Z';
    const future = interview('bytedance', 4); future.publishedAt = '2026-10-14T00:00:00.000Z';
    const truncated = interview('bytedance', 5); truncated.truncated = true; truncated.sourceMetadata = { contentAccess: 'truncated' };
    const frontend = interview('bytedance', 6); frontend.title = '字节前端一面面经';
    const editorial = interview('bytedance', 7); editorial.title = '字节 Agent 面试题汇总';
    const knowledge = interview('bytedance', 8); knowledge.source = 'github';
    const fakeGrade = interview('bytedance', 9); fakeGrade.text = '招聘岗位介绍'; fakeGrade.sourceMetadata = { evidenceGrade: 'A', company: 'bytedance', agentRelevant: true };
    await snapshots(library, [interview('tencent', 1), b, stale, future, truncated, frontend, editorial, knowledge, fakeGrade]);
    const result = await readCompanyInventory(resource, library, NOW);
    expect(result.tencent).toEqual({ published: 0, qualifiedPending: 1 });
    expect(result.ant).toEqual({ published: 0, qualifiedPending: 1 });
    expect(result.bytedance.qualifiedPending).toBe(0);
  });

  it('counts a source and its same-content or same-cluster repost only once', async () => {
    const { resource, library } = await fixture();
    const original = interview('tencent', 10);
    const exact = { ...original, url: 'https://www.nowcoder.com/discuss/11', canonicalUrl: 'https://www.nowcoder.com/discuss/11' };
    const cluster = interview('tencent', 12, '我又补充了一点。'); cluster.feJourney!.clusterId = original.feJourney!.clusterId;
    await snapshots(library, [original, exact, cluster]);
    expect((await readCompanyInventory(resource, library, NOW)).tencent).toEqual({ published: 0, qualifiedPending: 1 });
  });

  it('excludes published URL revisions, content aliases, and cluster aliases from pending', async () => {
    const { resource, library, historyPath } = await fixture();
    await published(resource, ['tencent']);
    const publishedSource = interview('tencent', 20);
    await history(historyPath, publishedSource);
    const revision = interview('tencent', 20, '正文修订');
    const contentAlias = { ...publishedSource, url: 'https://www.nowcoder.com/discuss/21', canonicalUrl: 'https://www.nowcoder.com/discuss/21', feJourney: { ...publishedSource.feJourney!, clusterId: 'different-cluster' } };
    const clusterAlias = interview('tencent', 22, '补充说明'); clusterAlias.feJourney!.clusterId = publishedSource.feJourney!.clusterId;
    await snapshots(library, [revision, contentAlias, clusterAlias, interview('ant', 23)]);
    const result = await readCompanyInventory(resource, library, NOW, historyPath);
    expect(result.tencent).toEqual({ published: 1, qualifiedPending: 0 });
    expect(result.ant).toEqual({ published: 0, qualifiedPending: 1 });
  });

  it('counts more than ten independent pending interviews without target truncation', async () => {
    const { resource, library } = await fixture();
    await snapshots(library, Array.from({ length: 13 }, (_, index) => interview('alibaba', 100 + index, `独立过程 ${index}`)));
    expect((await readCompanyInventory(resource, library, NOW)).alibaba.qualifiedPending).toBe(13);
  });

  it('fails closed when pending qualifies but published source identity is incomplete', async () => {
    const { resource, library } = await fixture();
    await published(resource, ['tencent']);
    await snapshots(library, [interview('ant', 30)]);
    await expect(readCompanyInventory(resource, library, NOW)).rejects.toThrow(/inventory-unverifiable/);
  });

  it('fails closed on missing catalog, malformed tree, unknown company, and source identity mismatch', async () => {
    const { resource, library } = await fixture();
    await rm(join(library, '_catalog', 'index.json'));
    await expect(readCompanyInventory(resource, library, NOW)).rejects.toThrow(/inventory/);
    await snapshots(library, []);
    await writeFile(join(resource, 'interview', '_tree.json'), '{}');
    await expect(readCompanyInventory(resource, library, NOW)).rejects.toThrow(/inventory/);
    await published(resource, ['unknown-company']);
    await expect(readCompanyInventory(resource, library, NOW)).rejects.toThrow(/inventory/);
    await published(resource, []);
    const document = interview('ant', 31); await snapshots(library, [document]);
    document.canonicalUrl = 'https://www.nowcoder.com/discuss/999';
    await writeFile(join(library, 'nowcoder', stableContentId(document.url), 'source.json'), JSON.stringify({ document, sanitizedHtml: '', summary: '', category: '', tags: [] }));
    await expect(readCompanyInventory(resource, library, NOW)).rejects.toThrow(/inventory/);
  });

  it('rejects corrupt explicit outside history and symbolic source paths instead of treating them as empty', async () => {
    const { resource, library, historyPath } = await fixture();
    await writeFile(historyPath, '{}');
    await expect(readCompanyInventory(resource, library, NOW, historyPath)).rejects.toThrow(/inventory/);
    const document = interview('ant', 32); await snapshots(library, [document]);
    const source = join(library, 'nowcoder', stableContentId(document.url), 'source.json');
    const outside = join(resource, 'outside.json');
    await writeFile(outside, await readFile(source, 'utf8'));
    await rm(source); await symlink(outside, source);
    await expect(readCompanyInventory(resource, library, NOW)).rejects.toThrow(/inventory/);
  });

  it('does not need or read an in-repository ledger when there are no qualifying pending snapshots', async () => {
    const { resource, library } = await fixture();
    await published(resource, ['tencent']);
    await mkdir(join(resource, '.codex'));
    await writeFile(join(resource, '.codex', 'interview-source-history.json'), '{broken ignored file');
    const stale = interview('ant', 40); stale.publishedAt = '2026-07-01T00:00:00.000Z';
    await snapshots(library, [stale]);
    expect((await readCompanyInventory(resource, library, NOW)).tencent).toEqual({ published: 1, qualifiedPending: 0 });
  });

  it('requires an explicit outside ledger even if a complete ledger exists inside the repository', async () => {
    const { resource, library } = await fixture();
    await published(resource, ['tencent']);
    await snapshots(library, [interview('ant', 41)]);
    const inside = join(resource, '.codex', 'interview-source-history.json');
    await mkdir(dirname(inside)); await history(inside, interview('tencent', 42));
    await expect(readCompanyInventory(resource, library, NOW)).rejects.toThrow(/inventory-unverifiable/);
    await expect(readCompanyInventory(resource, library, NOW, inside)).rejects.toThrow(/inventory-invalid/);
  });

  it('rejects relative, directory, symlinked leaf, and symlinked parent history paths', async () => {
    const { resource, library, historyPath } = await fixture();
    await history(historyPath, interview('tencent', 43));
    await expect(readCompanyInventory(resource, library, NOW, 'private/history.json')).rejects.toThrow(/inventory-invalid/);
    await expect(readCompanyInventory(resource, library, NOW, dirname(historyPath))).rejects.toThrow(/inventory-invalid/);
    const link = join(dirname(historyPath), 'history-link.json'); await symlink(historyPath, link);
    await expect(readCompanyInventory(resource, library, NOW, link)).rejects.toThrow(/inventory-invalid/);
    const parentLink = join(dirname(dirname(historyPath)), 'private-link'); await symlink(dirname(historyPath), parentLink);
    await expect(readCompanyInventory(resource, library, NOW, join(parentLink, 'interview-source-history.json'))).rejects.toThrow(/inventory-invalid/);
  });

  it('fails closed on unavailable or incomplete outside history', async () => {
    const { resource, library, historyPath } = await fixture();
    await published(resource, ['tencent', 'antfin']);
    await snapshots(library, [interview('ant', 44)]);
    await expect(readCompanyInventory(resource, library, NOW, historyPath)).rejects.toThrow(/inventory-unavailable/);
    await history(historyPath, interview('tencent', 45));
    await expect(readCompanyInventory(resource, library, NOW, historyPath)).rejects.toThrow(/inventory-unverifiable/);
  });

  it('enforces byte and record limits on the explicit outside history', async () => {
    const { resource, library, historyPath } = await fixture();
    const handle = await open(historyPath, 'w');
    try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(readCompanyInventory(resource, library, NOW, historyPath)).rejects.toThrow(/inventory-invalid/);
    await writeFile(historyPath, JSON.stringify({ schemaVersion: 1, updatedAt: '2026-10-13',
      records: Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [index.toString(16).padStart(12, '0'), {}])),
    }));
    await expect(readCompanyInventory(resource, library, NOW, historyPath)).rejects.toThrow(/inventory-invalid/);
  });
});
