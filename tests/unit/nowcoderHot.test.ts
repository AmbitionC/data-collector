import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import * as extractor from '../../packages/extension/src/extractors/nowcoder.js';
import { collectedDocumentSchema, renderHotMaterial, type CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { MarkdownLibrary } from '../../packages/bridge/src/library/writer.js';
import { listLibrary, readEntry } from '../../packages/bridge/src/library/manage.js';
import { syncEntries, pendingIds } from '../../packages/bridge/src/library/sync.js';
import { rebuildFeJourneyCandidateIndex } from '../../packages/bridge/src/feJourney/rebuildIndex.js';
import { saveCollectedDocument } from '../../packages/bridge/src/feJourney/save.js';
import { SinkRouter } from '../../packages/bridge/src/sinks/router.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const now = () => '2026-10-10T12:00:00.000Z';
const url = 'https://www.nowcoder.com/discuss/123456';
const temporary = createTemporaryDirectoryTracker();
afterEach(() => temporary.cleanup());

function extract(html: string): CollectedDocument[] {
  const fn = (extractor as unknown as Record<string, unknown>).extractNowcoderHotList;
  expect(typeof fn, 'current visible list extractor exists').toBe('function');
  return (fn as (document: Document, url: URL, now: () => string) => { documents: CollectedDocument[] })(
    new JSDOM(html).window.document, new URL('https://www.nowcoder.com/'), now,
  ).documents;
}

function hot(): CollectedDocument {
  const document = {
    schemaVersion: 1, source: 'nowcoder', kind: 'post', url, canonicalUrl: url,
    title: '没有面邀怎么办', collectedAt: now(), html: '<p>发帖人说没有面邀</p>',
    text: '发帖人说没有面邀', images: [], userCategory: '面经',
    operationMaterial: {
      schemaVersion: 1, purpose: 'nowcoder-hot', visibility: 'private', verificationStatus: 'unverified',
      observation: { listUrl: 'https://www.nowcoder.com/', listTitle: '牛客', publishedAtText: null,
        metrics: { heat: null, likes: null, comments: null, views: null }, observedAt: now() },
      evidence: { excerpt: '发帖人说没有面邀', attribution: 'source-quote' },
      editorial: { emotionTags: [], inspirationNote: '' },
      screenshotPolicy: 'redact-before-public-use',
    },
  } as CollectedDocument;
  document.html = renderHotMaterial(document.operationMaterial!);
  return document;
}

describe('Nowcoder private hot material', () => {
  it('reads only visible real post links, bounds excerpts and keeps unknown metrics null', () => {
    const docs = extract(`<title>讨论</title><article><a href="/discuss/123456?sourceSSR=home">焦虑：没有面邀</a><time>10-09 12:00</time><p class="feed-text">${'短摘'.repeat(250)}</p></article>
      <article hidden><a href="/discuss/888">隐藏帖子</a></article><a href="https://evil.test/discuss/999">外站</a>
      <article><a href="/discuss/123456">重复标题</a></article>`);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.canonicalUrl).toBe(url);
    expect(docs[0]?.author).toBeUndefined();
    expect(docs[0]?.images).toEqual([]);
    expect(docs[0]?.publishedAt).toBeUndefined();
    const material = (docs[0] as any).operationMaterial;
    expect(material.observation.publishedAtText).toBe('10-09 12:00');
    expect(material.observation.metrics).toEqual({ heat: null, likes: null, comments: null, views: null });
    expect(material.evidence.excerpt.length).toBeLessThanOrEqual(180);
    expect(material.editorial.emotionTags).toEqual([]);
  });

  it('adapts current hotList and feed icon markup without claiming global rank', () => {
    const docs = extract(`<div class="hotList"><h2>全站热榜</h2><ul><li><a href="/feed/main/detail/abcdef"><div class="number-pic">1</div><span class="vue-ellipsis-js-content">我不想卷了</span><span class="vue-ellipsis-placeholder-content">我不想卷了</span><div class="tw-text-right">1.1W</div><span aria-label="Redu0001"></span></a></li></ul></div>
      <div class="tw-px-5 tw-relative tw-pb-5 tw-pt-5"><a href="/discuss/123456">找工作困惑</a><div class="show-time">2026-10-09 12:30</div><a class="feed-text" href="/discuss/123456">这是发帖人的自述</a><span class="feed-interaction-data"><span aria-label="Dianzan"></span>7</span><span class="feed-interaction-data"><span aria-label="Pinglun"></span>4</span></div>`);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toBe('我不想卷了');
    expect((docs[0] as any).operationMaterial.observation.metrics.heat).toBe('1.1W');
    expect(docs[0]?.sourceMetadata?.rank).toBeUndefined();
    expect((docs[1] as any).operationMaterial.observation.metrics.likes).toBe('7');
    expect((docs[1] as any).operationMaterial.observation.metrics.comments).toBe('4');
    expect(docs[1]?.publishedAt).toBe('2026-10-09T04:30:00.000Z');
  });

  it('survives renamed semantic cards and an empty list', () => {
    expect(extract('<main>正在加载</main>')).toEqual([]);
    const docs = extract('<main><section><h3><a href="/discuss/654321">改版后的真实标题</a></h3></section></main>');
    expect(docs[0]?.title).toBe('改版后的真实标题');
  });

  it('never assigns another card title, date or quote after class names change', () => {
    const docs = extract(`<section><div class="renamed"><h3><a href="/discuss/111">First title</a></h3><p>First quote</p><time>2026-10-01</time></div>
      <div class="renamed"><h3><a href="/discuss/222">Second title</a></h3><p>Second quote</p><time>2026-10-02</time></div></section>`);
    expect(docs[1]?.title).toBe('Second title');
    expect(docs[1]?.text).toBe('Second quote');
    expect(docs[1]?.operationMaterial?.observation.publishedAtText).toBe('2026-10-02');
  });

  it('keeps structured source evidence and rejects public or diagnostic labels', () => {
    expect((collectedDocumentSchema.parse(hot()) as any).operationMaterial).toBeDefined();
    const invalid = hot() as any;
    invalid.operationMaterial.editorial.emotionTags = ['抑郁症'];
    expect(collectedDocumentSchema.safeParse(invalid).success).toBe(false);
    invalid.operationMaterial.editorial.emotionTags = [];
    invalid.operationMaterial.visibility = 'public';
    expect(collectedDocumentSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects full body payloads disguised as a private short excerpt', () => {
    const input = hot();
    input.text = '全文'.repeat(2000);
    input.html = '<p>批量复制的全文</p>';
    expect(collectedDocumentSchema.safeParse(input).success).toBe(false);
  });

  it('uses the production save chain without a candidate index or public sink', async () => {
    const root = await temporary.create('hot-save-chain-');
    const router = SinkRouter.build({ sinks: { markdown: { type: 'markdown' } }, routes: {} }, { libraryRoot: root });
    const results = await saveCollectedDocument(router, undefined, hot(), ['unknown-public-sink']);
    expect(results.some(result => result.sinkId === 'markdown' && result.ok)).toBe(true);
    expect((await listLibrary(root))[0]?.materialKind).toBe('nowcoder-hot');
  });

  it('preserves an interview at the same URL, blocks every inbox sink and excludes candidate rebuild', async () => {
    const root = await temporary.create('hot-material-');
    const library = new MarkdownLibrary({ root });
    const normal = { ...hot() } as any;
    delete normal.operationMaterial;
    const interview = await library.save(organize(normal));
    const material = await library.save(organize(hot()));
    expect(material.id).not.toBe(interview.id);
    expect(organize(hot()).category).toBe('热帖素材');
    expect((await listLibrary(root)).filter((entry: any) => entry.materialKind === 'nowcoder-hot')).toHaveLength(1);
    expect((await readEntry(root, material.id))?.document?.operationMaterial).toEqual(hot().operationMaterial);
    expect(await pendingIds(root)).toEqual([interview.id]);
    let writes = 0;
    const outcome = await syncEntries(root, [material.id], () => ({ id: 'public', label: 'public', save: async () => { writes++; return {} as any; } }));
    expect(outcome.failed).toBe(1);
    expect(writes).toBe(0);
    const rebuilt = await rebuildFeJourneyCandidateIndex(root);
    expect(rebuilt.scanned).toBe(1);
  });
});
