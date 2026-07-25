import {
  sidePanelStateFromStatus,
  renderSidePanel,
  type BackgroundStatus,
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
  default: 1000,
} as const;

async function message<T>(payload: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(payload)) as BackgroundResponse<T>;
  if (!response.ok) throw new Error(response.error ?? '扩展操作失败');
  return response.value as T;
}

let pollTimer: number | undefined;

function scheduleRefresh(phase: SidePanelState['phase']): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  const interval = phase === 'connecting'
    ? POLL_INTERVALS.connecting
    : phase === 'collecting'
      ? POLL_INTERVALS.collecting
      : POLL_INTERVALS.default;
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
    void refresh();
  }, interval);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function capturePage(
  overrides: { userCategory?: string; userTags?: string[]; sinks?: string[] },
): Promise<void> {
  try {
    renderSidePanel(document, { phase: 'collecting', activeStage: 0 }, actions);
    scheduleRefresh('collecting');
    await message({ type: 'capture.current', overrides });
    await refresh();
  } catch (error) {
    renderSidePanel(
      document,
      { phase: 'job_error', message: errorMessage(error, '采集失败，请重新保存。') },
      actions,
    );
    scheduleRefresh('job_error');
  }
}

async function refresh(): Promise<void> {
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

const actions: SidePanelActions = {
  async capture(overrides) {
    await capturePage(overrides);
  },
  async recapture() {
    await capturePage({});
  },
  async retry() {
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
