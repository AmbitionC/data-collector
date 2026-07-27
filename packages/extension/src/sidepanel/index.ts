import {
  sidePanelStateFromStatus,
  renderSidePanel,
  renderTopNav,
  renderUpdateBanner,
  type BackgroundStatus,
  type CaptureOverrides,
  type ItemFilter,
  type LibraryEntry,
  type SidePanelActions,
  type SidePanelState,
} from './state.js';

interface BackgroundResponse<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const POLL_INTERVALS = {
  connecting: 250,
  collecting: 700,
  batch: 700,
  default: 1000,
} as const;

async function message<T>(payload: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(payload)) as BackgroundResponse<T>;
  if (!response.ok) throw new Error(response.error ?? '扩展操作失败');
  return response.value as T;
}

let pollTimer: number | undefined;

/**
 * 侧栏被关掉后就别再轮询了：页面已经不在，继续问后台纯属浪费，
 * 而且会往一个正在销毁的文档上渲染。
 */
let stopped = false;
window.addEventListener('pagehide', () => {
  stopped = true;
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
});

/**
 * 本地粘性错误（优先级最高，见 docs/sidepanel-states.md）。
 *
 * 用户点击后立刻失败、且失败信息没能写进 storage 的情况，只能活在侧栏本地。
 * 它**必须挡住轮询推导出来的状态**——否则下一次轮询就会把错误屏覆盖掉，
 * 用户只看到错误一闪而过然后莫名跳到别的屏（曾经就是这样把失败显示成「完成」的）。
 * 只有用户动作（重试 / 重连 / 关闭）能清除它。
 */
let stickyError: string | undefined;

/** 「本轮明细」子页面的开关与筛选，只活在侧栏本地（纯视图状态）。 */
let itemsOpen = false;
let itemsFilter: ItemFilter = 'all';

/** 「已入库」页面的本地视图状态。 */
let page: 'collect' | 'library' = 'collect';
let library: LibraryEntry[] = [];
let librarySource = '';
let libraryLoading = false;
let libraryPending: Extract<SidePanelState, { phase: 'library' }>['pending'];
let libraryError: string | undefined;

function libraryState(): SidePanelState {
  return {
    phase: 'library',
    entries: library,
    source: librarySource,
    loading: libraryLoading,
    ...(libraryPending ? { pending: libraryPending } : {}),
    ...(libraryError ? { error: libraryError } : {}),
  };
}

async function loadLibrary(): Promise<void> {
  libraryLoading = true;
  libraryError = undefined;
  renderSidePanel(document, libraryState(), actions);
  try {
    const { entries } = await message<{ entries: LibraryEntry[] }>({ type: 'library.list' });
    library = entries;
  } catch (error) {
    libraryError = errorMessage(error, '读取已入库内容失败。');
  } finally {
    libraryLoading = false;
    renderSidePanel(document, libraryState(), actions);
  }
}

function scheduleRefresh(phase: SidePanelState['phase']): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  if (stopped) return;
  const interval = phase === 'connecting'
    ? POLL_INTERVALS.connecting
    : phase === 'collecting'
      ? POLL_INTERVALS.collecting
      : phase === 'batch'
        ? POLL_INTERVALS.batch
        : POLL_INTERVALS.default;
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
    void refresh();
  }, interval);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function showStickyError(error: unknown, fallback: string): void {
  stickyError = errorMessage(error, fallback);
  renderSidePanel(document, { phase: 'job_error', message: stickyError }, actions);
  scheduleRefresh('job_error');
}

async function capturePage(
  overrides: { userCategory?: string; userTags?: string[]; sinks?: string[] },
): Promise<void> {
  stickyError = undefined;
  try {
    renderSidePanel(document, { phase: 'collecting', activeStage: 0 }, actions);
    scheduleRefresh('collecting');
    await message({ type: 'capture.current', overrides });
    await refresh();
  } catch (error) {
    showStickyError(error, '采集失败，请重新保存。');
  }
}

async function refresh(): Promise<void> {
  // 「已入库」是个独立页面，不跟着采集状态走。
  if (page === 'library') {
    renderTopNav(document, page, actions);
    renderSidePanel(document, libraryState(), actions);
    return;
  }
  renderTopNav(document, page, actions);
  // 粘性错误挡住一切推导状态：不清掉它之前，轮询不许改屏。
  if (stickyError) {
    renderSidePanel(document, { phase: 'job_error', message: stickyError }, actions);
    scheduleRefresh('job_error');
    return;
  }
  try {
    const status = await message<BackgroundStatus>({ type: 'status.get' });
    const derived = sidePanelStateFromStatus(status);
    // 明细是叠在批量结果之上的子页面：只有批量结果还在时才有意义。
    const state: SidePanelState = itemsOpen && derived.phase === 'batch'
      ? {
          phase: 'items',
          items: status.batchItems ?? [],
          filter: itemsFilter,
          log: status.batch?.log ?? [],
        }
      : derived;
    if (derived.phase !== 'batch') itemsOpen = false;
    renderSidePanel(document, state, actions);
    renderUpdateBanner(document, status.updateAvailable === true, actions);
    scheduleRefresh(state.phase === 'items' ? 'batch' : state.phase);
  } catch {
    renderSidePanel(document, { phase: 'bridge_unavailable' }, actions);
    scheduleRefresh('bridge_unavailable');
  }
}

/**
 * 「和后台失联」与「后台明确告诉我失败了」是两回事。
 *
 * 前者是浏览器抛出的原生英文报错（端口关闭 / 上下文失效），只说明这条消息回不来了，
 * 批量本身可能已经跑了一半——真相在批量记录里（含 E8「后台被回收」判定）。
 * 后者是后台深思熟虑给出的中文原因（如「当前没有可采集的浏览器页面」），
 * 必须原样粘在屏上给用户看，绝不能被别的状态盖掉。
 */
function isTransportError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /message port closed|could not establish connection|extension context invalidated|receiving end does not exist/i
    .test(text);
}

/** 后台是否已经为本页建起批量记录（建起来了就由它呈现终态，而不是原始报错）。 */
async function batchRecorded(): Promise<boolean> {
  try {
    const status = await message<BackgroundStatus>({ type: 'status.get' });
    return Boolean(status.batch && status.batch.url === status.page.url);
  } catch {
    return false;
  }
}

async function captureListPage(
  overrides: CaptureOverrides,
  options: { continuation?: boolean } = {},
): Promise<void> {
  stickyError = undefined;
  try {
    renderSidePanel(
      document,
      { phase: 'batch', batchPhase: 'running', collected: 0, skipped: 0, failed: 0, message: '' },
      actions,
    );
    // 批量会跑很久：先让轮询接管进度展示，不等这条消息返回。
    scheduleRefresh('batch');
    await message({ type: 'capture.list', overrides, ...options });
    await refresh();
  } catch (error) {
    // 批量要跑好几分钟，中途后台被回收时这条消息的端口会断，抛出来的是
    // 「message port closed」这类原生英文报错——那对用户毫无意义，而且会被粘性错误
    // 顶在最前面，把精心写好的「已中断，可续采」屏彻底盖住。
    // 只有这种失联才让位给批量记录；后台明说的失败原因照旧粘住。
    if (isTransportError(error) && (await batchRecorded())) await refresh();
    else showStickyError(error, '批量采集没能开始，请重试。');
  }
}

const actions: SidePanelActions = {
  async capture(overrides) {
    await capturePage(overrides);
  },
  async captureList(overrides, options) {
    await captureListPage(overrides, options ?? {});
  },
  async stopBatch() {
    try {
      await message({ type: 'batch.stop' });
    } finally {
      await refresh();
    }
  },
  async diagnoseBatch() {
    const button = document.querySelector<HTMLButtonElement>('#batch-diagnose-button');
    try {
      const { diagnostics } = await message<{ diagnostics: string }>({ type: 'batch.diagnose' });
      await navigator.clipboard.writeText(diagnostics);
      if (button) button.textContent = '诊断信息已复制';
    } catch {
      if (button) button.textContent = '复制失败，请重试';
    }
  },
  async dismissBatch() {
    stickyError = undefined;
    try {
      await message({ type: 'batch.dismiss' });
    } finally {
      await refresh();
    }
  },
  async recapture() {
    await capturePage({});
  },
  async retry() {
    stickyError = undefined;
    try {
      renderSidePanel(document, { phase: 'connecting' }, actions);
      scheduleRefresh('connecting');
      await message({ type: 'connection.retry' });
      await refresh();
    } catch {
      renderSidePanel(document, { phase: 'bridge_unavailable' }, actions);
      scheduleRefresh('bridge_unavailable');
    }
  },
  async copyPath(path) {
    await navigator.clipboard.writeText(path);
  },
  showItems(open) {
    itemsOpen = open;
    void refresh();
  },
  filterItems(filter) {
    itemsFilter = filter;
    void refresh();
  },
  async locateItem(key) {
    // 找不到说明那条已经被站点从 DOM 里回收了，如实提示而不是静默无反应。
    const { found } = await message<{ found: boolean }>({ type: 'list.locate', key });
    if (!found) {
      const empty = document.querySelector<HTMLElement>('#items-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = '这一条已经不在页面上了（站点可能已回收该节点），滚动或重新加载后再试。';
      }
    }
  },
  openPage(next) {
    page = next;
    libraryPending = undefined;
    libraryError = undefined;
    renderTopNav(document, page, actions);
    if (next === 'library') void loadLibrary();
    else void refresh();
  },
  async reloadLibrary() {
    libraryPending = undefined;
    await loadLibrary();
  },
  filterLibrary(source) {
    librarySource = source;
    renderSidePanel(document, libraryState(), actions);
  },
  askDelete(target) {
    // 只进入确认态，绝不在这里动文件。
    libraryPending = target;
    libraryError = undefined;
    renderSidePanel(document, libraryState(), actions);
  },
  cancelDelete() {
    libraryPending = undefined;
    renderSidePanel(document, libraryState(), actions);
  },
  async confirmDelete() {
    const target = libraryPending;
    if (!target) return;
    libraryPending = undefined;
    try {
      await message(
        target.kind === 'all'
          ? { type: 'library.delete', all: true }
          : { type: 'library.delete', ids: [target.id] },
      );
      await loadLibrary();
    } catch (error) {
      libraryError = errorMessage(error, '删除失败。');
      renderSidePanel(document, libraryState(), actions);
    }
  },
  async copyLog(log) {
    const button = document.querySelector<HTMLButtonElement>('#items-log-button');
    try {
      await navigator.clipboard.writeText(log.join('\n') || '（本轮没有记录）');
      if (button) button.textContent = '记录已复制';
    } catch {
      if (button) button.textContent = '复制失败';
    }
  },
  async reloadExtension() {
    // 扩展重新加载会连带关掉这个侧栏，重新打开就是新版了。
    await message({ type: 'extension.reload' }).catch(() => undefined);
  },
  async revealPath(path) {
    await message({ type: 'library.reveal', path });
  },
};

renderSidePanel(document, { phase: 'loading' }, actions);
renderTopNav(document, page, actions);
void refresh();
