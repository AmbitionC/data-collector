import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  MarkdownLibrary,
  safeSlug,
} from '../../packages/bridge/src/library/index.js';

const URL = 'https://mp.weixin.qq.com/s/library-test';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'data-collector-library-'));
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
  it('writes assets and catalog atomically while preserving a stable update path', async () => {
    const root = await temporaryDirectory();
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('failure.png')) throw new Error('offline');
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    });
    const library = new MarkdownLibrary({ root, fetch: fetcher });

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
    expect(fetcher).toHaveBeenCalled();
  });
});
