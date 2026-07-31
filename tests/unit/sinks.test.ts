import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  DEFAULT_SINKS_CONFIG,
  RepoInboxSink,
  builtInSinksConfig,
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

  it('采集一律只落本机库；仓库收件箱是「同步去向」，不在采集时写', async () => {
    // 产品链路：采集 → 本机库（唯一落点、唯一去重依据）→ 人工核对 → 显式同步 → Agent 归档。
    // 采集时就直接投递会让用户失去中间那道审阅，出问题也分不清是采错了还是投错了。
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
    expect(nowcoder.map(result => result.sinkId)).toEqual(['markdown']);
    expect(nowcoder[0]!.outputRef).toContain(libraryRoot);

    const wechat = await router.save(organize(wechatDoc()));
    expect(wechat.map(result => result.sinkId)).toEqual(['markdown']);
    expect(wechat[0]!.outputRef).toContain(libraryRoot);

    // 但同步去向要说得出来，否则「同步」这一步无处可去。
    expect(router.syncTarget('nowcoder')?.id).toBe('fe-inbox');
    // 没配仓库去向的来源如实返回 undefined，同步时会明确报错而不是假装成功。
    expect(router.syncTarget('wechat')).toBeUndefined();
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

  it('describes destinations (label + categories) and per-source defaults without leaking paths', () => {
    const router = SinkRouter.build(
      {
        sinks: {
          markdown: { type: 'markdown' },
          'fe-inbox': {
            type: 'repo-inbox',
            repoPath: '~/Code/front-end-journey-resource',
            categories: ['面经', '知识点'],
          },
          lt: {
            type: 'repo-inbox',
            repoPath: '/x/life-teachers',
            label: 'life-teachers 收件箱',
            categories: ['投资', '财富', '职场', '认知', '教育', '其他'],
          },
        },
        routes: { nowcoder: ['fe-inbox'], wechat: ['markdown', 'lt'] },
      },
      { libraryRoot: '/tmp/lib' },
    );
    const routing = router.describeRouting();
    // 每个来源的默认去向（sink id）。
    expect(routing.defaults.nowcoder).toEqual(['fe-inbox']);
    expect(routing.defaults.wechat).toEqual(['markdown', 'lt']);
    expect(routing.defaults.zsxq).toEqual(['markdown']); // 未配置来源回退本机库
    // 可选去向带展示名与各自分类清单，供侧栏级联下拉。
    const byId = Object.fromEntries(routing.sinks.map(sink => [sink.id, sink]));
    expect(byId['lt']?.label).toBe('life-teachers 收件箱');
    expect(byId['lt']?.categories).toEqual(['投资', '财富', '职场', '认知', '教育', '其他']);
    expect(byId['fe-inbox']?.label).toBe('front-end-journey-resource 收件箱');
    expect(byId['markdown']?.categories).toContain('人工智能');
    // 不泄露本机路径
    expect(JSON.stringify(routing)).not.toContain('/x/');
    expect(JSON.stringify(routing)).not.toContain('Code');
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
  it('falls back to built-in targets when no config file exists（零配置可用）', async () => {
    const dir = await temporaryDirectory();
    const config = await loadSinksConfig(join(dir, 'missing.json'));
    // 本机库始终可用；内置去向仅在对应仓库存在时才出现，故这里只断言不变量。
    expect(config.sinks.markdown).toEqual({ type: 'markdown' });
    for (const [id, definition] of Object.entries(config.sinks)) {
      if (id === 'markdown') continue;
      expect(definition.type).toBe('repo-inbox');
      // 内置去向必须自带分类清单，否则侧栏「分类」会是空的。
      expect((definition as { categories?: string[] }).categories?.length).toBeGreaterThan(0);
    }
    // 路由只会指向已启用的去向。
    for (const ids of Object.values(config.routes)) {
      for (const id of ids) expect(config.sinks[id]).toBeDefined();
    }
  });

  it('enables a built-in target only when its repository exists（存在才启用）', async () => {
    // routes 表示「同步去向」——采集一律先落本机库，这里不再出现 markdown。
    const onlyLifeTeachers = await builtInSinksConfig(async path =>
      path.endsWith('/life-teachers'),
    );
    expect(Object.keys(onlyLifeTeachers.sinks).sort()).toEqual(['life-teachers', 'markdown']);
    expect(onlyLifeTeachers.routes.wechat).toEqual(['life-teachers']);
    expect(onlyLifeTeachers.routes.zsxq).toEqual(['life-teachers']);
    // 同步是显式动作，提交后顺手推一次，好让云端 Agent 拉得到。
    expect(onlyLifeTeachers.sinks['life-teachers']).toMatchObject({ push: true });
    expect(onlyLifeTeachers.routes.nowcoder).toBeUndefined();
    expect(onlyLifeTeachers.sinks['life-teachers']).toMatchObject({
      type: 'repo-inbox',
      label: 'life-teachers 收件箱',
      categories: ['投资', '财富', '职场', '认知', '教育', '其他'],
    });

    // 两个仓库都在：牛客路由到 fe-journey。
    const both = await builtInSinksConfig(async () => true);
    expect(both.routes.nowcoder).toEqual(['fe-journey']);
    expect(both.sinks['fe-journey']).toMatchObject({ label: 'fe-journey 收件箱' });

    // 都不在：降级为只有本机库，不会凭空创建目录。
    const none = await builtInSinksConfig(async () => false);
    expect(Object.keys(none.sinks)).toEqual(['markdown']);
    expect(none.routes).toEqual({});
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
