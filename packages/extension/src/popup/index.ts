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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function capturePage(
  overrides: { userCategory?: string; userTags?: string[] },
): Promise<void> {
  try {
    renderPopup(document, { phase: 'collecting', activeStage: 0 }, actions);
    await message({ type: 'capture.current', overrides });
    await refresh();
  } catch (error) {
    renderPopup(
      document,
      { phase: 'job_error', message: errorMessage(error, '采集失败，请重新保存。') },
      actions,
    );
  }
}

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
    try {
      renderPopup(document, { phase: 'loading' }, actions);
      await message({ type: 'pair.submit', code });
      await refresh();
    } catch (error) {
      renderPopup(
        document,
        { phase: 'unpaired', message: errorMessage(error, '配对失败，请检查配对码。') },
        actions,
      );
    }
  },
  async capture(overrides) {
    await capturePage(overrides);
  },
  async recapture() {
    await capturePage({});
  },
  async retry() {
    try {
      await message({ type: 'connection.retry' });
      await refresh();
    } catch (error) {
      renderPopup(
        document,
        { phase: 'error', message: errorMessage(error, 'Bridge 重新连接失败。') },
        actions,
      );
    }
  },
  async copyPath(path) {
    await navigator.clipboard.writeText(path);
    const button = document.querySelector<HTMLButtonElement>('#copy-path-button');
    if (button) button.textContent = '路径已复制';
  },
  async revealPath(path) {
    await message({ type: 'library.reveal', path });
  },
};

renderPopup(document, { phase: 'loading' }, actions);
void refresh();
