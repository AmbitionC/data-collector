import { descriptorForHost, parseSupportedUrl } from '@data-collector/shared';
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
const runner = new JobRunner({ tabs, bridge: connection, waitForTabComplete });
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
    'routing',
  ]);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let supported = false;
  let routeTargets: string[] = [];
  let destinations: { id: string; label: string; categories: string[] }[] = [];
  let defaultSinkIds: string[] = [];
  if (tab?.url) {
    try {
      parseSupportedUrl(tab.url);
      supported = true;
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
      }
    } catch {
      supported = false;
    }
  }
  return {
    bridgeStatus: values.bridgeStatus ?? 'disconnected',
    lastJobId: values.lastJobId,
    lastJobStatus: values.lastJobStatus,
    lastJobUrl: values.lastJobUrl,
    lastJobError: values.lastJobError,
    lastOutputPath: values.lastOutputPath,
    page: {
      supported,
      title: tab?.title ?? '',
      url: tab?.url ?? '',
      routeTargets,
      destinations,
      defaultSinkIds,
    },
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as { type?: string; overrides?: unknown };
  const action = async () => {
    if (request.type === 'status.get') return status();
    if (request.type === 'capture.current') {
      const jobId = await runner.captureCurrent(
        (request.overrides ?? {}) as {
          userCategory?: string;
          userTags?: string[];
          sinks?: string[];
        },
      );
      return { jobId };
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

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
  void configureSidePanel();
  void connection.start();
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
