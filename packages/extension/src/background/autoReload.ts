/**
 * 「磁盘上已经有新产物了，现在该不该自己重新加载？」
 *
 * 判断全留在这个纯函数模块里，`index.ts` 只负责取值和真的去调
 * `chrome.runtime.reload()`——后台脚本没法在测试里跑起来，逻辑写在那边等于没测。
 *
 * 比的是什么：本机服务读出来的 `artifacts/data-collector-extension/build-id.txt`
 * 对上编译进这份产物里的 `__BUILD_ID__`。两边是同一个文件的两种读法，
 * 字符串一模一样才算「我加载的就是磁盘上那份」。
 *
 * 之前比的是 git commit——那是「仓库 HEAD」，不是「磁盘上构建出来的是哪一版」。
 * 构建失败时 HEAD 已经往前走了而产物没动，照着 commit 判会一直说「有新版」，
 * 自动重载还会因此陷入死循环：重载 → 版本没变 → 又觉得有新版 → 再重载。
 */

export interface UpdateSignal {
  /** 本机服务在 build-id.txt 里读到的构建标记。 */
  builtBuildId?: string | undefined;
  /** 本扩展这份产物打包时烙进来的构建标记。 */
  runningBuildId?: string | undefined;
  /** 已经为哪个构建自动重载过一次；没生效就不再重复试。 */
  triedBuildId?: string | undefined;
  /** 本机服务拉到了新代码但构建失败：产物还是旧的，光重新加载没用。 */
  buildFailed?: boolean | undefined;
  /** 本机服务对这次检查的说明，构建失败时原样透给用户。 */
  updateMessage?: string | undefined;
  /** 正在采集：service worker 一重启就断在半路。 */
  busy?: boolean | undefined;
  /** 兼容旧调用；侧栏常开不再阻止重载，任务明细会从持久化状态恢复。 */
  panelOpen?: boolean | undefined;
}

/** Service Worker 被回收时进度会停更；超过这个时长仍标 running 视为已中断。 */
export const BATCH_STALE_MS = 90_000;

/** 采集途中不能重载。判据和侧栏用同一份记录、同一个超时，免得两边说法不一致。 */
export function isCollecting(input: {
  batch?: { phase?: string; updatedAt?: number } | undefined;
  lastJobStatus?: string | undefined;
  lastJobUpdatedAt?: number | undefined;
  now: number;
}): boolean {
  const batch = input.batch;
  // 卡死的批次不算「在跑」：Service Worker 早被回收了，再等下去永远等不到。
  if (batch?.phase === 'running' && input.now - (batch.updatedAt ?? 0) < BATCH_STALE_MS) {
    return true;
  }
  const activeJob = ['queued', 'dispatched', 'collecting', 'organizing']
    .includes(input.lastJobStatus ?? '');
  if (!activeJob || !Number.isFinite(input.lastJobUpdatedAt)) return false;
  return input.now - input.lastJobUpdatedAt! < BATCH_STALE_MS;
}

export function hasNewBuild(signal: UpdateSignal): boolean {
  const { builtBuildId, runningBuildId } = signal;
  // 任一边读不到就什么都不做：不知道就说不知道，绝不猜。
  return Boolean(builtBuildId && runningBuildId && builtBuildId !== runningBuildId);
}

/**
 * 自动重新加载的三个不动手的情形：
 *
 * - **正在采集**：service worker 一重启，跑到一半的批次就断在那儿，而页面上的
 *   已处理标记还在——重来一遍会整批跳过，用户看到的是「采了个寂寞」。
 * - **同一个构建已经自动重载过一次还是没变**：说明浏览器里加载的根本不是这份产物
 *   （多半是从别的目录加载的），再重载多少次都一样，交给横幅把话说清楚。
 */
export function shouldAutoReload(signal: UpdateSignal): boolean {
  if (!hasNewBuild(signal)) return false;
  if (signal.busy) return false;
  return signal.triedBuildId !== signal.builtBuildId;
}

export const STUCK_NOTE =
  '新版本已经构建好了，但自动重新加载没让它生效——'
  + '你在浏览器里加载的多半不是 artifacts/data-collector-extension 这个目录。';

/**
 * 横幅上说什么。
 *
 * 构建失败也要说：那时产物根本没更新，用户点多少次「立即加载」都还是旧版，
 * 不说清楚他只会觉得「这插件又不灵了」。
 */
export function updateBanner(signal: UpdateSignal): { available: boolean; note: string } {
  if (hasNewBuild(signal)) {
    return {
      available: true,
      note:
        signal.triedBuildId === signal.builtBuildId
          ? STUCK_NOTE
          : `本机服务已构建新版本 ${signal.builtBuildId}，点一下加载。`,
    };
  }
  if (signal.buildFailed) {
    return {
      available: true,
      note: `本机服务拉到了新代码，但构建失败，产物还是旧的：${signal.updateMessage ?? '原因见服务日志'}`,
    };
  }
  return { available: false, note: '' };
}
