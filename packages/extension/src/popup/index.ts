import {
  popupStateFromStatus,
  renderPopup,
  type BackgroundStatus,
  type PopupActions,
} from './state.js';

interface BackgroundResponse<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

async function message<T>(payload: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(payload)) as BackgroundResponse<T>;
  if (!response.ok) throw new Error(response.error ?? '扩展操作失败');
  return response.value as T;
}

let pollTimer: number | undefined;

async function refresh(): Promise<void> {
  try {
    const status = await message<BackgroundStatus>({ type: 'status.get' });
    const state = popupStateFromStatus(status);
    renderPopup(document, state, actions);
    if (state.phase === 'collecting' || state.phase === 'loading') {
      pollTimer = window.setTimeout(
        () => { void refresh(); },
        state.phase === 'loading' ? 250 : 700,
      );
    } else if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  } catch (error) {
    renderPopup(
      document,
      { phase: 'error', message: error instanceof Error ? error.message : '读取扩展状态失败' },
      actions,
    );
  }
}

const actions: PopupActions = {
  async pair(code) {
    renderPopup(document, { phase: 'loading' }, actions);
    await message({ type: 'pair.submit', code });
    await refresh();
  },
  async capture(overrides) {
    renderPopup(document, { phase: 'collecting', activeStage: 0 }, actions);
    await message({ type: 'capture.current', overrides });
    await refresh();
  },
  async retry() {
    await message({ type: 'connection.retry' });
    await refresh();
  },
  async copyPath(path) {
    await navigator.clipboard.writeText(path);
    const button = document.querySelector<HTMLButtonElement>('#copy-path-button');
    if (button) button.textContent = '路径已复制';
  },
};

renderPopup(document, { phase: 'loading' }, actions);
void refresh();
