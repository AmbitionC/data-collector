import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableContentId, type CollectedDocument } from '@data-collector/shared';
import {
  FeJourneyCandidateIndex,
  readDirectedCandidateCatalog,
  saveCollectedDocument,
} from '../../packages/bridge/src/feJourney/index.js';
import { listLibrary } from '../../packages/bridge/src/library/index.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { SinkRouter } from '../../packages/bridge/src/sinks/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function nowcoderDocument(id: string, text: string): CollectedDocument {
  const url = `https://www.nowcoder.com/discuss/${id}`;
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: 'Agent 研发一面面经',
    collectedAt: '2026-08-19T00:00:00.000Z',
    html: `<p>${text}</p>`,
    text,
    images: [],
  };
}

describe('FeJourneyCandidateIndex', () => {
  it('keeps ordinary catalog open compatible while directed preflight owns strict identity checks', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-ordinary-compatible-');
    await mkdir(join(root, '_catalog'));
    await writeFile(join(root, '_catalog', 'fe-journey.json'), `${JSON.stringify({
      version: 1,
      entries: [{
        id: 'legacy-noncanonical-id',
        source: 'nowcoder',
        url: 'https://www.nowcoder.com/discuss/legacy-ordinary',
        contentHash: '0123456789abcdef',
        simHash: '1111111111111111',
        clusterId: 'legacy-cluster',
        representativeId: 'legacy-noncanonical-id',
        qualityScore: 1,
        updatedAt: '2026-08-30T00:00:00.000Z',
      }],
    })}\n`);

    await expect(FeJourneyCandidateIndex.open(root)).resolves.toBeInstanceOf(FeJourneyCandidateIndex);
  });

  it.each(['cross-cluster', 'representative-chain'] as const)(
    'rejects a directed candidate catalog with an invalid %s representative relation',
    async kind => {
      const root = await temporaryDirectories.create(`fe-journey-index-${kind}-`);
      await mkdir(join(root, '_catalog'));
      const firstUrl = 'https://www.nowcoder.com/discuss/5101';
      const secondUrl = 'https://www.nowcoder.com/discuss/5102';
      const thirdUrl = 'https://www.nowcoder.com/discuss/5103';
      const firstId = stableContentId(firstUrl);
      const secondId = stableContentId(secondUrl);
      const thirdId = stableContentId(thirdUrl);
      const base = (id: string, url: string, clusterId: string, representativeId: string) => ({
        id,
        source: 'nowcoder',
        url,
        contentHash: '0123456789abcdef',
        simHash: '1111111111111111',
        clusterId,
        representativeId,
        qualityScore: 90,
        updatedAt: '2026-08-30T00:00:00.000Z',
      });
      const entries = kind === 'cross-cluster'
        ? [
            base(firstId, firstUrl, 'cluster-a', secondId),
            base(secondId, secondUrl, 'cluster-b', secondId),
          ]
        : [
            base(firstId, firstUrl, 'cluster-a', secondId),
            base(secondId, secondUrl, 'cluster-a', thirdId),
            base(thirdId, thirdUrl, 'cluster-a', thirdId),
          ];
      const validEntries = [
        base(firstId, firstUrl, 'cluster-a', firstId),
        base(secondId, secondUrl, 'cluster-b', secondId),
        ...(kind === 'representative-chain'
          ? [base(thirdId, thirdUrl, 'cluster-c', thirdId)]
          : []),
      ];
      await writeFile(join(root, '_catalog', 'fe-journey.json'), `${JSON.stringify({
        version: 1,
        entries: validEntries,
      })}\n`);
      const canonicalRoot = await realpath(root);
      await expect(readDirectedCandidateCatalog(canonicalRoot)).resolves.toMatchObject({
        version: 1,
        entries: validEntries,
      });
      await writeFile(join(root, '_catalog', 'fe-journey.json'), `${JSON.stringify({
        version: 1,
        entries,
      })}\n`);

      await expect(readDirectedCandidateCatalog(canonicalRoot)).rejects.toMatchObject({
        code: 'DIRECTED_CANDIDATE_CATALOG_CORRUPT',
      });
    },
  );

  it('persists Nowcoder evidence and gives a real Agent interview an AI source category', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-evidence-');
    const index = await FeJourneyCandidateIndex.open(root);
    const base = nowcoderDocument(
      '4001',
      [
        '我参加了阿里云 Agent 开发岗位一面，面试时间是8月18日。',
        '1.如何设计 React 管理端？',
        '2.如何设计 Agent Loop？',
        '3.怎样保障 Agent 按需调用工具？',
        '4.上下文压缩后如何验证需求没有丢失？',
      ].join(''),
    );
    const prepared = index.prepare({
      ...base,
      title: '阿里云 Agent 开发一面：React 管理端设计',
      author: '匿名候选人',
      publishedAt: '2026-08-18T15:39:00.000Z',
      sourceMetadata: { contentAccess: 'full' },
    }).document;

    expect(prepared).toMatchObject({
      suggestedCategory: '人工智能',
      sourceMetadata: {
        company: 'alibaba',
        businessUnit: '阿里云',
        evidenceGrade: 'A',
        questionCount: 4,
      },
    });
    expect(prepared.feJourney?.candidateKinds).toContain('interview');
    expect(organize(prepared).category).toBe('人工智能');
  });

  it('groups exact and near duplicates while preserving a separate unrelated cluster', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-');
    const index = await FeJourneyCandidateIndex.open(root);
    const originalText = '一面面试官追问 RAG 文档切分、向量召回、重排以及答案评测的实现原理。';
    const sourceIdentity = {
      author: '同一位候选人',
      title: '字节 Agent 开发一面面经',
      publishedAt: '2026-08-18T09:00:00.000Z',
    };
    const first = index.prepare({ ...nowcoderDocument('1001', originalText), ...sourceIdentity });
    await first.commit();

    const exact = index.prepare({
      ...nowcoderDocument('1002', ` ${originalText} `),
      ...sourceIdentity,
    });
    expect(exact.document.feJourney?.clusterId).toBe(first.document.feJourney?.clusterId);
    expect(exact.document.feJourney?.duplicateOf).toBe(
      stableContentId('https://www.nowcoder.com/discuss/1001'),
    );
    await exact.commit();

    const near = index.prepare({
      ...nowcoderDocument(
        '1003',
        '一面面试官继续追问 RAG 文档切分、向量召回、结果重排以及答案评测的实现原理。',
      ),
      ...sourceIdentity,
    });
    expect(near.document.feJourney?.clusterId).toBe(first.document.feJourney?.clusterId);
    expect(near.document.feJourney?.duplicateOf).toBe(
      stableContentId('https://www.nowcoder.com/discuss/1001'),
    );
    await near.commit();

    const unrelated = index.prepare(nowcoderDocument(
      '1004',
      '面经里讨论的是浏览器渲染流水线、CSS 合成层与动画性能，没有检索系统内容。',
    ));
    expect(unrelated.document.feJourney?.clusterId).not.toBe(first.document.feJourney?.clusterId);
    expect(unrelated.document.feJourney?.duplicateOf).toBeUndefined();
    await unrelated.commit();

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'fe-journey.json'), 'utf8'),
    ) as { version: number; entries: unknown[] };
    expect(catalog).toMatchObject({ version: 1 });
    expect(catalog.entries).toHaveLength(4);
  });

  it('keeps near-similar interview lists separate across companies and authors', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-source-boundary-');
    const index = await FeJourneyCandidateIndex.open(root);
    const prompts = [
      '1.介绍 Agent 项目架构。',
      '2.RAG 的完整流程是什么？',
      '3.如何选择 Agent 框架？',
      '4.长期记忆怎么存储？',
      '5.工具调用失败如何恢复？',
      '6.怎么做 Agent 评测？',
    ];
    const tencent = index.prepare({
      ...nowcoderDocument('5101', `我参加了腾讯 Agent 开发一面。${prompts.join('')}`),
      title: '腾讯 Agent 开发一面面经',
      author: '腾讯候选人甲',
      publishedAt: '2026-08-18T09:00:00.000Z',
    });
    await tencent.commit();

    const bytedance = index.prepare({
      ...nowcoderDocument(
        '5102',
        `我参加了字节 Agent 开发一面。${prompts.join('')}最后还追问了项目上线效果。`,
      ),
      title: '字节 Agent 开发一面面经',
      author: '字节候选人乙',
      publishedAt: '2026-08-18T10:00:00.000Z',
    });
    expect(bytedance.document.feJourney?.clusterId).not.toBe(
      tencent.document.feJourney?.clusterId,
    );
    expect(bytedance.document.feJourney?.duplicateOf).toBeUndefined();
    await bytedance.commit();

    const otherTencentAuthor = index.prepare({
      ...nowcoderDocument(
        '5103',
        `我参加了腾讯 Agent 开发一面。${prompts.join('')}最后还讨论了团队协作。`,
      ),
      title: '腾讯 Agent 开发一面复盘',
      author: '腾讯候选人丙',
      publishedAt: '2026-08-18T11:00:00.000Z',
    });
    expect(otherTencentAuthor.document.feJourney?.clusterId).not.toBe(
      tencent.document.feJourney?.clusterId,
    );
    expect(otherTencentAuthor.document.feJourney?.duplicateOf).toBeUndefined();
  });

  it('serializes writes across independent index instances without losing entries', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-cross-process-lock-');
    const firstIndex = await FeJourneyCandidateIndex.open(root);
    const secondIndex = await FeJourneyCandidateIndex.open(root);

    await Promise.all([
      firstIndex.runExclusive(async () => {
        const prepared = firstIndex.prepare(nowcoderDocument('5201', '腾讯 Agent 一面追问 RAG 评测与工具安全。'));
        await prepared.commit();
      }),
      secondIndex.runExclusive(async () => {
        const prepared = secondIndex.prepare(nowcoderDocument('5202', '字节 Agent 二面追问记忆系统与状态恢复。'));
        await prepared.commit();
      }),
    ]);

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'fe-journey.json'), 'utf8'),
    ) as { entries: Array<{ id: string }> };
    expect(catalog.entries).toHaveLength(2);
  });

  it('clusters same-author same-company question reposts even when one contains long answers', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-question-duplicate-');
    const index = await FeJourneyCandidateIndex.open(root);
    const prompts = [
      '1.为什么选择 AI 应用开发方向？',
      '2.怎么理解 Agent 系统，核心模块有哪些？',
      '3.Tool 的设计原则是什么？',
      '4.Memory 有哪些类型？',
      '5.ReAct 和 Plan-Execute 适用什么场景？',
      '6.多 Agent 协作系统怎么设计？',
      '7.RAG 整体流程是什么？',
      '8.Chunk 大小如何确定？',
      '9.Rerank 怎么实现？',
      '10.大模型异常时如何重试和降级？',
    ];
    const base = {
      author: '同一位候选人',
      publishedAt: '2026-08-10T09:22:00.000Z',
      sourceMetadata: { contentAccess: 'full' },
    };
    const first = index.prepare({
      ...nowcoderDocument('5001', `我参加了字节 AI 应用开发一面。${prompts.join('')}`),
      ...base,
      title: '字节 AI 应用开发一面面经',
    });
    await first.commit();
    const expanded = index.prepare({
      ...nowcoderDocument(
        '5002',
        `我参加了字节大模型应用开发一面。${prompts.map((prompt, index) =>
          `${prompt}这里是第${index + 1}题很长的项目回答、代码和追问复盘。`).join('')}`,
      ),
      ...base,
      title: '字节大模型应用开发一面深度复盘',
    });

    expect(expanded.document.feJourney?.clusterId).toBe(first.document.feJourney?.clusterId);
    expect(expanded.document.feJourney?.duplicateOf).toBe(
      stableContentId('https://www.nowcoder.com/discuss/5001'),
    );
  });

  it('does not enrich or index WeChat and ZSXQ documents', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-');
    const index = await FeJourneyCandidateIndex.open(root);
    const url = 'https://wx.zsxq.com/group/1/topic/511111111111111';
    const document: CollectedDocument = {
      schemaVersion: 1,
      source: 'zsxq',
      kind: 'post',
      url,
      canonicalUrl: url,
      title: '知识星球原有帖子',
      collectedAt: '2026-08-19T00:00:00.000Z',
      html: '<p>原有采集内容。</p>',
      text: '原有采集内容。',
      images: [],
    };

    const prepared = index.prepare(document);
    expect(prepared.document).toBe(document);
    expect(prepared.document.feJourney).toBeUndefined();
    await prepared.commit();

    expect(existsSync(join(root, '_catalog', 'fe-journey.json'))).toBe(false);
  });

  it('keeps existing sources writable when the optional candidate index is unavailable', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-unavailable-');
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const url = 'https://wx.zsxq.com/group/1/topic/522222222222222';
    const document: CollectedDocument = {
      schemaVersion: 1,
      source: 'zsxq',
      kind: 'post',
      url,
      canonicalUrl: url,
      title: '候选索引损坏时的知识星球帖子',
      collectedAt: '2026-08-20T00:00:00.000Z',
      html: '<p>原有知识星球采集链路继续可用。</p>',
      text: '原有知识星球采集链路继续可用。',
      images: [],
    };

    const results = await saveCollectedDocument(router, undefined, document);

    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true })]));
    expect(await listLibrary(root)).toHaveLength(1);
    expect(existsSync(join(root, '_catalog', 'fe-journey.json'))).toBe(false);
  });

  it('clusters duplicate candidates that are saved concurrently', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-concurrent-');
    const index = await FeJourneyCandidateIndex.open(root);
    const router = SinkRouter.build(undefined, { libraryRoot: root });
    const text = '一面面试官追问 RAG 文档切分、向量召回、重排以及答案评测的实现原理。';

    await Promise.all([
      saveCollectedDocument(router, index, nowcoderDocument('2001', text)),
      saveCollectedDocument(router, index, nowcoderDocument('2002', text)),
    ]);

    const documents = await Promise.all((await listLibrary(root)).map(async entry => {
      const sourcePath = join(root, entry.relativePath.replace(/index\.md$/, 'source.json'));
      return (JSON.parse(await readFile(sourcePath, 'utf8')) as { document: CollectedDocument }).document;
    }));
    expect(documents).toHaveLength(2);
    expect(new Set(documents.map(document => document.feJourney?.clusterId)).size).toBe(1);
    expect(documents.filter(document => document.feJourney?.duplicateOf)).toHaveLength(1);
  });

  it('keeps the existing cluster identity when the same URL is collected again', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-recapture-');
    const index = await FeJourneyCandidateIndex.open(root);
    const representativeUrl = 'https://www.nowcoder.com/discuss/3001';
    const representativeId = stableContentId(representativeUrl);
    const originalText = '一面重点追问 Agent 规划、工具调用、上下文压缩与长期记忆。';
    const first = index.prepare(nowcoderDocument('3001', originalText));
    await first.commit();
    const originalClusterId = first.document.feJourney?.clusterId;

    const duplicate = index.prepare(nowcoderDocument('3002', originalText));
    expect(duplicate.document.feJourney?.duplicateOf).toBe(representativeId);
    await duplicate.commit();

    const recapturedRepresentative = index.prepare(nowcoderDocument(
      '3001',
      '帖子后来补充了浏览器渲染、CSS 合成层与动画性能等完全不同的长篇内容。',
    ));
    expect(recapturedRepresentative.document.feJourney?.clusterId).toBe(originalClusterId);
    expect(recapturedRepresentative.document.feJourney?.duplicateOf).toBeUndefined();
    await recapturedRepresentative.commit();

    const recapturedDuplicate = index.prepare(nowcoderDocument(
      '3002',
      '帖子后来改成了数据库索引、事务隔离与分布式锁等完全不同的长篇内容。',
    ));
    expect(recapturedDuplicate.document.feJourney?.clusterId).toBe(originalClusterId);
    expect(recapturedDuplicate.document.feJourney?.duplicateOf).toBe(representativeId);
    await recapturedDuplicate.commit();

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'fe-journey.json'), 'utf8'),
    ) as { entries: Array<{ clusterId: string; representativeId: string }> };
    expect(catalog.entries).toHaveLength(2);
    expect(new Set(catalog.entries.map(entry => entry.clusterId))).toEqual(new Set([originalClusterId]));
    expect(new Set(catalog.entries.map(entry => entry.representativeId))).toEqual(new Set([representativeId]));
  });

  it('removes deleted library ids from the persisted candidate catalog', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-remove-');
    const index = await FeJourneyCandidateIndex.open(root);
    const first = index.prepare(nowcoderDocument('6001', '字节一面追问 Agent Loop、工具调用和 RAG 评测。'));
    const second = index.prepare(nowcoderDocument('6002', '腾讯一面追问浏览器渲染、网络缓存和性能优化。'));
    await first.commit();
    await second.commit();

    await index.remove([stableContentId('https://www.nowcoder.com/discuss/6001')]);

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'fe-journey.json'), 'utf8'),
    ) as { entries: Array<{ id: string }> };
    expect(catalog.entries.map(entry => entry.id)).toEqual([
      stableContentId('https://www.nowcoder.com/discuss/6002'),
    ]);
  });
});
