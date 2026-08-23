import { descriptorForHost, sourceLabel } from '@data-collector/shared';
import type { CollectionBatch, CollectionPlanId } from '@data-collector/shared';
import { BATCH_STALE_MS } from '../background/autoReload.js';
import type { BatchItem, BatchPhase } from '../background/jobs.js';

export type { BatchItem, BatchPhase };

export type TopPage = 'collect' | 'plans' | 'library';

export interface CollectionPlanStatus {
  id: CollectionPlanId;
  due: boolean;
  pending: boolean;
  nextRunAt: string;
  latest?: CollectionBatch;
}

/** 已入库的一条内容。 */
export interface LibraryEntry {
  id: string;
  source: string;
  title: string;
  url: string;
  category: string;
  updatedAt: string;
  /** 帖子自己的发布时间；站点没给就没有，界面退回采集时间并标注「录入」。 */
  publishedAt?: string;
  /** 缺省视为未同步：老条目没有这个字段。 */
  sync?: SyncInfo;
}

/**
 * 列表上显示的时间：**优先帖子自己的发布时间**。
 * 显示采集时间没有意义——用户想知道的是这条内容是什么时候发的。
 */
export function entryDate(entry: LibraryEntry): string {
  return entry.publishedAt
    ? entry.publishedAt.slice(0, 10)
    : `${entry.updatedAt.slice(0, 10)}（录入）`;
}

/**
 * 一条内容当前的同步状态（缺省未同步）。
 *
 * **「已提交但没推上去」一律按未完成算。** 用户的 Agent 是从远端读收件箱的，
 * 没推上去就等于没送到——这是他明确定下的口径：全部推送上去才算同步完成。
 *
 * 这里做归一而不是只信 `state` 字段，还因为库里存着 0.3.14 之前写下的旧记录：
 * 那时推送失败只算告警，条目被记成 `synced` + `pushed: false`。不归一的话，
 * 二十条全是「已同步·未推送」，底下按钮却显示「全部已同步」且不可点——
 * 想补推都没有入口。
 */
export function syncStateOf(entry: LibraryEntry): SyncInfo['state'] {
  const sync = entry.sync;
  if (!sync) return 'pending';
  if (isUnpushed(sync)) return 'failed';
  return sync.state;
}

/** 这一条是不是「已提交进仓库、只差推送」——按钮文案据此说「推送」而不是「同步」。 */
export function isUnpushed(sync: SyncInfo | undefined): boolean {
  if (sync?.state !== 'synced' || sync.pushed !== false) return false;
  // 没配置要推的去向也是 pushed:false，但那是有意为之，不该报成「未推送」。
  return Boolean(sync.pushFailed || sync.error);
}

/** 打开某条查看正文时的浮层状态。 */
export interface EntryView {
  id: string;
  title: string;
  loading: boolean;
  /** Markdown 正文；读取中或失败时为空。 */
  markdown?: string;
  truncated?: boolean;
  source?: string;
  category?: string;
  url?: string;
  absolutePath?: string;
  error?: string;
}

/** 一条已入库内容的同步状态。 */
export interface SyncInfo {
  state: 'pending' | 'synced' | 'failed';
  target?: string;
  at?: string;
  committed?: boolean;
  pushed?: boolean;
  /** 推送真失败（区别于「没配置要推」）。 */
  pushFailed?: boolean;
  error?: string;
}

/** 「已入库」页按同步状态筛选。 */
export type SyncFilter = 'all' | 'pending' | 'synced' | 'failed';

const SYNC_FILTER_LABELS: Record<SyncFilter, string> = {
  all: '全部',
  pending: '未同步',
  synced: '已同步',
  failed: '同步失败',
};

const SYNC_BADGES: Record<SyncInfo['state'], string> = {
  pending: '未同步',
  synced: '已同步',
  failed: '同步失败',
};

/**
 * 行内徽标。已提交但**没推上去**必须一眼看得出来。
 *
 * 原先一律显示「已同步」：条目确实写进了本机仓库，可用户的 Agent 是从 GitHub 读的，
 * 推不上去就等于没送到——他在 Agent 里问「处理收件箱」，得到的是「没有新的」，
 * 而侧栏这边二十条全绿。真踩过一次。
 */
function syncBadgeOf(sync: SyncInfo | undefined): string {
  if (isUnpushed(sync)) return '已同步·未推送';
  return SYNC_BADGES[sync?.state ?? 'pending'];
}

/** 明细列表的状态筛选。 */
export type ItemFilter = 'all' | 'saved' | 'skipped' | 'failed';

const FILTER_LABELS: Record<ItemFilter, string> = {
  all: '全部',
  saved: '已入库',
  skipped: '已跳过',
  failed: '失败',
};

const STATUS_LABELS: Record<BatchItem['status'], string> = {
  saved: '已入库',
  skipped: '已跳过',
  failed: '失败',
};

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
      /** 列表 / 精华页：一屏多条，保存动作是「批量」而不是「这一页」。 */
      list: boolean;
      routeTargets?: string[];
      destinations?: { id: string; label: string; categories: string[] }[];
      defaultSinkIds?: string[];
      /** 采集后这条内容之后会同步到哪个收件箱（采集本身只落本机库）。 */
      syncTarget?: string;
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
  | {
      /** 本轮明细：逐条列出采到 / 跳过 / 失败，点一条就滚回页面上的那条并高亮。 */
      phase: 'items';
      items: BatchItem[];
      filter: ItemFilter;
      log: string[];
    }
  | {
      phase: 'plans';
      plans: CollectionPlanStatus[];
      loading: boolean;
      runningPlanId?: CollectionPlanId;
      error?: string;
    }
  | {
      /** 「已入库」页面：查看本机知识库里已有的内容，并可删除 / 清空。 */
      phase: 'library';
      entries: LibraryEntry[];
      /** 按来源筛选；空串表示全部。 */
      source: string;
      /** 按同步状态筛选。 */
      syncFilter: SyncFilter;
      /** 正在同步中的条目 id（按钮据此禁用并显示进行中）。 */
      syncing?: string[];
      /** 上一次同步的结果摘要，如实展示成败与原因。 */
      syncNote?: string;
      /** 这一条会同步到哪（按来源），供 ready 面板与列表提示。 */
      syncTargets?: Record<string, string>;
      /** 待确认的破坏性操作（删除不可逆，必须二次确认）。 */
      pending?: { kind: 'one'; id: string; title: string } | { kind: 'all'; count: number };
      loading: boolean;
      error?: string;
      /** 正在查看的那一条（浮层）。 */
      viewing?: EntryView;
    }
  | { phase: 'saved'; path: string; targets: string[] }
  | { phase: 'needs_attention'; message: string }
  | { phase: 'job_error'; message: string }
  | { phase: 'bridge_unavailable' }
  | { phase: 'replaced' }
  | { phase: 'identity_error' };

export interface CaptureOverrides {
  userCategory?: string;
  userTags?: string[];
  sinks?: string[];
  /** 批量：本次要采够多少条，采够自动停（用户不必盯着手动停）。 */
  maxItems?: number;
  /** 连已入库的一起重采（采集器修好后整体刷新用）。 */
  refresh?: boolean;
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
  /** 打开 / 关闭「本轮明细」子页面。 */
  showItems(open: boolean): void;
  /** 切换明细的状态筛选。 */
  filterItems(filter: ItemFilter): void;
  /**
   * 点击某条：让页面滚过去并高亮它；没能入库的那些同时把证据包复制到剪贴板。
   * 「为什么这条被跳过」必须能一键取证，否则只能靠来回猜。
   */
  locateItem(key: string, status: BatchItem['status']): Promise<void>;
  /** 复制整轮的完整报告（运行记录 + 逐条结果 + 页面与钩子诊断），便于排查。 */
  copyLog(log: string[]): Promise<void>;
  /** 顶部页面切换。 */
  openPage(page: TopPage): void;
  /** 用户明确要求立即补跑/重试一条固定任务。 */
  runPlan(planId: CollectionPlanId, force: boolean): Promise<void>;
  /** 在新标签页打开计划对应站点，用于登录或人工核对。 */
  openPlanSource(url: string): void;
  /** 重新拉取已入库列表。 */
  reloadLibrary(): Promise<void>;
  /** 按来源筛选已入库列表。 */
  filterLibrary(source: string): void;
  /** 按同步状态筛选已入库列表。 */
  filterSync(filter: SyncFilter): void;
  /** 同步指定条目；不传 id 表示「同步全部未同步的」。 */
  syncLibrary(ids?: string[]): Promise<void>;
  /** 打开某条的正文浮层。 */
  openEntry(id: string, title: string): void;
  /** 关掉正文浮层。 */
  closeEntry(): void;
  /** 在浏览器里打开这条内容的原始地址。 */
  openSource(url: string): void;
  /** 请求删除（先进入确认态，不直接删）。 */
  askDelete(target: { kind: 'one'; id: string; title: string } | { kind: 'all'; count: number }): void;
  /** 确认执行删除。 */
  confirmDelete(): Promise<void>;
  /** 放弃删除。 */
  cancelDelete(): void;
  recapture(): Promise<void>;
  retry(): Promise<void>;
  copyPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  /** 重新加载扩展本身，让本机服务刚构建好的新版生效。 */
  reloadExtension(): Promise<void>;
}

export interface BatchStatus {
  url: string;
  log?: string[];
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
  /** 本机服务已经拉新并构建出更新的版本，等一次重新加载才会生效。 */
  updateAvailable?: boolean;
  /** 横幅上具体说什么：构建失败、自动重载没生效，都要如实说出来。 */
  updateNote?: string;
  lastJobStatus?: string;
  lastJobUrl?: string;
  lastJobError?: string;
  lastOutputPath?: string;
  /** 本篇真正写成功的去向 id（默认路由可能同时写多处）。 */
  lastSinkIds?: string[];
  batch?: BatchStatus;
  /** 本轮逐条结果，供「本轮明细」子页面展示。 */
  batchItems?: BatchItem[];
  page: {
    supported: boolean;
    list?: boolean;
    title: string;
    url: string;
    routeTargets?: string[];
    destinations?: { id: string; label: string; categories: string[] }[];
    defaultSinkIds?: string[];
    /** 本页来源之后会同步到哪个收件箱（采集本身只落本机库）。 */
    syncTarget?: string;
  };
}

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
    // 去向名从路由表反查：结果屏必须说清内容到底进了哪几处，
    // 而不是一律写「本地知识库」——选了「只存到收件箱」时那句话就是错的。
    const known = status.page.destinations ?? [];
    const targets = (status.lastSinkIds ?? []).map(
      id => known.find(sink => sink.id === id)?.label ?? id,
    );
    return { phase: 'saved', path: status.lastOutputPath, targets };
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
    list: status.page.list === true,
    ...(status.page.routeTargets?.length ? { routeTargets: status.page.routeTargets } : {}),
    ...(status.page.destinations?.length ? { destinations: status.page.destinations } : {}),
    ...(status.page.defaultSinkIds?.length ? { defaultSinkIds: status.page.defaultSinkIds } : {}),
    ...(status.page.syncTarget ? { syncTarget: status.page.syncTarget } : {}),
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
  const target = Number(required<HTMLInputElement>(document, '#target').value);
  // 「连已入库的一起重采」默认关着：平时本机库是去重依据，重复采只是浪费。
  const refresh = document.querySelector<HTMLInputElement>('#refresh')?.checked === true;
  return {
    ...(category ? { userCategory: category } : {}),
    ...(Number.isFinite(target) && target > 0 ? { maxItems: Math.min(60, Math.round(target)) } : {}),
    ...(refresh ? { refresh: true } : {}),
  };
}

function setConnectionLabel(document: Document, state: SidePanelState): void {
  const label = required<HTMLElement>(document, '#connection-label');
  const connected = [
    'unsupported',
    'ready',
    'collecting',
    'batch',
    'items',
    'plans',
    'library',
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
    note: '采完一屏会像人一样慢慢往下滚，加载出下一批。页面外观一动不动，随时可以肉眼核对。',
    tone: 'ok',
  },
  done: {
    heading: '本轮批量归档完成',
    note: '内容已落到本机库。去「已入库」核对后同步到收件箱，再让 Agent 拉去归档。',
    tone: 'ok',
  },
  capped: {
    heading: '已采够本次目标',
    note: '内容已落到本机库；本页可能还有更多帖子。'
      + '点「继续采下一批」接着采（已入库的不会重复），或去「已入库」核对后同步。',
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
  const itemsButton = required<HTMLButtonElement>(document, '#batch-items-button');
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
  // 打不开就把原因写在按钮上：静默无反应最难排查（曾经收件箱路径一律 400 且悄无声息）。
  revealButton.onclick = async () => {
    if (!outputPath) return;
    try {
      await actions.revealPath(outputPath);
    } catch {
      revealButton.textContent = '打不开，改用「复制路径」';
    }
  };

  stopButton.onclick = () => { void actions.stopBatch(); };
  // 「继续」是续采，保留已采标记；「重试」是重来一遍，先把页面还原成完整状态。
  continueButton.onclick = () => {
    void actions.captureList(collectOverrides(document), { continuation: true });
  };
  retryButton.onclick = () => { void actions.captureList(collectOverrides(document)); };
  // 明细入口：只要看到过帖子就该能逐条核对，不管这一批最后是什么结局。
  itemsButton.hidden = running || state.collected + state.skipped + state.failed === 0;
  itemsButton.onclick = () => actions.showItems(true);
  diagnoseButton.onclick = () => { void actions.diagnoseBatch(); };
  doneButton.onclick = () => { void actions.dismissBatch(); };
}

/**
 * 「有新版可加载」横幅。它独立于状态机，任何一屏都可能出现——
 * 本机服务已经把代码拉新并构建好了，只差扩展重新读一次磁盘。
 */
export function renderUpdateBanner(
  document: Document,
  update: { available: boolean; note?: string | undefined },
  actions: SidePanelActions,
): void {
  const banner = document.querySelector<HTMLElement>('#update-banner');
  if (!banner) return;
  banner.hidden = !update.available;
  // 横幅上的话由后台给：多数时候是「有新版，点一下加载」，但也可能是
  // 「构建失败，产物还是旧的」或「自动重载没生效」——不能一句话包打天下。
  const note = banner.querySelector<HTMLElement>('#update-note');
  if (note && update.note) note.textContent = update.note;
  const button = banner.querySelector<HTMLButtonElement>('#update-reload-button');
  if (button) button.onclick = () => { void actions.reloadExtension(); };
}

function renderItems(
  document: Document,
  state: Extract<SidePanelState, { phase: 'items' }>,
  actions: SidePanelActions,
): void {
  show(document, '#items-panel');
  const counts: Record<ItemFilter, number> = {
    all: state.items.length,
    saved: state.items.filter(item => item.status === 'saved').length,
    skipped: state.items.filter(item => item.status === 'skipped').length,
    failed: state.items.filter(item => item.status === 'failed').length,
  };
  required(document, '#items-heading').textContent = `本轮看到 ${counts.all} 条`;
  const hint = required<HTMLElement>(document, '#items-hint');
  const unresolved = counts.skipped + counts.failed;
  hint.hidden = unresolved === 0;
  hint.textContent = '点未入库的条目：页面滚过去并高亮，同时把「为什么没成」的证据复制到剪贴板。';

  const filters = required<HTMLElement>(document, '#items-filters');
  filters.replaceChildren();
  for (const filter of ['all', 'saved', 'skipped', 'failed'] as const) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = `${FILTER_LABELS[filter]} ${counts[filter]}`;
    chip.setAttribute('aria-pressed', String(state.filter === filter));
    chip.onclick = () => actions.filterItems(filter);
    filters.append(chip);
  }

  const visible = state.filter === 'all'
    ? state.items
    : state.items.filter(item => item.status === state.filter);
  const list = required<HTMLElement>(document, '#items-list');
  list.replaceChildren();
  for (const item of visible) {
    const row = document.createElement('li');
    row.dataset.status = item.status;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item-open';
    const title = document.createElement('span');
    title.className = 'item-title';
    title.textContent = item.title || '（无标题）';
    const meta = document.createElement('span');
    meta.className = 'item-meta';
    const status = document.createElement('span');
    status.className = 'item-status';
    status.textContent = STATUS_LABELS[item.status];
    meta.append(status);
    if (item.reason) {
      const reason = document.createElement('span');
      reason.textContent = item.reason;
      meta.append(reason);
    }
    button.append(title, meta);
    button.onclick = () => { void actions.locateItem(item.key, item.status); };
    row.append(button);
    list.append(row);
  }
  required<HTMLElement>(document, '#items-empty').hidden = visible.length > 0;
  required<HTMLButtonElement>(document, '#items-back-button').onclick = () => actions.showItems(false);
  required<HTMLButtonElement>(document, '#items-log-button').onclick = () => {
    void actions.copyLog(state.log);
  };
}

/**
 * 已入库条目的正文浮层。
 *
 * 「点开看不了内容」等于这个页面白做——用户没法核对自己到底采到了什么。
 * 读取中 / 读失败都要说出来，绝不给一片空白让人以为内容就是空的。
 */
function renderEntryOverlay(
  document: Document,
  state: Extract<SidePanelState, { phase: 'library' }>,
  actions: SidePanelActions,
): void {
  const view = state.viewing;
  const overlay = document.querySelector<HTMLElement>('#entry-overlay');
  if (!overlay) return;
  overlay.hidden = !view;
  if (!view) return;
  const entry = state.entries.find(candidate => candidate.id === view.id);
  const syncState = entry ? syncStateOf(entry) : 'pending';
  const busy = (state.syncing ?? []).includes(view.id);
  const syncButton = required<HTMLButtonElement>(document, '#entry-sync');
  // 逐条核对完就地同步：这正是「逐个验证后同步远程」那一步。
  syncButton.disabled = busy || !entry;
  syncButton.textContent = busy
    ? '正在同步…'
    : syncState === 'synced' ? '重新同步这一条' : '同步这一条';
  syncButton.onclick = () => { void actions.syncLibrary([view.id]); };

  required(document, '#entry-title').textContent = view.title || '（无标题）';
  const meta = [
    view.source ? sourceLabel(view.source) : '',
    view.category ?? '',
    syncBadgeOf(entry?.sync) + (entry?.sync?.error ? `（${entry.sync.error}）` : ''),
    view.absolutePath ?? '',
  ].filter(Boolean);
  required(document, '#entry-meta').textContent = meta.join(' · ');

  const status = required<HTMLElement>(document, '#entry-status');
  const statusText = view.error
    ?? (view.loading ? '正在读取本机文件…' : view.truncated ? '内容较长，这里只显示前一部分。' : '');
  status.hidden = statusText === '';
  status.textContent = statusText;

  required(document, '#entry-body').textContent = view.markdown ?? '';

  const openSource = required<HTMLButtonElement>(document, '#entry-open-source');
  openSource.hidden = !view.url;
  openSource.onclick = () => { if (view.url) actions.openSource(view.url); };

  const reveal = required<HTMLButtonElement>(document, '#entry-reveal');
  reveal.hidden = !view.absolutePath;
  reveal.onclick = async () => {
    if (!view.absolutePath) return;
    try {
      await actions.revealPath(view.absolutePath);
    } catch {
      reveal.textContent = '打不开，改用文件管理器';
    }
  };
  required<HTMLButtonElement>(document, '#entry-close').onclick = () => actions.closeEntry();
}

function renderLibrary(
  document: Document,
  state: Extract<SidePanelState, { phase: 'library' }>,
  actions: SidePanelActions,
): void {
  show(document, '#library-panel');
  renderEntryOverlay(document, state, actions);
  const sources = [...new Set(state.entries.map(entry => entry.source))].sort();
  const visible = state.entries
    .filter(entry => !state.source || entry.source === state.source)
    .filter(entry => state.syncFilter === 'all' || syncStateOf(entry) === state.syncFilter);
  const pendingCount = state.entries.filter(entry => syncStateOf(entry) !== 'synced').length;

  required(document, '#library-heading').textContent = state.loading
    ? '正在读取…'
    : `已入库 ${state.entries.length} 条`;

  const filters = required<HTMLElement>(document, '#library-filters');
  filters.replaceChildren();
  for (const source of ['', ...sources]) {
    const count = source
      ? state.entries.filter(entry => entry.source === source).length
      : state.entries.length;
    const chip = document.createElement('button');
    chip.type = 'button';
    // 筛选值仍是标识（要和索引对得上），显示的必须是人话。
    chip.textContent = `${source ? sourceLabel(source) : '全部'} ${count}`;
    chip.setAttribute('aria-pressed', String(state.source === source));
    chip.onclick = () => actions.filterLibrary(source);
    filters.append(chip);
  }

  const list = required<HTMLElement>(document, '#library-list');
  list.replaceChildren();
  for (const entry of visible) {
    const row = document.createElement('li');
    row.dataset.id = entry.id;
    // 整行可点 → 打开正文浮层。此前这里是个 <span>，压根点不动，
    // 用户看不到自己采到了什么，「已入库」页也就只剩一张没用的清单。
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'item-open';
    const label = document.createElement('span');
    label.className = 'item-title';
    label.textContent = entry.title || '（无标题）';
    const meta = document.createElement('span');
    meta.className = 'item-meta';
    const tag = document.createElement('span');
    tag.className = 'item-status';
    // 显示来源名而不是内部标识：用户不该在界面上看到 zsxq 这种东西。
    tag.textContent = sourceLabel(entry.source);
    const when = document.createElement('span');
    when.textContent = `${entry.category} · ${entryDate(entry)}`;
    // 同步状态必须在列表上一眼可见：这是「该同步哪些」的唯一依据。
    const sync = document.createElement('span');
    const syncState = syncStateOf(entry);
    sync.className = 'item-sync';
    sync.dataset.sync = isUnpushed(entry.sync) ? 'unpushed' : syncState;
    sync.textContent = syncBadgeOf(entry.sync);
    meta.append(tag, when, sync);
    open.append(label, meta);
    open.onclick = () => actions.openEntry(entry.id, entry.title);

    // 按钮和标签**必须长得不一样**：早先两者都是同一种小药丸，
    // 来源、同步状态、同步、删除四个东西并排且外观相同，根本看不出哪个能点。
    const syncOne = document.createElement('button');
    syncOne.type = 'button';
    syncOne.className = 'row-button';
    const busy = (state.syncing ?? []).includes(entry.id);
    syncOne.disabled = busy;
    syncOne.textContent = busy
      ? '同步中…'
      : isUnpushed(entry.sync) ? '推送' : syncState === 'synced' ? '重新同步' : '同步';
    syncOne.onclick = () => { void actions.syncLibrary([entry.id]); };

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-button danger';
    remove.textContent = '删除';
    remove.onclick = () => actions.askDelete({ kind: 'one', id: entry.id, title: entry.title });
    const actionsRow = document.createElement('span');
    actionsRow.className = 'item-actions';
    actionsRow.append(syncOne, remove);
    row.append(open, actionsRow);
    list.append(row);
  }
  // 同步状态筛选：核对时最常用的就是「只看未同步的」。
  const syncFilters = required<HTMLElement>(document, '#library-sync-filters');
  syncFilters.replaceChildren();
  for (const filter of ['all', 'pending', 'synced', 'failed'] as const) {
    const count = filter === 'all'
      ? state.entries.length
      : state.entries.filter(entry => syncStateOf(entry) === filter).length;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = `${SYNC_FILTER_LABELS[filter]} ${count}`;
    chip.setAttribute('aria-pressed', String(state.syncFilter === filter));
    chip.onclick = () => actions.filterSync(filter);
    syncFilters.append(chip);
  }

  required<HTMLElement>(document, '#library-empty').hidden = visible.length > 0 || state.loading;

  // 上一轮同步的结果：成败与原因都如实说出来，不静默。
  const syncNote = required<HTMLElement>(document, '#library-sync-note');
  syncNote.hidden = !state.syncNote;
  syncNote.textContent = state.syncNote ?? '';

  const syncButton = required<HTMLButtonElement>(document, '#library-sync-button');
  const syncing = (state.syncing ?? []).length > 0;
  syncButton.disabled = syncing || pendingCount === 0;
  // 待办全是「已提交只差推送」时，按钮就该直说是推送——否则用户看着一排
  // 「已同步·未推送」，却只有一个写着「同步」的按钮，根本不知道该点哪儿。
  const unpushedOnly =
    pendingCount > 0 && state.entries.filter(entry => syncStateOf(entry) !== 'synced')
      .every(entry => isUnpushed(entry.sync));
  syncButton.textContent = syncing
    ? '正在同步…'
    : pendingCount === 0
      ? '全部已同步'
      : unpushedOnly ? `推送 ${pendingCount} 条到远端` : `同步未同步的 ${pendingCount} 条`;
  syncButton.onclick = () => { void actions.syncLibrary(); };

  required<HTMLButtonElement>(document, '#library-refresh-button').onclick = () => {
    void actions.reloadLibrary();
  };
  const clearButton = required<HTMLButtonElement>(document, '#library-clear-button');
  clearButton.disabled = state.entries.length === 0;
  clearButton.onclick = () =>
    actions.askDelete({ kind: 'all', count: state.entries.length });

  // 删除失败是状态信息，留在页面上；确认走独立的模态框，两者别混在一起。
  const error = required<HTMLElement>(document, '#library-error');
  error.hidden = !state.error;
  error.textContent = state.error ?? '';

  renderConfirmModal(document, state.pending, actions);
}

/**
 * 删除确认框。
 *
 * 删除不可逆，因此值得一个**真正的模态对话框**：早先是把问题和两颗行内小药丸按钮
 * 塞进一行说明文字里，和普通提示长得一模一样、还挤在面板底部，既容易误点也不成体统。
 *
 * 三条：焦点默认落在「取消」（危险操作不该是回车就中的那个）、Esc 与点遮罩都等于取消、
 * 「确认删除」用危险色，不靠用户读文字来分辨。
 */
function renderConfirmModal(
  document: Document,
  pending: Extract<SidePanelState, { phase: 'library' }>['pending'],
  actions: SidePanelActions,
): void {
  const modal = document.querySelector<HTMLElement>('#confirm-modal');
  if (!modal) return;
  const wasOpen = modal.hidden === false;
  modal.hidden = !pending;
  if (!pending) return;

  required(document, '#library-confirm').textContent = pending.kind === 'all'
    ? `即将删除全部 ${pending.count} 条内容，连同它们的正文与图片一起从本机知识库中移除。此操作不可恢复。`
    : `即将删除「${pending.title}」，连同它的正文与图片一起从本机知识库中移除。此操作不可恢复。`;

  const yes = required<HTMLButtonElement>(document, '#library-confirm-yes');
  const no = required<HTMLButtonElement>(document, '#library-confirm-no');
  yes.textContent = pending.kind === 'all' ? `确认删除 ${pending.count} 条` : '确认删除';
  yes.onclick = () => { void actions.confirmDelete(); };
  no.onclick = () => actions.cancelDelete();
  required<HTMLElement>(document, '#confirm-scrim').onclick = () => actions.cancelDelete();
  modal.onkeydown = event => {
    if ((event as KeyboardEvent).key === 'Escape') actions.cancelDelete();
  };
  // 只在刚打开的那一次抢焦点，之后的重渲染不打断用户。
  if (!wasOpen) no.focus();
}

/** 顶部页面切换按钮的选中态。 */
export function renderTopNav(document: Document, page: TopPage, actions: SidePanelActions): void {
  const collect = document.querySelector<HTMLButtonElement>('#nav-collect');
  const plans = document.querySelector<HTMLButtonElement>('#nav-plans');
  const library = document.querySelector<HTMLButtonElement>('#nav-library');
  if (!collect || !plans || !library) return;
  collect.setAttribute('aria-pressed', String(page === 'collect'));
  plans.setAttribute('aria-pressed', String(page === 'plans'));
  library.setAttribute('aria-pressed', String(page === 'library'));
  collect.onclick = () => actions.openPage('collect');
  plans.onclick = () => actions.openPage('plans');
  library.onclick = () => actions.openPage('library');
}

const PLAN_PRESENTATION: Record<CollectionPlanId, {
  title: string;
  cadence: string;
  scope: string;
  url: string;
}> = {
  'zsxq-chen-teacher': {
    title: '陈老师的知识星球',
    cadence: '每天 08:00',
    scope: '最新 · 精华 · 只看星主',
    url: 'https://wx.zsxq.com/group/48844584441158',
  },
  'nowcoder-agent-market': {
    title: 'Agent 面经雷达',
    cadence: '每天 09:00',
    scope: '腾讯 · 字节 · 阿里 · 蚂蚁',
    url: 'https://www.nowcoder.com/search?query=Agent%20%E9%9D%A2%E7%BB%8F',
  },
};

const BATCH_STATUS_LABELS: Record<CollectionBatch['status'], string> = {
  running: '正在采集',
  completed: '已完成',
  completed_with_attention: '完成，需处理',
  failed: '运行失败',
};

function planTime(value: string | undefined): string {
  if (!value) return '尚无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function appendMetric(document: Document, parent: HTMLElement, label: string, value: number): void {
  const item = document.createElement('div');
  const count = document.createElement('strong');
  const name = document.createElement('span');
  count.textContent = String(value);
  name.textContent = label;
  item.append(count, name);
  parent.append(item);
}

function renderPlans(
  document: Document,
  state: Extract<SidePanelState, { phase: 'plans' }>,
  actions: SidePanelActions,
): void {
  show(document, '#plans-panel');
  const list = required<HTMLElement>(document, '#plans-list');
  const empty = required<HTMLElement>(document, '#plans-empty');
  const error = required<HTMLElement>(document, '#plans-error');
  list.replaceChildren();
  empty.hidden = state.loading || state.plans.length > 0;
  empty.textContent = state.loading ? '正在读取任务…' : '还没有可用的采集计划。';
  error.hidden = !state.error;
  error.textContent = state.error ?? '';

  for (const plan of state.plans) {
    const copy = PLAN_PRESENTATION[plan.id];
    const latest = plan.latest;
    const ticket = document.createElement('article');
    ticket.className = 'plan-ticket';
    ticket.dataset.planId = plan.id;

    const head = document.createElement('header');
    const heading = document.createElement('div');
    const kicker = document.createElement('p');
    const title = document.createElement('h3');
    const badge = document.createElement('span');
    kicker.className = 'plan-cadence';
    kicker.textContent = copy.cadence;
    title.textContent = copy.title;
    heading.append(kicker, title);
    badge.className = 'plan-status';
    badge.dataset.tone = latest?.status === 'failed' || (latest?.needsAttention ?? 0) > 0
      ? 'warn'
      : latest?.status === 'running'
        ? 'active'
        : 'ok';
    badge.textContent = plan.pending
      ? '等待浏览器'
      : latest
        ? BATCH_STATUS_LABELS[latest.status]
        : plan.due
          ? '等待首次运行'
          : '尚未运行';
    head.append(heading, badge);

    const scope = document.createElement('p');
    scope.className = 'plan-scope';
    scope.textContent = copy.scope;

    const spine = document.createElement('dl');
    spine.className = 'plan-spine';
    for (const [term, value] of [
      ['上次', planTime(latest?.startedAt)],
      ['下次', planTime(plan.nextRunAt)],
    ] as const) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      row.append(dt, dd);
      spine.append(row);
    }

    const metrics = document.createElement('div');
    metrics.className = 'plan-metrics';
    appendMetric(document, metrics, '入库', latest?.saved ?? 0);
    appendMetric(document, metrics, '跳过', latest?.skipped ?? 0);
    appendMetric(document, metrics, '失败', latest?.failed ?? 0);
    appendMetric(document, metrics, '需处理', latest?.needsAttention ?? 0);

    ticket.append(head, scope, spine, metrics);
    if (plan.id === 'nowcoder-agent-market') {
      const coverage = document.createElement('div');
      coverage.className = 'plan-coverage';
      coverage.setAttribute('aria-label', '公司覆盖');
      for (const [key, label] of [
        ['ByteDance', '字节'],
        ['Tencent', '腾讯'],
        ['Alibaba', '阿里'],
        ['Ant', '蚂蚁'],
      ] as const) {
        const cell = document.createElement('span');
        cell.textContent = `${label} ${latest?.coverage?.[key] ?? 0}`;
        coverage.append(cell);
      }
      ticket.append(coverage);
    }

    const footer = document.createElement('footer');
    const run = document.createElement('button');
    const source = document.createElement('button');
    run.type = 'button';
    run.className = 'primary-button plan-run';
    run.dataset.planRun = plan.id;
    run.disabled = state.runningPlanId === plan.id || latest?.status === 'running';
    run.textContent = state.runningPlanId === plan.id
      ? '正在启动…'
      : latest?.status === 'failed' || (latest?.needsAttention ?? 0) > 0
        ? '重试这一轮'
        : '立即运行';
    run.onclick = () => { void actions.runPlan(plan.id, true); };
    source.type = 'button';
    source.className = 'secondary-button plan-source';
    source.textContent = '打开站点 / 登录';
    source.onclick = () => actions.openPlanSource(copy.url);
    footer.append(run, source);
    ticket.append(footer);
    list.append(ticket);
  }
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
  if (state.phase === 'plans') {
    renderPlans(document, state, actions);
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
    const syncHint = required<HTMLElement>(document, '#sync-hint');
    const categorySelect = required<HTMLSelectElement>(document, '#category');
    const destinations = state.destinations ?? [];

    // 采集只落本机库，之后再由用户在「已入库」里显式同步。这里不再让用户选去向——
    // 选了也不会在采集时生效，摆一个不起作用的控件比没有更糟。
    routeHint.hidden = false;
    routeHint.textContent = '保存去向：本机库（采集只落本地）';
    syncHint.hidden = !state.syncTarget;
    syncHint.textContent = state.syncTarget
      ? `核对无误后，可在「已入库」里同步到 ${state.syncTarget}，再让 Agent 拉收件箱归档。`
      : '';

    /** 「分类」选项：优先用同步去向那套分类体系，它才是内容最终要去的地方。 */
    const applyCategories = (options: { preserve: boolean }): void => {
      const target = destinations.find(sink => sink.label === state.syncTarget);
      const fallback = destinations.find(sink => sink.categories.length > 0);
      const categories = [...(target ?? fallback)?.categories ?? []];
      // 换页面时按新页面的建议分类重置；同一页面刷新时保留用户已选。
      const wanted = options.preserve ? categorySelect.value : state.category;
      categorySelect.replaceChildren();
      categorySelect.append(new Option('自动分类（由内容判定）', ''));
      for (const category of categories) categorySelect.append(new Option(category, category));
      categorySelect.value = categories.includes(wanted) ? wanted : '';
      categorySelect.disabled = categories.length === 0;
    };

    // 重建选项的时机：切换页面，或 Bridge 侧的去向/分类发生变化（改了配置后无需重装扩展）。
    // 其余轮询刷新不动 DOM，避免覆盖用户正在填的内容。
    const routingSignature = JSON.stringify([destinations, state.syncTarget]);
    if (panel.dataset.url !== state.url || panel.dataset.routing !== routingSignature) {
      const sameUrl = panel.dataset.url === state.url;
      panel.dataset.url = state.url;
      panel.dataset.routing = routingSignature;
      applyCategories({ preserve: sameUrl });
    }

    // 列表 / 精华页一屏多条，单页保存会把整个信息流糊成一篇，这里改成批量入口。
    required(document, '#ready-copy').textContent = state.list ? '可批量保存' : '可以保存';
    required(document, '#capture-button-label').textContent = state.list
      ? '批量保存本页帖子'
      : '保存这一页';
    const listHint = required<HTMLElement>(document, '#list-hint');
    listHint.hidden = !state.list;
    // 目标条数只对批量有意义。
    required<HTMLElement>(document, '#target-label').hidden = !state.list;
    // 「连已入库的一起重采」只在列表页有意义（单页保存本来就是重采）。
    required<HTMLElement>(document, '#refresh-label').hidden = !state.list;
    required<HTMLElement>(document, '#target').hidden = !state.list;

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
  if (state.phase === 'items') {
    renderItems(document, state, actions);
    return;
  }
  if (state.phase === 'library') {
    renderLibrary(document, state, actions);
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
    // 标题必须说真话：默认路由写两处、选了「只存到收件箱」就只写一处，
    // 一律写死「内容已进入本地知识库」在后一种情况下是错的。
    required(document, '#saved-heading').textContent = state.targets.length
      ? `内容已进入 ${state.targets.join(' + ')}`
      : '内容已入库';
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
    const revealButton = required<HTMLButtonElement>(document, '#reveal-path-button');
    revealButton.onclick = async () => {
      try {
        await actions.revealPath(state.path);
      } catch {
        // 同上：失败必须看得见。
        revealButton.textContent = '打不开，改用「复制路径」';
      }
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
