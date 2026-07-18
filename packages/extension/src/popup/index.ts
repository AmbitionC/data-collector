import { renderPopup, type PopupActions, type PopupState } from './state.js';

interface BackgroundResponse<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

interface BackgroundStatus {
  bridgeStatus: string;
  lastJobStatus?: string;
  lastOutputPath?: string;
  page: { supported: boolean; title: string; url: string };
}

async function message<T>(payload: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(payload)) as BackgroundResponse<T>;
  if (!response.ok) throw new Error(response.error ?? '扩展操作失败');
  return response.value as T;
}

function sourceLabel(url: string): string {
  return new URL(url).hostname === 'mp.weixin.qq.com' ? '微信公众号' : '知识星球';
}

function toState(status: BackgroundStatus): PopupState {
  if (status.bridgeStatus === 'unpaired') return { phase: 'unpaired' };
  if (status.lastJobStatus === 'needs_attention') {
    return { phase: 'needs_attention', message: '请在保留的页面中登录或打开单条详情，然后重新保存。' };
  }
  if (['queued', 'dispatched', 'collecting'].includes(status.lastJobStatus ?? '')) {
    return {
      phase: 'collecting',
      activeStage: status.lastJobStatus === 'queued' ? 0 : status.lastJobStatus === 'dispatched' ? 1 : 2,
    };
  }
  if (status.lastJobStatus === 'saved' && status.lastOutputPath) {
    return { phase: 'saved', path: status.lastOutputPath };
  }
  if (status.bridgeStatus !== 'connected') {
    return { phase: 'error', message: '运行 Bridge 后点击“重新连接”。' };
  }
  if (!status.page.supported) return { phase: 'unsupported' };
  return {
    phase: 'ready',
    sourceLabel: sourceLabel(status.page.url),
    title: status.page.title || '未命名内容',
    category: '其他',
    tags: [],
  };
}

let pollTimer: number | undefined;

async function refresh(): Promise<void> {
  try {
    const status = await message<BackgroundStatus>({ type: 'status.get' });
    const state = toState(status);
    renderPopup(document, state, actions);
    if (state.phase === 'collecting') {
      pollTimer = window.setTimeout(() => { void refresh(); }, 700);
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
