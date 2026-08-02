import { descriptorForHost, isListPage, parseSupportedUrl } from '@data-collector/shared';
import { injectionPlan } from './injection.js';
import {
  BridgeConnection,
  type ExtensionStorage,
  type SocketLike,
} from './connection.js';
import {
  JobRunner,
  type BrowserTab,
  type ExtractionResponse,
  type TabsApi,
} from './jobs.js';

const storage: ExtensionStorage = {
  get: keys => chrome.storage.local.get(keys),
  set: values => chrome.storage.local.set(values),
  remove: keys => chrome.storage.local.remove(keys),
};

const tabs: TabsApi = {
  create: async input => chrome.tabs.create(input) as Promise<BrowserTab>,
  remove: id => chrome.tabs.remove(id),
  update: async (id, input) => { await chrome.tabs.update(id, input); },
  query: async input => chrome.tabs.query(input as chrome.tabs.QueryInfo) as Promise<BrowserTab[]>,
  sendMessage: async (id, message) =>
    chrome.tabs.sendMessage(id, message) as Promise<ExtractionResponse>,
  // 注入而不是刷新：刷新会把知识星球的「精华」分类退回默认的「最新」，
  // 用户在精华页发起的采集就采成了别的内容。清单与理由见 injection.ts。
  inject: async (id: number) => {
    let url: string | undefined;
    try {
      url = (await chrome.tabs.get(id)).url;
    } catch {
      // 标签页刚被关掉：按「不需要主世界钩子」处理，内容脚本那步自己会抛错。
    }
    for (const step of injectionPlan(url)) {
      const done = chrome.scripting.executeScript({
        target: { tabId: id },
        files: step.files,
        ...(step.world ? { world: step.world } : {}),
      });
      if (step.required) await done;
      else await done.catch(() => undefined);
    }
  },
};

function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return chrome.tabs.get(tabId).then(tab => {
    if (tab.status === 'complete') return;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('页面加载超时'));
      }, timeoutMs);
      const onUpdated = (updatedId: number, change: { status?: string }) => {
        if (updatedId === tabId && change.status === 'complete') {
          cleanup();
          resolve();
        }
      };
      const onRemoved = (removedId: number) => {
        if (removedId === tabId) {
          cleanup();
          reject(new Error('采集标签页已关闭'));
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  });
}

const connection = new BridgeConnection({
  storage,
  extensionId: chrome.runtime.id,
  socketFactory: url => new WebSocket(url) as unknown as SocketLike,
  fetch,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: handle => clearInterval(handle as number),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as number),
});
const runner = new JobRunner({
  tabs,
  bridge: connection,
  waitForTabComplete,
  // 批量采集会跑很久，进度写进 storage 由侧栏轮询展示。
  reportBatch: progress => { void chrome.storage.local.set({ batch: progress }); },
  // 逐条结果单独存：明细列表要用，也方便出问题时直接看每条的判定。
  reportItems: items => { void chrome.storage.local.set({ batchItems: items }); },
  // 本机库是唯一的去重依据：采之前先问一遍库里有什么，已有的不再重复采。
  knownUrls: async () => {
    const entries = (await connection.library()) as { url?: unknown }[];
    return new Set(entries.map(entry => String(entry.url ?? '')).filter(Boolean));
  },
});
connection.onCollect((requestId, url) => runner.runRemoteJob(requestId, url));

async function configureSidePanel(): Promise<void> {
  const sidePanel = (chrome as typeof chrome & {
    sidePanel?: {
      setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
    };
  }).sidePanel;
  if (!sidePanel?.setPanelBehavior) return;
  await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function status() {
  const values = await chrome.storage.local.get([
    'bridgeStatus',
    'lastJobId',
    'lastJobStatus',
    'lastJobUrl',
    'lastJobError',
    'lastOutputPath',
    'lastSinkIds',
    'routing',
    'batch',
    'update',
    'loadedCommit',
    'batchItems',
  ]);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let supported = false;
  let list = false;
  let routeTargets: string[] = [];
  let destinations: { id: string; label: string; categories: string[] }[] = [];
  let defaultSinkIds: string[] = [];
  let syncTarget: string | undefined;
  if (tab?.url) {
    try {
      const parsed = parseSupportedUrl(tab.url);
      supported = true;
      // 列表 / 精华页：一屏多条，走批量保存而不是单页保存。
      list = isListPage(parsed);
      const source = descriptorForHost(new URL(tab.url).hostname)?.id;
      const routing = values.routing as
        | {
            sinks?: { id: string; label: string; categories: string[] }[];
            defaults?: Record<string, string[]>;
          }
        | undefined;
      if (Array.isArray(routing?.sinks)) destinations = routing.sinks;
      if (source && Array.isArray(routing?.defaults?.[source])) {
        defaultSinkIds = routing.defaults[source];
        routeTargets = defaultSinkIds.map(
          id => destinations.find(sink => sink.id === id)?.label ?? id,
        );
        // 路由表在新链路里表示「同步去向」：采集只落本机库，同步是之后的显式动作。
        syncTarget = routeTargets.find(label => label !== '本机库');
      }
    } catch {
      supported = false;
    }
  }
  // 本机服务构建出的版本和「本扩展加载时的版本」不一致 → 磁盘上已有新版，等一次重新加载。
  const built = (values.update as { commit?: string } | undefined)?.commit;
  const loaded = values.loadedCommit as string | undefined;
  return {
    bridgeStatus: values.bridgeStatus ?? 'disconnected',
    ...(built && loaded && built !== loaded ? { updateAvailable: true } : {}),
    lastJobId: values.lastJobId,
    lastJobStatus: values.lastJobStatus,
    lastJobUrl: values.lastJobUrl,
    lastJobError: values.lastJobError,
    lastOutputPath: values.lastOutputPath,
    lastSinkIds: values.lastSinkIds,
    batch: values.batch,
    batchItems: values.batchItems,
    page: {
      supported,
      list,
      title: tab?.title ?? '',
      url: tab?.url ?? '',
      routeTargets,
      destinations,
      defaultSinkIds,
      ...(syncTarget ? { syncTarget } : {}),
    },
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as { type?: string; overrides?: unknown };
  const action = async () => {
    if (request.type === 'status.get') return status();
    if (request.type === 'capture.current') {
      // 单页任务与批量记录互斥：同一页不可能两者同时进行，清掉另一边免得状态打架。
      await chrome.storage.local.remove(['batch', 'batchItems']);
      const jobId = await runner.captureCurrent(
        (request.overrides ?? {}) as {
          userCategory?: string;
          userTags?: string[];
          sinks?: string[];
        },
      );
      return { jobId };
    }
    if (request.type === 'capture.list') {
      await chrome.storage.local.set({
        lastJobId: '',
        lastJobStatus: '',
        lastJobUrl: '',
        lastJobError: '',
        lastOutputPath: '',
      });
      const overrides = (request.overrides ?? {}) as {
        userCategory?: string;
        userTags?: string[];
        sinks?: string[];
        maxItems?: number;
      };
      return runner.captureList(overrides, {
        // 采够目标条数就自动停，用户不必盯着手动停。
        ...(overrides.maxItems ? { maxItems: overrides.maxItems } : {}),
        // 「继续采下一批」是续采，保留上一批的处理标记；重新发起则先把页面还原。
        ...((request as { continuation?: boolean }).continuation === true
          ? { continuation: true }
          : {}),
      });
    }
    if (request.type === 'batch.report') {
      // 一份全量报告：批量记录 + 逐条结果 + 页面诊断（含主世界钩子统计）。
      // 用户要的是「一次性把问题解决」，那就让一次复制带走全部上下文。
      const values = await chrome.storage.local.get(['batch', 'batchItems']);
      const diagnostics = await runner
        .diagnoseList()
        .catch(error => `（页面诊断取不到：${error instanceof Error ? error.message : error}）`);
      return {
        report: [
          `构建版本：${chrome.runtime.getManifest().version}`,
          `时间：${new Date().toISOString()}`,
          '',
          '== 本轮批量 ==',
          JSON.stringify(values.batch ?? null, null, 2),
          '',
          '== 逐条结果 ==',
          JSON.stringify(values.batchItems ?? [], null, 2),
          '',
          '== 页面诊断 ==',
          diagnostics,
        ].join('\n'),
      };
    }
    if (request.type === 'list.itemDiagnose' && typeof (request as { key?: unknown }).key === 'string') {
      return { diagnostics: await runner.itemDiagnostics((request as { key: string }).key) };
    }
    if (request.type === 'library.list') {
      return { entries: await connection.library() };
    }
    if (request.type === 'library.entry' && typeof (request as { id?: unknown }).id === 'string') {
      return connection.libraryEntry((request as { id: string }).id);
    }
    if (request.type === 'library.sync') {
      return connection.syncLibrary({
        ...(Array.isArray((request as { ids?: unknown }).ids)
          ? { ids: (request as { ids: string[] }).ids }
          : {}),
        ...((request as { pending?: unknown }).pending === true ? { pending: true } : {}),
      });
    }
    if (request.type === 'library.delete') {
      const input = request as { ids?: string[]; all?: boolean };
      const outcome = await connection.deleteLibrary({
        ...(input.ids ? { ids: input.ids } : {}),
        ...(input.all ? { all: true } : {}),
      });
      // 清空只删得掉本机库里的文件，可「采过没有」的判断还挂在另外两处，
      // 库一空它们就是脏的：页面上的已处理标记会让重采整批跳过，
      // 上一轮的采集明细说的则是一批已经不存在的东西。一起清掉。
      if (input.all) {
        await chrome.storage.local.remove(['batch', 'batchItems']);
        await runner.resetPageMarks();
      }
      return outcome;
    }
    if (request.type === 'list.locate') {
      return { found: await runner.highlight(String((request as { key?: unknown }).key ?? '')) };
    }
    if (request.type === 'batch.stop') {
      runner.stopBatch();
      return { stopped: true };
    }
    if (request.type === 'batch.diagnose') {
      return { diagnostics: await runner.diagnoseList() };
    }
    if (request.type === 'batch.dismiss') {
      await chrome.storage.local.remove(['batch', 'batchItems']);
      return status();
    }
    if (request.type === 'extension.reload') {
      // 未打包扩展重新加载会重新读磁盘上的文件，等同于扩展管理页那个 ↻ 按钮。
      chrome.runtime.reload();
      return { reloading: true };
    }
    if (request.type === 'connection.retry') {
      await connection.retry();
      return status();
    }
    if (request.type === 'library.reveal' && typeof (request as { path?: unknown }).path === 'string') {
      await connection.reveal((request as { path: string }).path);
      return { revealed: true };
    }
    throw new Error('不支持的扩展操作');
  };
  void action()
    .then(value => sendResponse({ ok: true, value }))
    .catch(error =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '扩展操作失败',
      }),
    );
  return true;
});

/**
 * 记下「本次加载对应的代码版本」。onInstalled 在未打包扩展每次重新加载时都会触发，
 * 所以这就是「我现在跑的是哪一版」。之后本机服务构建出新版本，两者不一致即可提示。
 */
async function stampLoadedBuild(): Promise<void> {
  const { update } = await chrome.storage.local.get(['update']);
  const commit = (update as { commit?: string } | undefined)?.commit;
  await chrome.storage.local.set({ loadedCommit: commit ?? '' });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
  void configureSidePanel();
  void connection.start().then(stampLoadedBuild);
});
chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
  void connection.start();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'bridge-reconnect') void connection.start();
});
void configureSidePanel();
void connection.start();
