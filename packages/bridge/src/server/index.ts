import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  clearLibrary,
  deleteEntries,
  listLibrary,
  pendingIds,
  readEntry,
  syncEntries,
} from '../library/index.js';
import { updateWorkspace, type UpdateOutcome } from '../autoUpdate.js';
import {
  FeJourneyCollector,
  FeJourneyCandidateIndex,
  discoverGithubProjects,
  discoverNowcoderUrls,
  saveCollectedDocument,
} from '../feJourney/index.js';

/** 删除请求：要么给明确的 id 列表，要么显式 all:true —— 不接受隐式全删。 */
const deleteLibrarySchema = z.object({
  ids: z.array(z.string().min(1).max(200)).max(2_000).optional(),
  all: z.boolean().optional(),
});

const execFileAsync = promisify(execFile);

const createJobSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  url: z.string().url().max(4096),
  requestedBy: z.enum(['codex', 'cli', 'extension']).default('cli'),
  /** 用户为本次采集显式选择的落地去向（sink id）；缺省按来源默认路由。 */
  sinks: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
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
  /** 只有常驻 CLI 服务显式开启固定周期；嵌入式/测试启动不产生后台网络请求。 */
  enableFeJourneyScheduler?: boolean;
  /** 到期检查间隔，默认 15 分钟。 */
  feJourneyCheckIntervalMs?: number;
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

/** 真正去跑 git / npm；只在这里碰子进程，纯逻辑留在 autoUpdate.ts 里好测。 */
const processUpdateHost = {
  run: async (command: string, args: readonly string[], cwd: string): Promise<string> => {
    const { stdout } = await execFileAsync(command, [...args], { cwd, timeout: 10 * 60_000 });
    return stdout;
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
  const access = await AccessTokenManager.open(config.authFile);
  const jobs = await JobStore.open(config.jobsFile);
  await jobs.recover();
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
  const candidateIndex = await FeJourneyCandidateIndex.open(config.libraryRoot);
  const reveal = options.reveal ?? defaultReveal;

  // ── 自更新 ───────────────────────────────────────────────────────────
  // 失败一律只记录、不抛：更新是附加能力，绝不能把采集服务带下水。
  let update: UpdateOutcome | undefined;
  const repoRoot = options.repoRoot ?? undefined;
  const runUpdate = options.runUpdate ?? (root => updateWorkspace(root, processUpdateHost));
  const checkForUpdate = async (): Promise<void> => {
    if (!repoRoot) return;
    try {
      update = await runUpdate(repoRoot);
      if (update.changed) console.warn(`[update] ${update.message}`);
    } catch (error) {
      console.warn(`[update] 检查更新失败：${error instanceof Error ? error.message : error}`);
    }
  };
  const updateTimer = repoRoot
    ? setInterval(() => void checkForUpdate(), options.updateIntervalMs ?? 10 * 60_000)
    : undefined;
  updateTimer?.unref?.();
  void checkForUpdate();
  // 本次进程内的「任务 → 用户选定去向」覆盖表。Bridge 重启后该覆盖丢失，
  // 任务回退到来源默认路由（安全的降级，不会写到未选定的目标）。
  const sinkOverrides = new Map<string, string[]>();
  let extensionSocket: WebSocket | undefined;
  let extensionReady = false;

  const dispatch = async (job: JobRecord): Promise<void> => {
    if (!extensionReady || extensionSocket?.readyState !== WebSocket.OPEN || job.status !== 'queued') return;
    await jobs.transition(job.id, 'dispatched');
    extensionSocket.send(JSON.stringify(envelope('job.collect', job.id, { url: job.url })));
  };

  const dispatchQueued = async (): Promise<void> => {
    for (const job of jobs.list('queued')) await dispatch(job);
  };

  const feJourneyEnabled = sinksConfig.sinks['fe-journey']?.type === 'repo-inbox';
  const collectorFetcher = options.fetch ?? fetch;
  const feJourneyCollector = await FeJourneyCollector.open({
    stateFile: join(config.configDir, 'fe-journey-state.json'),
    enabled: feJourneyEnabled,
    now: () => new Date().toISOString(),
    knownNowcoderUrls: () => new Set(
      jobs.list()
        .map(job => job.url)
        .filter(url => url.startsWith('https://www.nowcoder.com/')),
    ),
    discoverNowcoder: knownUrls => discoverNowcoderUrls(collectorFetcher, knownUrls),
    enqueueNowcoder: async url => {
      const id = `fe-journey-nowcoder-${stableContentId(url)}`;
      if (jobs.get(id)) return false;
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

  const handleSocketMessage = async (socket: WebSocket, data: RawData): Promise<void> => {
    const parsedEnvelope = wsEnvelopeSchema.parse(JSON.parse(messageText(data)));
    if (parsedEnvelope.type === 'extension.hello') {
      if (!extensionReady) await jobs.recover();
      extensionReady = true;
      await dispatchQueued();
      return;
    }
    if (parsedEnvelope.type === 'bridge.ping') {
      socket.send(JSON.stringify(envelope('bridge.pong', parsedEnvelope.requestId, {})));
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
      if (job.status === 'saved') return;
      const result = jobResultPayloadSchema.parse(parsedEnvelope.payload);
      if (result.document.canonicalUrl !== job.url) {
        throw new Error('回传内容 URL 与采集任务不一致');
      }
      if (job.status === 'dispatched') await jobs.transition(job.id, 'collecting');
      const override = sinkOverrides.get(job.id);
      const sinkResults = await saveCollectedDocument(
        router,
        candidateIndex,
        result.document as CollectedDocument,
        override,
      );
      sinkOverrides.delete(job.id);
      const succeeded = sinkResults.filter(sinkResult => sinkResult.ok);
      if (succeeded.length === 0) {
        const detail = sinkResults
          .map(sinkResult => `${sinkResult.sinkId}: ${sinkResult.detail?.error ?? '失败'}`)
          .join('；');
        throw new Error(`所有落地目标均失败：${detail || '无可用目标'}`);
      }
      const primary = succeeded[0]!;
      await jobs.transition(job.id, 'saved', { outputPath: primary.outputRef });
      socket.send(
        JSON.stringify(
          envelope('job.saved', job.id, { outputPath: primary.outputRef, results: sinkResults }),
        ),
      );
      return;
    }
    if (parsedEnvelope.type === 'job.error') {
      const error = errorSchema.parse(parsedEnvelope.payload);
      const status = error.needsAttention ? 'needs_attention' : 'failed';
      await jobs.transition(job.id, status, {
        errorCode: error.code,
        errorMessage: error.message,
      });
      return;
    }
    throw new Error(`不支持的 WebSocket 消息：${parsedEnvelope.type}`);
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopback(request)) throw new HttpError(403, 'LOOPBACK_ONLY', '只允许本机访问');
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      return sendJson(response, 200, {
        ok: true,
        version: APP_VERSION,
        trustedExtensionId: TRUSTED_EXTENSION_ID,
        extensionConnected: extensionReady && extensionSocket?.readyState === WebSocket.OPEN,
        routing: router.describeRouting(),
        // 同步去向：采集只落本机库，这里说明「之后会同步到哪」。
        syncTargets: router.describeSyncTargets(),
        // 扩展据此判断「我加载的是不是当前这一版」，是就不打扰，不是就提示重新加载。
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
        ...(input.id ? { id: input.id } : {}),
      });
      if (input.sinks?.length) sinkOverrides.set(job.id, input.sinks);
      sendJson(response, 202, job);
      if (job.requestedBy !== 'extension') await dispatch(job);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/fe-journey/status') {
      return sendJson(response, 200, feJourneyCollector.status());
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/fe-journey/collect') {
      const input = runFeJourneySchema.parse(await readJson(request));
      if (!feJourneyCollector.status().enabled) {
        throw new HttpError(
          409,
          'FE_JOURNEY_DISABLED',
          '本机未启用固定 fe-journey 收件箱，定时采集保持关闭',
        );
      }
      return sendJson(response, 200, await feJourneyCollector.run(input));
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
      // 「清空」必须显式请求，绝不把「没传 ids」理解成「删全部」。
      const outcome = input.all
        ? await clearLibrary(config.libraryRoot)
        : await deleteEntries(config.libraryRoot, input.ids ?? []);
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
    void route(request, response).catch(error => {
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const code = error instanceof HttpError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : '未知错误';
      sendJson(response, status, { error: { code, message } });
    });
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
        messageQueue = messageQueue
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
          });
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
  if (options.enableFeJourneyScheduler && feJourneyEnabled) {
    const runScheduledCollection = (): void => {
      void feJourneyCollector.run().catch(error => {
        console.warn(`[fe-journey] 定时采集失败：${error instanceof Error ? error.message : error}`);
      });
    };
    runScheduledCollection();
    feJourneyTimer = setInterval(
      runScheduledCollection,
      options.feJourneyCheckIntervalMs ?? 15 * 60_000,
    );
    feJourneyTimer.unref?.();
  }
  const address = server.address() as AddressInfo;
  const url = `http://${config.host}:${address.port}`;
  return {
    url,
    wsUrl: `ws://${config.host}:${address.port}/v1/extension`,
    async close() {
      if (updateTimer) clearInterval(updateTimer);
      if (feJourneyTimer) clearInterval(feJourneyTimer);
      extensionSocket?.close(1001, 'server shutdown');
      websocketServer.close();
      server.close();
      await once(server, 'close');
    },
  };
}
