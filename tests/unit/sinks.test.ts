import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  DEFAULT_SINKS_CONFIG,
  RepoInboxSink,
  SinkRouter,
  loadSinksConfig,
  type SinksConfig,
} from '../../packages/bridge/src/sinks/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function temporaryDirectory(): Promise<string> {
  return temporaryDirectories.create('data-collector-sinks-');
}

function pngFetcher() {
  return vi.fn<typeof fetch>(async () =>
    new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png', 'content-length': '4' },
    }),
  );
}

const PUBLIC_DNS = async () => ['93.184.216.34'];

function nowcoderDoc(overrides: Partial<CollectedDocument> = {}): CollectedDocument {
  const url = 'https://www.nowcoder.com/discuss/123456';
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: '字节前端一面面经',
    author: '前端の张三',
    publishedAt: '2026-07-10T01:30:00.000Z',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: '<p>一面问了事件循环、Promise.all 手写和 HTTP 缓存字段。</p><img src="https://static.nowcoder.com/x.png" alt="图">',
    text: '一面问了事件循环、Promise.all 手写和 HTTP 缓存字段。',
    images: [{ url: 'https://static.nowcoder.com/x.png', alt: '图' }],
    ...overrides,
  };
}

function wechatDoc(): CollectedDocument {
  const url = 'https://mp.weixin.qq.com/s/router-wechat';
  return {
    schemaVersion: 1,
    source: 'wechat',
    kind: 'article',
    url,
    canonicalUrl: url,
    title: '一篇公众号文章',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: '<p>公众号正文，用于验证默认路由回退到本机 Markdown 库。</p>',
    text: '公众号正文，用于验证默认路由回退到本机 Markdown 库。',
    images: [],
  };
}

describe('RepoInboxSink', () => {
  it('drops original.md + meta.json + assets into <repo>/_inbox/<source>/ and commits', async () => {
    const repo = await temporaryDirectory();
    const runGit = vi.fn(async () => ({ code: 0, stderr: '' }));
    const sink = new RepoInboxSink({
      id: 'life-teachers',
      repoPath: repo,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
      runGit,
    });

    const result = await sink.save(organize(nowcoderDoc()));

    expect(result.ok).toBe(true);
    expect(result.sinkId).toBe('life-teachers');
    expect(result.outputRef).toContain(join('_inbox', 'nowcoder'));
    expect(result.detail).toMatchObject({ committed: true, downloadedImages: 1 });

    const original = await readFile(join(result.outputRef, 'original.md'), 'utf8');
    expect(original).toContain('title: "字节前端一面面经"');
    expect(original).toContain('date: 2026-07-10');
    expect(original).toContain('date_source: published');
    expect(original).toContain('source: "牛客网"');
    expect(original).toContain('source_url: "https://www.nowcoder.com/discuss/123456"');
    expect(original).toContain('# 字节前端一面面经');
    expect(original).toContain('事件循环');
    expect(original).toContain('assets/');

    const meta = JSON.parse(await readFile(join(result.outputRef, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      source: 'nowcoder',
      kind: 'post',
      url: 'https://www.nowcoder.com/discuss/123456',
      downloadedImages: 1,
    });
    // 内容指纹用于加工阶段的原文去重（同文不同 URL 的转载指纹一致）。
    expect(meta.contentHash).toMatch(/^[a-f0-9]{16}$/);

    expect(runGit).toHaveBeenCalledWith(repo, expect.arrayContaining(['add']));
    expect(runGit).toHaveBeenCalledWith(repo, expect.arrayContaining(['commit', '-m']));
    expect(runGit).not.toHaveBeenCalledWith(repo, ['push']);
  });

  it('marks the date as collected when the source has no publish time', async () => {
    const repo = await temporaryDirectory();
    const sink = new RepoInboxSink({
      id: 'lt',
      repoPath: repo,
      commit: false,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
    });

    const result = await sink.save(
      organize(nowcoderDoc({ publishedAt: undefined, images: [], html: '<p>没有发布时间的正文，用录入日期占位。</p>' })),
    );

    const original = await readFile(join(result.outputRef, 'original.md'), 'utf8');
    expect(original).toContain('date: 2026-07-18');
    expect(original).toContain('date_source: collected');
    expect(result.detail).toMatchObject({ committed: false });
  });

  it('pushes when configured and records the push result', async () => {
    const repo = await temporaryDirectory();
    const runGit = vi.fn(async () => ({ code: 0, stderr: '' }));
    const sink = new RepoInboxSink({
      id: 'fe',
      repoPath: repo,
      push: true,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
      runGit,
    });

    const result = await sink.save(organize(nowcoderDoc({ images: [] })));
    expect(result.detail).toMatchObject({ committed: true, pushed: true });
    expect(runGit).toHaveBeenCalledWith(repo, ['push']);
  });
});

describe('SinkRouter', () => {
  it('routes every source to the local Markdown library by default', async () => {
    const libraryRoot = await temporaryDirectory();
    const router = SinkRouter.build(DEFAULT_SINKS_CONFIG, {
      libraryRoot,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
    });

    const results = await router.save(organize(nowcoderDoc({ images: [] })));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sinkId: 'markdown', ok: true });
    expect(results[0]!.outputRef).toContain(libraryRoot);
  });

  it('routes a configured source to a repo inbox and leaves others on markdown', async () => {
    const libraryRoot = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const config: SinksConfig = {
      sinks: {
        markdown: { type: 'markdown' },
        'fe-inbox': { type: 'repo-inbox', repoPath: repo, commit: false },
      },
      routes: { nowcoder: ['fe-inbox'] },
    };
    const router = SinkRouter.build(config, {
      libraryRoot,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
    });

    const nowcoder = await router.save(organize(nowcoderDoc({ images: [] })));
    expect(nowcoder.map(result => result.sinkId)).toEqual(['fe-inbox']);
    expect(nowcoder[0]!.outputRef).toContain(repo);

    const wechat = await router.save(organize(wechatDoc()));
    expect(wechat.map(result => result.sinkId)).toEqual(['markdown']);
    expect(wechat[0]!.outputRef).toContain(libraryRoot);
  });

  it('skips undefined sinks with a warning and falls back to markdown', () => {
    const warn = vi.fn();
    const router = SinkRouter.build(
      { sinks: { markdown: { type: 'markdown' } }, routes: { nowcoder: ['ghost'] } },
      { libraryRoot: '/tmp/does-not-matter' },
      warn,
    );

    expect(router.resolveSinkIds('nowcoder')).toEqual(['markdown']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost'));
  });

  it('describes per-source routing targets by user-facing label (no paths leaked)', () => {
    const router = SinkRouter.build(
      {
        sinks: {
          markdown: { type: 'markdown' },
          'fe-inbox': { type: 'repo-inbox', repoPath: '~/Code/front-end-journey-resource' },
          lt: { type: 'repo-inbox', repoPath: '/x/life-teachers', label: 'life-teachers 收件箱' },
        },
        routes: { nowcoder: ['fe-inbox'], wechat: ['markdown', 'lt'] },
      },
      { libraryRoot: '/tmp/lib' },
    );
    const routes = router.describeRoutes();
    expect(routes.nowcoder).toEqual(['front-end-journey-resource 收件箱']);
    expect(routes.wechat).toEqual(['本机库', 'life-teachers 收件箱']);
    expect(routes.zsxq).toEqual(['本机库']); // 未配置来源回退本机库
    // 不泄露本机路径
    expect(JSON.stringify(routes)).not.toContain('/x/');
    expect(JSON.stringify(routes)).not.toContain('Code');
  });

  it('honours an explicit per-job override', () => {
    const router = SinkRouter.build(
      {
        sinks: { markdown: { type: 'markdown' }, inbox: { type: 'repo-inbox', repoPath: '/tmp/r' } },
        routes: {},
      },
      { libraryRoot: '/tmp/lib' },
    );
    expect(router.resolveSinkIds('wechat', ['inbox', 'markdown'])).toEqual(['inbox', 'markdown']);
  });
});

describe('loadSinksConfig', () => {
  it('returns the default config when the file is absent', async () => {
    const dir = await temporaryDirectory();
    const config = await loadSinksConfig(join(dir, 'missing.json'));
    expect(config).toEqual(DEFAULT_SINKS_CONFIG);
  });

  it('parses a config and guarantees a markdown fallback sink', async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, 'sinks.json');
    await (await import('node:fs/promises')).writeFile(
      path,
      JSON.stringify({
        sinks: { 'fe-inbox': { type: 'repo-inbox', repoPath: '~/Code/front-end-journey-resource' } },
        routes: { nowcoder: ['fe-inbox'] },
      }),
    );
    const config = await loadSinksConfig(path);
    expect(config.sinks.markdown).toEqual({ type: 'markdown' });
    expect(config.routes.nowcoder).toEqual(['fe-inbox']);
  });

  it('rejects a malformed config', async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, 'bad.json');
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify({ sinks: 'nope' }));
    await expect(loadSinksConfig(path)).rejects.toThrow();
  });
});
