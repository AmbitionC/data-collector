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
  /** 代码是新的但构建没成，磁盘上的产物还是旧的——光重新加载插件没用。 */
  buildFailed?: boolean;
  checkedAt: string;
}

export interface UpdateHost {
  /** 执行命令；失败要抛错，stdout 原样返回。 */
  run(command: string, args: readonly string[], cwd: string): Promise<string>;
  /**
   * 磁盘上那份产物是从哪个提交构建的（读 build-id.txt）。拿不到就返回 undefined。
   *
   * 有它才能回答「该不该重新构建」。只比 HEAD 动没动是不够的：构建失败过一次、
   * 或者用户自己 pull 了却没构建，HEAD 都没再动，产物却一直是旧的——
   * 「已是最新」于是成了假话，插件那边永远等不到新版本。
   */
  builtCommit?(repoRoot: string): Promise<string | undefined>;
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
    if (isHttp2TransportFailure(error)) {
      try {
        // GitHub/代理偶发会把 HTTP/2 流提前掐断；HTTP/1.1 是同一只读 fetch 的
        // 传输降级，不改变远端、分支或工作区语义。只重试一次，避免后台死循环。
        await git('-c', 'http.version=HTTP/1.1', 'fetch', 'origin', branch);
      } catch (fallbackError) {
        return {
          changed: false,
          commit: before,
          message: `拉取失败（HTTP/2 降级重试后仍失败）：${message(fallbackError)}`,
          checkedAt: host.now(),
        };
      }
    } else {
      return {
        changed: false,
        commit: before,
        message: `拉取失败（网络或权限）：${message(error)}`,
        checkedAt: host.now(),
      };
    }
  }

  const target = (await git('rev-parse', `origin/${branch}`)).trim().slice(0, SHORT);
  /*
   * 产物落后于代码也要重新构建，不只是「拉到了新提交」才构建。
   *
   * 构建失败过一次，HEAD 就不会再动了，下一轮直接答「已是最新」——而磁盘上的产物
   * 一直是旧的，插件那边永远等不到新版本，还没人说得出为什么。用户自己 pull 了
   * 却没构建也是同一回事。
   * 只有调用方根本没有提供产物读取能力时，才按「不知道」且不构建处理。生产 Bridge
   * 明确提供了读取器却返回空，说明 stable artifact 缺失或损坏；这时必须按落后处理，
   * 否则精确 build-id 门禁会永久拒绝知识星球任务。失败后的重试由外层 10 分钟周期限流。
   */
  const built = await host.builtCommit?.(repoRoot);
  const stale = host.builtCommit !== undefined
    && (built === undefined || !before.startsWith(built));
  if (target === before && !stale) {
    return {
      changed: false,
      commit: before,
      message: '已是最新。',
      checkedAt: host.now(),
    };
  }

  let current = before;
  let moved = false;
  if (target !== before) {
    try {
      // 只快进：本地领先或分叉时宁可不动，也不要替用户决定怎么合。
      await git('merge', '--ff-only', `origin/${branch}`);
      // `merge --ff-only` 在“本地领先、远端是祖先”时也会成功，但 HEAD 不会移动。
      // 必须重读 HEAD，不能仅凭 target 与 before 不同就声称更新成功并反复构建。
      current = (await git('rev-parse', 'HEAD')).trim().slice(0, SHORT);
      moved = current !== before;
    } catch (error) {
      return {
        changed: false,
        commit: before,
        message: `本地与远端已分叉，无法快进更新：${message(error)}`,
        checkedAt: host.now(),
      };
    }
    if (!moved && !stale) {
      return {
        changed: false,
        commit: before,
        message: '本地分支领先远端，已保留本地提交。',
        checkedAt: host.now(),
      };
    }
  }

  try {
    await host.run('npm', ['run', 'package'], repoRoot);
  } catch (error) {
    return {
      changed: moved,
      commit: current,
      buildFailed: true,
      message: moved
        ? `代码已更新到 ${current}，但构建失败：${message(error)}`
        : `产物落后于代码（${built} → ${current}），重新构建失败：${message(error)}`,
      checkedAt: host.now(),
    };
  }

  return {
    changed: true,
    commit: current,
    message: moved
      ? `已更新到 ${current} 并完成构建，重新加载插件即可生效。`
      : `产物落后于代码，已按 ${current} 重新构建，重新加载插件即可生效。`,
    checkedAt: host.now(),
  };
}

/**
 * 从构建标记里取出提交号：`v0.4.6 · abc1234` → `abc1234`。
 *
 * 有未提交改动时构建标记会写成 `abc1234+dirty.<内容指纹>`，
 * 那个后缀不属于提交号。为兼容旧产物，`+本地改动` 也会被同样去掉。
 * 拿不到 git 信息时标记是 `unknown`，返回 undefined——**绝不编一个假的**，
 * 上游据此按「不知道产物是哪一版」处理，而不是按「落后了」去反复重建。
 */
export function buildStampCommit(buildId: string): string | undefined {
  const stamp = buildId.split('·').pop()?.trim() ?? '';
  const commit = stamp.split('+')[0]?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : undefined;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.slice(0, 200);
}

function isHttp2TransportFailure(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /HTTP\/?2|HTTP2|curl\s+92|stream\s+\d+\s+was\s+not\s+closed\s+cleanly/iu.test(detail);
}
