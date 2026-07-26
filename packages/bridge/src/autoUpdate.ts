/**
 * 自更新：本机服务已经是登录项、一直在跑，就让它顺手把代码拉新、重新构建，
 * 用户只剩「重新加载插件」这一步（侧栏还会给一个按钮，连这步也不用去扩展管理页）。
 *
 * 三条硬约束：
 * - **只快进**。绝不 rebase、绝不 reset，拉不动就如实报告，不猜用户想要什么。
 * - **工作区有改动就不动它**。用户可能正在本地改代码，自动 pull 会毁掉他的工作。
 * - **失败不影响采集**。更新只是附加能力，出错记录下来就算了，服务照常提供。
 */

export interface UpdateOutcome {
  /** 这次检查有没有真的把代码推进到新版本。 */
  changed: boolean;
  /** 当前 HEAD 的 commit（短），供扩展判断「我加载的是不是这一版」。 */
  commit: string;
  /** 人话说明，直接给用户看。 */
  message: string;
  checkedAt: string;
}

export interface UpdateHost {
  /** 执行命令；失败要抛错，stdout 原样返回。 */
  run(command: string, args: readonly string[], cwd: string): Promise<string>;
  now(): string;
}

const SHORT = 12;

/**
 * 拉取并重新构建。branch 只允许简单分支名，避免拼接出别的 git 参数。
 */
export async function updateWorkspace(
  repoRoot: string,
  host: UpdateHost,
  branch = 'master',
): Promise<UpdateOutcome> {
  if (!/^[\w./-]+$/.test(branch)) {
    return {
      changed: false,
      commit: '',
      message: `分支名不合法：${branch}`,
      checkedAt: host.now(),
    };
  }
  const git = (...args: string[]) => host.run('git', args, repoRoot);
  let before = '';
  try {
    before = (await git('rev-parse', 'HEAD')).trim().slice(0, SHORT);
  } catch (error) {
    return {
      changed: false,
      commit: '',
      message: `不是一个 git 仓库或 git 不可用：${message(error)}`,
      checkedAt: host.now(),
    };
  }

  // 工作区有未提交改动就完全不动——用户可能正在本地改东西。
  const dirty = (await git('status', '--porcelain').catch(() => '')).trim();
  if (dirty) {
    return {
      changed: false,
      commit: before,
      message: '本地有未提交的改动，已跳过自动更新（避免覆盖你正在改的东西）。',
      checkedAt: host.now(),
    };
  }

  try {
    await git('fetch', 'origin', branch);
  } catch (error) {
    return {
      changed: false,
      commit: before,
      message: `拉取失败（网络或权限）：${message(error)}`,
      checkedAt: host.now(),
    };
  }

  const target = (await git('rev-parse', `origin/${branch}`)).trim().slice(0, SHORT);
  if (target === before) {
    return { changed: false, commit: before, message: '已是最新。', checkedAt: host.now() };
  }

  try {
    // 只快进：本地领先或分叉时宁可不动，也不要替用户决定怎么合。
    await git('merge', '--ff-only', `origin/${branch}`);
  } catch (error) {
    return {
      changed: false,
      commit: before,
      message: `本地与远端已分叉，无法快进更新：${message(error)}`,
      checkedAt: host.now(),
    };
  }

  try {
    await host.run('npm', ['run', 'package'], repoRoot);
  } catch (error) {
    return {
      changed: true,
      commit: target,
      message: `代码已更新到 ${target}，但构建失败：${message(error)}`,
      checkedAt: host.now(),
    };
  }

  return {
    changed: true,
    commit: target,
    message: `已更新到 ${target} 并完成构建，重新加载插件即可生效。`,
    checkedAt: host.now(),
  };
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.slice(0, 200);
}
