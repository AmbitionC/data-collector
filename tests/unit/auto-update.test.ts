import { describe, expect, it } from 'vitest';
import {
  buildStampCommit,
  shouldDeferArtifactUpdate,
  updateWorkspace,
  type UpdateHost,
} from '../../packages/bridge/src/autoUpdate.js';

const REPO = '/Users/chenhao/code/data-collector';

function host(
  responses: Record<string, string | Error | Array<string | Error>>,
  builtCommit?: string | null,
): UpdateHost & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    now: () => '2026-07-25T00:00:00.000Z',
    ...(builtCommit === undefined
      ? {}
      : { builtCommit: async () => builtCommit ?? undefined }),
    async run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      ran.push(key);
      const configured = responses[key];
      const response = Array.isArray(configured) ? configured.shift() : configured;
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error(`未预期的命令：${key}`);
      return response;
    },
  };
}

const AT_OLD = { 'git rev-parse HEAD': 'aaaaaaaaaaaabbbb\n', 'git status --porcelain': '' };

describe('bridge auto update', () => {
  it('defers package and restart handoff for start intent, readers, or an active directed run', () => {
    expect(shouldDeferArtifactUpdate({ startIntents: 1, pendingReaders: 0, activeReaders: 0 }, false)).toBe(true);
    expect(shouldDeferArtifactUpdate({ startIntents: 0, pendingReaders: 1, activeReaders: 0 }, false)).toBe(true);
    expect(shouldDeferArtifactUpdate({ startIntents: 0, pendingReaders: 0, activeReaders: 1 }, false)).toBe(true);
    expect(shouldDeferArtifactUpdate({ startIntents: 0, pendingReaders: 0, activeReaders: 0, physicalBusy: true }, false)).toBe(true);
    expect(shouldDeferArtifactUpdate({ startIntents: 0, pendingReaders: 0, activeReaders: 0 }, true)).toBe(true);
    expect(shouldDeferArtifactUpdate({ startIntents: 0, pendingReaders: 0, activeReaders: 0 }, false)).toBe(false);
  });

  it('fast-forwards and rebuilds when the remote moved ahead', async () => {
    const target = host({
      ...AT_OLD,
      'git rev-parse HEAD': ['aaaaaaaaaaaabbbb\n', 'ccccccccccccdddd\n'],
      'git fetch origin master': '',
      'git rev-parse origin/master': 'ccccccccccccdddd\n',
      'git merge --ff-only origin/master': 'Fast-forward',
      'npm run package': '/path/to.zip',
    });

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome).toMatchObject({ changed: true, commit: 'cccccccccccc' });
    expect(outcome.message).toContain('重新加载插件');
    // 构建必须跑：拉了代码不构建，用户加载到的还是旧产物。
    expect(target.ran).toContain('npm run package');
  });

  it('does nothing when already up to date', async () => {
    const target = host({
      ...AT_OLD,
      'git fetch origin master': '',
      'git rev-parse origin/master': 'aaaaaaaaaaaabbbb\n',
    });

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome).toMatchObject({ changed: false, commit: 'aaaaaaaaaaaa' });
    expect(outcome.message).toBe('已是最新。');
    expect(target.ran).not.toContain('npm run package');
  });

  it('never touches a dirty working tree', async () => {
    const target = host({
      'git rev-parse HEAD': 'aaaaaaaaaaaabbbb\n',
      'git status --porcelain': ' M packages/extension/src/content.ts\n',
    });

    const outcome = await updateWorkspace(REPO, target);

    // 用户可能正在本地改代码，自动 pull 会毁掉他的工作。
    expect(outcome.changed).toBe(false);
    expect(outcome.message).toContain('未提交的改动');
    expect(target.ran).not.toContain('git fetch origin master');
  });

  it('refuses to resolve a diverged branch on the user behalf', async () => {
    const target = host({
      ...AT_OLD,
      'git fetch origin master': '',
      'git rev-parse origin/master': 'ccccccccccccdddd\n',
      'git merge --ff-only origin/master': new Error('fatal: Not possible to fast-forward'),
    });

    const outcome = await updateWorkspace(REPO, target);

    // 只快进：分叉了宁可不动，也不替用户决定怎么合。
    expect(outcome).toMatchObject({ changed: false, commit: 'aaaaaaaaaaaa' });
    expect(outcome.message).toContain('分叉');
    expect(target.ran).not.toContain('npm run package');
  });

  it('rebuilds when the artifacts on disk lag behind the code, even with nothing to pull', async () => {
    /*
     * 真实场景：某一轮构建失败了。HEAD 已经往前走了，于是下一轮「已是最新」，
     * 而磁盘上的产物一直停在旧版——插件那边永远等不到新版本，还没人说得出为什么。
     * 用户自己 pull 了却没构建也是同一回事。
     */
    const target = host(
      {
        ...AT_OLD,
        'git rev-parse HEAD': ['aaaaaaaaaaaabbbb\n', 'aaaaaaaaaaaabbbb\n'],
        'git fetch origin master': '',
        'git rev-parse origin/master': 'aaaaaaaaaaaabbbb\n',
        'npm run package': '/path/to.zip',
      },
      '9999999',
    );

    const outcome = await updateWorkspace(REPO, target);

    expect(target.ran).toContain('npm run package');
    // 代码没动，所以不该说「已更新到」；说的是产物落后、已重新构建。
    expect(target.ran).not.toContain('git merge --ff-only origin/master');
    expect(outcome.message).toContain('产物落后于代码');
  });

  it('rebuilds when production artifact identity is missing or corrupt', async () => {
    const target = host(
      {
        ...AT_OLD,
        'git fetch origin master': '',
        'git rev-parse origin/master': 'aaaaaaaaaaaabbbb\n',
        'npm run package': '/path/to.zip',
      },
      // The production host has an artifact reader, but it cannot prove any current build.
      null,
    );

    const outcome = await updateWorkspace(REPO, target);

    expect(target.ran).toContain('npm run package');
    expect(outcome).toMatchObject({ changed: true, commit: 'aaaaaaaaaaaa' });
    expect(outcome.message).toContain('产物落后于代码');
  });

  it('stays quiet when the artifacts already match HEAD', async () => {
    const target = host(
      {
        ...AT_OLD,
        'git fetch origin master': '',
        'git rev-parse origin/master': 'aaaaaaaaaaaabbbb\n',
      },
      // build-id.txt 里是 7 位短 sha，HEAD 是 12 位——前缀相同就是同一个提交。
      'aaaaaaa',
    );

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome.message).toBe('已是最新。');
    // 每 10 分钟盲目跑一次 npm run package 是不可接受的。
    expect(target.ran).not.toContain('npm run package');
  });

  it('preserves a clean local branch that is ahead of origin without rebuilding forever', async () => {
    const target = host(
      {
        ...AT_OLD,
        'git fetch origin master': '',
        'git rev-parse origin/master': '9999999999990000\n',
        // 合并祖先分支会成功返回，但 HEAD 根本没有移动。
        'git merge --ff-only origin/master': 'Already up to date.',
      },
      'aaaaaaa',
    );

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome).toMatchObject({ changed: false, commit: 'aaaaaaaaaaaa' });
    expect(outcome.message).toContain('领先远端');
    expect(target.ran).not.toContain('npm run package');
  });

  it('reports a build failure honestly instead of claiming the update landed', async () => {
    const target = host({
      ...AT_OLD,
      'git rev-parse HEAD': ['aaaaaaaaaaaabbbb\n', 'ccccccccccccdddd\n'],
      'git fetch origin master': '',
      'git rev-parse origin/master': 'ccccccccccccdddd\n',
      'git merge --ff-only origin/master': '',
      'npm run package': new Error('打包文件不在允许清单：unexpected=inject.js'),
    });

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome.changed).toBe(true);
    expect(outcome.message).toContain('构建失败');
    expect(outcome.message).toContain('不在允许清单');
    // 扩展据此把「点了也没用」说清楚：产物根本没更新，重新加载多少次都是旧版。
    expect(outcome.buildFailed).toBe(true);
  });

  it('survives a missing git or a non-repo directory', async () => {
    const target = host({ 'git rev-parse HEAD': new Error('not a git repository') });

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome).toMatchObject({ changed: false, commit: '' });
    expect(outcome.message).toContain('不是一个 git 仓库');
  });

  it('reports a fetch failure without touching the working copy', async () => {
    const target = host({
      ...AT_OLD,
      'git fetch origin master': new Error('Could not resolve host: github.com'),
    });

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome.changed).toBe(false);
    expect(outcome.message).toContain('拉取失败');
    expect(target.ran).not.toContain('git -c http.version=HTTP/1.1 fetch origin master');
  });

  it('retries an HTTP/2 transport failure once with HTTP/1.1', async () => {
    const target = host({
      ...AT_OLD,
      'git fetch origin master': new Error(
        'RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: INTERNAL_ERROR',
      ),
      'git -c http.version=HTTP/1.1 fetch origin master': '',
      'git rev-parse origin/master': 'aaaaaaaaaaaabbbb\n',
    });

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome).toMatchObject({ changed: false, commit: 'aaaaaaaaaaaa' });
    expect(outcome.message).toBe('已是最新。');
    expect(target.ran).toEqual(expect.arrayContaining([
      'git fetch origin master',
      'git -c http.version=HTTP/1.1 fetch origin master',
    ]));
  });

  it('rejects a branch name that could smuggle extra git arguments', async () => {
    const target = host({});

    const outcome = await updateWorkspace(REPO, target, '--upload-pack=evil');

    expect(outcome.changed).toBe(false);
    expect(outcome.message).toContain('分支名不合法');
    expect(target.ran).toEqual([]);
  });
});

describe('从构建标记里认出提交号', () => {
  it('认出正常的构建标记', () => {
    expect(buildStampCommit('v0.4.6 · 815a450')).toBe('815a450');
  });

  it('去掉「本地改动」后缀——那不是提交号的一部分', () => {
    expect(buildStampCommit('v0.4.6 · 815a450+本地改动')).toBe('815a450');
  });

  it('去掉可区分本地内容的 dirty 指纹后缀', () => {
    expect(buildStampCommit('v0.4.29 · 815a450+dirty.91d8f0c2aa17')).toBe('815a450');
  });

  it('拿不到 git 信息时返回 undefined，绝不编一个假的', () => {
    // 编一个就会被当成「产物落后」，于是每 10 分钟重新构建一次，没完没了。
    expect(buildStampCommit('v0.4.6 · unknown')).toBeUndefined();
    expect(buildStampCommit('')).toBeUndefined();
  });
});
