import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  atomicWriteInboxText,
  explainGitFailure,
} from '../../packages/bridge/src/sinks/repoInboxSink.js';
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
  it('removes only its exact temporary file when atomic rename fails', async () => {
    const repo = await temporaryDirectory();
    const target = join(repo, 'meta.json');
    await expect(atomicWriteInboxText(
      repo,
      target,
      '{"ok":true}\n',
      async () => { throw new Error('injected rename failure'); },
    )).rejects.toThrow('injected rename failure');

    expect(await readdir(repo)).toEqual([]);
  });

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
    // **不写 push 也要推。** 旧默认是 false，前提是「Agent 直接读本机工作区」——
    // 那个前提早废了。而 sinks.json 一旦存在就完全接管内置默认，漏写 push
    // 就变成只 commit 不 push，界面还显示「已同步」，用户每次都得自己去终端补推。
    expect(runGit).toHaveBeenCalledWith(repo, ['push']);
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
    expect(await readdir(result.outputRef)).not.toContain('assets');
  });

  it('preserves fe-journey scoring and primitive source evidence in meta.json', async () => {
    const repo = await temporaryDirectory();
    const sink = new RepoInboxSink({ id: 'fe-journey', repoPath: repo, commit: false });
    const result = await sink.save(organize(nowcoderDoc({
      images: [],
      sourceMetadata: { searchQuery: 'Agent 面经', likes: 32, firstParty: true },
      feJourney: {
        candidateKinds: ['interview', 'knowledge'],
        qualityScore: 78,
        qualitySignals: ['第一手面试经历'],
        contentHash: '0123456789abcdef',
        simHash: 'fedcba9876543210',
        clusterId: 'cluster-0123456789ab',
      },
    })));

    const meta = JSON.parse(await readFile(join(result.outputRef, 'meta.json'), 'utf8'));
    expect(meta.sourceMetadata).toEqual({ searchQuery: 'Agent 面经', likes: 32, firstParty: true });
    expect(meta.feJourney).toMatchObject({
      candidateKinds: ['interview', 'knowledge'],
      qualityScore: 78,
      clusterId: 'cluster-0123456789ab',
    });
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

    // 两个仓库都在：牛客和 GitHub 只同步到本机 fe-journey 收件箱。
    const both = await builtInSinksConfig(async () => true);
    expect(both.routes.nowcoder).toEqual(['fe-journey']);
    expect(both.routes.github).toEqual(['fe-journey']);
    expect(both.sinks['fe-journey']).toMatchObject({
      label: 'fe-journey 收件箱',
      commit: false,
      push: false,
    });
    expect(both.sinks['life-teachers']).toMatchObject({ push: true });

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

describe('git 报错要翻成人能照做的一句话', () => {
  it('认得出常见成因，并给出可执行的下一步', () => {
    // 直接把 stderr 摆出来毫无用处，但**翻错了比不翻更糟**：这条一度被翻成
    // 「这台 Mac 的命令行工具坏了，去 xcode-select --install」，而用户终端里的 git 好得很。
    // 真正的成因是本机服务（登录项）的 PATH 找不到用户那份 git——细节见 tests/unit/git.test.ts。
    const xcrun = explainGitFailure(
      'git add',
      'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)',
    );
    expect(xcrun).toContain('本机服务');
    expect(xcrun).not.toContain('xcode-select --install');

    expect(explainGitFailure('git add', 'fatal: not a git repository'))
      .toContain('不是一个 git 仓库');
    expect(explainGitFailure('git commit', '*** Please tell me who you are.'))
      .toContain('git config user.email');
    // 推送失败要说清两件事：提交是成功的，但**没上远端**——用户的 Agent 从远端读，
    // 看不到就等于没送到。原先这里安慰「本机 Agent 直接读工作区即可」，
    // 而用户的 Agent 在云端，那句话把人引偏了。
    const push = explainGitFailure('git push', 'fatal: Authentication failed');
    expect(push).toContain('没上远端');
    expect(push).toContain('点一次同步即可重试');
  });

  it('认不出来的原样带出，绝不吞掉', () => {
    expect(explainGitFailure('git add', 'some brand new error'))
      .toBe('git add 失败：some brand new error');
  });
});

describe('提交失败绝不能报成「已同步」', () => {
  /** 真实链路里 git commit 会因为没配 user.email、被钩子拒等原因失败。 */
  async function saveWith(runGit: (repo: string, args: string[]) => Promise<{ code: number; stderr: string; stdout?: string }>) {
    const repo = await temporaryDirectory();
    const sink = new RepoInboxSink({
      id: 'x',
      repoPath: repo,
      runGit,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
    });
    return sink.save(organize(nowcoderDoc({ images: [] })));
  }

  it('commit 真失败时算失败，并说清原因', async () => {
    const result = await saveWith(async (_repo, args) =>
      args[0] === 'commit'
        ? { code: 1, stderr: '*** Please tell me who you are.', stdout: '' }
        : { code: 0, stderr: '', stdout: '' },
    );
    const detail = result.detail as { commitFailed?: boolean; gitWarning?: string };
    // 原先这里只把 committed 记成 false，既不报警也不算失败——
    // 侧栏照样绿着「已同步」，而仓库里一个提交都没有。
    expect(detail.commitFailed).toBe(true);
    expect(detail.gitWarning).toContain('git config user.email');
  });

  it('「没有改动可提交」是幂等成功，不能误报成失败', async () => {
    const result = await saveWith(async (_repo, args) =>
      args[0] === 'commit'
        ? { code: 1, stderr: '', stdout: 'nothing to commit, working tree clean' }
        : { code: 0, stderr: '', stdout: '' },
    );
    expect((result.detail as { commitFailed?: boolean }).commitFailed).toBeUndefined();
  });
});

describe('推送失败就算同步失败（用户明确要求）', () => {
  it('push 失败时标 pushFailed，并指向可执行的下一步', async () => {
    const repo = await temporaryDirectory();
    const sink = new RepoInboxSink({
      id: 'lt',
      repoPath: repo,
      push: true,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
      runGit: async (_repo, args) =>
        args[0] === 'push'
          ? { code: 128, stderr: 'fatal: could not read Username for https://github.com', stdout: '' }
          : { code: 0, stderr: '', stdout: '' },
    });

    const result = await sink.save(organize(nowcoderDoc({ images: [] })));
    const detail = result.detail as { committed?: boolean; pushed?: boolean; pushFailed?: boolean; gitWarning?: string };

    expect(detail.committed).toBe(true);
    expect(detail.pushFailed).toBe(true);
    // 提交是成功的，这一点要如实；但没上远端，Agent 就读不到。
    expect(detail.gitWarning).toContain('没上远端');
    expect(detail.gitWarning).not.toContain('本机 Agent 直接读工作区即可');
  });

  it('没配置要推的 sink 不会被误判成推送失败', async () => {
    const repo = await temporaryDirectory();
    const sink = new RepoInboxSink({
      id: 'lt',
      repoPath: repo,
      fetch: pngFetcher(),
      resolveAddresses: PUBLIC_DNS,
      runGit: async () => ({ code: 0, stderr: '', stdout: '' }),
    });

    const result = await sink.save(organize(nowcoderDoc({ images: [] })));
    expect((result.detail as { pushFailed?: boolean }).pushFailed).toBeUndefined();
  });

  it('远端领先被拒时说清该 pull --rebase', () => {
    const message = explainGitFailure('git push', '! [rejected] master -> master (fetch first)');
    expect(message).toContain('git pull --rebase');
  });
});

describe('远端领先时自己 rebase 一次再推', () => {
  /**
   * 这是链路的常态：云端 Agent 归档完收件箱把远端推前，本机仓库随即落后，
   * 下一次同步必然 non-fast-forward。要求用户每次采集前手动 pull 太蠢。
   */
  function sinkWith(steps: Record<string, { code: number; stderr?: string; stdout?: string }[]>) {
    const calls: string[][] = [];
    const runGit = async (_repo: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(' ');
      const queue = steps[key] ?? steps[args[0]!] ?? [{ code: 0 }];
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { code: next.code, stderr: next.stderr ?? '', stdout: next.stdout ?? '' };
    };
    return { calls, runGit };
  }

  it('推被拒 → pull --rebase → 重推成功，用户无感', async () => {
    const repo = await temporaryDirectory();
    const { calls, runGit } = sinkWith({
      push: [
        { code: 1, stderr: '! [rejected] master -> master (non-fast-forward)' },
        { code: 0 },
      ],
      'pull --rebase': [{ code: 0 }],
    });
    const sink = new RepoInboxSink({ id: 'lt', repoPath: repo, push: true, fetch: pngFetcher(), resolveAddresses: PUBLIC_DNS, runGit });

    const result = await sink.save(organize(nowcoderDoc({ images: [] })));

    expect(result.detail).toMatchObject({ committed: true, pushed: true });
    expect(calls.some(args => args.join(' ') === 'pull --rebase')).toBe(true);
    expect(calls.filter(args => args[0] === 'push')).toHaveLength(2);
  });

  it('rebase 失败要 --abort，绝不把仓库留在中间态', async () => {
    const repo = await temporaryDirectory();
    const { calls, runGit } = sinkWith({
      push: [{ code: 1, stderr: '! [rejected] master -> master (fetch first)' }],
      'pull --rebase': [{ code: 1, stderr: 'CONFLICT (content): Merge conflict in _inbox/x/meta.json' }],
    });
    const sink = new RepoInboxSink({ id: 'lt', repoPath: repo, push: true, fetch: pngFetcher(), resolveAddresses: PUBLIC_DNS, runGit });

    const result = await sink.save(organize(nowcoderDoc({ images: [] })));
    const detail = result.detail as { pushFailed?: boolean; gitWarning?: string };

    expect(calls.some(args => args.join(' ') === 'rebase --abort')).toBe(true);
    expect(detail.pushFailed).toBe(true);
    expect(detail.gitWarning).toContain('已还原');
  });

  it('推被拒但不是因为落后（比如没权限）时不乱 rebase', async () => {
    const repo = await temporaryDirectory();
    const { calls, runGit } = sinkWith({
      push: [{ code: 128, stderr: 'fatal: Authentication failed' }],
    });
    const sink = new RepoInboxSink({ id: 'lt', repoPath: repo, push: true, fetch: pngFetcher(), resolveAddresses: PUBLIC_DNS, runGit });

    await sink.save(organize(nowcoderDoc({ images: [] })));
    expect(calls.some(args => args[0] === 'pull')).toBe(false);
  });
});

describe('仓库卡在没解决完的合并里', () => {
  it('说清是合并没收尾，而不是甩一句 unmerged files', () => {
    // 用户那边真出过：pull 冲突没处理完就接着采集，此后每次同步的 commit 都失败。
    const message = explainGitFailure(
      'git commit',
      'error: Committing is not possible because you have unmerged files.',
    );
    expect(message).toContain('没解决完的合并');
    expect(message).toContain('git merge --abort');
  });
});

describe('工单 D5/D7：截断标志与提问者要落进 meta', () => {
  it('truncated / questioner 同时进 meta.json 和 frontmatter', async () => {
    // 归档侧的验收标准明确要求这两个字段：
    // 字数启发式误报率 78%，21 条问答帖的提问人全被抹掉。
    const repo = await temporaryDirectory();
    const sink = new RepoInboxSink({
      id: 'lt', repoPath: repo, commit: false,
      fetch: pngFetcher(), resolveAddresses: PUBLIC_DNS,
    });

    const result = await sink.save(organize(nowcoderDoc({
      images: [],
      truncated: true,
      questioner: 'City 躺平大叔',
    })));

    const meta = JSON.parse(await readFile(join(result.outputRef, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ truncated: true, questioner: 'City 躺平大叔' });
    const original = await readFile(join(result.outputRef, 'original.md'), 'utf8');
    expect(original).toContain('questioner: "City 躺平大叔"');
    expect(original).toContain('truncated: true');
  });

  it('正常条目不带这两个字段，不给下游添噪声', async () => {
    const repo = await temporaryDirectory();
    const sink = new RepoInboxSink({
      id: 'lt', repoPath: repo, commit: false,
      fetch: pngFetcher(), resolveAddresses: PUBLIC_DNS,
    });
    const result = await sink.save(organize(nowcoderDoc({ images: [] })));
    const meta = JSON.parse(await readFile(join(result.outputRef, 'meta.json'), 'utf8'));
    expect(meta.truncated).toBeUndefined();
    expect(meta.questioner).toBeUndefined();
  });
});

describe('push 默认开着，显式关掉才不推', () => {
  it('显式 push:false 时确实不推（有人只想本地提交）', async () => {
    const repo = await temporaryDirectory();
    const runGit = vi.fn(async () => ({ code: 0, stderr: '' }));
    const sink = new RepoInboxSink({
      id: 'lt', repoPath: repo, push: false,
      fetch: pngFetcher(), resolveAddresses: PUBLIC_DNS, runGit,
    });

    await sink.save(organize(nowcoderDoc({ images: [] })));

    expect(runGit).toHaveBeenCalledWith(repo, expect.arrayContaining(['commit', '-m']));
    expect(runGit).not.toHaveBeenCalledWith(repo, ['push']);
  });
});
