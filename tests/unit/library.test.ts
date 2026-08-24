import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  type CollectedDocument,
} from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  MarkdownLibrary,
  pendingIds,
  safeSlug,
} from '../../packages/bridge/src/library/index.js';
import { downloadAssets, readResponseBytes } from '../../packages/bridge/src/library/assets.js';
import { atomicWriteText } from '../../packages/bridge/src/library/writer.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const URL = 'https://mp.weixin.qq.com/s/library-test';
const CURRENT_COMPLETENESS = {
  contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  contentCompletenessBuildId: 'v0.4.29 · test-build',
} as const;
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

async function temporaryDirectory(): Promise<string> {
  return temporaryDirectories.create('data-collector-library-');
}

function collected(overrides: Partial<CollectedDocument> = {}): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'wechat',
    kind: 'article',
    url: URL,
    canonicalUrl: URL,
    title: '../../危险标题',
    author: '测试公众号',
    publishedAt: '2026-07-17T12:37:00.000Z',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: [
      '<p>这是一篇用于验证知识库写入的正文。</p>',
      '<img src="https://img.example/success.png" alt="成功图">',
      '<img src="https://img.example/failure.png" alt="失败图">',
    ].join(''),
    text: '这是一篇用于验证知识库写入的正文。它讨论浏览器采集和本地知识库。',
    images: [
      { url: 'https://img.example/success.png', alt: '成功图' },
      { url: 'https://img.example/failure.png', alt: '失败图' },
    ],
    userCategory: '../个人收藏',
    userTags: ['稍后精读', '本地知识库'],
    ...overrides,
  };
}

describe('library paths', () => {
  it('creates safe readable slugs', () => {
    expect(safeSlug('../../危险 标题 / test')).toBe('危险-标题-test');
    expect(safeSlug('CON')).not.toBe('CON');
    expect(safeSlug('')).toBe('untitled');
  });
});

describe('Markdown library', () => {
  it('removes a text temp file when its final atomic rename fails', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'blocked-target');
    await mkdir(target);

    await expect(atomicWriteText(root, target, 'content')).rejects.toThrow();

    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes an asset temp file when its final atomic rename fails', async () => {
    const root = await temporaryDirectory();
    const entryDirectory = join(root, 'entry');
    const assetsDirectory = join(entryDirectory, 'assets');
    const blockedTarget = join(assetsDirectory, '0f4636c78f65d363-image.png');
    await mkdir(blockedTarget, { recursive: true });

    const result = await downloadAssets({
      html: '<img src="https://img.example/blocked.png">',
      images: [{ url: 'https://img.example/blocked.png', alt: 'image' }],
      entryDirectory,
      libraryRoot: root,
      fetch: async () => new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      }),
      resolveAddresses: async () => ['93.184.216.34'],
    });

    expect(result).toMatchObject({ downloaded: 0, failed: 1 });
    expect((await readdir(assetsDirectory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes assets and catalog atomically while preserving a stable update path', async () => {
    const root = await temporaryDirectory();
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('failure.png')) throw new Error('offline');
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    });
    const library = new MarkdownLibrary({
      root,
      fetch: fetcher,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    const first = await library.save(organize(collected()));
    const second = await library.save(
      organize(collected({ title: '改过的标题', collectedAt: '2026-07-18T01:00:00.000Z' })),
    );

    expect(first.markdownPath).toBe(second.markdownPath);
    expect(isAbsolute(first.markdownPath)).toBe(true);
    expect(relative(root, first.markdownPath)).not.toMatch(/^\.\./);
    expect(first.downloadedImages).toBe(1);
    expect(first.failedImages).toBe(1);

    const markdown = await readFile(first.markdownPath, 'utf8');
    expect(markdown).toContain('source: "wechat"');
    expect(markdown).toContain('category: "../个人收藏"');
    expect(markdown).toContain('tags:');
    expect(markdown).toContain('assets/');
    expect(markdown).toContain('https://img.example/failure.png');
    expect(markdown).toContain('改过的标题');
    expect(markdown).toContain(URL);

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as unknown[];
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).not.toHaveProperty('contentComplete');
    expect(fetcher).toHaveBeenCalled();
  });

  it('preserves unknown completeness for a legacy linked ZSXQ document', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = 'https://wx.zsxq.com/dweb2/index/topic_detail/legacy-linked-topic';

    await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '历史长文入口',
      images: [],
      sourceMetadata: { linkedArticleUrl: 'https://mp.weixin.qq.com/s/legacy-linked-article' },
    })));

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ contentComplete?: boolean }>;
    expect(catalog[0]).not.toHaveProperty('contentComplete');
  });

  it('records explicitly complete source content for future skip decisions', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });

    await library.save(organize(collected({ images: [], truncated: false })));

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ contentComplete?: boolean }>;
    expect(catalog[0]?.contentComplete).toBe(true);
  });

  it('records incomplete source content explicitly for one-time repair decisions', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });

    await library.save(organize(collected({ images: [], truncated: true })));

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ contentComplete?: boolean }>;
    expect(catalog[0]?.contentComplete).toBe(false);
  });

  it.each([
    ['shorter', '新正文'],
    ['equal-length', '另一个版本正文完全不同，包含甲段、乙段和不同结论。'],
  ])('keeps richer complete ZSXQ content when a %s complete recapture arrives', async (_, nextText) => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = 'https://wx.zsxq.com/dweb2/index/topic_detail/richer-persistence';
    const originalText = '原正文内容更加完整，包含第一段、第二段和明确结论。';
    const first = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '完整版本',
      collectedAt: '2026-08-25T01:00:00.000Z',
      html: `<p>${originalText}</p>`,
      text: originalText,
      images: [],
      truncated: false,
      sourceMetadata: CURRENT_COMPLETENESS,
    })));
    const catalogPath = join(root, '_catalog', 'index.json');
    const sourcePath = join(dirname(first.markdownPath), 'source.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<Record<string, unknown>>;
    catalog[0]!.sync = {
      state: 'synced',
      target: 'life-teachers',
      at: '2026-08-25T01:30:00.000Z',
      committed: true,
      pushed: true,
    };
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const before = {
      markdown: await readFile(first.markdownPath, 'utf8'),
      source: await readFile(sourcePath, 'utf8'),
      catalog: await readFile(catalogPath, 'utf8'),
    };

    const saved = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '较弱副本',
      collectedAt: '2026-08-25T02:00:00.000Z',
      html: `<p>${nextText}</p>`,
      text: nextText,
      images: [],
      truncated: false,
      sourceMetadata: CURRENT_COMPLETENESS,
    })));

    expect(saved).toMatchObject({
      id: first.id,
      markdownPath: first.markdownPath,
      downloadedImages: 0,
      failedImages: 0,
    });
    expect(await readFile(first.markdownPath, 'utf8')).toBe(before.markdown);
    expect(await readFile(sourcePath, 'utf8')).toBe(before.source);
    expect(await readFile(catalogPath, 'utf8')).toBe(before.catalog);
  });

  it('lets a new exact build replace a longer v2 snapshot produced by an older build', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/cross-build-repair';
    const pollutedText = '旧构建错误混入推荐区和重复块，因此字数更长但并非真实正文。'.repeat(20);
    const first = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '旧构建污染版本',
      collectedAt: '2026-08-25T01:00:00.000Z',
      html: `<p>${pollutedText}</p>`,
      text: pollutedText,
      images: [],
      truncated: false,
      sourceMetadata: {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.29 · build-A',
      },
    })));
    const verifiedText = '新构建已经排除推荐区，只保留经详情页验证的完整正文和结论。'.repeat(6);

    await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '新构建验证版本',
      collectedAt: '2026-08-25T02:00:00.000Z',
      html: `<p>${verifiedText}</p>`,
      text: verifiedText,
      images: [],
      truncated: false,
      sourceMetadata: {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.29 · build-B',
      },
    })));

    const source = JSON.parse(
      await readFile(join(dirname(first.markdownPath), 'source.json'), 'utf8'),
    ) as { document: { text: string } };
    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ title: string; contentCompletenessBuildId?: string }>;
    expect(source.document.text).toBe(verifiedText);
    expect(catalog[0]).toMatchObject({
      title: '新构建验证版本',
      contentCompletenessBuildId: 'v0.4.29 · build-B',
    });
  });

  it.each([
    [
      'a different source build',
      {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.29 · build-B',
      },
    ],
    [
      'a missing source build',
      { contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY },
    ],
    [
      'an empty source build',
      {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: '',
      },
    ],
    [
      'a different source completeness version',
      {
        contentCompletenessVersion: 'zsxq-complete-content-v1',
        contentCompletenessBuildId: 'v0.4.29 · build-A',
      },
    ],
  ])('does not apply same-build rollback protection when source.json carries %s', async (_, storedProof) => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/interrupted-source-proof';
    const buildA = {
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
      contentCompletenessBuildId: 'v0.4.29 · build-A',
    } as const;
    const first = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '构建 A 的原始版本',
      collectedAt: '2026-08-25T01:00:00.000Z',
      html: '<p>构建 A 的原始正文。</p>',
      text: '构建 A 的原始正文。',
      images: [],
      truncated: false,
      sourceMetadata: buildA,
    })));
    const catalogPath = join(root, '_catalog', 'index.json');
    const sourcePath = join(dirname(first.markdownPath), 'source.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<Record<string, unknown>>;
    catalog[0]!.sync = {
      state: 'synced',
      target: 'life-teachers',
      at: '2026-08-25T01:30:00.000Z',
      committed: true,
      pushed: true,
    };
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    // 模拟 Markdown/source 已原子写成另一构建，但进程在 catalog 更新前中断。
    const interrupted = JSON.parse(await readFile(sourcePath, 'utf8')) as {
      document: {
        html: string;
        text: string;
        sourceMetadata?: Record<string, string>;
      };
    };
    interrupted.document.html = '<p>构建 B 的污染长正文，不能冒充构建 A 的防回退基线。</p>';
    interrupted.document.text = '构建 B 的污染长正文，不能冒充构建 A 的防回退基线。';
    interrupted.document.sourceMetadata = storedProof;
    await writeFile(sourcePath, `${JSON.stringify(interrupted, null, 2)}\n`);

    const repairedText = 'A 的可信短正文。';
    await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '构建 A 的修复版本',
      collectedAt: '2026-08-25T02:00:00.000Z',
      html: `<p>${repairedText}</p>`,
      text: repairedText,
      images: [],
      truncated: false,
      sourceMetadata: buildA,
    })));

    const repaired = JSON.parse(await readFile(sourcePath, 'utf8')) as {
      document: { text: string; sourceMetadata?: Record<string, unknown> };
    };
    const repairedCatalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<{
      title: string;
      updatedAt: string;
      contentCompletenessVersion?: string;
      contentCompletenessBuildId?: string;
      sync?: { state: string };
    }>;
    expect(repaired.document).toMatchObject({
      text: repairedText,
      sourceMetadata: buildA,
    });
    expect(repairedCatalog[0]).toMatchObject({
      title: '构建 A 的修复版本',
      updatedAt: '2026-08-25T02:00:00.000Z',
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
      contentCompletenessBuildId: 'v0.4.29 · build-A',
      sync: { state: 'pending' },
    });
  });

  it('replaces complete ZSXQ content only when the recaptured body is strictly richer', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = 'https://wx.zsxq.com/dweb2/index/topic_detail/richer-update';
    const first = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '旧标题',
      collectedAt: '2026-08-25T01:00:00.000Z',
      html: '<p>第一段正文。</p>',
      text: '第一段正文。',
      images: [],
      truncated: false,
      sourceMetadata: CURRENT_COMPLETENESS,
    })));

    await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '新标题',
      collectedAt: '2026-08-25T02:00:00.000Z',
      html: '<p>第一段正文。第二段新增正文和结论。</p>',
      text: '第一段正文。第二段新增正文和结论。',
      images: [],
      truncated: false,
      sourceMetadata: CURRENT_COMPLETENESS,
    })));

    const source = JSON.parse(
      await readFile(join(dirname(first.markdownPath), 'source.json'), 'utf8'),
    ) as { document: { text: string } };
    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ title: string; updatedAt: string; sync?: { state: string } }>;
    expect(source.document.text).toBe('第一段正文。第二段新增正文和结论。');
    expect(catalog[0]).toMatchObject({
      title: '新标题',
      updatedAt: '2026-08-25T02:00:00.000Z',
      sync: { state: 'pending' },
    });
  });

  it('uses catalog completeness for a legacy ZSXQ source snapshot without a truncation field', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = 'https://wx.zsxq.com/dweb2/index/topic_detail/legacy-complete-source';
    const first = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      html: '<p>已由目录确认完整的历史长正文。</p>',
      text: '已由目录确认完整的历史长正文。',
      images: [],
      truncated: false,
      sourceMetadata: CURRENT_COMPLETENESS,
    })));
    const sourcePath = join(dirname(first.markdownPath), 'source.json');
    const source = JSON.parse(await readFile(sourcePath, 'utf8')) as {
      document: { text: string; truncated?: boolean };
    };
    delete source.document.truncated;
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    const before = await readFile(sourcePath, 'utf8');

    await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      collectedAt: '2026-08-25T02:00:00.000Z',
      html: '<p>短正文。</p>',
      text: '短正文。',
      images: [],
      truncated: false,
      sourceMetadata: CURRENT_COMPLETENESS,
    })));

    expect(await readFile(sourcePath, 'utf8')).toBe(before);
  });

  it('lets the current completeness protocol replace a longer legacy unversioned snapshot', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = 'https://wx.zsxq.com/group/1/topic/versioned-repair';
    const first = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '旧版假完整快照',
      html: `<p>${'旧版可能混入外围界面的较长正文。'.repeat(20)}</p>`,
      text: '旧版可能混入外围界面的较长正文。'.repeat(20),
      images: [],
      truncated: false,
    })));

    const verifiedText = '当前协议重新验证过的完整正文与结论。'.repeat(8);
    await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '当前协议完整快照',
      collectedAt: '2026-08-25T03:00:00.000Z',
      html: `<p>${verifiedText}</p>`,
      text: verifiedText,
      images: [],
      truncated: false,
      sourceMetadata: {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.29 · final-build',
      },
    })));

    const source = JSON.parse(
      await readFile(join(dirname(first.markdownPath), 'source.json'), 'utf8'),
    ) as { document: { text: string } };
    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ contentCompletenessVersion?: string; contentCompletenessBuildId?: string }>;
    expect(source.document.text).toBe(verifiedText);
    expect(catalog[0]).toMatchObject({
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
      contentCompletenessBuildId: 'v0.4.29 · final-build',
    });
  });

  it.each(['missing', 'corrupt'])('allows a complete ZSXQ recapture to repair a %s legacy source.json', async state => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const topicUrl = `https://wx.zsxq.com/dweb2/index/topic_detail/legacy-source-${state}`;
    const first = await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      html: '<p>历史正文比新副本更长，但留存文件已不可用。</p>',
      text: '历史正文比新副本更长，但留存文件已不可用。',
      images: [],
      truncated: false,
    })));
    const sourcePath = join(dirname(first.markdownPath), 'source.json');
    if (state === 'missing') {
      await rm(sourcePath);
    } else {
      await writeFile(sourcePath, '不是 JSON');
    }

    await library.save(organize(collected({
      source: 'zsxq',
      kind: 'post',
      url: topicUrl,
      canonicalUrl: topicUrl,
      title: '自愈后的条目',
      collectedAt: '2026-08-25T02:00:00.000Z',
      html: '<p>新的完整正文。</p>',
      text: '新的完整正文。',
      images: [],
      truncated: false,
    })));

    const repaired = JSON.parse(await readFile(sourcePath, 'utf8')) as {
      document: { text: string };
    };
    expect(repaired.document.text).toBe('新的完整正文。');
  });

  it('serializes concurrent saves without losing catalog entries', async () => {
    const root = await temporaryDirectory();
    const library = new MarkdownLibrary({ root });
    const documents = Array.from({ length: 30 }, (_, index) =>
      organize(
        collected({
          url: `https://mp.weixin.qq.com/s/concurrent-${index}`,
          canonicalUrl: `https://mp.weixin.qq.com/s/concurrent-${index}`,
          title: `并发文章 ${index}`,
          html: `<p>并发写入正文 ${index}</p>`,
          text: `并发写入正文 ${index}，用于验证目录不会丢失。`,
          images: [],
        }),
      ),
    );

    await Promise.all(documents.map(document => library.save(document)));

    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ relativePath: string }>;
    expect(catalog).toHaveLength(documents.length);
    expect(await readdir(dirname(join(root, catalog[0]!.relativePath)))).not.toContain('assets');
  });

  it('blocks loopback image SSRF before invoking fetch', async () => {
    const root = await temporaryDirectory();
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    const imageUrl = 'http://127.0.0.1:8080/private.png';
    const library = new MarkdownLibrary({ root, fetch: fetcher });

    const saved = await library.save(
      organize(
        collected({
          html: `<img src="${imageUrl}">`,
          images: [{ url: imageUrl }],
        }),
      ),
    );

    expect(saved).toMatchObject({ downloadedImages: 0, failedImages: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(saved.markdownPath, 'utf8')).toContain(imageUrl);
    expect(await readdir(dirname(saved.markdownPath))).not.toContain('assets');
  });

  it('streams image bodies and stops reading at the hard byte limit', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(6 * 1024 * 1024);
    const response = new Response(
      new ReadableStream({
        async pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
          await new Promise(resolve => setTimeout(resolve, 1));
          if (pulls >= 3) controller.close();
        },
      }),
    );

    await expect(readResponseBytes(response, 10 * 1024 * 1024)).rejects.toThrow(
      /图片超过 10 MB/,
    );
    expect(pulls).toBeLessThan(3);
  });

  it('uses manual redirects and rejects active SVG assets', async () => {
    const root = await temporaryDirectory();
    const imageUrl = 'https://public.example/image.svg';
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response('<svg onload="alert(1)"></svg>', {
        headers: { 'content-type': 'image/svg+xml' },
      }),
    );
    const library = new MarkdownLibrary({
      root,
      fetch: fetcher,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    const saved = await library.save(
      organize(
        collected({
          html: `<img src="${imageUrl}">`,
          images: [{ url: imageUrl }],
        }),
      ),
    );

    expect(saved).toMatchObject({ downloadedImages: 0, failedImages: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      imageUrl,
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('revalidates every redirect before contacting a private destination', async () => {
    const root = await temporaryDirectory();
    const imageUrl = 'https://public.example/redirect.png';
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/internal.png' },
      }),
    );
    const library = new MarkdownLibrary({
      root,
      fetch: fetcher,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    const saved = await library.save(
      organize(
        collected({
          html: `<img src="${imageUrl}">`,
          images: [{ url: imageUrl }],
        }),
      ),
    );

    expect(saved).toMatchObject({ downloadedImages: 0, failedImages: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects a symlinked directory that escapes the library root', async () => {
    const workspace = await temporaryDirectory();
    const root = join(workspace, 'library');
    const outside = join(workspace, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, '微信公众号'));
    const library = new MarkdownLibrary({ root });

    await expect(
      library.save(organize(collected({ html: '<p>正文</p>', images: [] }))),
    ).rejects.toThrow(/符号链接/);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('「已提交但没推上去」不算送到', () => {
  it('pendingIds 要把它捞出来，否则用户没有补推的入口', async () => {
    // 0.3.14 之前推送失败只算告警，条目被记成 synced + pushed:false。
    // 那批条目既不算已完成、也不进待办——侧栏二十条全是「已同步·未推送」，
    // 按钮却写着「全部已同步」还不可点。用户原话：真奇怪。
    const root = await temporaryDirectory();
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(
      join(root, '_catalog', 'index.json'),
      JSON.stringify([
        { id: 'a', source: 'zsxq', title: '推上去了', url: 'u1', category: 'x', relativePath: 'a/index.md', updatedAt: '2026-08-01T00:00:00.000Z', sync: { state: 'synced', pushed: true } },
        { id: 'b', source: 'zsxq', title: '只提交没推送', url: 'u2', category: 'x', relativePath: 'b/index.md', updatedAt: '2026-08-01T00:00:00.000Z', sync: { state: 'synced', pushed: false, pushFailed: true, error: 'git push 失败：没有推送权限' } },
        { id: 'c', source: 'zsxq', title: '从没同步过', url: 'u3', category: 'x', relativePath: 'c/index.md', updatedAt: '2026-08-01T00:00:00.000Z' },
      ]),
    );

    expect((await pendingIds(root)).sort()).toEqual(['b', 'c']);
  });

  it('没配置要推的去向（pushed:false 但没有失败原因）算送到了', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(
      join(root, '_catalog', 'index.json'),
      JSON.stringify([
        { id: 'a', source: 'zsxq', title: 't', url: 'u', category: 'x', relativePath: 'a/index.md', updatedAt: '2026-08-01T00:00:00.000Z', sync: { state: 'synced', pushed: false } },
      ]),
    );
    expect(await pendingIds(root)).toEqual([]);
  });
});
