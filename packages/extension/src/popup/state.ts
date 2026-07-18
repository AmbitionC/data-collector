export type PopupState =
  | { phase: 'loading' }
  | { phase: 'unpaired' }
  | { phase: 'unsupported' }
  | {
      phase: 'ready';
      sourceLabel: string;
      title: string;
      category: string;
      tags: string[];
    }
  | { phase: 'collecting'; activeStage: number }
  | { phase: 'saved'; path: string }
  | { phase: 'needs_attention'; message: string }
  | { phase: 'error'; message: string };

export interface PopupActions {
  pair(code: string): Promise<void>;
  capture(overrides: { userCategory?: string; userTags?: string[] }): Promise<void>;
  retry(): Promise<void>;
  copyPath(path: string): Promise<void>;
}

function required<T extends Element>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`弹窗缺少元素：${selector}`);
  return element;
}

function hidePanels(document: Document): void {
  for (const panel of document.querySelectorAll<HTMLElement>('.state-panel')) panel.hidden = true;
}

function show(document: Document, selector: string): HTMLElement {
  const panel = required<HTMLElement>(document, selector);
  panel.hidden = false;
  return panel;
}

function setConnectionLabel(document: Document, state: PopupState): void {
  const label = required<HTMLElement>(document, '#connection-label');
  const connected = !['loading', 'unpaired', 'error'].includes(state.phase);
  label.textContent = state.phase === 'unpaired' ? '未配对' : connected ? '本机在线' : '检查连接';
  label.dataset.connected = String(connected);
}

export function renderPopup(
  document: Document,
  state: PopupState,
  actions: PopupActions,
): void {
  hidePanels(document);
  setConnectionLabel(document, state);

  if (state.phase === 'loading') {
    show(document, '#loading-panel');
    return;
  }
  if (state.phase === 'unpaired') {
    show(document, '#unpaired-panel');
    const form = required<HTMLFormElement>(document, '#pair-form');
    form.onsubmit = event => {
      event.preventDefault();
      const code = required<HTMLInputElement>(document, '#pair-code').value.trim();
      if (/^\d{6}$/.test(code)) void actions.pair(code);
    };
    return;
  }
  if (state.phase === 'unsupported') {
    show(document, '#unsupported-panel');
    return;
  }
  if (state.phase === 'ready') {
    show(document, '#ready-panel');
    required(document, '#source-label').textContent = state.sourceLabel;
    required(document, '#page-title').textContent = state.title;
    required<HTMLInputElement>(document, '#category').value = state.category;
    required<HTMLInputElement>(document, '#tags').value = state.tags.join(', ');
    required<HTMLButtonElement>(document, '#capture-button').onclick = () => {
      const category = required<HTMLInputElement>(document, '#category').value.trim();
      const tags = required<HTMLInputElement>(document, '#tags').value
        .split(/[,，]/)
        .map(tag => tag.trim())
        .filter(Boolean)
        .slice(0, 8);
      void actions.capture({
        ...(category ? { userCategory: category } : {}),
        ...(tags.length ? { userTags: tags } : {}),
      });
    };
    return;
  }
  if (state.phase === 'collecting') {
    show(document, '#collecting-panel');
    const stages = ['识别页面', '清理正文', '归纳内容', '写入本机'];
    const activeStage = Math.max(0, Math.min(3, state.activeStage));
    required(document, '#collecting-status').textContent = `正在${stages[activeStage]}`;
    for (const step of document.querySelectorAll<HTMLElement>('.track-step')) {
      const stage = Number(step.dataset.stage);
      step.classList.toggle('complete', stage < activeStage);
      step.classList.toggle('active', stage === activeStage);
      if (stage === activeStage) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
    return;
  }
  if (state.phase === 'saved') {
    show(document, '#saved-panel');
    required(document, '#saved-path').textContent = state.path;
    required<HTMLButtonElement>(document, '#copy-path-button').onclick = () => {
      void actions.copyPath(state.path);
    };
    return;
  }
  if (state.phase === 'needs_attention') {
    show(document, '#attention-panel');
    required(document, '#attention-message').textContent = state.message;
    return;
  }
  show(document, '#error-panel');
  required(document, '#error-message').textContent = state.message;
  required<HTMLButtonElement>(document, '#retry-button').onclick = () => { void actions.retry(); };
}
