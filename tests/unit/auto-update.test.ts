import { describe, expect, it } from 'vitest';
import { updateWorkspace, type UpdateHost } from '../../packages/bridge/src/autoUpdate.js';

const REPO = '/Users/chenhao/code/data-collector';

function host(responses: Record<string, string | Error>): UpdateHost & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    now: () => '2026-07-25T00:00:00.000Z',
    async run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      ran.push(key);
      const response = responses[key];
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error(`未预期的命令：${key}`);
      return response;
    },
  };
}

const AT_OLD = { 'git rev-parse HEAD': 'aaaaaaaaaaaabbbb\n', 'git status --porcelain': '' };

describe('bridge auto update', () => {
  it('fast-forwards and rebuilds when the remote moved ahead', async () => {
    const target = host({
      ...AT_OLD,
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

  it('reports a build failure honestly instead of claiming the update landed', async () => {
    const target = host({
      ...AT_OLD,
      'git fetch origin master': '',
      'git rev-parse origin/master': 'ccccccccccccdddd\n',
      'git merge --ff-only origin/master': '',
      'npm run package': new Error('打包文件不在允许清单：unexpected=inject.js'),
    });

    const outcome = await updateWorkspace(REPO, target);

    expect(outcome.changed).toBe(true);
    expect(outcome.message).toContain('构建失败');
    expect(outcome.message).toContain('不在允许清单');
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
  });

  it('rejects a branch name that could smuggle extra git arguments', async () => {
    const target = host({});

    const outcome = await updateWorkspace(REPO, target, '--upload-pack=evil');

    expect(outcome.changed).toBe(false);
    expect(outcome.message).toContain('分支名不合法');
    expect(target.ran).toEqual([]);
  });
});
