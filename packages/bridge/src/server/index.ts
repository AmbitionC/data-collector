import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { WebSocket, type RawData } from 'ws';
import {
  APP_VERSION,
  EXTENSION_REPLACED_CLOSE_CODE,
  EXTENSION_REPLACED_CLOSE_REASON,
  TRUSTED_EXTENSION_ID,
  bridgeAuthorizedPayloadSchema,
  COLLECTION_PLAN_IDS,
  descriptorForHost,
  extensionPlanResultPayloadSchema,
  jobResultPayloadSchema,
  wsEnvelopeSchema,
  stableContentId,
  type CollectedDocument,
  type JobRecord,
  type WsEnvelope,
} from '@data-collector/shared';
import { AccessTokenManager } from '../auth.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { JobStore } from '../jobs/store.js';
import type { ResolveAddresses } from '../library/assets.js';
import { loadSinksConfig, SinkRouter } from '../sinks/index.js';
import { attachExtensionWebSocket } from './websocket.js';
import { bearerToken, HttpError, isLoopback, readJson, sendJson } from './http.js';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearLibrary,
  deleteEntries,
  listLibrary,
  pendingIds,
  readEntry,
  syncEntries,
} from '../library/index.js';
import { buildStampCommit, updateWorkspace, type UpdateOutcome } from '../autoUpdate.js';
import { runTool, terminateActiveToolProcesses } from '../git.js';
import {
  FeJourneyCollector,
  FeJourneyCandidateIndex,
  discoverGithubProjects,
  discoverNowcoderPlanCandidates,
  discoverNowcoderUrls,
  saveCollectedDocument,
  type FeJourneyRunOptions,
  type FeJourneyRunReport,
} from '../feJourney/index.js';
import {
  CollectionPlanService,
  CollectionPlanStore,
  pendingNowcoderPlanJobs,
  selectNowcoderPlanCandidates,
  type ExtensionPlanResult,
} from '../plans/index.js';
import { writePlanBenchmark } from '../plans/benchmark.js';

/** 删除请求：要么给明确的 id 列表，要么显式 all:true —— 不接受隐式全删。 */
const deleteLibrarySchema = z.object({
  ids: z.array(z.string().min(1).max(200)).max(2_000).optional(),
  all: z.boolean().optional(),
});


const createJobSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  url: z.string().url().max(4096),
  requestedBy: z.enum(['codex', 'cli', 'extension']).default('cli'),
  /** 用户为本次采集显式选择的落地去向（sink id）；缺省按来源默认路由。 */
  sinks: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  batchId: z.string().trim().min(1).max(200).optional(),
  planId: z.enum(COLLECTION_PLAN_IDS).optional(),
}).superRefine((input, context) => {
  if (Boolean(input.batchId) !== Boolean(input.planId)) {
    context.addIssue({ code: 'custom', path: ['batchId'], message: 'batchId 与 planId 必须同时提供' });
  }
});
const progressSchema = z.object({ stage: z.enum(['collecting']) });
const errorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1000),
  needsAttention: z.boolean().optional(),
});
const revealSchema = z.object({ path: z.string().trim().min(1).max(4096) });
const syncLibrarySchema = z.object({
  ids: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  /** 同步全部未同步的条目；必须显式请求，绝不把「没传 ids」理解成「同步全部」。 */
  pending: z.boolean().optional(),
});
const runFeJourneySchema = z.object({
  force: z.boolean().default(false),
  nowcoder: z.boolean().default(true),
  github: z.boolean().default(true),
}).strict();

export interface StartBridgeOptions extends ConfigOverrides {
  fetch?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  reveal?: (path: string) => Promise<void>;
  /**
   * 自更新：仓库根目录。服务常驻在用户机器上，顺手把代码拉新并重新构建，
   * 用户只剩「重新加载插件」一步。
   *
   * **缺省关闭**：库函数被调用不该顺带跑 git / npm（测试、嵌入使用都会被殃及）。
   * 只有 CLI 的 `bridge start` 会显式打开它。
   */
  repoRoot?: string | null;
  /** 自更新检查间隔（毫秒），默认 10 分钟。 */
  updateIntervalMs?: number;
  /** 可注入的更新实现（测试用）。 */
  runUpdate?: (repoRoot: string) => Promise<UpdateOutcome>;
  /** 更新完成后怎么退出（默认 process.exit(0)，交给登录项拉起来）。测试用。 */
  exit?: () => void;
  /** 只有常驻 CLI 服务显式开启固定周期；嵌入式/测试启动不产生后台网络请求。 */
  enableFeJourneyScheduler?: boolean;
  /** 到期检查间隔，默认 15 分钟。 */
  feJourneyCheckIntervalMs?: number;
  /** 常驻服务才开启两个固定采集计划；测试/嵌入启动不产生定时任务。 */
  enableCollectionPlanScheduler?: boolean;
  collectionPlanCheckIntervalMs?: number;
}

export interface BridgeHandle {
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

/**
 * 仓库根目录：本文件在 <repo>/packages/bridge/dist/server/index.js，回退四层即仓库根。
 * 推导不出来（比如被单独拷贝出去用）就返回 undefined，自更新自动关闭。
 */
export function discoverRepoRoot(): string | undefined {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const root = resolvePath(here, '..', '..', '..', '..');
    return existsSync(join(root, '.git')) ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 浏览器实际加载的那份产物的构建标记。
 *
 * 「插件是不是最新的」只有这一个可靠依据：这个文件里写的，和扩展打包时烙进
 * `__BUILD_ID__` 的，是同一份内容的两种读法。拿 git HEAD 去比是不行的——
 * 构建失败时 HEAD 已经动了而产物没动，插件会永远显示「有新版」。
 */
async function readBuildId(repoRoot: string): Promise<string | undefined> {
  try {
    const text = await readFile(
      join(repoRoot, 'artifacts', 'data-collector-extension', 'build-id.txt'),
      'utf8',
    );
    return text.trim() || undefined;
  } catch {
    // 还没打包过就是没有，如实返回空，别编。
    return undefined;
  }
}

/** 真正去跑 git / npm；只在这里碰子进程，纯逻辑留在 autoUpdate.ts 里好测。 */
const processUpdateHost = {
  run: (command: string, args: readonly string[], cwd: string): Promise<string> =>
    runTool(command, args, cwd),
  builtCommit: async (repoRoot: string): Promise<string | undefined> => {
    const buildId = await readBuildId(repoRoot);
    return buildId ? buildStampCommit(buildId) : undefined;
  },
  now: () => new Date().toISOString(),
};

function envelope<T>(type: string, requestId: string, payload: T): WsEnvelope<string, T> {
  return {
    protocolVersion: 1,
    type,
    requestId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function messageText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

async function defaultReveal(path: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', path]]
      : process.platform === 'win32'
        ? ['explorer.exe', [`/select,${path}`]]
        : ['xdg-open', [dirname(path)]];
  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveSpawn();
    });
  });
}

/** 词法 + realpath 双重判断：candidate 是否确实落在 root 之内。 */
async function containedBy(root: string, candidate: string): Promise<boolean> {
  const lexicalRelative = relative(root, candidate);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) return false;
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    const realRelative = relative(realRoot, realCandidate);
    return !realRelative.startsWith('..') && !isAbsolute(realRelative);
  } catch {
    // 目录不存在或路径通过符号链接跑出去了，都不放行。
    return false;
  }
}

/**
 * 「在文件夹中查看」的越界校验。
 *
 * 允许的不止本机库：默认路由可能把内容只投到仓库收件箱，那时产出路径根本不在
 * 本机库下，只认库根目录会把这些条目一律 400 —— 用户点了按钮却毫无反应。
 * 放行范围严格等于「我们自己写过内容的根目录」，不多一个。
 */
async function verifiedRevealPath(roots: readonly string[], requestedPath: string): Promise<string> {
  const candidate = resolve(requestedPath);
  for (const root of roots) {
    if (root && (await containedBy(root, candidate))) return candidate;
  }
  throw new HttpError(400, 'INVALID_LIBRARY_PATH', '只能打开 Data Collector 自己写入的文件');
}

export async function startBridge(options: StartBridgeOptions = {}): Promise<BridgeHandle> {
  const config = loadConfig(options);
  const activeOperations = new Set<Promise<unknown>>();
  let closing = false;
  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation);
    void operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation),
    );
    return operation;
  };
  const drainActiveOperations = async (): Promise<void> => {
    while (activeOperations.size > 0) {
      await Promise.allSettled([...activeOperations]);
    }
  };
  const access = await AccessTokenManager.open(config.authFile);
  const jobs = await JobStore.open(config.jobsFile);
  await jobs.recover();
  let planStore: CollectionPlanStore | undefined;
  let planStoreError: string | undefined;
  try {
    planStore = await CollectionPlanStore.open(config.plansFile);
  } catch (error) {
    planStoreError = error instanceof Error ? error.message : String(error);
    console.warn(`[plans] ${planStoreError}`);
  }
  const sinksConfig = await loadSinksConfig(config.sinksFile);
  const router = SinkRouter.build(
    sinksConfig,
    {
      libraryRoot: config.libraryRoot,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
    },
    message => console.warn(`[sinks] ${message}`),
  );
  let candidateIndex: FeJourneyCandidateIndex | undefined;
  let candidateIndexError: string | undefined;
  try {
    candidateIndex = await FeJourneyCandidateIndex.open(config.libraryRoot);
  } catch (error) {
    candidateIndexError = `fe-journey 候选索引不可用：${error instanceof Error ? error.message : error}`;
    console.warn(`[fe-journey] ${candidateIndexError}`);
  }
  const reveal = options.reveal ?? defaultReveal;

  // 本次进程内的「任务 → 用户选定去向」覆盖表。Bridge 重启后该覆盖丢失，
  // 任务回退到来源默认路由（安全的降级，不会写到未选定的目标）。
  const sinkOverrides = new Map<string, string[]>();
  let extensionSocket: WebSocket | undefined;
  let extensionReady = false;

  // ── 自更新 ───────────────────────────────────────────────────────────
  // 失败一律只记录、不抛：更新是附加能力，绝不能把采集服务带下水。
  let update: UpdateOutcome | undefined;
  let restartPending = false;
  let feJourneyRuns = 0;
  const repoRoot = options.repoRoot ?? undefined;
  const runUpdate = options.runUpdate ?? (root => updateWorkspace(root, processUpdateHost));
  const exit = options.exit ?? ((): void => process.exit(0));

  /**
   * 服务自己也得重启一次，拉下来的服务端代码才作数——进程跑的是内存里那份旧的。
   * 登录项（launchd 的 KeepAlive / systemd 的 Restart=always）会立刻把它拉起来，
   * 用户什么都不用做。
   *
   * 只在**没有扩展连着、也没有任务在跑**的时候退出。采集途中退出会把 WebSocket 断掉，
   * 正在跑的那一批当场失败——绝不能为了更新去打断用户手头的事。浏览器一关就是安全窗口。
   */
  const maybeRestart = (): void => {
    if (!restartPending) return;
    if (extensionReady && extensionSocket?.readyState === WebSocket.OPEN) return;
    const inFlight = ['queued', 'dispatched', 'collecting'] as const;
    if (inFlight.some(status => jobs.list(status).length > 0)) return;
    if (feJourneyRuns > 0) return;
    restartPending = false;
    console.warn('[update] 新版本已构建，本机服务重启以生效');
    exit();
  };

  const checkForUpdate = async (): Promise<void> => {
    if (!repoRoot) return;
    try {
      update = await runUpdate(repoRoot);
      if (update.changed) console.warn(`[update] ${update.message}`);
      // 构建失败时产物还是旧的，重启只会把好好的服务换成同一份代码——没有意义。
      if (update.changed && !update.buildFailed) restartPending = true;
    } catch (error) {
      console.warn(`[update] 检查更新失败：${error instanceof Error ? error.message : error}`);
    }
    maybeRestart();
  };
  const updateTimer = repoRoot
    ? setInterval(() => void checkForUpdate(), options.updateIntervalMs ?? 10 * 60_000)
    : undefined;
  updateTimer?.unref?.();
  void checkForUpdate();

  const dispatch = async (job: JobRecord): Promise<void> => {
    if (!extensionReady || extensionSocket?.readyState !== WebSocket.OPEN || job.status !== 'queued') return;
    const jobSource = descriptorForHost(new URL(job.url).hostname)?.id;
    if (
      !candidateIndex &&
      (jobSource === 'nowcoder' || jobSource === 'github')
    ) {
      await jobs.transition(job.id, 'failed', {
        errorCode: 'FE_JOURNEY_INDEX_UNAVAILABLE',
        errorMessage: candidateIndexError ?? 'fe-journey 候选索引不可用',
      });
      return;
    }
    await jobs.transition(job.id, 'dispatched');
    extensionSocket.send(JSON.stringify(envelope('job.collect', job.id, {
      url: job.url,
      interactive: !job.batchId,
    })));
  };

  const dispatchQueued = async (): Promise<void> => {
    for (const job of jobs.list('queued')) await dispatch(job);
  };
  const collectorFetcher = options.fetch ?? fetch;

  const storedDocumentFor = async (job: JobRecord): Promise<CollectedDocument | undefined> => {
    if (!job.outputPath) return undefined;
    try {
      const raw = JSON.parse(await readFile(join(dirname(job.outputPath), 'source.json'), 'utf8')) as {
        document?: CollectedDocument;
      };
      return raw.document;
    } catch {
      return undefined;
    }
  };

  const collectionPlans = planStore
    ? new CollectionPlanService({
        store: planStore,
        jobs,
        extensionConnected: () => extensionReady && extensionSocket?.readyState === WebSocket.OPEN,
        discoverNowcoder: knownUrls => discoverNowcoderPlanCandidates(collectorFetcher, knownUrls),
        dispatch,
        collectZsxq: async (batchId, planId) => {
          if (!extensionReady || extensionSocket?.readyState !== WebSocket.OPEN) {
            throw new Error('Edge 扩展当前离线');
          }
          extensionSocket.send(JSON.stringify(envelope('plan.collect', batchId, { batchId, planId })));
        },
        shouldAutoSync: async job => {
          const document = await storedDocumentFor(job);
          if (!document) return false;
          if (job.planId === 'zsxq-chen-teacher') {
            return document.sourceMetadata?.authorRole === 'owner';
          }
          const grade = document.sourceMetadata?.evidenceGrade;
          return grade === 'A' || grade === 'B';
        },
        pendingNowcoderJobs: async deliveryBatchId => pendingNowcoderPlanJobs(
          jobs.list(),
          new Set(await pendingIds(config.libraryRoot, deliveryBatchId)),
        ),
        selectNowcoderJobs: async (planJobs, now) => {
          const readable: Array<{ job: JobRecord; document: CollectedDocument }> = [];
          const rejected: Array<{ url: string; reason: string }> = [];
          for (const planJob of planJobs) {
            const document = await storedDocumentFor(planJob);
            if (document) readable.push({ job: planJob, document });
            else rejected.push({ url: planJob.url, reason: '本机文档不可读' });
          }
          const selection = selectNowcoderPlanCandidates(
            readable.map(item => item.document),
            now,
          );
          const acceptedUrls = new Set(selection.accepted.map(document => document.canonicalUrl));
          return {
            accepted: readable
              .filter(item => acceptedUrls.has(item.document.canonicalUrl))
              .map(item => item.job),
            coverage: selection.coverage,
            rejected: rejected.concat(selection.rejected),
          };
        },
        coverageKey: async job => {
          if (job.planId !== 'nowcoder-agent-market') return undefined;
          const document = await storedDocumentFor(job);
          const grade = document?.sourceMetadata?.evidenceGrade;
          const company = document?.sourceMetadata?.company;
          return (grade === 'A' || grade === 'B') && typeof company === 'string'
            ? company
            : undefined;
        },
        syncJob: async (job, deliveryBatchId) => {
          const outcome = await syncEntries(
            config.libraryRoot,
            [stableContentId(job.url)],
            source => router.syncTarget(source),
            undefined,
            deliveryBatchId ? { deliveryBatchId } : {},
          );
          if (outcome.failed > 0 || outcome.synced === 0) throw new Error('自动同步未送达目标收件箱');
        },
        syncNowcoderJobs: async (planJobs, deliveryBatchId) => {
          const ids = [...new Set(planJobs.map(job => stableContentId(job.url)))];
          const outcome = await syncEntries(
            config.libraryRoot,
            ids,
            source => router.syncTarget(source),
            undefined,
            { deliveryBatchId, atomic: true },
          );
          if (outcome.failed > 0 || outcome.synced !== ids.length) {
            throw new Error('自动同步未送达目标收件箱');
          }
        },
        writeBenchmark: async (batch, jobs) => {
          await writePlanBenchmark(config.configDir, batch, jobs, {
            metadataFor: async job => {
              const document = await storedDocumentFor(job);
              if (!document) return undefined;
              return {
                company: document.sourceMetadata?.company,
                evidenceGrade: document.sourceMetadata?.evidenceGrade,
                questionCount: document.sourceMetadata?.questionCount,
                clusterId: document.feJourney?.clusterId,
              };
            },
          });
        },
      })
    : undefined;

  const feJourneyConfigured = sinksConfig.sinks['fe-journey']?.type === 'repo-inbox';
  const feJourneyEnabled = feJourneyConfigured && Boolean(candidateIndex);
  const feJourneyCollector = await FeJourneyCollector.open({
    stateFile: join(config.configDir, 'fe-journey-state.json'),
    enabled: feJourneyEnabled,
    ...(feJourneyConfigured && candidateIndexError ? { disabledError: candidateIndexError } : {}),
    now: () => new Date().toISOString(),
    knownNowcoderUrls: () => new Set(
      jobs.list()
        .filter(job => job.status !== 'failed' && job.status !== 'needs_attention')
        .map(job => job.url)
        .filter(url => url.startsWith('https://www.nowcoder.com/')),
    ),
    discoverNowcoder: knownUrls => discoverNowcoderUrls(collectorFetcher, knownUrls),
    enqueueNowcoder: async url => {
      const id = `fe-journey-nowcoder-${stableContentId(url)}`;
      const existing = jobs.get(id);
      if (existing) {
        if (existing.status !== 'failed' && existing.status !== 'needs_attention') return false;
        const retried = await jobs.retry(id);
        await dispatch(retried);
        return true;
      }
      const job = await jobs.create({ id, url, requestedBy: 'codex' });
      await dispatch(job);
      return true;
    },
    discoverGithub: () => discoverGithubProjects(collectorFetcher, () => new Date().toISOString()),
    saveGithub: async document => {
      const results = await saveCollectedDocument(router, candidateIndex, document);
      return results.some(result => result.sinkId === 'markdown' && result.ok);
    },
  });
  const runFeJourney = async (
    runOptions: FeJourneyRunOptions = {},
  ): Promise<FeJourneyRunReport> => {
    feJourneyRuns += 1;
    try {
      return await feJourneyCollector.run(runOptions);
    } finally {
      feJourneyRuns -= 1;
      // HTTP 手动触发时先让响应写回；常驻调度同样在本轮事件结束后再重启。
      setImmediate(maybeRestart);
    }
  };

  const handleSocketMessage = async (socket: WebSocket, data: RawData): Promise<void> => {
    const parsedEnvelope = wsEnvelopeSchema.parse(JSON.parse(messageText(data)));
    if (parsedEnvelope.type === 'extension.hello') {
      if (!extensionReady) await jobs.recover();
      extensionReady = true;
      await dispatchQueued();
      void collectionPlans?.onExtensionConnected({
        runDue: options.enableCollectionPlanScheduler ?? options.enableFeJourneyScheduler ?? false,
      }).catch(error => {
        console.warn(`[plans] 扩展重连补跑失败：${error instanceof Error ? error.message : error}`);
      });
      return;
    }
    if (parsedEnvelope.type === 'bridge.ping') {
      socket.send(JSON.stringify(envelope('bridge.pong', parsedEnvelope.requestId, {})));
      return;
    }
    if (parsedEnvelope.type === 'plan.result') {
      if (!collectionPlans) throw new Error(planStoreError ?? '固定采集计划不可用');
      const result = extensionPlanResultPayloadSchema.parse(parsedEnvelope.payload);
      await collectionPlans.onExtensionPlanResult(result as ExtensionPlanResult);
      return;
    }
    const job = jobs.get(parsedEnvelope.requestId);
    if (!job) throw new Error(`任务不存在：${parsedEnvelope.requestId}`);
    if (parsedEnvelope.type === 'job.progress') {
      progressSchema.parse(parsedEnvelope.payload);
      if (
        job.status === 'dispatched' ||
        (job.status === 'queued' && job.requestedBy === 'extension')
      ) {
        await jobs.transition(job.id, 'collecting');
      }
      return;
    }
    if (parsedEnvelope.type === 'job.result') {
      try {
        if (job.status === 'saved') return;
        const result = jobResultPayloadSchema.parse(parsedEnvelope.payload);
        if (result.document.canonicalUrl !== job.url) {
          throw new Error('回传内容 URL 与采集任务不一致');
        }
        if (job.status === 'dispatched') await jobs.transition(job.id, 'collecting');
        const override = sinkOverrides.get(job.id);
        const document: CollectedDocument = job.batchId && job.planId
          ? {
              ...(result.document as CollectedDocument),
              sourceMetadata: {
                ...(result.document.sourceMetadata ?? {}),
                batchId: job.batchId,
                planId: job.planId,
              },
            }
          : result.document as CollectedDocument;
        const sinkResults = await saveCollectedDocument(
          router,
          candidateIndex,
          document,
          override,
        );
        const succeeded = sinkResults.filter(sinkResult => sinkResult.ok);
        if (succeeded.length === 0) {
          const detail = sinkResults
            .map(sinkResult => `${sinkResult.sinkId}: ${sinkResult.detail?.error ?? '失败'}`)
            .join('；');
          throw new Error(`所有落地目标均失败：${detail || '无可用目标'}`);
        }
        const primary = succeeded[0]!;
        const saved = await jobs.transition(job.id, 'saved', { outputPath: primary.outputRef });
        socket.send(
          JSON.stringify(
            envelope('job.saved', job.id, { outputPath: primary.outputRef, results: sinkResults }),
          ),
        );
        await collectionPlans?.onJobTerminal(saved);
        return;
      } finally {
        sinkOverrides.delete(job.id);
      }
    }
    if (parsedEnvelope.type === 'job.error') {
      const error = errorSchema.parse(parsedEnvelope.payload);
      sinkOverrides.delete(job.id);
      const status = error.needsAttention ? 'needs_attention' : 'failed';
      const terminal = await jobs.transition(job.id, status, {
        errorCode: error.code,
        errorMessage: error.message,
      });
      await collectionPlans?.onJobTerminal(terminal);
      return;
    }
    throw new Error(`不支持的 WebSocket 消息：${parsedEnvelope.type}`);
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopback(request)) throw new HttpError(403, 'LOOPBACK_ONLY', '只允许本机访问');
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      // 每次都现读：用户自己跑一次 npm run package 也该立刻算数，不用等下一轮自更新。
      const buildId = repoRoot ? await readBuildId(repoRoot) : undefined;
      return sendJson(response, 200, {
        ok: true,
        version: APP_VERSION,
        trustedExtensionId: TRUSTED_EXTENSION_ID,
        extensionConnected: extensionReady && extensionSocket?.readyState === WebSocket.OPEN,
        routing: router.describeRouting(),
        // 同步去向：采集只落本机库，这里说明「之后会同步到哪」。
        syncTargets: router.describeSyncTargets(),
        ...(planStoreError ? { planError: planStoreError } : {}),
        // 扩展据此判断「我加载的是不是当前这一版」，是就不打扰，不是就自己重新加载。
        ...(buildId ? { buildId } : {}),
        ...(update ? { update } : {}),
      });
    }
    const jobMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    /*
     * `/v1/*` 一律需要令牌，**绝不用白名单逐条列举受保护路由**。
     *
     * 白名单会漂移：新增接口时忘了往名单里加，表现是这个接口上线即 404。
     * 实测踩过——/v1/library/entry 与 /v1/library/sync 就这样静静地 404 了，
     * 而扩展把 404 解读成「这一条已经不在本机知识库里了」，
     * 把人往完全错误的方向指。默认受保护，未知路径照旧落到末尾的 404。
     */
    if (!requestUrl.pathname.startsWith('/v1/')) {
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }

    const token = bearerToken(request) ?? '';
    if (!access.verify(token)) throw new HttpError(401, 'UNAUTHORIZED', '访问令牌无效');

    if (request.method === 'POST' && requestUrl.pathname === '/v1/jobs') {
      const input = createJobSchema.parse(await readJson(request));
      const job = await jobs.create({
        url: input.url,
        requestedBy: input.requestedBy,
        ...(input.id
          ? { id: input.id }
          : input.batchId
            ? { id: `${input.batchId}-${stableContentId(input.url)}` }
            : {}),
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
      });
      await collectionPlans?.onJobCreated(job);
      if (input.sinks?.length) sinkOverrides.set(job.id, input.sinks);
      sendJson(response, 202, job);
      if (job.requestedBy !== 'extension') await dispatch(job);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/plans/status') {
      if (!collectionPlans) {
        throw new HttpError(409, 'COLLECTION_PLANS_UNAVAILABLE', planStoreError ?? '固定采集计划不可用');
      }
      return sendJson(response, 200, collectionPlans.status());
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/plans/batches') {
      if (!collectionPlans) {
        throw new HttpError(409, 'COLLECTION_PLANS_UNAVAILABLE', planStoreError ?? '固定采集计划不可用');
      }
      const limit = z.coerce.number().int().min(1).max(100).parse(
        requestUrl.searchParams.get('limit') ?? '20',
      );
      const rawPlanId = requestUrl.searchParams.get('planId');
      const planId = rawPlanId === null ? undefined : z.enum(COLLECTION_PLAN_IDS).parse(rawPlanId);
      return sendJson(response, 200, {
        batches: collectionPlans.batches(limit, planId),
      });
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/plans/run') {
      if (!collectionPlans) {
        throw new HttpError(409, 'COLLECTION_PLANS_UNAVAILABLE', planStoreError ?? '固定采集计划不可用');
      }
      const input = z.object({
        planId: z.enum(COLLECTION_PLAN_IDS),
        force: z.boolean().optional(),
      }).strict().parse(await readJson(request));
      return sendJson(response, 202, await collectionPlans.run(
        input.planId,
        input.force === undefined ? {} : { force: input.force },
      ));
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/fe-journey/status') {
      return sendJson(response, 200, feJourneyCollector.status());
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/fe-journey/collect') {
      const input = runFeJourneySchema.parse(await readJson(request));
      if (!feJourneyCollector.status().enabled) {
        const status = feJourneyCollector.status();
        throw new HttpError(
          409,
          'FE_JOURNEY_DISABLED',
          status.error ?? '本机未启用固定 fe-journey 收件箱，定时采集保持关闭',
        );
      }
      return sendJson(response, 200, await runFeJourney(input));
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/library') {
      return sendJson(response, 200, { entries: await listLibrary(config.libraryRoot) });
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/library/entry') {
      const id = requestUrl.searchParams.get('id')?.trim() ?? '';
      if (!id) throw new HttpError(400, 'INVALID_REQUEST', '缺少条目 id');
      const entry = await readEntry(config.libraryRoot, id);
      // 索引里有、文件没了也算「找不到」——绝不返回一片空白让用户以为内容就是空的。
      if (!entry) throw new HttpError(404, 'ENTRY_NOT_FOUND', '这一条已经不在本机知识库里了');
      return sendJson(response, 200, entry);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/library/sync') {
      const input = syncLibrarySchema.parse(await readJson(request));
      const ids = input.pending ? await pendingIds(config.libraryRoot) : input.ids ?? [];
      const outcome = await syncEntries(
        config.libraryRoot,
        ids,
        source => router.syncTarget(source),
      );
      return sendJson(response, 200, outcome);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/library/delete') {
      const input = deleteLibrarySchema.parse(await readJson(request));
      const removeCandidates = (ids: readonly string[]): Promise<void> =>
        candidateIndex?.remove(ids) ?? Promise.resolve();
      // 「清空」必须显式请求，绝不把「没传 ids」理解成「删全部」。
      const outcome = input.all
        ? await clearLibrary(config.libraryRoot, removeCandidates)
        : await deleteEntries(config.libraryRoot, input.ids ?? [], removeCandidates);
      return sendJson(response, 200, outcome);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/reveal') {
      const input = revealSchema.parse(await readJson(request));
      const path = await verifiedRevealPath(
        [config.libraryRoot, ...router.revealRoots()],
        input.path,
      );
      await reveal(path);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'GET' && jobMatch?.[1]) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在');
      return sendJson(response, 200, job);
    }
    throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  };

  const server = createServer((request, response) => {
    void trackOperation(route(request, response).catch(error => {
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const code = error instanceof HttpError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : '未知错误';
      sendJson(response, status, { error: { code, message } });
    }));
  });

  const websocketServer = attachExtensionWebSocket({
    server,
    access,
    onConnection: (socket, authorization) => {
      if (authorization.bootstrapToken) {
        socket.send(
          JSON.stringify(
            envelope(
              'bridge.authorized',
              'authorization',
              bridgeAuthorizedPayloadSchema.parse({ token: authorization.bootstrapToken }),
            ),
          ),
        );
      }
      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        extensionSocket.close(
          EXTENSION_REPLACED_CLOSE_CODE,
          EXTENSION_REPLACED_CLOSE_REASON,
        );
      }
      extensionSocket = socket;
      extensionReady = false;
      let messageQueue: Promise<void> = Promise.resolve();
      let policyViolated = false;
      socket.on('message', data => {
        messageQueue = trackOperation(messageQueue
          .then(() => handleSocketMessage(socket, data))
          .catch(error => {
            if (policyViolated) return;
            policyViolated = true;
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify(
                  envelope('protocol.error', 'protocol', {
                    code: 'INVALID_MESSAGE',
                    message: error instanceof Error ? error.message : '消息无效',
                  }),
                ),
              );
              socket.close(1008, 'invalid protocol message');
            }
          }));
      });
      socket.once('close', () => {
        if (extensionSocket === socket) {
          extensionSocket = undefined;
          extensionReady = false;
        }
      });
    },
  });

  server.listen(config.port, config.host);
  await once(server, 'listening');
  let feJourneyTimer: NodeJS.Timeout | undefined;
  if (options.enableFeJourneyScheduler && feJourneyCollector.status().enabled) {
    const runScheduledCollection = (): void => {
      if (closing) return;
      void trackOperation(runFeJourney().catch(error => {
        console.warn(`[fe-journey] 定时采集失败：${error instanceof Error ? error.message : error}`);
      }));
    };
    runScheduledCollection();
    feJourneyTimer = setInterval(
      runScheduledCollection,
      options.feJourneyCheckIntervalMs ?? 15 * 60_000,
    );
    feJourneyTimer.unref?.();
  }
  let collectionPlanTimer: NodeJS.Timeout | undefined;
  if ((options.enableCollectionPlanScheduler ?? options.enableFeJourneyScheduler) && collectionPlans) {
    collectionPlanTimer = setInterval(() => {
      if (closing) return;
      void trackOperation(collectionPlans.runDuePlans().catch(error => {
        console.warn(`[plans] 到期检查失败：${error instanceof Error ? error.message : error}`);
      }));
    }, options.collectionPlanCheckIntervalMs ?? 15 * 60_000);
    collectionPlanTimer.unref?.();
  }
  const address = server.address() as AddressInfo;
  const url = `http://${config.host}:${address.port}`;
  let closePromise: Promise<void> | undefined;
  return {
    url,
    wsUrl: `ws://${config.host}:${address.port}/v1/extension`,
    close() {
      closePromise ??= (async () => {
        closing = true;
        if (updateTimer) clearInterval(updateTimer);
        // 服务已经明确进入关闭流程，不再等待外部更新命令优雅退出；立即收掉整棵树，
        // 否则忽略 TERM 的 git/npm 孙进程会反过来卡住 Node 的自然退出。
        terminateActiveToolProcesses('SIGKILL');
        if (feJourneyTimer) clearInterval(feJourneyTimer);
        if (collectionPlanTimer) clearInterval(collectionPlanTimer);
        for (const socket of websocketServer.clients) socket.close(1001, 'server shutdown');
        const websocketClosed = new Promise<void>(resolveClosed => {
          websocketServer.close(() => resolveClosed());
        });
        const serverClosed = server.listening ? once(server, 'close').then(() => undefined) : Promise.resolve();
        server.close();
        await Promise.all([serverClosed, websocketClosed]);
        await drainActiveOperations();
      })();
      return closePromise;
    },
  };
}
