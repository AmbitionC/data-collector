import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  MarkdownLibrary,
  pendingIds,
  safeSlug,
} from '../../packages/bridge/src/library/index.js';
import { readResponseBytes } from '../../packages/bridge/src/library/assets.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const URL = 'https://mp.weixin.qq.com/s/library-test';
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
    expect(fetcher).toHaveBeenCalled();
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
    ) as unknown[];
    expect(catalog).toHaveLength(documents.length);
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
