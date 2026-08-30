import { describe, expect, it } from 'vitest';
import {
  collectionBatchSchema,
  jobCancelPayloadSchema,
  jobCollectPayloadSchema,
  mergeZsxqDocumentCopies,
  planCollectEnvelopeSchema,
  planStartedEnvelopeSchema,
  planResultEnvelopeSchema,
  unionZsxqViewDocuments,
} from '@data-collector/shared';

const BATCH = {
  id: 'batch-20260823-nowcoder-agent-market',
  planId: 'nowcoder-agent-market',
  status: 'completed_with_attention',
  startedAt: '2026-08-23T01:00:00.000Z',
  finishedAt: '2026-08-23T01:03:00.000Z',
  discovered: 16,
  accepted: 10,
  saved: 8,
  skipped: 1,
  failed: 0,
  needsAttention: 1,
  deliveryIds: ['a1b2c3d4e5f6', '0123456789ab'],
  coverage: { bytedance: 3, tencent: 3, alibaba: 2, ant: 0 },
} as const;

describe('fixed collection plan contracts', () => {
  it('unions the same ZSXQ topic across views with a deterministic primitive label field', () => {
    const topic = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url: 'https://wx.zsxq.com/group/48844584441158/topic/611111111111111',
      canonicalUrl: 'https://wx.zsxq.com/group/48844584441158/topic/611111111111111',
      title: '投资创业观察',
      collectedAt: '2026-08-23T00:00:00.000Z',
      html: '<p>正文</p>',
      text: '正文',
      images: [],
    };
    const merged = unionZsxqViewDocuments([
      { label: '最新', documents: [topic] },
      { label: '精华', documents: [{ ...topic, title: '更新后的投资创业观察' }] },
      { label: '只看星主', documents: [topic] },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      title: '投资创业观察',
      sourceMetadata: { viewLabels: '最新、精华、只看星主' },
    });
  });

  it('keeps the linked-article and image resource superset when equal-text views differ only in HTML', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111112';
    const text = '这是一段相同的长文导语，正文位于链接文章中。';
    const firstImage = 'https://images.example/first-view.png';
    const secondImage = 'https://images.example/second-view.png';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '跨视图长文入口',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      truncated: false,
    };

    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: `<p>${text}</p><img src="${firstImage}" alt="首图">`,
          images: [{ url: firstImage, alt: '首图' }],
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          html: `<p>${text}</p>`
            + '<a href="HTTPS://ARTICLES.ZSXQ.COM/id_assetunion.html?utm_source=feed#tail">阅读全文</a>'
            + `<img src="${firstImage}" alt="首图">`
            + `<img src="${secondImage}" alt="次图">`,
          images: [
            { url: firstImage, alt: '首图' },
            { url: secondImage, alt: '次图' },
          ],
        }],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.html).toContain('href="https://articles.zsxq.com/id_assetunion.html"');
    expect(merged[0]?.html).toContain(firstImage);
    expect(merged[0]?.html).toContain(secondImage);
    expect(merged[0]?.images).toEqual(expect.arrayContaining([
      { url: firstImage, alt: '首图' },
      { url: secondImage, alt: '次图' },
    ]));
    expect(merged[0]?.truncated).toBe(false);
  });

  it('keeps the ordinary attachment and media resource superset across stable copies', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111121';
    const text = '两帧正文完全相同，后一帧才挂载完整附件与音视频资源。';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '稳定帧资源补齐',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };
    const result = mergeZsxqDocumentCopies(
      { ...base, html: `<p>${text}</p>` },
      {
        ...base,
        html: `<p>${text}</p>`
          + '<a href="https://files.zsxq.com/report.pdf#download">报告附件</a>'
          + '<video src="/media/lesson.mp4"></video>'
          + '<audio src="https://media.zsxq.com/lesson.mp3"></audio>'
          + '<source src="https://media.zsxq.com/lesson-hd.mp4">',
      },
    );

    expect(result.conflict).toBeUndefined();
    expect(result.document.truncated).toBe(false);
    expect(result.document.html).toContain('https://files.zsxq.com/report.pdf#download');
    expect(result.document.html).toContain('/media/lesson.mp4');
    expect(result.document.html).toContain('https://media.zsxq.com/lesson.mp3');
    expect(result.document.html).toContain('https://media.zsxq.com/lesson-hd.mp4');
  });

  it('keeps poster, srcset, track, embed, iframe, and object resources from a strict superset', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111125';
    const text = '正文相同，响应式图片和嵌入资源在后一稳定帧才完整出现。';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '嵌入资源补齐',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };
    const richerHtml = `<p>${text}</p>`
      + '<video poster="https://media.zsxq.com/poster.jpg">'
      + '<track src="https://media.zsxq.com/subtitles.vtt"></video>'
      + '<img srcset="https://images.zsxq.com/normal.jpg 1x, '
      + 'https://images.zsxq.com/retina.jpg 2x">'
      + '<source srcset="https://media.zsxq.com/medium.mp4 720w, '
      + 'https://media.zsxq.com/high.mp4 1080w">'
      + '<iframe src="https://player.zsxq.com/embed/lesson"></iframe>'
      + '<embed src="https://media.zsxq.com/slides.pdf">'
      + '<object data="https://files.zsxq.com/workbook.pdf"></object>';

    const result = mergeZsxqDocumentCopies(
      { ...base, html: `<p>${text}</p>` },
      { ...base, html: richerHtml },
    );

    expect(result.conflict).toBeUndefined();
    expect(result.document.truncated).toBe(false);
    expect(result.document.html).toBe(richerHtml);
  });

  it('treats img data-src as authoritative over its placeholder src when comparing resources', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111128';
    const text = '同一张懒加载图片不能把占位 src 误算成另一份正文资源。';
    const placeholder = 'https://images.zsxq.com/placeholder.png';
    const image = 'https://images.zsxq.com/actual.png';
    const attachment = 'https://files.zsxq.com/actual-image-note.pdf';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '懒加载图片资源身份',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };
    const result = mergeZsxqDocumentCopies(
      {
        ...base,
        html: `<p>${text}</p><img src="${placeholder}" data-src="${image}">`,
      },
      {
        ...base,
        html: `<p>${text}</p><img src="${image}"><a href="${attachment}">附件</a>`,
      },
    );

    expect(result.conflict).toBeUndefined();
    expect(result.document.truncated).toBe(false);
    expect(result.document.html).toContain(attachment);
  });

  it('keeps a later ordinary attachment when equal-text copies are unioned across views', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111122';
    const text = '列表正文已经稳定，附件链接在另一个视图中才完整挂载。';
    const attachment = 'https://files.zsxq.com/portfolio.xlsx';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '跨视图附件补齐',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };

    const merged = unionZsxqViewDocuments([
      { label: '最新', documents: [{ ...base, html: `<p>${text}</p>` }] },
      {
        label: '精华',
        documents: [{
          ...base,
          html: `<p>${text}</p><a href="${attachment}">下载附件</a>`,
        }],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.html).toContain(attachment);
    expect(merged[0]?.truncated).toBe(false);
  });

  it('keeps longer compatible body text and resources carried only by its shorter prefix copy', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111126';
    const prefix = '这是两帧都能看到的正文开头。';
    const fullText = `${prefix}这是后一段完整正文与最终结论。`;
    const attachment = 'https://files.zsxq.com/prefix-only.pdf';
    const video = 'https://media.zsxq.com/prefix-only.mp4';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '正文与资源优势交叉',
      collectedAt: '2026-08-25T00:00:00.000Z',
      images: [],
      truncated: false,
    };
    const result = mergeZsxqDocumentCopies(
      { ...base, html: `<p>${fullText}</p>`, text: fullText },
      {
        ...base,
        html: `<p>${prefix}</p><a href="${attachment}">附件</a>`
          + `<video src="${video}"></video>`,
        text: prefix,
      },
    );

    expect(result.conflict).toBeUndefined();
    expect(result.document.truncated).toBe(false);
    expect(result.document.text).toBe(fullText);
    expect(result.document.html).toContain(attachment);
    expect(result.document.html).toContain(video);
  });

  it('fails closed without unioning non-containing resource sets from equal-text copies', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111123';
    const text = '正文相同，但两帧分别绑定互不相容的上一帖资源。';
    const staleAttachment = 'https://files.zsxq.com/stale-a.pdf';
    const currentVideo = 'https://media.zsxq.com/current-b.mp4';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '互斥资源拒绝合并',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };
    const result = mergeZsxqDocumentCopies(
      {
        ...base,
        html: `<p>${text}</p><a href="${staleAttachment}">附件 A</a>`,
      },
      {
        ...base,
        html: `<p>${text}</p><video src="${currentVideo}"></video>`,
      },
    );

    expect(result.conflict).toBe('body');
    expect(result.document.truncated).toBe(true);
    expect(result.document.html).toContain(staleAttachment);
    expect(result.document.html).not.toContain(currentVideo);
  });

  it('does not carry assets from an unknown observation into a later source-proven complete copy', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111119';
    const text = '当前帖子 B 的正文已经由精确来源完整证明。';
    const staleImage = 'https://images.zsxq.com/Fj_stale_A.jpg';
    const staleArticle = 'https://articles.zsxq.com/id_staleA.html';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '虚拟列表资源绑定',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
    };
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: `<p>${text}</p><a href="${staleArticle}">全文</a><img src="${staleImage}">`,
          images: [{ url: staleImage }],
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          html: `<p>${text}</p>`,
          images: [],
          truncated: false,
          sourceMetadata: {
            topicId: '611111111111119',
            sourceBodyProven: true,
            sourceMediaProven: true,
            sourceCoversDom: true,
          },
        }],
      },
    ]);

    expect(merged[0]?.truncated).toBe(false);
    expect(merged[0]?.html).not.toContain(staleArticle);
    expect(merged[0]?.html).not.toContain(staleImage);
    expect(merged[0]?.images).toEqual([]);
  });

  it('does not replace an authoritative empty resource set with a later unknown superset', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111124';
    const text = '来源已经证明本帖没有资源，后到的未知副本不能补入上一帖附件。';
    const staleAttachment = 'https://files.zsxq.com/stale-late.pdf';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '来源资源权威顺序',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };
    const result = mergeZsxqDocumentCopies(
      {
        ...base,
        html: `<p>${text}</p>`,
        sourceMetadata: {
          topicId: '611111111111124',
          sourceBodyProven: true,
          sourceMediaProven: true,
          sourceCoversDom: true,
        },
      },
      {
        ...base,
        html: `<p>${text}</p><a href="${staleAttachment}">上一帖附件</a>`,
      },
    );

    expect(result.conflict).toBeUndefined();
    expect(result.document.truncated).toBe(false);
    expect(result.document.html).not.toContain(staleAttachment);
  });

  it('lets authoritative non-empty resources replace a mutually exclusive unknown stale set', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111127';
    const text = '正文相同，来源媒体证明必须覆盖未知帧粘住的上一帖资源。';
    const staleAttachment = 'https://files.zsxq.com/stale-exclusive.pdf';
    const authoritativeVideo = 'https://media.zsxq.com/authoritative.mp4';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '权威资源覆盖互斥旧帧',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };
    const result = mergeZsxqDocumentCopies(
      {
        ...base,
        html: `<p>${text}</p><a href="${staleAttachment}">上一帖附件</a>`,
      },
      {
        ...base,
        html: `<p>${text}</p><video src="${authoritativeVideo}"></video>`,
        sourceMetadata: {
          topicId: '611111111111127',
          sourceBodyProven: true,
          sourceMediaProven: true,
          sourceCoversDom: true,
        },
      },
    );

    expect(result.conflict).toBeUndefined();
    expect(result.document.truncated).toBe(false);
    expect(result.document.html).toContain(authoritativeVideo);
    expect(result.document.html).not.toContain(staleAttachment);
  });

  it('selects authoritative empty source assets over equal-text positively-tainted stale assets', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111120';
    const text = '帖子 B 的正文相同，但旧列表帧仍带着帖子 A 的资源。';
    const staleImage = 'https://images.zsxq.com/Fj_stale_A2.jpg';
    const staleArticle = 'https://articles.zsxq.com/id_staleA2.html';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '详情资源权威覆盖',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
    };
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: `<p>${text}</p><a href="${staleArticle}">全文</a><img src="${staleImage}">`,
          images: [{ url: staleImage }],
          truncated: true,
          sourceMetadata: { sourceMediaProven: false },
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          html: `<p>${text}</p>`,
          images: [],
          truncated: false,
          sourceMetadata: {
            topicId: '611111111111120',
            sourceBodyProven: true,
            sourceMediaProven: true,
            sourceCoversDom: true,
          },
        }],
      },
    ]);

    expect(merged[0]?.truncated).toBe(true);
    expect(merged[0]?.html).not.toContain(staleArticle);
    expect(merged[0]?.html).not.toContain(staleImage);
    expect(merged[0]?.images).toEqual([]);
  });

  it('fails closed when equal-text views point at non-containing linked-article URL sets', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/611111111111113';
    const text = '两份观察正文相同，但指向了不同的链接长文。';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '冲突长文入口',
      collectedAt: '2026-08-25T00:00:00.000Z',
      text,
      images: [],
      truncated: false,
    };

    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: `<p>${text}</p><a href="https://articles.zsxq.com/id_conflicta.html">全文</a>`,
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          html: `<p>${text}</p><a href="https://articles.zsxq.com/id_conflictb.html">全文</a>`,
        }],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.truncated).toBe(true);
  });

  it('keeps the richer copy but preserves earlier positive truncation evidence', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/622222222222222';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      collectedAt: '2026-08-24T00:00:00.000Z',
      images: [],
    };
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          title: '折叠版本',
          html: '<p>只有开头</p><p>展开全部</p>',
          text: '只有开头\n展开全部',
          truncated: true,
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          title: '完整版本',
          html: '<p>这里是完整正文和结论。</p>',
          text: '这里是完整正文和结论。',
          truncated: false,
        }],
      },
      { label: '只看星主', documents: [] },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      title: '完整版本',
      text: '这里是完整正文和结论。',
      sourceMetadata: { viewLabels: '最新、精华' },
    });
    expect(merged[0]?.truncated).toBe(true);
  });

  it('does not let a shorter unknown copy erase an explicitly truncated cross-view copy', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/622222222222223';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '投资复盘',
      collectedAt: '2026-08-24T00:00:00.000Z',
      images: [],
    };
    const truncatedText = '明确被折叠的长正文。'.repeat(50);
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: `<p>${truncatedText}</p>`,
          text: truncatedText,
          truncated: true,
        }],
      },
      {
        label: '精华',
        documents: [{ ...base, html: '<p>只有很短的未知版本</p>', text: '只有很短的未知版本' }],
      },
    ]);

    expect(merged[0]?.text).toBe(truncatedText);
    expect(merged[0]?.truncated).toBe(true);
  });

  it('does not let a shorter no-control copy erase an explicitly truncated cross-view copy', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/622222222222224';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '超长经营复盘',
      collectedAt: '2026-08-24T00:00:00.000Z',
      images: [],
    };
    const truncatedText = 'A'.repeat(20_000);
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: `<p>${truncatedText}</p>`,
          text: truncatedText,
          truncated: true,
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          html: `<p>${'A'.repeat(1_000)}</p>`,
          text: 'A'.repeat(1_000),
          truncated: false,
        }],
      },
    ]);

    expect(merged[0]?.text).toBe(truncatedText);
    expect(merged[0]?.truncated).toBe(true);
  });

  it('does not let a one-character-longer no-control copy erase positive truncation evidence', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/622222222222225';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '超长经营复盘',
      collectedAt: '2026-08-24T00:00:00.000Z',
      images: [],
    };
    const confirmedTruncated = 'A'.repeat(20_000);
    const apparentlyLonger = 'B'.repeat(20_001);
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: `<p>${confirmedTruncated}</p>`,
          text: confirmedTruncated,
          truncated: true,
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          html: `<p>${apparentlyLonger}</p>`,
          text: apparentlyLonger,
          truncated: false,
        }],
      },
    ]);

    expect(merged[0]?.text).toBe(apparentlyLonger);
    expect(merged[0]?.truncated).toBe(true);
  });

  it('keeps the longer copy when duplicate ZSXQ views omit truncation markers', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/633333333333333';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '投资复盘',
      collectedAt: '2026-08-24T00:00:00.000Z',
      images: [],
    };
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{ ...base, html: '<p>只有开头</p>', text: '只有开头' }],
      },
      {
        label: '只看星主',
        documents: [{
          ...base,
          html: '<p>这里是更长且完整的投资复盘正文和最终结论。</p>',
          text: '这里是更长且完整的投资复盘正文和最终结论。',
        }],
      },
    ]);

    expect(merged[0]).toMatchObject({
      text: '这里是更长且完整的投资复盘正文和最终结论。',
      sourceMetadata: { viewLabels: '最新、只看星主' },
    });
  });

  it('marks incompatible bodies for one canonical topic as incomplete instead of picking one', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/633333333333334';
    const base = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url,
      canonicalUrl: url,
      title: '同一帖子身份冲突',
      collectedAt: '2026-08-24T00:00:00.000Z',
      images: [],
      truncated: false,
    };
    const merged = unionZsxqViewDocuments([
      {
        label: '最新',
        documents: [{
          ...base,
          html: '<p>甲版本讨论投资和经营复盘。</p>',
          text: '甲版本讨论投资和经营复盘。'.repeat(8),
        }],
      },
      {
        label: '精华',
        documents: [{
          ...base,
          html: '<p>乙版本是完全无关的职场建议。</p>',
          text: '乙版本是完全无关的职场建议。'.repeat(8),
        }],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.truncated).toBe(true);
  });

  it('accepts an honest terminal batch with zero company coverage', () => {
    expect(collectionBatchSchema.parse(BATCH)).toEqual(BATCH);
  });

  it('accepts persisted ZSXQ preparation phases and legacy batches without the field', () => {
    const zsxq = {
      id: 'batch-20260825-zsxq',
      planId: 'zsxq-chen-teacher',
      status: 'running',
      startedAt: '2026-08-25T00:00:00.000Z',
      discovered: 1,
      accepted: 1,
      saved: 0,
      skipped: 0,
      failed: 0,
      needsAttention: 0,
      deliveryIds: [],
    } as const;

    expect(collectionBatchSchema.parse({
      ...zsxq,
      preparationStatus: 'collecting',
    }).preparationStatus).toBe('collecting');
    expect(collectionBatchSchema.parse({
      ...zsxq,
      preparationStatus: 'completed',
      preparationAttempt: 'a1b2c3d4e5f60718',
      force: true,
    }).preparationStatus).toBe('completed');
    expect(collectionBatchSchema.parse(zsxq).preparationStatus).toBeUndefined();
  });

  it('rejects unknown plan ids and inconsistent terminal timestamps', () => {
    expect(collectionBatchSchema.safeParse({ ...BATCH, planId: 'custom-plan' }).success).toBe(false);
    expect(collectionBatchSchema.safeParse({ ...BATCH, status: 'running' }).success).toBe(false);
  });

  it('validates plan.collect and plan.result websocket envelopes', () => {
    const base = {
      protocolVersion: 1,
      requestId: 'request-1',
      timestamp: '2026-08-23T01:00:00.000Z',
    } as const;
    expect(planCollectEnvelopeSchema.parse({
      ...base,
      type: 'plan.collect',
      payload: {
        planId: 'zsxq-chen-teacher',
        batchId: 'batch-zsxq-1',
        attempt: 'a1b2c3d4e5f60718',
        force: true,
      },
    }).payload.force).toBe(true);
    expect(planResultEnvelopeSchema.parse({
      ...base,
      type: 'plan.result',
      payload: { batch: BATCH },
    }).payload.batch.saved).toBe(8);
    expect(planResultEnvelopeSchema.parse({
      ...base,
      type: 'plan.result',
      payload: {
        batchId: 'batch-zsxq-1',
        attempt: 'a1b2c3d4e5f60718',
        discovered: 17,
        rejectionDetails: [{
          url: 'https://wx.zsxq.com/group/48844584441158/topic/611111111111111',
          reason: '正文不完整',
        }],
      },
    }).payload).toMatchObject({
      batchId: 'batch-zsxq-1',
      attempt: 'a1b2c3d4e5f60718',
      discovered: 17,
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/611111111111111',
        reason: '正文不完整',
      }],
    });
    expect(planCollectEnvelopeSchema.safeParse({
      ...base,
      type: 'plan.collect',
      payload: { planId: 'arbitrary-user-plan' },
    }).success).toBe(false);
    expect(planCollectEnvelopeSchema.safeParse({
      ...base,
      type: 'plan.collect',
      payload: { planId: 'zsxq-chen-teacher', batchId: 'batch-zsxq-1' },
    }).success).toBe(false);
    expect(planStartedEnvelopeSchema.parse({
      ...base,
      type: 'plan.started',
      payload: {
        planId: 'zsxq-chen-teacher',
        batchId: 'batch-zsxq-1',
        attempt: 'a1b2c3d4e5f60718',
      },
    }).payload.attempt).toBe('a1b2c3d4e5f60718');
  });

  it('preserves owner-history mode and typed audit facts in a persisted batch', () => {
    const parsed = collectionBatchSchema.parse({
      id: 'batch-20260829-zsxq-owner-history',
      planId: 'zsxq-chen-teacher',
      status: 'completed',
      startedAt: '2026-08-29T00:00:00.000Z',
      finishedAt: '2026-08-29T00:30:00.000Z',
      discovered: 60,
      accepted: 3,
      saved: 3,
      skipped: 57,
      failed: 0,
      needsAttention: 0,
      deliveryIds: ['0123456789ab'],
      zsxqMode: 'owner-history',
      ownerAudit: {
        mode: 'owner-history',
        pagesFetched: 3,
        observed: 60,
        qualifying: 44,
        exactDuplicates: 40,
        semanticDuplicates: 1,
        filtered: 16,
        knownComplete: 40,
        repaired: 0,
        saved: 3,
        failed: 0,
        newestObservedAt: '2026-08-28T01:00:00.000Z',
        oldestObservedAt: '2021-01-01T01:00:00.000Z',
        exhausted: true,
        safetyCapReached: false,
        completedDays: 400,
        emptyDays: 1600,
        failedDays: 0,
      },
    });

    expect(parsed).toMatchObject({
      zsxqMode: 'owner-history',
      ownerAudit: {
        observed: 60,
        qualifying: 44,
        exhausted: true,
      },
    });
  });

  it('accepts resumable owner page facts in plan collect and result envelopes', () => {
    const base = {
      protocolVersion: 1,
      requestId: 'request-owner-history',
      timestamp: '2026-08-29T00:00:00.000Z',
    } as const;
    const collect = planCollectEnvelopeSchema.parse({
      ...base,
      type: 'plan.collect',
      payload: {
        planId: 'zsxq-chen-teacher',
        batchId: 'batch-owner-history',
        attempt: 'a1b2c3d4e5f60718',
        zsxqMode: 'owner-history',
        targetDays: ['2026-08-28', '2026-08-27'],
        resumeCursor: '2026-08-20T00:00:00.000Z',
      },
    });
    expect(collect.payload).toMatchObject({
      zsxqMode: 'owner-history',
      targetDays: ['2026-08-28', '2026-08-27'],
      resumeCursor: '2026-08-20T00:00:00.000Z',
    });

    const result = planResultEnvelopeSchema.parse({
      ...base,
      type: 'plan.result',
      payload: {
        batchId: 'batch-owner-history',
        attempt: 'a1b2c3d4e5f60718',
        discovered: 20,
        prepared: false,
        checkpoint: {
          mode: 'owner-history',
          cursor: '2026-08-20T00:00:00.000Z',
          pagesFetched: 1,
          newestObservedAt: '2026-08-28T01:00:00.000Z',
          oldestObservedAt: '2026-08-20T00:00:00.001Z',
          exhausted: false,
        },
        dayDrafts: [{
          day: '2026-08-28',
          rawOwnerCount: 2,
          qualifyingCount: 1,
          filteredCount: 1,
          exactDuplicateCount: 1,
          semanticDuplicateCount: 0,
          knownCompleteCount: 1,
          repairCount: 0,
          candidateCount: 0,
          savedCount: 0,
          failedCount: 0,
          crossedDayBoundary: true,
        }],
      },
    });
    expect(result.payload).toMatchObject({
      checkpoint: { pagesFetched: 1, exhausted: false },
      dayDrafts: [{ day: '2026-08-28', qualifyingCount: 1 }],
    });
  });

  it('defaults old direct collection commands to interactive and accepts explicit plan isolation', () => {
    expect(jobCollectPayloadSchema.parse({ url: 'https://mp.weixin.qq.com/s/x' })).toEqual({
      url: 'https://mp.weixin.qq.com/s/x',
      interactive: true,
    });
    expect(jobCollectPayloadSchema.parse({
      url: 'https://www.nowcoder.com/discuss/1',
      interactive: false,
    }).interactive).toBe(false);
    expect(jobCollectPayloadSchema.parse({
      url: 'https://www.nowcoder.com/discuss/2',
      interactive: false,
      directedRunId: 'directed-1',
      directedRunAttempt: '0123456789abcdef',
    }).interactive).toBe(false);
    expect(() => jobCollectPayloadSchema.parse({
      url: 'https://www.nowcoder.com/discuss/2',
      interactive: true,
      directedRunId: 'directed-1',
      directedRunAttempt: '0123456789abcdef',
    })).toThrow('牛客定向任务必须以非交互模式采集');
  });

  it('fences directed cancellation with the current directed run attempt', () => {
    expect(jobCancelPayloadSchema.parse({
      directedRunId: 'directed-1',
      directedRunAttempt: '0123456789abcdef',
    })).toEqual({ directedRunId: 'directed-1', directedRunAttempt: '0123456789abcdef' });
  });
});
