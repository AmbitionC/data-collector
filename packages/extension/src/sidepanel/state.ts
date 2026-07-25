import { descriptorForHost } from '@data-collector/shared';

export type SidePanelState =
  | { phase: 'loading' }
  | { phase: 'connecting' }
  | { phase: 'unsupported' }
  | {
      phase: 'ready';
      url: string;
      sourceLabel: string;
      title: string;
      category: string;
      tags: string[];
      routeTargets?: string[];
      destinations?: { id: string; label: string; categories: string[] }[];
      defaultSinkIds?: string[];
    }
  | { phase: 'collecting'; activeStage: number }
  | { phase: 'saved'; path: string }
  | { phase: 'needs_attention'; message: string }
  | { phase: 'job_error'; message: string }
  | { phase: 'bridge_unavailable' }
  | { phase: 'replaced' }
  | { phase: 'identity_error' };

export interface SidePanelActions {
  capture(overrides: {
    userCategory?: string;
    userTags?: string[];
    sinks?: string[];
  }): Promise<void>;
  recapture(): Promise<void>;
  retry(): Promise<void>;
  copyPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
}

export interface BackgroundStatus {
  bridgeStatus: string;
  lastJobStatus?: string;
  lastJobUrl?: string;
  lastJobError?: string;
  lastOutputPath?: string;
  page: {
    supported: boolean;
    title: string;
    url: string;
    routeTargets?: string[];
    destinations?: { id: string; label: string; categories: string[] }[];
    defaultSinkIds?: string[];
  };
}

export function sidePanelStateFromStatus(status: BackgroundStatus): SidePanelState {
  if (status.bridgeStatus === 'connecting') return { phase: 'connecting' };
  if (status.bridgeStatus === 'replaced') return { phase: 'replaced' };
  if (status.bridgeStatus === 'identity_error') return { phase: 'identity_error' };
  if (status.bridgeStatus !== 'connected') return { phase: 'bridge_unavailable' };

  const jobBelongsToPage = Boolean(
    status.lastJobUrl && status.lastJobUrl === status.page.url,
  );
  if (jobBelongsToPage && status.lastJobStatus === 'needs_attention') {
    return {
      phase: 'needs_attention',
      message: '请在保留的页面中登录或打开单条详情，然后重新保存。',
    };
  }
  if (
    jobBelongsToPage &&
    ['queued', 'dispatched', 'collecting', 'organizing'].includes(status.lastJobStatus ?? '')
  ) {
    return {
      phase: 'collecting',
      activeStage:
        status.lastJobStatus === 'queued'
          ? 0
          : status.lastJobStatus === 'dispatched' || status.lastJobStatus === 'collecting'
            ? 1
            : 2,
    };
  }
  if (jobBelongsToPage && status.lastJobStatus === 'saved' && status.lastOutputPath) {
    return { phase: 'saved', path: status.lastOutputPath };
  }
  if (jobBelongsToPage && status.lastJobStatus === 'failed') {
    return { phase: 'job_error', message: status.lastJobError || '采集失败，请重新保存。' };
  }
  if (!status.page.supported) return { phase: 'unsupported' };
  return {
    phase: 'ready',
    url: status.page.url,
    sourceLabel: descriptorForHost(new URL(status.page.url).hostname)?.label ?? '内容',
    title: status.page.title || '未命名内容',
    category: '',
    tags: [],
    ...(status.page.routeTargets?.length ? { routeTargets: status.page.routeTargets } : {}),
    ...(status.page.destinations?.length ? { destinations: status.page.destinations } : {}),
    ...(status.page.defaultSinkIds?.length ? { defaultSinkIds: status.page.defaultSinkIds } : {}),
  };
}

function required<T extends Element>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`侧栏缺少元素：${selector}`);
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

function setConnectionLabel(document: Document, state: SidePanelState): void {
  const label = required<HTMLElement>(document, '#connection-label');
  const connected = [
    'unsupported',
    'ready',
    'collecting',
    'saved',
    'needs_attention',
    'job_error',
  ].includes(state.phase);
  const labels: Partial<Record<SidePanelState['phase'], string>> = {
    loading: '读取状态',
    connecting: '正在连接',
    bridge_unavailable: '服务离线',
    replaced: '已被接管',
    identity_error: '身份异常',
  };
  label.textContent = labels[state.phase] ?? '本机在线';
  label.dataset.connected = String(connected);
}

export function renderSidePanel(
  document: Document,
  state: SidePanelState,
  actions: SidePanelActions,
): void {
  hidePanels(document);
  setConnectionLabel(document, state);

  if (state.phase === 'loading') {
    show(document, '#loading-panel');
    return;
  }
  if (state.phase === 'connecting') {
    show(document, '#connecting-panel');
    return;
  }
  if (state.phase === 'bridge_unavailable') {
    show(document, '#bridge-unavailable-panel');
    required<HTMLButtonElement>(document, '#retry-button').onclick = () => {
      void actions.retry();
    };
    return;
  }
  if (state.phase === 'replaced') {
    show(document, '#replaced-panel');
    required<HTMLButtonElement>(document, '#replaced-retry-button').onclick = () => {
      void actions.retry();
    };
    return;
  }
  if (state.phase === 'identity_error') {
    show(document, '#identity-error-panel');
    return;
  }
  if (state.phase === 'unsupported') {
    show(document, '#unsupported-panel');
    return;
  }
  if (state.phase === 'ready') {
    const panel = show(document, '#ready-panel');
    required(document, '#source-label').textContent = state.sourceLabel;
    required(document, '#page-title').textContent = state.title;
    const routeHint = required<HTMLElement>(document, '#route-hint');
    const destinationSelect = required<HTMLSelectElement>(document, '#destination');
    const categorySelect = required<HTMLSelectElement>(document, '#category');
    const destinations = state.destinations ?? [];
    const defaultIds = state.defaultSinkIds ?? [];
    const defaultLabels = state.routeTargets ?? [];

    /** 「分类」选项随选定去向联动：取该去向的分类清单；默认路由取首个默认去向的清单。 */
    const applyCategories = (options: { preserve: boolean }): void => {
      const chosen = destinationSelect.value;
      const effectiveId = chosen || defaultIds[0] || '';
      const categories =
        destinations.find(sink => sink.id === effectiveId)?.categories ?? [];
      // 切换去向时尽量保留用户已选分类；换页面时按新页面的建议分类重置。
      const wanted = options.preserve ? categorySelect.value : state.category;
      categorySelect.replaceChildren();
      categorySelect.append(new Option('自动分类（由内容判定）', ''));
      for (const category of categories) categorySelect.append(new Option(category, category));
      categorySelect.value = categories.includes(wanted) ? wanted : '';
      categorySelect.disabled = categories.length === 0;
      const labels = chosen
        ? [destinations.find(sink => sink.id === chosen)?.label ?? chosen]
        : defaultLabels;
      routeHint.hidden = labels.length === 0;
      routeHint.textContent = labels.length ? `保存去向：${labels.join(' · ')}` : '';
    };

    // 仅在切换页面时重建选项/重置输入，避免轮询刷新覆盖用户正在填的内容。
    if (panel.dataset.url !== state.url) {
      panel.dataset.url = state.url;
      destinationSelect.replaceChildren();
      const defaultText = defaultLabels.length
        ? `默认（${defaultLabels.join(' · ')}）`
        : '默认去向';
      destinationSelect.append(new Option(defaultText, ''));
      for (const sink of destinations) destinationSelect.append(new Option(sink.label, sink.id));
      destinationSelect.value = '';
      destinationSelect.disabled = destinations.length === 0;
      required<HTMLInputElement>(document, '#tags').value = state.tags.join(', ');
      applyCategories({ preserve: false });
    }
    destinationSelect.onchange = () => applyCategories({ preserve: true });

    required<HTMLButtonElement>(document, '#capture-button').onclick = () => {
      const category = categorySelect.value.trim();
      const destination = destinationSelect.value;
      const tags = required<HTMLInputElement>(document, '#tags').value
        .split(/[,，]/)
        .map(tag => tag.trim())
        .filter(Boolean)
        .slice(0, 8);
      void actions.capture({
        ...(category ? { userCategory: category } : {}),
        ...(tags.length ? { userTags: tags } : {}),
        ...(destination ? { sinks: [destination] } : {}),
      });
    };
    return;
  }
  if (state.phase === 'collecting') {
    const panel = show(document, '#collecting-panel');
    const stages = ['识别页面', '清理正文', '归纳内容', '写入本机'];
    const activeStage = Math.max(0, Math.min(3, state.activeStage));
    panel.dataset.stage = String(activeStage);
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
    const panel = show(document, '#saved-panel');
    required(document, '#saved-path').textContent = state.path;
    const copyButton = required<HTMLButtonElement>(document, '#copy-path-button');
    if (panel.dataset.path !== state.path) {
      panel.dataset.path = state.path;
      copyButton.textContent = '复制文件路径';
    }
    copyButton.onclick = async () => {
      await actions.copyPath(state.path);
      if (panel.dataset.path === state.path) copyButton.textContent = '路径已复制';
    };
    required<HTMLButtonElement>(document, '#reveal-path-button').onclick = () => {
      void actions.revealPath(state.path);
    };
    return;
  }
  if (state.phase === 'needs_attention') {
    show(document, '#attention-panel');
    required(document, '#attention-message').textContent = state.message;
    required<HTMLButtonElement>(document, '#attention-recapture-button').onclick = () => {
      void actions.recapture();
    };
    return;
  }
  show(document, '#job-error-panel');
  required(document, '#job-error-message').textContent = state.message;
  required<HTMLButtonElement>(document, '#job-recapture-button').onclick = () => {
    void actions.recapture();
  };
}
