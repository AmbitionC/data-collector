import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableContentId, type CollectedDocument } from '@data-collector/shared';
import {
  FeJourneyCandidateIndex,
  saveCollectedDocument,
} from '../../packages/bridge/src/feJourney/index.js';
import { listLibrary } from '../../packages/bridge/src/library/index.js';
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
  it('groups exact and near duplicates while preserving a separate unrelated cluster', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-');
    const index = await FeJourneyCandidateIndex.open(root);
    const originalText = '一面面试官追问 RAG 文档切分、向量召回、重排以及答案评测的实现原理。';
    const first = index.prepare(nowcoderDocument('1001', originalText));
    await first.commit();

    const exact = index.prepare(nowcoderDocument('1002', ` ${originalText} `));
    expect(exact.document.feJourney?.clusterId).toBe(first.document.feJourney?.clusterId);
    expect(exact.document.feJourney?.duplicateOf).toBe(
      stableContentId('https://www.nowcoder.com/discuss/1001'),
    );
    await exact.commit();

    const near = index.prepare(nowcoderDocument(
      '1003',
      '一面面试官继续追问 RAG 文档切分、向量召回、结果重排以及答案评测的实现原理。',
    ));
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
});
