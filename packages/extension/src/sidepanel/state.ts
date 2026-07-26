import { descriptorForHost } from '@data-collector/shared';
import type { BatchPhase } from '../background/jobs.js';

export type { BatchPhase };

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
      /** 列表 / 精华页：一屏多条，保存动作是「批量」而不是「这一页」。 */
      list: boolean;
      routeTargets?: string[];
      destinations?: { id: string; label: string; categories: string[] }[];
      defaultSinkIds?: string[];
    }
  | { phase: 'collecting'; activeStage: number }
  | {
      phase: 'batch';
      /** 见 docs/sidepanel-states.md：结束 ≠ 完成，每个终态有各自的文案与出路。 */
      batchPhase: BatchPhase;
      collected: number;
      skipped: number;
      failed: number;
      message: string;
      code?: string;
      /** 本批最后写入的文件路径：结果页据此提供「在文件夹中查看」，不让用户没头没尾。 */
      outputPath?: string;
    }
  | { phase: 'saved'; path: string }
  | { phase: 'needs_attention'; message: string }
  | { phase: 'job_error'; message: string }
  | { phase: 'bridge_unavailable' }
  | { phase: 'replaced' }
  | { phase: 'identity_error' };

export interface CaptureOverrides {
  userCategory?: string;
  userTags?: string[];
  sinks?: string[];
}

export interface SidePanelActions {
  capture(overrides: CaptureOverrides): Promise<void>;
  /** 批量保存当前列表页上的帖子；continuation 表示「继续采下一批」（保留已采标记）。 */
  captureList(overrides: CaptureOverrides, options?: { continuation?: boolean }): Promise<void>;
  /** 中止正在跑的批量。 */
  stopBatch(): Promise<void>;
  /** 导出页面结构样本（帖子拿不到各自链接时用于排查适配）。 */
  diagnoseBatch(): Promise<void>;
  /** 收起批量结果，回到可再次采集的状态。 */
  dismissBatch(): Promise<void>;
  recapture(): Promise<void>;
  retry(): Promise<void>;
  copyPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
}

export interface BatchStatus {
  url: string;
  collected: number;
  skipped: number;
  failed: number;
  rounds: number;
  phase: BatchPhase;
  error?: string;
  code?: string;
  updatedAt: number;
}

export interface BackgroundStatus {
  bridgeStatus: string;
  lastJobStatus?: string;
  lastJobUrl?: string;
  lastJobError?: string;
  lastOutputPath?: string;
  batch?: BatchStatus;
  page: {
    supported: boolean;
    list?: boolean;
    title: string;
    url: string;
    routeTargets?: string[];
    destinations?: { id: string; label: string; categories: string[] }[];
    defaultSinkIds?: string[];
  };
}

/** Service Worker 被回收时进度会停更；超过这个时长仍标 running 视为已中断。 */
const BATCH_STALE_MS = 90_000;

export function sidePanelStateFromStatus(
  status: BackgroundStatus,
  now: () => number = Date.now,
): SidePanelState {
  if (status.bridgeStatus === 'connecting') return { phase: 'connecting' };
  if (status.bridgeStatus === 'replaced') return { phase: 'replaced' };
  if (status.bridgeStatus === 'identity_error') return { phase: 'identity_error' };
  if (status.bridgeStatus !== 'connected') return { phase: 'bridge_unavailable' };

  // 批量结果属于发起它的那一页；换页面就不再打扰（与单页任务同一套归属判断）。
  const batch = status.batch;
  if (batch && batch.url === status.page.url) {
    // E8：Service Worker 被回收时进度停更，不能让侧栏永远转圈——按「已中断」处理。
    const stalled = batch.phase === 'running' && now() - batch.updatedAt >= BATCH_STALE_MS;
    const batchPhase: BatchPhase = stalled ? 'failed' : batch.phase;
    return {
      phase: 'batch',
      batchPhase,
      collected: batch.collected,
      skipped: batch.skipped,
      failed: batch.failed,
      message: stalled
        ? '浏览器回收了插件的后台进程，本批已中断。已入库的不会重复，可以直接续采。'
        : batch.error ?? '',
      ...(stalled ? { code: 'WORKER_EVICTED' } : batch.code ? { code: batch.code } : {}),
      // 采到东西了就得给出「东西在哪」——批量结束时 lastOutputPath 是本批最后写入的文件。
      ...(batch.collected > 0 && status.lastOutputPath
        ? { outputPath: status.lastOutputPath }
        : {}),
    };
  }

  const jobBelongsToPage = Boolean(
    status.lastJobUrl && status.lastJobUrl === status.page.url,
  );
  if (jobBelongsToPage && status.lastJobStatus === 'needs_attention') {
    return {
      phase: 'needs_attention',
      // 优先展示具体原因（如「页面脚本未就绪，请刷新」），没有时才用通用提示。
      message:
        status.lastJobError || '请在保留的页面中登录或打开单条详情，然后重新保存。',
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
    list: status.page.list === true,
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

/**
 * 读取「去向 / 分类 / 标签」三个控件当前的取值。
 * 批量结果面板上的「继续」也用它——ready 面板只是被隐藏，取值仍在，
 * 于是续采沿用用户这次选好的去向，而不是悄悄退回默认路由。
 */
function collectOverrides(document: Document): CaptureOverrides {
  const category = required<HTMLSelectElement>(document, '#category').value.trim();
  const destination = required<HTMLSelectElement>(document, '#destination').value;
  const tags = required<HTMLInputElement>(document, '#tags').value
    .split(/[,，]/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    ...(category ? { userCategory: category } : {}),
    ...(tags.length ? { userTags: tags } : {}),
    ...(destination ? { sinks: [destination] } : {}),
  };
}

function setConnectionLabel(document: Document, state: SidePanelState): void {
  const label = required<HTMLElement>(document, '#connection-label');
  const connected = [
    'unsupported',
    'ready',
    'collecting',
    'batch',
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

/** 每个批量终态的标题、说明与出路按钮；「结束」不等于「完成」。 */
const BATCH_COPY: Record<BatchPhase, { heading: string; note: string; tone: 'ok' | 'warn' }> = {
  running: {
    heading: '正在批量归档',
    note: '采完一屏会自动收起已处理的帖子并向下加载，侧栏可以保持打开。',
    tone: 'ok',
  },
  done: {
    heading: '本轮批量归档完成',
    note: '本页已经没有新的帖子了。',
    tone: 'ok',
  },
  capped: {
    heading: '已达单次上限',
    note: '本页可能还有更多帖子。点「继续采下一批」接着采，已入库的不会重复。',
    tone: 'ok',
  },
  stopped: {
    heading: '已停止',
    note: '已入库的内容都保留了。点「继续采下一批」可以接着采。',
    tone: 'ok',
  },
  empty: {
    heading: '本页没有找到可采集的帖子',
    note: '可能页面还没加载完，或当前不是帖子列表。等内容出现后再重试。',
    tone: 'warn',
  },
  skipped_all: {
    heading: '这些帖子无法分别入库',
    note: '每条必须带自己的帖子地址才能各自成篇，否则会算出同一个 ID 相互覆盖。这是页面结构适配问题——点下面的按钮复制诊断信息，发给我就能修。',
    tone: 'warn',
  },
  failed: {
    heading: '批量归档中断',
    note: '',
    tone: 'warn',
  },
};

function renderBatch(
  document: Document,
  state: Extract<SidePanelState, { phase: 'batch' }>,
  actions: SidePanelActions,
): void {
  const panel = show(document, '#batch-panel');
  const copy = BATCH_COPY[state.batchPhase];
  const running = state.batchPhase === 'running';
  panel.dataset.tone = copy.tone;

  required(document, '#batch-kicker').textContent = copy.tone === 'warn' ? '需要你处理' : '批量归档';
  required<HTMLElement>(document, '#batch-kicker').classList.toggle('warning', copy.tone === 'warn');
  required(document, '#batch-heading').textContent = copy.heading;
  required(document, '#batch-collected').textContent = String(state.collected);
  required(document, '#batch-skipped').textContent = String(state.skipped);
  required(document, '#batch-failed').textContent = String(state.failed);
  // 失败时优先展示具体原因；其余状态展示该状态的固定说明。
  required(document, '#batch-note').textContent = state.message || copy.note;

  const stopButton = required<HTMLButtonElement>(document, '#batch-stop-button');
  const continueButton = required<HTMLButtonElement>(document, '#batch-continue-button');
  const retryButton = required<HTMLButtonElement>(document, '#batch-retry-button');
  const diagnoseButton = required<HTMLButtonElement>(document, '#batch-diagnose-button');
  const doneButton = required<HTMLButtonElement>(document, '#batch-done-button');
  const revealButton = required<HTMLButtonElement>(document, '#batch-reveal-button');
  const pathLine = required<HTMLElement>(document, '#batch-path');

  const recoverable = ['empty', 'skipped_all', 'failed'].includes(state.batchPhase);
  stopButton.hidden = !running;
  continueButton.hidden = running || recoverable;
  retryButton.hidden = running || !recoverable;
  // 诊断按钮常驻在需要处理的终态上：结构适配问题不只出现在「全部跳过」这一种。
  diagnoseButton.hidden = running || !recoverable;
  doneButton.hidden = running;

  // 有产出就告诉用户东西落在哪、并给一个直接打开的入口。
  const outputPath = state.outputPath;
  pathLine.hidden = !outputPath;
  pathLine.textContent = outputPath ?? '';
  revealButton.hidden = running || !outputPath;
  revealButton.onclick = () => { if (outputPath) void actions.revealPath(outputPath); };

  stopButton.onclick = () => { void actions.stopBatch(); };
  // 「继续」是续采，保留已采标记；「重试」是重来一遍，先把页面还原成完整状态。
  continueButton.onclick = () => {
    void actions.captureList(collectOverrides(document), { continuation: true });
  };
  retryButton.onclick = () => { void actions.captureList(collectOverrides(document)); };
  diagnoseButton.onclick = () => { void actions.diagnoseBatch(); };
  doneButton.onclick = () => { void actions.dismissBatch(); };
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

    // 重建选项的时机：切换页面，或 Bridge 侧的去向/分类发生变化（改了配置后无需重装扩展）。
    // 其余轮询刷新不动 DOM，避免覆盖用户正在填的内容。
    const routingSignature = JSON.stringify([destinations, defaultIds]);
    const routingChanged = panel.dataset.routing !== routingSignature;
    if (panel.dataset.url !== state.url || routingChanged) {
      const sameUrl = panel.dataset.url === state.url;
      panel.dataset.url = state.url;
      panel.dataset.routing = routingSignature;
      // 仅路由变化（同一页面）时保留用户已选去向，避免打断正在进行的编辑。
      const keepDestination = sameUrl ? destinationSelect.value : '';
      destinationSelect.replaceChildren();
      const defaultText = defaultLabels.length
        ? `默认（${defaultLabels.join(' · ')}）`
        : '默认去向';
      destinationSelect.append(new Option(defaultText, ''));
      for (const sink of destinations) destinationSelect.append(new Option(sink.label, sink.id));
      destinationSelect.value = destinations.some(sink => sink.id === keepDestination)
        ? keepDestination
        : '';
      destinationSelect.disabled = destinations.length === 0;
      if (!sameUrl) required<HTMLInputElement>(document, '#tags').value = state.tags.join(', ');
      applyCategories({ preserve: sameUrl });
    }
    destinationSelect.onchange = () => applyCategories({ preserve: true });

    // 列表 / 精华页一屏多条，单页保存会把整个信息流糊成一篇，这里改成批量入口。
    required(document, '#ready-copy').textContent = state.list ? '可批量保存' : '可以保存';
    required(document, '#capture-button-label').textContent = state.list
      ? '批量保存本页帖子'
      : '保存这一页';
    const listHint = required<HTMLElement>(document, '#list-hint');
    listHint.hidden = !state.list;

    required<HTMLButtonElement>(document, '#capture-button').onclick = () => {
      const overrides = collectOverrides(document);
      void (state.list ? actions.captureList(overrides) : actions.capture(overrides));
    };
    return;
  }
  if (state.phase === 'batch') {
    renderBatch(document, state, actions);
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
