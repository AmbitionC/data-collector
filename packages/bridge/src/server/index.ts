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
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  bridgeAuthorizedPayloadSchema,
  COLLECTION_PLAN_IDS,
  collectionPlanAttemptSchema,
  descriptorForHost,
  extensionHelloPayloadSchema,
  extensionPlanResultPayloadSchema,
  planStartedPayloadSchema,
  jobResultPayloadSchema,
  nowcoderDirectedCancelRequestSchema,
  nowcoderDirectedCancelResponseSchema,
  nowcoderDirectedRetryRequestSchema,
  nowcoderDirectedRetryResponseSchema,
  nowcoderDirectedStartRequestSchema,
  nowcoderDirectedStartResponseSchema,
  nowcoderSearchPreviewRequestSchema,
  nowcoderSearchPreviewResponseSchema,
  wsEnvelopeSchema,
  stableContentId,
  type CollectedDocument,
  type CollectionPlanAttempt,
  type JobRecord,
  type WsEnvelope,
} from '@data-collector/shared';
import { AccessTokenManager } from '../auth.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { JobStore } from '../jobs/store.js';
import type { ResolveAddresses } from '../library/assets.js';
import { loadSinksConfig, SinkRouter, type SinkResult } from '../sinks/index.js';
import { attachExtensionWebSocket } from './websocket.js';
import { bearerToken, HttpError, isLoopback, readJson, sendJson } from './http.js';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearLibrary,
  deleteEntries,
  listLibrary,
  loadZsxqLibraryIndex,
  pendingIds,
  readEntry,
  syncEntries,
} from '../library/index.js';
import {
  buildStampCommit,
  shouldDeferArtifactUpdate,
  updateWorkspace,
  type UpdateOutcome,
} from '../autoUpdate.js';
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
  PlanStartAcks,
  ZsxqDayLedgerStore,
  filterProcessedNowcoderDocuments,
  loadProcessedNowcoderHistory,
  pendingNowcoderPlanJobs,
  selectNowcoderPlanCandidates,
  type ExtensionPlanResult,
  planStartAckKey,
} from '../plans/index.js';
import { writePlanBenchmark } from '../plans/benchmark.js';
import {
  NowcoderDirectedBoundaryError,
  NowcoderDirectedService,
} from '../nowcoderDirected/service.js';
import { NowcoderDirectedStore } from '../nowcoderDirected/store.js';
import { NowcoderDirectedPublisher } from '../nowcoderDirected/publisher.js';
import {
  NowcoderDirectedSearchError,
  NowcoderDirectedSessionController,
} from '../nowcoderDirected/sessionController.js';
import { projectOrganized } from '../library/storedDocument.js';
import { NowcoderDirectedSelectionCoordinator } from '../nowcoderDirected/selection.js';
import {
  ArtifactReaderCoordinator,
  type ArtifactReaderCoordinatorLike,
  type ArtifactReaderHandle,
  type ArtifactUpdateIntent,
} from '../artifactReaderCoordinator.js';
import {
  acquireArtifactLease,
} from '../../../../scripts/artifact-lease.mjs';

/** 删除请求：要么给明确的 id 列表，要么显式 all:true —— 不接受隐式全删。 */
const deleteLibrarySchema = z.object({
  ids: z.array(z.string().min(1).max(200)).max(2_000).optional(),
  all: z.boolean().optional(),
});

const ZSXQ_COMPLETE_CONTENT_MINIMUM_EXTENSION_VERSION = '0.4.29';

function versionAtLeast(actual: string | undefined, minimum: string): boolean {
  if (!actual) return false;
  const parse = (value: string): number[] =>
    value.split('.').slice(0, 3).map(part => Number.parseInt(part, 10));
  const left = parse(actual);
  const right = parse(minimum);
  if (left.length !== 3 || right.length !== 3 || [...left, ...right].some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return true;
}


const createJobSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  url: z.string().url().max(4096),
  requestedBy: z.enum(['codex', 'cli', 'extension']).default('cli'),
  /** 用户为本次采集显式选择的落地去向（sink id）；缺省按来源默认路由。 */
  sinks: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  batchId: z.string().trim().min(1).max(200).optional(),
  planId: z.enum(COLLECTION_PLAN_IDS).optional(),
  attempt: collectionPlanAttemptSchema.optional(),
}).superRefine((input, context) => {
  if (Boolean(input.batchId) !== Boolean(input.planId)) {
    context.addIssue({ code: 'custom', path: ['batchId'], message: 'batchId 与 planId 必须同时提供' });
  }
  if (input.planId === 'zsxq-chen-teacher' && !input.attempt) {
    context.addIssue({ code: 'custom', path: ['attempt'], message: '知识星球计划子任务必须绑定尝试令牌' });
  }
  if (input.attempt && input.planId !== 'zsxq-chen-teacher') {
    context.addIssue({ code: 'custom', path: ['attempt'], message: '只有知识星球计划支持尝试令牌' });
  }
});
const progressSchema = z.object({ stage: z.enum(['collecting']) });
const SERVER_CLOSE_FAILED_MESSAGE = '本机服务未能安全关闭';
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

const DIRECTED_ROUTE_ERRORS: Record<string, {
  status: number;
  code: string;
  message: string;
}> = {
  '搜索会话已过期': {
    status: 410,
    code: 'NOWCODER_SESSION_EXPIRED',
    message: '牛客搜索会话已过期',
  },
  '所选候选不属于搜索会话': {
    status: 409,
    code: 'NOWCODER_CANDIDATE_NOT_OWNED',
    message: '所选候选不属于该牛客搜索会话',
  },
  '幂等键已用于不同请求': {
    status: 409,
    code: 'NOWCODER_IDEMPOTENCY_CONFLICT',
    message: '牛客定向幂等键已用于不同请求',
  },
  '重试必须使用新的幂等键': {
    status: 409,
    code: 'NOWCODER_IDEMPOTENCY_CONFLICT',
    message: '牛客定向重试必须使用新的幂等键',
  },
  '已有活跃定向运行': {
    status: 409,
    code: 'NOWCODER_ACTIVE_RUN_CONFLICT',
    message: '已有活跃的牛客定向运行',
  },
  '定向运行尝试已过期': {
    status: 409,
    code: 'NOWCODER_ATTEMPT_STALE',
    message: '牛客定向运行尝试已过期',
  },
  '定向运行已越过取消截止点': {
    status: 409,
    code: 'NOWCODER_PUBLISHING_CANCEL_CONFLICT',
    message: '牛客定向运行已越过取消截止点',
  },
};

function directedRouteError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof z.ZodError) {
    return new HttpError(400, 'INVALID_REQUEST', '牛客定向请求参数无效');
  }
  if (error instanceof NowcoderDirectedSearchError) {
    return new HttpError(503, error.code, error.message);
  }
  if (error instanceof NowcoderDirectedBoundaryError) {
    return new HttpError(error.status, error.code, error.message);
  }
  const known = error instanceof Error ? DIRECTED_ROUTE_ERRORS[error.message] : undefined;
  if (known) return new HttpError(known.status, known.code, known.message);
  return new HttpError(
    503,
    'NOWCODER_DIRECTED_UNAVAILABLE',
    '牛客定向服务暂时不可用',
  );
}

async function directedRoute<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw directedRouteError(error);
  }
}

function directedRouteId(raw: string): string {
  try {
    const id = decodeURIComponent(raw).trim();
    if (id.length === 0) throw new Error('empty');
    return id;
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', '牛客定向资源 ID 无效');
  }
}

export interface StartBridgeOptions extends ConfigOverrides {
  fetch?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  reveal?: (path: string) => Promise<void>;
  /**
   * artifact authority：稳定扩展产物所在的仓库根目录。知识星球 build-id 精确门禁与
   * package/sink 跨进程租约始终依赖它，不能因为关闭自动更新而一起关闭。
   *
   * **缺省不发现**：库函数被调用时不会猜仓库；生产 CLI 会显式传 discoverRepoRoot。
   */
  repoRoot?: string | null;
  /** 是否周期拉新并重新构建；repoRoot 存在时默认开启，`--no-update` 显式关闭。 */
  enableAutoUpdate?: boolean;
  /** 自更新检查间隔（毫秒），默认 10 分钟。 */
  updateIntervalMs?: number;
  /** 可注入的更新实现（测试用）。 */
  runUpdate?: (repoRoot: string) => Promise<UpdateOutcome>;
  /** 可注入的 artifact build-id 读取实现（测试竞态用）。 */
  readArtifactBuildId?: (repoRoot: string) => Promise<string | undefined>;
  /** 可注入的进程内 artifact reader 协调器（确定性竞态测试用）。 */
  artifactReaderCoordinator?: ArtifactReaderCoordinatorLike;
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
  const repoRoot = options.repoRoot ?? undefined;
  const enableAutoUpdate = options.enableAutoUpdate ?? repoRoot !== undefined;
  const readArtifactBuildId = options.readArtifactBuildId ?? readBuildId;
  // semver + capability 无法区分同一版本号下较早的 dirty bundle；固定计划只能由
  // 与本机 artifact 完全同一 build-id 的扩展执行。
  const startupExtensionBuildId = repoRoot ? await readArtifactBuildId(repoRoot) : undefined;
  let currentArtifactBuildId = startupExtensionBuildId;
  const refreshArtifactBuildId = async (): Promise<string | undefined> => {
    if (!repoRoot) return undefined;
    currentArtifactBuildId = await readArtifactBuildId(repoRoot);
    return currentArtifactBuildId;
  };
  let resumeDeferredUpdate = (): void => undefined;
  let resumeArtifactIdle = (): void => undefined;
  const artifactReaders = options.artifactReaderCoordinator ?? new ArtifactReaderCoordinator({
      acquirePhysical: async () => repoRoot
        ? await acquireArtifactLease(repoRoot, { role: 'artifact-reader' })
        : { release: async () => undefined },
    });
  artifactReaders.setOnIdle(() => resumeArtifactIdle());
  const access = await AccessTokenManager.open(config.authFile);
  // Legacy files do not have directed pins. Load the directed run store first, then install
  // its exact active proof set before terminal pruning can discard recovery evidence.
  const jobs = await JobStore.open(config.jobsFile, { deferPrune: true });
  let directedStore: NowcoderDirectedStore | undefined;
  let directedError: {
    code: 'DIRECTED_STORE_UNAVAILABLE' | 'DIRECTED_RECOVERY_FAILED';
    message: string;
  } | undefined;
  const quarantineDirectedError = (
    code: 'DIRECTED_STORE_UNAVAILABLE' | 'DIRECTED_RECOVERY_FAILED',
    message: string,
  ): void => {
    directedError = { code, message };
    console.warn(`[nowcoder-directed] ${message}`);
  };
  try {
    directedStore = await NowcoderDirectedStore.open(
      join(config.configDir, 'nowcoder-directed.json'),
    );
  } catch {
    quarantineDirectedError('DIRECTED_STORE_UNAVAILABLE', '牛客定向状态不可用');
  }
  if (directedStore) await jobs.reconcileDirectedPins(
    directedStore.reconciliationSnapshots().map(snapshot => ({
      runId: snapshot.id,
      attempt: snapshot.attempt,
      jobIds: snapshot.currentJobIds,
    })),
  );
  // Ordinary/fixed-plan jobs keep the existing recovery behavior. Directed jobs are recovered
  // later from the durable current-run/current-round fence so an old attempt never becomes queued.
  await jobs.recover(new Set(
    jobs.list().filter(job => job.directedRunId !== undefined).map(job => job.id),
  ));
  let planStore: CollectionPlanStore | undefined;
  let zsxqLedger: ZsxqDayLedgerStore | undefined;
  let planStoreError: string | undefined;
  try {
    planStore = await CollectionPlanStore.open(config.plansFile);
    zsxqLedger = await ZsxqDayLedgerStore.open(config.zsxqLedgerFile);
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
  /** 结果已进入本 Bridge 的 sink，扩展换连时不得把它回滚重派。 */
  const persistingJobIds = new Set<string>();
  /**
   * 知识星球 sink 与 artifact 生成必须互斥。同一进程的 updater 若在完整性校验后、
   * Markdown 原子写完成前把 A 替换成 B，A 的旧正文会先污染磁盘，再被错误报成 saved。
   */
  const zsxqPersistingJobIds = new Set<string>();
  const persistenceDrainWaiters = new Set<() => void>();
  const waitForPersistenceDrain = (): Promise<void> => {
    if (persistingJobIds.size === 0) return Promise.resolve();
    return new Promise(resolveDrain => persistenceDrainWaiters.add(resolveDrain));
  };
  type PendingJobNotice =
    | {
        type: 'job.saved';
        payload: {
          outputPath?: string;
          results: SinkResult[];
          attempt?: CollectionPlanAttempt;
        };
        zsxq: boolean;
      }
    | {
        type: 'job.failed';
        payload: {
          code: string;
          message: string;
          attempt?: CollectionPlanAttempt;
        };
        zsxq: boolean;
      };
  const pendingJobNotices = new Map<string, PendingJobNotice>();
  let extensionSocket: WebSocket | undefined;
  let extensionReady = false;
  let extensionVersion: string | undefined;
  let extensionBuildId: string | undefined;
  const extensionRuntime = new WeakMap<WebSocket, {
    version: string;
    buildId?: string;
    runtimeId?: string;
    capabilities: string[];
  }>();
  const extensionHasZsxqProtocol = (socket = extensionSocket): boolean => {
    const runtime = socket ? extensionRuntime.get(socket) : undefined;
    return versionAtLeast(runtime?.version, ZSXQ_COMPLETE_CONTENT_MINIMUM_EXTENSION_VERSION)
      && runtime?.capabilities.includes(ZSXQ_COMPLETE_CONTENT_CAPABILITY) === true;
  };
  const extensionMatchesArtifact = (
    socket = extensionSocket,
    artifactBuildId = currentArtifactBuildId,
  ): boolean => {
    const runtime = socket ? extensionRuntime.get(socket) : undefined;
    return repoRoot === undefined
      || (
        artifactBuildId !== undefined
        && runtime?.buildId === artifactBuildId
      );
  };
  const extensionCanCollectZsxq = (
    socket = extensionSocket,
    artifactBuildId = currentArtifactBuildId,
  ): boolean => extensionHasZsxqProtocol(socket)
    && extensionMatchesArtifact(socket, artifactBuildId);
  const flushPendingJobNotices = (socket = extensionSocket): void => {
    if (
      !socket ||
      socket !== extensionSocket ||
      !extensionReady ||
      socket.readyState !== WebSocket.OPEN
    ) return;
    for (const [jobId, notice] of pendingJobNotices) {
      if (notice.zsxq && !extensionCanCollectZsxq(socket)) continue;
      socket.send(JSON.stringify(envelope(notice.type, jobId, notice.payload)));
      pendingJobNotices.delete(jobId);
    }
  };
  const publishJobNotice = (job: JobRecord, notice: PendingJobNotice): void => {
    pendingJobNotices.set(job.id, notice);
    flushPendingJobNotices();
  };
  const isZsxqJob = (job: Pick<JobRecord, 'url'>): boolean =>
    descriptorForHost(new URL(job.url).hostname)?.id === 'zsxq';
  const publishDurableJobNotice = (job: JobRecord): void => {
    if (job.status === 'saved') {
      publishJobNotice(job, {
        type: 'job.saved',
        payload: {
          ...(job.outputPath ?? job.markdownOutput?.outputPath
            ? { outputPath: job.outputPath ?? job.markdownOutput!.outputPath }
            : {}),
          results: [],
          ...(job.planAttempt ? { attempt: job.planAttempt } : {}),
        },
        zsxq: isZsxqJob(job),
      });
      return;
    }
    if (job.status === 'failed' || job.status === 'needs_attention') {
      publishJobNotice(job, {
        type: 'job.failed',
        payload: {
          code: job.errorCode ?? (job.status === 'failed' ? 'CANCELLED' : 'COLLECTION_FAILED'),
          message: job.errorMessage ?? '牛客定向采集已终止',
          ...(job.planAttempt ? { attempt: job.planAttempt } : {}),
        },
        zsxq: isZsxqJob(job),
      });
    }
  };
  let collectionPlans: CollectionPlanService | undefined;
  let directedService: NowcoderDirectedService | undefined;
  let directedSelection: NowcoderDirectedSelectionCoordinator | undefined;
  const notifyJobTerminal = async (
    job: JobRecord,
    fixedPlanRejection?: string,
  ): Promise<void> => {
    try {
      if (fixedPlanRejection !== undefined) {
        await collectionPlans?.onJobRejected(job, fixedPlanRejection);
      } else {
        await collectionPlans?.onJobTerminal(job);
      }
    } catch (error) {
      console.warn(`[plans] 任务终态同步失败：${error instanceof Error ? error.message : error}`);
    }
    try {
      await directedService?.onJobTerminal(job);
    } catch (error) {
      console.warn(`[nowcoder-directed] 任务终态同步失败：${error instanceof Error ? error.message : error}`);
    }
  };
  const planStartAcks = new PlanStartAcks();
  const hasActiveZsxqAttempt = (): boolean => planStore?.active('zsxq-chen-teacher')
    .some(batch => batch.preparationAttempt !== undefined) === true;

  // ── 自更新 ───────────────────────────────────────────────────────────
  // 失败一律只记录、不抛：更新是附加能力，绝不能把采集服务带下水。
  let update: UpdateOutcome | undefined;
  let restartPending = false;
  // 更新完成后，新扩展会因加载新产物而换连。它完成 hello 且旧 sink 写入排空后，
  // 这条连接本身就是安全交接点；不能再等它主动断开，否则旧 Bridge 会永久驻留。
  let restartHandoffSocket: WebSocket | undefined;
  let restartHandoffReady = false;
  let restartIntent: ArtifactUpdateIntent | undefined;
  let updateCheckInFlight = false;
  let updateCheckDeferred = false;
  const updateDrainWaiters = new Set<() => void>();
  const waitForUpdateDrain = (): Promise<void> => {
    if (!updateCheckInFlight) return Promise.resolve();
    return new Promise(resolveDrain => updateDrainWaiters.add(resolveDrain));
  };
  const acquireZsxqPersistenceLease = (jobId: string): Promise<void> | undefined => {
    // 必须同步置位，调用者随后才允许第一次 await 文件租约。已经在跑的 updater 无法
    // 中断，就等它排空；新的 updater 一看到 Set 非空会延期，不能从两层租约间穿过。
    zsxqPersistingJobIds.add(jobId);
    if (!updateCheckInFlight) return undefined;
    return (async () => {
      while (updateCheckInFlight) await waitForUpdateDrain();
    })();
  };
  let feJourneyRuns = 0;
  const runUpdate = options.runUpdate ?? (root => updateWorkspace(root, processUpdateHost));
  const exit = options.exit ?? ((): void => process.exit(0));

  /**
   * 服务自己也得重启一次，拉下来的服务端代码才作数——进程跑的是内存里那份旧的。
   * 登录项（launchd 的 KeepAlive / systemd 的 Restart=always）会立刻把它拉起来，
   * 用户什么都不用做。
   *
   * 只在**没有扩展连着、也没有本进程 sink 写入**的时候退出。queued/dispatched/collecting
   * 都是磁盘上的 durable 状态，新进程启动会 recover；拿它们挡重启会让离线任务永久锁死升级。
   */
  const maybeRestart = (): void => {
    if (closing || !restartPending) return;
    // 新 build-id 可能已经落盘，但打包子进程还在收尾。先记住交接，
    // 等 runUpdate 真正返回后再退出，避免杀掉尚未完成的更新。
    if (updateCheckInFlight) return;
    if (shouldDeferArtifactUpdate(
      artifactReaders.snapshot(),
      directedService?.hasActiveRun() ?? false,
    )) return;
    if (!restartIntent) {
      const intent = artifactReaders.tryBeginUpdate(directedService?.hasActiveRun() ?? false);
      if (!intent) return;
      intent.handoffToRestart();
      restartIntent = intent;
    }
    if (
      extensionSocket?.readyState === WebSocket.OPEN
      && !(restartHandoffReady && extensionSocket === restartHandoffSocket)
    ) return;
    if (persistingJobIds.size > 0) return;
    if (feJourneyRuns > 0) return;
    restartPending = false;
    restartHandoffSocket = undefined;
    restartHandoffReady = false;
    restartIntent.release();
    restartIntent = undefined;
    console.warn('[update] 新版本已构建，本机服务重启以生效');
    exit();
  };

  const checkForUpdate = async (): Promise<void> => {
    if (closing || !repoRoot || !enableAutoUpdate || updateCheckInFlight) return;
    const readerState = artifactReaders.snapshot();
    if (
      zsxqPersistingJobIds.size > 0
      || hasActiveZsxqAttempt()
      || shouldDeferArtifactUpdate(readerState, directedService?.hasActiveRun() ?? false)
    ) {
      updateCheckDeferred = true;
      return;
    }
    const updateIntent = artifactReaders.tryBeginUpdate(directedService?.hasActiveRun() ?? false);
    if (!updateIntent) {
      updateCheckDeferred = true;
      return;
    }
    updateCheckDeferred = false;
    updateCheckInFlight = true;
    let handedToRestart = false;
    try {
      try {
        update = await runUpdate(repoRoot);
        if (update.changed) console.warn(`[update] ${update.message}`);
        // 构建失败时产物还是旧的，重启只会把好好的服务换成同一份代码——没有意义。
        if (update.changed && !update.buildFailed) {
          restartPending = true;
          updateIntent.handoffToRestart();
          restartIntent = updateIntent;
          handedToRestart = true;
        }
      } catch (error) {
        console.warn(`[update] 检查更新失败：${error instanceof Error ? error.message : error}`);
      }
    } finally {
      if (!handedToRestart) updateIntent.release();
      updateCheckInFlight = false;
      for (const resolveDrain of updateDrainWaiters) resolveDrain();
      updateDrainWaiters.clear();
      maybeRestart();
      // A plan may have been queued while this update was already in flight. Resume it only after
      // the updater has completely released its package process and the exact artifact can be read.
      setImmediate(() => {
        if (closing) return;
        const pending = planStore?.active('zsxq-chen-teacher')
          .find(batch => batch.preparationAttempt === undefined);
        if (!pending || !collectionPlans) return;
        void trackOperation(collectionPlans.run('zsxq-chen-teacher').catch(error => {
          console.warn(`[plans] 更新后恢复知识星球采集失败：${error instanceof Error ? error.message : error}`);
        }));
      });
    }
  };
  resumeDeferredUpdate = (): void => {
    setImmediate(() => {
      if (closing) return;
      if (
        updateCheckDeferred
        && zsxqPersistingJobIds.size === 0
        && !hasActiveZsxqAttempt()
        && !shouldDeferArtifactUpdate(
          artifactReaders.snapshot(),
          directedService?.hasActiveRun() ?? false,
        )
      ) void trackOperation(checkForUpdate());
    });
  };
  resumeArtifactIdle = (): void => {
    resumeDeferredUpdate();
    setImmediate(maybeRestart);
  };
  let updateTimer: NodeJS.Timeout | undefined;

  const dispatch = async (job: JobRecord, targetSocket = extensionSocket): Promise<void> => {
    if (
      !targetSocket ||
      targetSocket !== extensionSocket ||
      !extensionReady ||
      targetSocket.readyState !== WebSocket.OPEN ||
      job.status !== 'queued'
    ) return;
    if (job.directedRunId && !directedService?.canDispatch(job)) return;
    if (job.directedRunId && !await directedService?.guardJobBoundary(job, 'before-dispatch')) return;
    const zsxqJob = isZsxqJob(job);
    // 恢复中的子任务也必须服从完整正文能力门禁。artifact 可能在 Bridge 运行中
    // 被打包流程原地替换，所以每次 dispatch 都重新读磁盘，不能信启动时快照。
    if (zsxqJob) {
      const artifactBuildId = await refreshArtifactBuildId();
      if (
        targetSocket !== extensionSocket
        || targetSocket.readyState !== WebSocket.OPEN
        || !extensionCanCollectZsxq(targetSocket, artifactBuildId)
      ) return;
    }
    if (
      job.planId === 'zsxq-chen-teacher'
      && !collectionPlans?.isCurrentJobAttempt(job)
    ) {
      const failed = await jobs.transition(job.id, 'failed', {
        errorCode: 'STALE_PLAN_ATTEMPT',
        errorMessage: '知识星球采集尝试已过期',
      });
      await notifyJobTerminal(failed);
      return;
    }
    const jobSource = descriptorForHost(new URL(job.url).hostname)?.id;
    if (
      !candidateIndex &&
      (jobSource === 'nowcoder' || jobSource === 'github')
    ) {
      const failed = await jobs.transition(job.id, 'failed', {
        errorCode: 'FE_JOURNEY_INDEX_UNAVAILABLE',
        errorMessage: candidateIndexError ?? 'fe-journey 候选索引不可用',
      });
      await notifyJobTerminal(failed);
      return;
    }
    await jobs.transition(job.id, 'dispatched');
    // 状态落盘期间连接或磁盘 artifact 都可能已被替换；发送前再做最后一道 fence。
    if (targetSocket !== extensionSocket || targetSocket.readyState !== WebSocket.OPEN) {
      if (jobs.get(job.id)?.status === 'dispatched') await jobs.transition(job.id, 'queued');
      return;
    }
    if (zsxqJob) {
      const artifactBuildId = await refreshArtifactBuildId();
      if (
        targetSocket !== extensionSocket
        || targetSocket.readyState !== WebSocket.OPEN
        || !extensionCanCollectZsxq(targetSocket, artifactBuildId)
      ) {
        await jobs.transition(job.id, 'queued');
        return;
      }
    }
    const latest = jobs.get(job.id);
    if (!latest) return;
    if (
      latest.directedRunId
      && !await directedService?.guardJobBoundary(latest, 'before-job-collect-send')
    ) {
      if (latest.status === 'dispatched') await jobs.transition(latest.id, 'queued');
      return;
    }
    // The final directed guard awaits a disk artifact read. The authenticated socket can be
    // replaced during that await, so re-read every send fence immediately before the frame.
    const sendCandidate = jobs.get(latest.id);
    if (
      targetSocket !== extensionSocket
      || !extensionReady
      || targetSocket.readyState !== WebSocket.OPEN
    ) {
      if (sendCandidate?.status === 'dispatched') await jobs.transition(sendCandidate.id, 'queued');
      return;
    }
    if (!sendCandidate || sendCandidate.status !== 'dispatched') return;
    if (
      sendCandidate.directedRunId
      && (
        !directedService?.ownsCurrentJob(sendCandidate)
        || !directedService.acceptsResult(sendCandidate)
      )
    ) {
      const fenced = await jobs.transition(sendCandidate.id, 'failed', {
        errorCode: 'STALE_DIRECTED_RUN',
        errorMessage: '牛客定向运行已变化，任务未派发',
      });
      await notifyJobTerminal(fenced);
      return;
    }
    const collectFrame = () => targetSocket.send(JSON.stringify(envelope('job.collect', sendCandidate.id, {
      url: sendCandidate.url,
      interactive: sendCandidate.directedRunId ? false : !sendCandidate.batchId,
      ...(sendCandidate.directedRunId && sendCandidate.directedRunAttempt
        ? {
            directedRunId: sendCandidate.directedRunId,
            directedRunAttempt: sendCandidate.directedRunAttempt,
          }
        : {}),
    })));
    if (sendCandidate.directedRunId) {
      await directedService?.dispatchCurrent(sendCandidate, () => {
        if (
          targetSocket !== extensionSocket
          || !extensionReady
          || targetSocket.readyState !== WebSocket.OPEN
        ) throw new Error('扩展连接已在定向派发截止点变化');
        collectFrame();
      });
    } else {
      collectFrame();
    }
  };

  const dispatchQueued = async (targetSocket = extensionSocket): Promise<void> => {
    for (const job of jobs.list('queued')) await dispatch(job, targetSocket);
  };
  const collectorFetcher = options.fetch ?? fetch;

  const storedDocumentFor = async (job: JobRecord): Promise<CollectedDocument | undefined> => {
    if (job.directedRunId && !directedService?.ownsCurrentJob(job)) return undefined;
    if (!job.outputPath) return undefined;
    try {
      return projectOrganized(JSON.parse(
        await readFile(join(dirname(job.outputPath), 'source.json'), 'utf8'),
      ) as unknown).document;
    } catch {
      return undefined;
    }
  };

  const directedLiveEvidence = async () => {
    const socket = extensionSocket;
    const runtime = socket ? extensionRuntime.get(socket) : undefined;
    const artifactBuildId = await refreshArtifactBuildId();
    const socketStillCurrent = Boolean(
      socket
      && socket === extensionSocket
      && socket.readyState === WebSocket.OPEN
      && runtime,
    );
    return {
      applicationVersion: APP_VERSION,
      ...(startupExtensionBuildId ? { bridgeBuildId: startupExtensionBuildId } : {}),
      ...(artifactBuildId ? { artifactBuildId } : {}),
      extensionOnline: socketStillCurrent,
      ...(runtime?.version ? { extensionVersion: runtime.version } : {}),
      ...(runtime?.buildId ? { extensionBuildId: runtime.buildId } : {}),
      ...(runtime?.runtimeId ? { extensionRuntimeId: runtime.runtimeId } : {}),
      ...(runtime ? { extensionCapabilities: [...runtime.capabilities] } : {}),
      observedAt: new Date().toISOString(),
    };
  };
  const nowcoderTargetRoot = router.directedSyncTarget('nowcoder')?.root;
  const directedSessionController = directedStore
    ? new NowcoderDirectedSessionController({
        store: directedStore,
        jobs,
        libraryRoot: config.libraryRoot,
        ...(nowcoderTargetRoot ? { targetRoot: nowcoderTargetRoot } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : undefined;
  const directedPublisher = directedStore
    ? new NowcoderDirectedPublisher({
        store: directedStore,
        libraryRoot: config.libraryRoot,
        resolveTarget: source => router.syncTarget(source),
        finalizePublished: async (runId, attempt) => {
          if (!directedService) throw new Error('牛客定向服务尚未就绪');
          return await directedService.finalizePublished(runId, attempt);
        },
      })
    : undefined;
  directedService = directedStore
    ? new NowcoderDirectedService({
        store: directedStore,
        jobs,
        dispatch,
        sendCancel: async job => {
          const socket = extensionSocket;
          if (!socket || !extensionReady || socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify(envelope('job.cancel', job.id, {
            directedRunId: job.directedRunId,
            directedRunAttempt: job.directedRunAttempt,
          })));
        },
        acknowledgeTerminal: async job => { publishDurableJobNotice(job); },
        replayProvenTerminal: async job => {
          const socket = extensionSocket;
          if (!socket || !extensionReady || socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify(envelope('job.collect', job.id, {
            url: job.url,
            interactive: false,
            directedRunId: job.directedRunId,
            directedRunAttempt: job.directedRunAttempt,
          })));
        },
        ownedTabsClear: async snapshot => directedStore!.hasCompleteTabClearEvidence(
          snapshot.id,
          snapshot.attempt,
        ),
        isPersistenceInFlight: jobId => persistingJobIds.has(jobId),
        artifactReaders,
        liveEvidence: directedLiveEvidence,
        reconcileSelection: async context => directedSelection
          ? await directedSelection.reconcile(context)
          : { state: 'paused' },
        recoverPublisher: async context => {
          await directedPublisher!.recover(context);
        },
        reportRecoveryFailure: error => quarantineDirectedError(error.code, error.message),
      })
    : undefined;
  if (directedService) {
    directedSelection = new NowcoderDirectedSelectionCoordinator({
      store: directedStore!,
      service: () => directedService!,
      libraryRoot: config.libraryRoot,
      ...(nowcoderTargetRoot ? { targetRoot: nowcoderTargetRoot } : {}),
    });
  }
  if (directedService) {
    try {
      // Reacquire the durable run reader before the updater gets its first opportunity. With no
      // extension hello yet, live recovery pauses without dropping the reader or changing phase.
      await directedService.initialize();
    } catch {
      quarantineDirectedError('DIRECTED_RECOVERY_FAILED', '牛客定向运行恢复不可用');
    }
  }
  const requireDirectedHttp = () => {
    const controller = directedSessionController;
    const store = directedStore;
    const service = directedService;
    if (!controller || !store || !service) {
      throw new HttpError(
        503,
        'NOWCODER_DIRECTED_UNAVAILABLE',
        '牛客定向服务暂时不可用',
      );
    }
    return { controller, store, service };
  };
  if (repoRoot && enableAutoUpdate) {
    updateTimer = setInterval(
      () => void trackOperation(checkForUpdate()),
      options.updateIntervalMs ?? 10 * 60_000,
    );
    updateTimer.unref?.();
    void trackOperation(checkForUpdate());
  }

  collectionPlans = planStore
    ? new CollectionPlanService({
        store: planStore,
        jobs,
        extensionConnected: () => extensionReady && extensionSocket?.readyState === WebSocket.OPEN,
        canCollectZsxq: extensionCanCollectZsxq,
        canStartZsxqAttempt: () => persistingJobIds.size === 0
          && !updateCheckInFlight
          && artifactReaders.snapshot().updateState === 'idle',
        discoverNowcoder: knownUrls => discoverNowcoderPlanCandidates(collectorFetcher, knownUrls),
        dispatch,
        collectZsxq: async (
          batchId,
          planId,
          attempt,
          force,
          mode,
          targetDays,
          resumeCursor,
        ) => {
          const targetSocket = extensionSocket;
          const artifactBuildId = await refreshArtifactBuildId();
          if (
            !targetSocket ||
            !extensionReady ||
            targetSocket.readyState !== WebSocket.OPEN ||
            targetSocket !== extensionSocket ||
            !extensionCanCollectZsxq(targetSocket, artifactBuildId)
          ) {
            throw new Error('知识星球采集命令未派发：扩展连接或构建证明已变化');
          }
          const message = JSON.stringify(envelope('plan.collect', batchId, {
            batchId,
            planId,
            attempt,
            ...(force ? { force: true } : {}),
            zsxqMode: mode,
            targetDays: [...targetDays],
            ...(resumeCursor ? { resumeCursor } : {}),
          }));
          await planStartAcks.dispatch(planStartAckKey(batchId, attempt), () => {
            if (
              targetSocket !== extensionSocket
              || !extensionReady
              || targetSocket.readyState !== WebSocket.OPEN
            ) throw new Error('扩展连接已在接单确认前变化');
            targetSocket.send(message);
          });
          return true;
        },
        ...(zsxqLedger ? { zsxqLedger } : {}),
        onZsxqAttemptTerminal: () => resumeDeferredUpdate(),
        shouldAutoSync: async job => {
          const document = await storedDocumentFor(job);
          if (!document) return false;
          if (job.planId === 'zsxq-chen-teacher') {
            return document.sourceMetadata?.authorRole === 'owner' && document.truncated === false;
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
          const targetRoot = router.syncTarget('nowcoder')?.root;
          const processed = targetRoot
            ? filterProcessedNowcoderDocuments(
                readable.map(item => item.document),
                await loadProcessedNowcoderHistory(targetRoot),
              )
            : {
                eligible: readable.map(item => item.document),
                rejected: [] as Array<{ url: string; reason: string }>,
              };
          const selection = selectNowcoderPlanCandidates(
            processed.eligible,
            now,
          );
          const acceptedUrls = new Set(selection.accepted.map(document => document.canonicalUrl));
          return {
            accepted: readable
              .filter(item => acceptedUrls.has(item.document.canonicalUrl))
              .map(item => item.job),
            coverage: selection.coverage,
            rejected: rejected.concat(processed.rejected, selection.rejected),
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
            deliveryBatchId
              ? { deliveryBatchId, deliveryPlanId: 'nowcoder-agent-market' }
              : job.planId === 'zsxq-chen-teacher'
                ? { skipDelivered: true }
                : {},
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
            {
              deliveryBatchId,
              deliveryPlanId: 'nowcoder-agent-market',
              atomic: true,
            },
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
    if (socket !== extensionSocket) throw new Error('扩展连接已被替换');
    const parsedEnvelope = wsEnvelopeSchema.parse(JSON.parse(messageText(data)));
    if (parsedEnvelope.type === 'extension.hello') {
      const hello = extensionHelloPayloadSchema.parse(parsedEnvelope.payload);
      // Record authenticated socket evidence while this socket is deliberately not ready. Active
      // directed recovery validates/appends it before any reconnect path can dispatch work.
      const helloArtifactBuildId = await refreshArtifactBuildId();
      if (socket !== extensionSocket) return;
      extensionRuntime.set(socket, {
        version: hello.version,
        ...(hello.buildId ? { buildId: hello.buildId } : {}),
        ...(hello.runtimeId ? { runtimeId: hello.runtimeId } : {}),
        capabilities: [...(hello.capabilities ?? [])],
      });
      if (
        hello.buildId !== undefined
        && hello.buildId === helloArtifactBuildId
        && helloArtifactBuildId !== startupExtensionBuildId
      ) {
        restartPending = true;
        restartHandoffSocket = socket;
      }
      if (directedService) {
        try {
          await directedService.observeExtensionEvidence();
        } catch {
          quarantineDirectedError('DIRECTED_RECOVERY_FAILED', '牛客定向运行恢复不可用');
        }
      }
      if (socket !== extensionSocket) return;
      if (!extensionReady) {
        await jobs.recover(new Set([
          ...persistingJobIds,
          ...jobs.list().filter(job => job.directedRunId !== undefined).map(job => job.id),
        ]));
      }
      // recover 会触发文件 I/O；等待期间这个 socket 可能已被新版连接替换。
      if (socket !== extensionSocket) return;
      extensionReady = true;
      extensionVersion = hello.version;
      extensionBuildId = hello.buildId;
      // 旧连接可能已完成了一个 sink 写入；先把终态回执交给当前扩展，再下发新任务。
      flushPendingJobNotices(socket);
      // sink 写入与 attempt 换代必须串行：否则旧轮结果可在新轮开始后落盘。
      await waitForPersistenceDrain();
      if (socket !== extensionSocket) return;
      if (socket === restartHandoffSocket) {
        restartHandoffReady = true;
        maybeRestart();
        // 若还有定时采集在收尾，保留空闲连接等它排空；不要在待重启进程里再派新任务。
        return;
      }
      await collectionPlans?.onExtensionConnected({
        runDue: options.enableCollectionPlanScheduler ?? options.enableFeJourneyScheduler ?? false,
        ...(hello.runtimeId ? { runtimeId: hello.runtimeId } : {}),
      }).catch(error => {
        console.warn(`[plans] 扩展重连补跑失败：${error instanceof Error ? error.message : error}`);
      });
      if (socket !== extensionSocket) return;
      if (directedService) {
        try {
          await directedService.reconcileAll();
          if (directedError?.code === 'DIRECTED_RECOVERY_FAILED') directedError = undefined;
        } catch {
          quarantineDirectedError('DIRECTED_RECOVERY_FAILED', '牛客定向运行恢复不可用');
        }
      }
      if (socket !== extensionSocket) return;
      await dispatchQueued(socket);
      return;
    }
    if (parsedEnvelope.type === 'bridge.ping') {
      socket.send(JSON.stringify(envelope('bridge.pong', parsedEnvelope.requestId, {})));
      return;
    }
    if (parsedEnvelope.type === 'plan.started') {
      if (!collectionPlans) throw new Error(planStoreError ?? '固定采集计划不可用');
      const started = planStartedPayloadSchema.parse(parsedEnvelope.payload);
      if (parsedEnvelope.requestId !== started.batchId) {
        throw new Error('知识星球计划接单确认与批次编号不一致');
      }
      const artifactBuildId = await refreshArtifactBuildId();
      if (socket !== extensionSocket) return;
      if (
        started.planId === 'zsxq-chen-teacher'
        && !extensionCanCollectZsxq(socket, artifactBuildId)
      ) throw new Error('当前扩展构建无权确认知识星球计划');
      await collectionPlans.assertJobAttempt(
        started.batchId,
        started.planId,
        started.attempt,
      );
      planStartAcks.ack(planStartAckKey(started.batchId, started.attempt));
      return;
    }
    if (parsedEnvelope.type === 'plan.result') {
      if (!collectionPlans) throw new Error(planStoreError ?? '固定采集计划不可用');
      const result = extensionPlanResultPayloadSchema.parse(parsedEnvelope.payload);
      const batch = planStore?.get(result.batchId);
      if (batch?.planId === 'zsxq-chen-teacher') {
        const artifactBuildId = await refreshArtifactBuildId();
        if (socket !== extensionSocket) return;
        if (!extensionCanCollectZsxq(socket, artifactBuildId)) {
          throw new Error('当前扩展版本或构建产物不具备知识星球完整正文采集能力');
        }
      }
      await collectionPlans.onExtensionPlanResult(result as ExtensionPlanResult);
      resumeDeferredUpdate();
      return;
    }
    const job = jobs.get(parsedEnvelope.requestId);
    if (!job) throw new Error(`任务不存在：${parsedEnvelope.requestId}`);
    if (
      job.directedRunId
      && directedService?.acceptsCancellationTerminal(job)
      && (parsedEnvelope.type === 'job.result' || parsedEnvelope.type === 'job.error')
    ) {
      let kind: 'cancelled_after_close' | 'remote_terminal_after_close';
      if (parsedEnvelope.type === 'job.error') {
        const terminalError = errorSchema.parse(parsedEnvelope.payload);
        kind = terminalError.code === 'CANCELLED'
          ? 'cancelled_after_close'
          : 'remote_terminal_after_close';
      } else {
        // Validate the terminal frame, but never interpret or persist its document while cancelling.
        jobResultPayloadSchema.parse(parsedEnvelope.payload);
        kind = 'remote_terminal_after_close';
      }
      if (await directedService.onCancellationTerminal(job, kind)) return;
    }
    if (
      job.directedRunId
      && (parsedEnvelope.type === 'job.result' || parsedEnvelope.type === 'job.error')
    ) {
      if (parsedEnvelope.type === 'job.result') {
        jobResultPayloadSchema.parse(parsedEnvelope.payload);
      } else {
        errorSchema.parse(parsedEnvelope.payload);
      }
      // A terminal frame is also the durable proof that this exact job no longer owns a remote
      // tab. Persist that proof before JobStore or any sink transition so a crash cannot cause a
      // cancelling restart to redispatch the job.
      if (!await directedService?.recordRemoteTerminalEvidence(job)) return;
      const durable = jobs.get(job.id);
      if (durable && (
        durable.status === 'saved'
        || durable.status === 'failed'
        || durable.status === 'needs_attention'
      )) {
        // Terminal tuples are acknowledged at least once, including after reconnect/replay. The
        // acknowledgement is emitted only after both proof and JobStore terminal state are durable.
        publishDurableJobNotice(durable);
        await notifyJobTerminal(durable);
        return;
      }
    }
    // Directed progress/result/error is fenced before parsing or touching JobStore/sinks/index.
    if (job.directedRunId) {
      if (!directedService?.acceptsResult(job)) return;
      const boundary = parsedEnvelope.type === 'job.progress'
        ? 'before-progress'
        : parsedEnvelope.type === 'job.result'
          ? 'before-result'
          : parsedEnvelope.type === 'job.error'
            ? 'before-error'
            : undefined;
      if (boundary && !await directedService.guardJobBoundary(job, boundary)) return;
    }
    const zsxqJob = isZsxqJob(job);
    let artifactBuildId: string | undefined;
    if (zsxqJob) {
      artifactBuildId = await refreshArtifactBuildId();
      if (socket !== extensionSocket) return;
    }
    const zsxqRuntimeAuthorized = !zsxqJob
      || extensionCanCollectZsxq(socket, artifactBuildId);
    const artifactDrifted = zsxqJob
      && extensionHasZsxqProtocol(socket)
      && !extensionMatchesArtifact(socket, artifactBuildId);
    if (
      !zsxqRuntimeAuthorized
      && !(parsedEnvelope.type === 'job.result' && artifactDrifted)
    ) {
      throw new Error('当前扩展版本或构建产物不具备知识星球完整正文采集能力');
    }
    // requestId 只能驱动它创建时所属的当前 attempt。换代后旧轮的
    // progress/result/error 全部丢弃，避免旧快照先把新轮同 URL 任务置为 saved。
    if (
      job.planId === 'zsxq-chen-teacher'
      && !collectionPlans?.isCurrentJobAttempt(job)
    ) return;
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
      const result = jobResultPayloadSchema.parse(parsedEnvelope.payload);
      if (result.document.canonicalUrl !== job.url) {
        throw new Error('回传内容 URL 与采集任务不一致');
      }
      if (job.status === 'saved' || job.status === 'failed' || job.status === 'needs_attention') return;
      // 必须在第一个 await 前打标；否则换连 hello 可以在状态落盘间隙把它重派。
      persistingJobIds.add(job.id);
      let holdsZsxqPersistenceLease = false;
      let artifactReader: ArtifactReaderHandle | undefined;
      try {
        if (zsxqJob) {
          // updater 已经在跑时先等它完整结束；随后下面会重新读取 artifact 并拒绝旧 A。
          // 反过来一旦拿到租约，checkForUpdate 会延后到本次 sink 全部结束。
          const updateDrain = acquireZsxqPersistenceLease(job.id);
          holdsZsxqPersistenceLease = true;
          if (updateDrain) await updateDrain;
          // 外部 package 只持有文件租约而没有本进程 update intent；此时仍须先等它
          // 释放，再读取最终 build-id。若本进程已进入 restart，则先复核 A/B 并拒绝旧结果。
          if (artifactReaders.snapshot().updateState === 'idle') {
            artifactReader = await artifactReaders.acquireReader('zsxq-persistence');
          }
        } else if (job.directedRunId) {
          artifactReader = await artifactReaders.acquireReader('nowcoder-directed-persistence');
        }
        let current = job;
        if (job.directedRunId && !directedService?.acceptsResult(job)) return;
        if (job.status === 'queued' || job.status === 'dispatched') {
          current = await jobs.transition(job.id, 'collecting');
        }
        // artifact 可在任务已经下发后被原地覆盖。结果进入 sink 前再次现读磁盘；
        // 旧构建即使带着对 A 的完整性证明，也不能在当前 artifact 已是 B 时落库。
        let sinkArtifactBuildId: string | undefined;
        if (zsxqJob) {
          sinkArtifactBuildId = await refreshArtifactBuildId();
          if (!extensionCanCollectZsxq(socket, sinkArtifactBuildId)) {
            const terminal = await jobs.transition(current.id, 'needs_attention', {
              errorCode: 'EXTENSION_UPDATE_REQUIRED',
              errorMessage: '扩展构建已落后于当前磁盘产物，已拒绝知识星球正文入库',
            });
            await notifyJobTerminal(terminal, '扩展构建已过期');
            return;
          }
          // 先完成上面的 A/B 构建复核：若 updater 已把 A 换成 B，旧结果应进入
          // needs_attention，而不是因 restart intent 拒绝 reader 后误报普通保存失败。
          if (!artifactReader) {
            artifactReader = await artifactReaders.acquireReader('zsxq-persistence');
          }
        }
        // 所有知识星球入库都必须带新版扩展给出的显式完整证明。
        // 固定计划、侧栏单条/批量与恢复重派全部走同一条 sink 前防线。
        const zsxqCompletenessProven = result.document.truncated === false
          && result.document.sourceMetadata?.contentCompletenessVersion
            === ZSXQ_COMPLETE_CONTENT_CAPABILITY
          && (
            repoRoot === undefined
            || (
              sinkArtifactBuildId !== undefined
              && result.document.sourceMetadata?.contentCompletenessBuildId
                === sinkArtifactBuildId
            )
          );
        if (zsxqJob && !zsxqCompletenessProven) {
          const terminal = await jobs.transition(current.id, 'needs_attention', {
            errorCode: 'INCOMPLETE_CONTENT',
            errorMessage: '知识星球正文不完整，已拒绝归档和交付',
          });
          await notifyJobTerminal(terminal, '正文不完整');
          return;
        }
        // This is the final fence before candidate preparation, Markdown save and index commit.
        if (current.directedRunId && !directedService?.acceptsResult(current)) return;
        if (
          current.directedRunId
          && !await directedService?.guardJobBoundary(current, 'before-result-save')
        ) return;
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
          current.directedRunId && current.directedRunAttempt
            ? {
                runId: current.directedRunId,
                attempt: current.directedRunAttempt,
                currentJobId: current.id,
              }
            : undefined,
        );
        const succeeded = sinkResults.filter(sinkResult => sinkResult.ok);
        if (succeeded.length === 0) {
          const detail = sinkResults
            .map(sinkResult => `${sinkResult.sinkId}: ${sinkResult.detail?.error ?? '失败'}`)
            .join('；');
          throw new Error(`所有落地目标均失败：${detail || '无可用目标'}`);
        }
        const markdownResults = succeeded.filter(sinkResult =>
          router.isTrustedLocalEvidenceResult(sinkResult));
        if (current.directedRunId && markdownResults.length !== 1) {
          throw new Error('定向牛客结果未形成可验证的本机 Markdown 快照');
        }
        const markdown = markdownResults[0];
        const primary = current.directedRunId ? markdown! : succeeded[0]!;
        const saved = await jobs.transition(job.id, 'saved', {
          outputPath: primary.outputRef,
          ...(markdown ? { markdownOutput: { sinkId: 'markdown', outputPath: markdown.outputRef } } : {}),
        });
        publishJobNotice(saved, {
          type: 'job.saved',
          payload: {
            outputPath: primary.outputRef,
            results: sinkResults,
            ...(saved.planAttempt ? { attempt: saved.planAttempt } : {}),
          },
          zsxq: isZsxqJob(saved),
        });
        await notifyJobTerminal(saved);
        return;
      } catch (error) {
        const latest = jobs.get(job.id);
        if (
          latest &&
          (!latest.directedRunId || directedService?.acceptsResult(latest)) &&
          latest.status !== 'saved' &&
          latest.status !== 'failed' &&
          latest.status !== 'needs_attention'
        ) {
          const message = error instanceof Error ? error.message : '内容落地失败';
          const directedSaveCode = typeof error === 'object' && error !== null && 'code' in error
            && (error.code === 'DIRECTED_LOCAL_LIBRARY_CORRUPT'
              || error.code === 'DIRECTED_CANDIDATE_CATALOG_CORRUPT')
            ? error.code
            : undefined;
          const errorCode = directedSaveCode ?? 'SAVE_FAILED';
          console.warn(`[jobs] 任务 ${latest.id} 落地失败：${message}`);
          const failed = await jobs.transition(latest.id, 'failed', {
            errorCode,
            errorMessage: message,
          });
          publishJobNotice(failed, {
            type: 'job.failed',
            payload: {
              code: errorCode,
              message,
              ...(failed.planAttempt ? { attempt: failed.planAttempt } : {}),
            },
            zsxq: isZsxqJob(failed),
          });
          await notifyJobTerminal(failed);
          return;
        }
        throw error;
      } finally {
        try {
          if (holdsZsxqPersistenceLease) zsxqPersistingJobIds.delete(job.id);
          persistingJobIds.delete(job.id);
          if (persistingJobIds.size === 0) {
            for (const resolveDrain of persistenceDrainWaiters) resolveDrain();
            persistenceDrainWaiters.clear();
          }
          sinkOverrides.delete(job.id);
          // 扩展可能在 sink 写入期间为加载新产物而断开；写完这一刻才是真正安全窗口。
          setImmediate(() => {
            maybeRestart();
            resumeDeferredUpdate();
          });
        } finally {
          // The short logical reader deliberately outlives sink/index, terminal notification,
          // directed selection/finalization, and the persisting-job fence itself. If terminal
          // handling releases the run reader, this operation reader still owns the physical lease.
          if (artifactReader) await artifactReader.release();
        }
      }
    }
    if (parsedEnvelope.type === 'job.error') {
      const error = errorSchema.parse(parsedEnvelope.payload);
      if (job.directedRunId && !directedService?.acceptsResult(job)) return;
      sinkOverrides.delete(job.id);
      const status = error.needsAttention ? 'needs_attention' : 'failed';
      const terminal = await jobs.transition(job.id, status, {
        errorCode: error.code,
        errorMessage: error.message,
      });
      publishDurableJobNotice(terminal);
      await notifyJobTerminal(
        terminal,
        isZsxqJob(job) && error.code === 'INCOMPLETE_CONTENT' ? '正文不完整' : undefined,
      );
      resumeDeferredUpdate();
      return;
    }
    throw new Error(`不支持的 WebSocket 消息：${parsedEnvelope.type}`);
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopback(request)) throw new HttpError(403, 'LOOPBACK_ONLY', '只允许本机访问');
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      // 每次都现读：用户自己跑一次 npm run package 也该立刻算数，不用等下一轮自更新。
      const buildId = await refreshArtifactBuildId();
      return sendJson(response, 200, {
        ok: true,
        version: APP_VERSION,
        trustedExtensionId: TRUSTED_EXTENSION_ID,
        extensionConnected: extensionReady && extensionSocket?.readyState === WebSocket.OPEN,
        directedRunActive: directedService?.hasActiveRun() ?? false,
        ...(extensionReady && extensionVersion ? { extensionVersion } : {}),
        ...(extensionReady && extensionBuildId ? { extensionBuildId } : {}),
        ...(extensionReady && extensionSocket ? {
          extensionCapabilities: extensionRuntime.get(extensionSocket)?.capabilities ?? [],
        } : {}),
        routing: router.describeRouting(),
        // 同步去向：采集只落本机库，这里说明「之后会同步到哪」。
        syncTargets: router.describeSyncTargets(),
        ...(planStoreError ? { planError: planStoreError } : {}),
        ...(directedError ? { directedError } : {}),
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

    const nowcoderSessionMatch = requestUrl.pathname.match(
      /^\/v1\/nowcoder\/search-sessions\/([^/]+)$/u,
    );
    const nowcoderRunMatch = requestUrl.pathname.match(/^\/v1\/nowcoder\/runs\/([^/]+)$/u);
    const nowcoderCancelMatch = requestUrl.pathname.match(
      /^\/v1\/nowcoder\/runs\/([^/]+)\/cancel$/u,
    );
    const nowcoderRetryMatch = requestUrl.pathname.match(
      /^\/v1\/nowcoder\/runs\/([^/]+)\/retry$/u,
    );

    if (request.method === 'POST' && requestUrl.pathname === '/v1/nowcoder/search-sessions') {
      const { controller } = requireDirectedHttp();
      return await directedRoute(async () => {
        const input = nowcoderSearchPreviewRequestSchema.parse(await readJson(request));
        const session = await controller.create(input);
        return sendJson(
          response,
          201,
          nowcoderSearchPreviewResponseSchema.parse({ session }),
        );
      });
    }
    if (request.method === 'GET' && nowcoderSessionMatch?.[1]) {
      const { store } = requireDirectedHttp();
      const id = directedRouteId(nowcoderSessionMatch[1]);
      const session = store.getSession(id);
      if (!session) {
        throw new HttpError(
          404,
          'NOWCODER_SESSION_NOT_FOUND',
          '牛客搜索会话不存在',
        );
      }
      return sendJson(response, 200, nowcoderSearchPreviewResponseSchema.parse({ session }));
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/nowcoder/runs') {
      const { store, service } = requireDirectedHttp();
      return await directedRoute(async () => {
        const input = nowcoderDirectedStartRequestSchema.parse(await readJson(request));
        if (!store.getSession(input.searchSessionId)) {
          throw new HttpError(
            404,
            'NOWCODER_SESSION_NOT_FOUND',
            '牛客搜索会话不存在',
          );
        }
        const result = await service.startRun(input);
        return sendJson(
          response,
          result.created ? 202 : 200,
          nowcoderDirectedStartResponseSchema.parse({ run: result.run }),
        );
      });
    }
    if (request.method === 'GET' && nowcoderRunMatch?.[1]) {
      const { store } = requireDirectedHttp();
      const id = directedRouteId(nowcoderRunMatch[1]);
      const run = store.getRun(id);
      if (!run) {
        throw new HttpError(404, 'NOWCODER_RUN_NOT_FOUND', '牛客定向运行不存在');
      }
      return sendJson(response, 200, nowcoderDirectedStartResponseSchema.parse({ run }));
    }
    if (request.method === 'POST' && nowcoderCancelMatch?.[1]) {
      const { store, service } = requireDirectedHttp();
      return await directedRoute(async () => {
        const id = directedRouteId(nowcoderCancelMatch[1]!);
        const input = nowcoderDirectedCancelRequestSchema.parse(await readJson(request));
        const current = store.getRun(id);
        if (!current) {
          throw new HttpError(404, 'NOWCODER_RUN_NOT_FOUND', '牛客定向运行不存在');
        }
        if (current.attempt !== input.attempt) {
          throw new HttpError(
            409,
            'NOWCODER_ATTEMPT_STALE',
            '牛客定向运行尝试已过期',
          );
        }
        const run = await service.cancelRun(id, input.attempt);
        return sendJson(
          response,
          200,
          nowcoderDirectedCancelResponseSchema.parse({ run }),
        );
      });
    }
    if (request.method === 'POST' && nowcoderRetryMatch?.[1]) {
      const { store, service } = requireDirectedHttp();
      return await directedRoute(async () => {
        const id = directedRouteId(nowcoderRetryMatch[1]!);
        const input = nowcoderDirectedRetryRequestSchema.parse(await readJson(request));
        if (!store.getRun(id)) {
          throw new HttpError(404, 'NOWCODER_RUN_NOT_FOUND', '牛客定向运行不存在');
        }
        const result = await service.retryRun(id, input);
        return sendJson(
          response,
          result.created ? 202 : 200,
          nowcoderDirectedRetryResponseSchema.parse({ run: result.run }),
        );
      });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/v1/jobs') {
      const input = createJobSchema.parse(await readJson(request));
      const inputSource = descriptorForHost(new URL(input.url).hostname)?.id;
      const artifactBuildId = inputSource === 'zsxq'
        ? await refreshArtifactBuildId()
        : undefined;
      if (
        inputSource === 'zsxq'
        && !extensionCanCollectZsxq(extensionSocket, artifactBuildId)
      ) {
        throw new HttpError(
          409,
          'EXTENSION_UPDATE_REQUIRED',
          `知识星球完整正文采集要求扩展版本至少为 ${ZSXQ_COMPLETE_CONTENT_MINIMUM_EXTENSION_VERSION}、具备完整性能力标识，且构建与当前磁盘产物一致`,
        );
      }
      if (input.batchId && input.planId) {
        try {
          await collectionPlans?.assertJobAttempt(input.batchId, input.planId, input.attempt);
        } catch (error) {
          throw new HttpError(
            409,
            'STALE_PLAN_ATTEMPT',
            error instanceof Error ? error.message : '固定采集计划尝试已过期',
          );
        }
      }
      const job = await jobs.create({
        url: input.url,
        requestedBy: input.requestedBy,
        ...(input.id
          ? { id: input.id }
          : input.batchId
            ? {
                id: input.attempt
                  ? `${input.batchId}-${input.attempt}-${stableContentId(input.url)}`
                  : `${input.batchId}-${stableContentId(input.url)}`,
              }
            : {}),
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.attempt ? { planAttempt: input.attempt } : {}),
      });
      try {
        await collectionPlans?.onJobCreated(job);
      } catch (error) {
        // 在计划预检与 JobStore 落盘之间可能恰好发生重连换代。
        // 二次原子校验是最终权威；旧代任务绝不回传 202。
        if (job.status === 'queued') {
          const failed = await jobs.transition(job.id, 'failed', {
            errorCode: 'STALE_PLAN_ATTEMPT',
            errorMessage: error instanceof Error ? error.message : '固定采集计划尝试已过期',
          }).catch(() => undefined);
          if (failed) await notifyJobTerminal(failed);
        }
        throw new HttpError(
          409,
          'STALE_PLAN_ATTEMPT',
          error instanceof Error ? error.message : '固定采集计划尝试已过期',
        );
      }
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
        zsxqMode: z.enum(['daily-ledger', 'owner-history']).optional(),
      }).strict().superRefine((value, context) => {
        if (value.zsxqMode && value.planId !== 'zsxq-chen-teacher') {
          context.addIssue({
            code: 'custom',
            path: ['zsxqMode'],
            message: '只有知识星球计划支持逐日或历史模式',
          });
        }
      }).parse(await readJson(request));
      if (input.planId === 'zsxq-chen-teacher') await refreshArtifactBuildId();
      return sendJson(response, 202, await collectionPlans.run(
        input.planId,
        {
          ...(input.force === undefined ? {} : { force: input.force }),
          ...(input.zsxqMode ? { zsxqMode: input.zsxqMode } : {}),
        },
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
    if (request.method === 'GET' && requestUrl.pathname === '/v1/library/zsxq-index') {
      return sendJson(response, 200, { entries: await loadZsxqLibraryIndex(config.libraryRoot) });
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
      restartHandoffSocket = restartPending ? socket : undefined;
      restartHandoffReady = false;
      extensionReady = false;
      extensionVersion = undefined;
      extensionBuildId = undefined;
      let messageQueue: Promise<void> = Promise.resolve();
      let policyViolated = false;
      const rejectInvalidMessage = (error: unknown): void => {
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
      };
      socket.on('message', data => {
        // hello 处理链会下发 plan.collect 并等待 plan.started；若确认消息也排在同一
        // 串行队列后面，就会形成自锁。接单确认只触碰 attempt fence 与内存 waiter，
        // 可安全地作为唯一的队外控制消息处理。
        let planStartAck = false;
        try {
          planStartAck = (JSON.parse(messageText(data)) as { type?: unknown }).type === 'plan.started';
        } catch {
          // 无效 JSON 仍交给串行处理路径生成统一协议错误。
        }
        if (planStartAck) {
          void trackOperation(handleSocketMessage(socket, data)).catch(rejectInvalidMessage);
          return;
        }
        messageQueue = trackOperation(messageQueue
          .then(() => handleSocketMessage(socket, data))
          .catch(rejectInvalidMessage));
      });
      socket.once('close', () => {
        if (extensionSocket === socket) {
          extensionSocket = undefined;
          if (restartHandoffSocket === socket) restartHandoffSocket = undefined;
          restartHandoffReady = false;
          extensionReady = false;
          extensionVersion = undefined;
          extensionBuildId = undefined;
          // 不等下一轮（生产默认 10 分钟）更新检查；短暂断连就是旧进程退出的窗口。
          setImmediate(maybeRestart);
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
  const closeFailedError = new Error(SERVER_CLOSE_FAILED_MESSAGE);
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
        // 先等所有入口彻底关闭，保证不会再登记新操作；再排空关闭前已经接收的工作。
        let cleanupFailed = false;
        const endpointResults = await Promise.allSettled([serverClosed, websocketClosed]);
        if (endpointResults.some(result => result.status === 'rejected')) cleanupFailed = true;
        try {
          await drainActiveOperations();
        } catch {
          cleanupFailed = true;
        }
        try {
          await directedService?.close();
        } catch {
          cleanupFailed = true;
        }
        try {
          restartIntent?.release();
        } catch {
          cleanupFailed = true;
        } finally {
          restartIntent = undefined;
        }
        try {
          await artifactReaders.close();
        } catch {
          cleanupFailed = true;
        }
        if (cleanupFailed) throw closeFailedError;
      })();
      return closePromise;
    },
  };
}
