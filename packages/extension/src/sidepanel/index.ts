import {
  sidePanelStateFromStatus,
  renderSidePanel,
  type BackgroundStatus,
  type CaptureOverrides,
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
 * 本地粘性错误（优先级最高，见 docs/sidepanel-states.md）。
 *
 * 用户点击后立刻失败、且失败信息没能写进 storage 的情况，只能活在侧栏本地。
 * 它**必须挡住轮询推导出来的状态**——否则下一次轮询就会把错误屏覆盖掉，
 * 用户只看到错误一闪而过然后莫名跳到别的屏（曾经就是这样把失败显示成「完成」的）。
 * 只有用户动作（重试 / 重连 / 关闭）能清除它。
 */
let stickyError: string | undefined;

function scheduleRefresh(phase: SidePanelState['phase']): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
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
  // 粘性错误挡住一切推导状态：不清掉它之前，轮询不许改屏。
  if (stickyError) {
    renderSidePanel(document, { phase: 'job_error', message: stickyError }, actions);
    scheduleRefresh('job_error');
    return;
  }
  try {
    const status = await message<BackgroundStatus>({ type: 'status.get' });
    const state = sidePanelStateFromStatus(status);
    renderSidePanel(document, state, actions);
    scheduleRefresh(state.phase);
  } catch {
    renderSidePanel(document, { phase: 'bridge_unavailable' }, actions);
    scheduleRefresh('bridge_unavailable');
  }
}

async function captureListPage(
  overrides: CaptureOverrides,
  options: { reloadFirst?: boolean } = {},
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
    // 批量自身的失败已经写进 batch 记录并由 refresh 呈现；
    // 走到这里说明连批量记录都没建起来（如找不到可采集的标签页）。
    showStickyError(error, '批量采集没能开始，请重试。');
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
  async revealPath(path) {
    await message({ type: 'library.reveal', path });
  },
};

renderSidePanel(document, { phase: 'loading' }, actions);
void refresh();
