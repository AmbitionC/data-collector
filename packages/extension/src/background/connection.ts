import {
  APP_VERSION,
  EXTENSION_REPLACED_CLOSE_CODE,
  EXTENSION_REPLACED_CLOSE_REASON,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  bridgeAuthorizedPayloadSchema,
  collectionPlanAttemptSchema,
  jobCollectPayloadSchema,
  jobFailedPayloadSchema,
  jobSavedPayloadSchema,
  planCollectPayloadSchema,
  wsEnvelopeSchema,
  type CollectionPlanAttempt,
  type CollectionPlanId,
  type ZsxqCollectionMode,
  type ZsxqLibraryIndexEntry,
} from '@data-collector/shared';

export interface ExtensionStorage {
  get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface SocketLike {
  readyState: number;
  addEventListener(type: string, listener: (event: {
    data?: string;
    code?: number;
    reason?: string;
  }) => void): void;
  send(value: string): void;
  close(): void;
}

interface ConnectionDependencies {
  storage: ExtensionStorage;
  extensionId: string;
  socketFactory: (url: string) => SocketLike;
  fetch: typeof fetch;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

type CollectHandler = (requestId: string, url: string, interactive: boolean) => void | Promise<void>;
type PlanCollectHandler = (
  requestId: string,
  payload: {
    batchId: string;
    planId: CollectionPlanId;
    attempt: CollectionPlanAttempt;
    force?: boolean;
    zsxqMode?: ZsxqCollectionMode;
    targetDays?: string[];
    resumeCursor?: string;
  },
) => void | Promise<void>;

const DEFAULT_PORT = 17321;
const PLAN_REJECTIONS_MINIMUM_BRIDGE_VERSION = '0.4.11';
const PLAN_REJECTION_DETAILS_MINIMUM_BRIDGE_VERSION = '0.4.29';

function versionAtLeast(actual: string | undefined, minimum: string): boolean {
  if (!actual) return false;
  const parse = (value: string) => value.split('.').slice(0, 3).map(part => Number.parseInt(part, 10));
  const left = parse(actual);
  const right = parse(minimum);
  if (left.length !== 3 || right.length !== 3 || [...left, ...right].some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return true;
}

interface ConnectionTransition {
  generation: number;
  values: Record<string, unknown>;
}

interface JobTerminalNotice {
  status: 'saved' | 'failed';
  attempt?: CollectionPlanAttempt;
  message?: string;
}

interface JobTerminalWaiter {
  expectedAttempt?: CollectionPlanAttempt;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle?: unknown;
  settled: boolean;
}

// Image downloads, repository writes and delivery sync all finish before Bridge emits the durable
// terminal acknowledgement. Real ZSXQ posts with remote media can legitimately take over a minute;
// keep this below the 30-minute plan deadline while leaving enough room for slow attachment hosts.
const JOB_TERMINAL_ACK_TIMEOUT_MS = 10 * 60_000;
const RECENT_JOB_TERMINAL_LIMIT = 100;

export class BridgeConnection {
  private socket: SocketLike | undefined;
  private pingTimer: unknown;
  private reconnectTimer: unknown;
  private reconnectAttempt = 0;
  private collectHandler: CollectHandler | undefined;
  private planCollectHandler: PlanCollectHandler | undefined;
  private stopped = false;
  private startPromise: Promise<void> | undefined;
  private generation = 0;
  private latestTransition: ConnectionTransition | undefined;
  private latestJobTransition: ConnectionTransition | undefined;
  private tokenInvalidation: Promise<void> | undefined;
  private ignoreStoredToken = false;
  private reconnectSuppressed = false;
  private bridgeVersion: string | undefined;
  /** WebSocket 终态可能比调用方注册 waiter 更快，保留一个有界抢先回执缓存。 */
  private readonly recentJobTerminals = new Map<string, JobTerminalNotice>();
  private readonly jobTerminalWaiters = new Map<string, Set<JobTerminalWaiter>>();

  constructor(private readonly dependencies: ConnectionDependencies) {}

  onCollect(handler: CollectHandler): void {
    this.collectHandler = handler;
  }

  onPlanCollect(handler: PlanCollectHandler): void {
    this.planCollectHandler = handler;
  }

  async start(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true;
    if (force) this.reconnectSuppressed = false;
    if (this.reconnectSuppressed) return;
    this.stopped = false;
    if (this.startPromise) {
      await this.startPromise;
      if (force && this.reconnectSuppressed) {
        this.reconnectSuppressed = false;
        await this.start({ force: true });
      }
      return;
    }
    const startPromise = this.startOnce(force);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  async retry(): Promise<void> {
    await this.start({ force: true });
  }

  /** 尽力刷新「去向/分类」路由缓存；失败忽略（连接问题由 WebSocket 反映）。 */
  private async refreshRouting(port: number): Promise<void> {
    try {
      // 必须先取成局部变量再调用：写成 this.dependencies.fetch(...) 会把 dependencies
      // 当作 fetch 的接收者，浏览器抛 Illegal invocation，又被下面的 catch 吞掉，
      // 表现为「改了 Bridge 配置必须重装扩展」。
      const fetcher = this.dependencies.fetch;
      const response = await fetcher(`http://127.0.0.1:${port}/health`);
      if (!response.ok) return;
      const health = (await response.json()) as {
        version?: unknown;
        routing?: unknown;
        update?: unknown;
        buildId?: unknown;
      };
      await this.dependencies.storage.set({
        ...(health.routing && typeof health.routing === 'object'
          ? { routing: health.routing }
          : {}),
        // 本机服务会自己拉新代码并重新构建；扩展据此提示「有新版可加载」。
        ...(health.update && typeof health.update === 'object' ? { update: health.update } : {}),
        // 磁盘上那份产物的构建标记。和本扩展烙进来的一比就知道自己是不是最新的。
        ...(typeof health.buildId === 'string' ? { buildId: health.buildId } : {}),
      });
      if (typeof health.version === 'string') this.bridgeVersion = health.version;
    } catch {
      // 忽略。
    }
  }

  private async startOnce(force: boolean): Promise<void> {
    await this.tokenInvalidation;
    const settings = await this.settings();
    // 每次建连都重新验证；health 失败时必须保守按旧 Bridge 发送。
    this.bridgeVersion = undefined;
    if (!force && settings.status === 'replaced') {
      this.reconnectSuppressed = true;
      return;
    }
    // 已授权时先尽力刷新一次路由：即使当前已连接（下面会提前 return），
    // Bridge 侧改了去向/分类也能生效，不需要重装扩展。
    if (settings.token) await this.refreshRouting(settings.port);
    if (this.socket?.readyState === 0 || this.socket?.readyState === 1) return;
    const generation = ++this.generation;
    const bootstrap = !settings.token;
    if (bootstrap) {
      let trustedExtensionId: string;
      try {
        const fetcher = this.dependencies.fetch;
        const response = await fetcher(
          `http://127.0.0.1:${settings.port}/health`,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = (await response.json()) as {
          version?: unknown;
          trustedExtensionId?: unknown;
          routing?: unknown;
          buildId?: unknown;
        };
        if (typeof health.trustedExtensionId !== 'string') {
          throw new Error('Bridge health response is missing trustedExtensionId');
        }
        trustedExtensionId = health.trustedExtensionId;
        if (typeof health.version === 'string') this.bridgeVersion = health.version;
        // 缓存路由说明（可选去向 + 各自分类 + 来源默认去向），供侧边栏渲染选择器。
        if (health.routing && typeof health.routing === 'object') {
          await this.dependencies.storage.set({ routing: health.routing });
        }
        if (typeof health.buildId === 'string') {
          await this.dependencies.storage.set({ buildId: health.buildId });
        }
      } catch {
        await this.markDisconnected(generation);
        return;
      }
      if (trustedExtensionId !== this.dependencies.extensionId) {
        this.cancelReconnect();
        await this.transition(generation, { bridgeStatus: 'identity_error' });
        return;
      }
    }
    if (!this.isCurrent(generation)) return;

    if (!(await this.transition(generation, { bridgeStatus: 'connecting' }))) return;
    let socket: SocketLike;
    try {
      socket = this.dependencies.socketFactory(
        bootstrap
          ? `ws://127.0.0.1:${settings.port}/v1/extension?bootstrap=1`
          : `ws://127.0.0.1:${settings.port}/v1/extension?token=${encodeURIComponent(settings.token!)}`,
      );
    } catch {
      await this.markDisconnected(generation);
      return;
    }
    if (!this.isCurrent(generation)) {
      socket.close();
      return;
    }
    this.socket = socket;
    let disconnected = false;
    let announced = false;
    let connectionReady: Promise<boolean> | undefined;
    const isCurrent = () =>
      this.isCurrent(generation) && !disconnected && this.socket === socket;

    const announce = async (token?: string): Promise<void> => {
      if (announced || !isCurrent()) return;
      if (token && !connectionReady) {
        connectionReady = this.transition(generation, {
          bridgeToken: token,
          bridgeStatus: 'connected',
        });
      }
      if (bootstrap && !connectionReady) return;
      connectionReady ??= this.transition(generation, { bridgeStatus: 'connected' });
      const readyCommitted = await connectionReady;
      if (token && readyCommitted) this.ignoreStoredToken = false;
      if (!readyCommitted) return;
      if (announced || !isCurrent() || socket.readyState !== 1) return;
      announced = true;
      this.reconnectSuppressed = false;
      this.reconnectAttempt = 0;
      this.cancelReconnect();
      const runningBuildId = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : undefined;
      this.send('extension.hello', 'extension', {
        version: APP_VERSION,
        ...(runningBuildId ? { buildId: runningBuildId } : {}),
        capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
      });
      this.startKeepalive();
    };

    socket.addEventListener('open', () => {
      void announce();
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || !isCurrent()) return;
      void this.handleMessage(
        event.data,
        generation,
        isCurrent,
        token => announce(token),
      );
    });
    const disconnect = (event: { code?: number; reason?: string } = {}) => {
      if (disconnected || this.socket !== socket) return;
      const replaced =
        event.code === EXTENSION_REPLACED_CLOSE_CODE &&
        event.reason === EXTENSION_REPLACED_CLOSE_REASON;
      disconnected = true;
      if (replaced) {
        this.reconnectSuppressed = true;
        this.cancelReconnect();
      }
      if (socket.readyState !== 3) socket.close();
      if (this.socket === socket) this.socket = undefined;
      if (this.pingTimer !== undefined) {
        this.dependencies.clearInterval(this.pingTimer);
        this.pingTimer = undefined;
      }
      const ready = connectionReady;
      const invalidateStoredToken = !replaced && !bootstrap && !announced;
      void (async () => {
        if (ready) {
          try {
            await ready;
          } catch {
            // The disconnected transition below remains authoritative.
          }
        }
        if (replaced) {
          await this.transition(generation, { bridgeStatus: 'replaced' });
          return;
        }
        if (invalidateStoredToken) await this.invalidateStoredToken();
        await this.markDisconnected(generation);
      })();
    };
    socket.addEventListener('close', disconnect);
    socket.addEventListener('error', () => disconnect());
    if (socket.readyState === 1 && !bootstrap) void announce();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.pingTimer !== undefined) {
      this.dependencies.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  send(type: string, requestId: string, payload: unknown): void {
    const socket = this.socket;
    if (socket?.readyState !== 1) throw new Error('Bridge WebSocket 未连接');
    let compatiblePayload = payload;
    if (type === 'plan.result' && typeof payload === 'object' && payload !== null) {
      const planPayload = { ...payload as Record<string, unknown> };
      // prepared 是 ZSXQ 两阶段 staging 的标识。旧/未知 Bridge 无法可靠接收
      // rejection audit；宁可让上层收敛成 attention，也绝不能删字段后假绿。
      if (
        typeof planPayload.prepared === 'boolean'
        && !versionAtLeast(this.bridgeVersion, PLAN_REJECTION_DETAILS_MINIMUM_BRIDGE_VERSION)
      ) {
        throw new Error('BRIDGE_UPDATE_REQUIRED：当前 Bridge 无法接收知识星球正文完整性审计结果');
      }
      if (!versionAtLeast(this.bridgeVersion, PLAN_REJECTIONS_MINIMUM_BRIDGE_VERSION)) {
        delete planPayload.rejections;
      }
      if (!versionAtLeast(this.bridgeVersion, PLAN_REJECTION_DETAILS_MINIMUM_BRIDGE_VERSION)) {
        delete planPayload.rejectionDetails;
      }
      compatiblePayload = planPayload;
    }
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type,
        requestId,
        timestamp: new Date().toISOString(),
        payload: compatiblePayload,
      }),
    );
    const localStatus =
      type === 'job.progress'
        ? 'collecting'
        : type === 'job.result'
          ? 'organizing'
          : type === 'job.error'
            ? ((payload as { needsAttention?: boolean }).needsAttention ? 'needs_attention' : 'failed')
            : undefined;
    if (localStatus) {
      const generation = this.generation;
      const isCurrent = () => this.isCurrent(generation) && this.socket === socket;
      const errorMessage =
        type === 'job.error' && typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : '';
      void this.transitionJob(generation, isCurrent, {
        lastJobId: requestId,
        lastJobStatus: localStatus,
        lastJobError: errorMessage,
      });
    }
  }

  async createJob(
    url: string,
    overrides?: {
      userCategory?: string;
      userTags?: string[];
      sinks?: string[];
      batchId?: string;
      planId?: CollectionPlanId;
      attempt?: CollectionPlanAttempt;
    },
  ): Promise<{ id: string }> {
    const settings = await this.settings();
    if (!settings.token) throw new Error('浏览器扩展仍在自动连接 Bridge');
    const generation = this.generation;
    const isCurrent = () => this.isCurrent(generation);
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(
      `http://127.0.0.1:${settings.port}/v1/jobs`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url,
          requestedBy: 'extension',
          ...(overrides?.sinks?.length ? { sinks: overrides.sinks } : {}),
          ...(overrides?.batchId ? { batchId: overrides.batchId } : {}),
          ...(overrides?.planId ? { planId: overrides.planId } : {}),
          ...(overrides?.attempt ? { attempt: overrides.attempt } : {}),
        }),
      },
    );
    if (!response.ok) throw new Error(`创建采集任务失败：HTTP ${response.status}`);
    const job = (await response.json()) as { id?: unknown };
    if (typeof job.id !== 'string') throw new Error('Bridge 返回了无效任务');
    await this.transitionJob(generation, isCurrent, {
      lastJobId: job.id,
      lastJobStatus: 'queued',
      lastJobUrl: url,
      lastJobError: '',
    });
    return { id: job.id };
  }

  /**
   * 等待 Bridge 的持久化终态。WebSocket notice 是快路径；若 Bridge 恰好在
   * JobStore 落盘后、发 notice 前重启，超时时再查 JobStore，避免把成功误报失败。
   */
  waitForJobTerminal(
    jobId: string,
    expectedAttempt?: CollectionPlanAttempt,
    timeoutMs = JOB_TERMINAL_ACK_TIMEOUT_MS,
  ): Promise<void> {
    const recent = this.recentJobTerminals.get(jobId);
    if (recent) {
      this.recentJobTerminals.delete(jobId);
      const error = this.jobTerminalError(jobId, recent, expectedAttempt);
      return error ? Promise.reject(error) : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: JobTerminalWaiter = {
        ...(expectedAttempt ? { expectedAttempt } : {}),
        resolve,
        reject,
        settled: false,
      };
      const waiters = this.jobTerminalWaiters.get(jobId) ?? new Set<JobTerminalWaiter>();
      waiters.add(waiter);
      this.jobTerminalWaiters.set(jobId, waiters);
      waiter.timeoutHandle = this.dependencies.setTimeout(() => {
        void this.recoverPersistedJobTerminal(jobId)
          .then(notice => {
            if (waiter.settled) return;
            if (notice) {
              this.recordJobTerminal(jobId, notice);
              return;
            }
            this.finishJobTerminalWaiter(
              jobId,
              waiter,
              new Error(`等待 Bridge 持久化回执超时：${jobId}`),
            );
          })
          .catch(() => {
            this.finishJobTerminalWaiter(
              jobId,
              waiter,
              new Error(`等待 Bridge 持久化回执超时：${jobId}`),
            );
          });
      }, Math.max(1, timeoutMs));
    });
  }

  private jobTerminalError(
    jobId: string,
    notice: JobTerminalNotice,
    expectedAttempt?: CollectionPlanAttempt,
  ): Error | undefined {
    if (expectedAttempt && notice.attempt !== expectedAttempt) {
      return new Error(
        `固定计划任务回执尝试不匹配：${jobId}（期望 ${expectedAttempt}，收到 ${notice.attempt ?? '缺失'}）`,
      );
    }
    return notice.status === 'failed'
      ? new Error(notice.message ?? `Bridge 持久化失败：${jobId}`)
      : undefined;
  }

  private finishJobTerminalWaiter(
    jobId: string,
    waiter: JobTerminalWaiter,
    error?: Error,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timeoutHandle !== undefined) {
      this.dependencies.clearTimeout(waiter.timeoutHandle);
    }
    const waiters = this.jobTerminalWaiters.get(jobId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.jobTerminalWaiters.delete(jobId);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  private recordJobTerminal(jobId: string, notice: JobTerminalNotice): void {
    const waiters = this.jobTerminalWaiters.get(jobId);
    if (waiters?.size) {
      for (const waiter of [...waiters]) {
        this.finishJobTerminalWaiter(
          jobId,
          waiter,
          this.jobTerminalError(jobId, notice, waiter.expectedAttempt),
        );
      }
      return;
    }
    this.recentJobTerminals.delete(jobId);
    this.recentJobTerminals.set(jobId, notice);
    while (this.recentJobTerminals.size > RECENT_JOB_TERMINAL_LIMIT) {
      const oldest = this.recentJobTerminals.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recentJobTerminals.delete(oldest);
    }
  }

  private async recoverPersistedJobTerminal(jobId: string): Promise<JobTerminalNotice | undefined> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(`${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    const raw = await response.json() as {
      id?: unknown;
      status?: unknown;
      planAttempt?: unknown;
      errorMessage?: unknown;
    };
    if (raw.id !== jobId) return undefined;
    const parsedAttempt = collectionPlanAttemptSchema.safeParse(raw.planAttempt);
    const attempt = parsedAttempt.success ? parsedAttempt.data : undefined;
    if (raw.status === 'saved') {
      return { status: 'saved', ...(attempt ? { attempt } : {}) };
    }
    if (raw.status === 'failed' || raw.status === 'needs_attention') {
      return {
        status: 'failed',
        ...(attempt ? { attempt } : {}),
        ...(typeof raw.errorMessage === 'string' ? { message: raw.errorMessage } : {}),
      };
    }
    return undefined;
  }

  /** 当前 Bridge 是否达到某项扩展侧兼容逻辑要求的最低版本。 */
  supportsVersion(minimum: string): boolean {
    return versionAtLeast(this.bridgeVersion, minimum);
  }

  /** 已入库内容列表（供侧栏的「已入库」页面）。 */
  async library(): Promise<unknown[]> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(`${baseUrl}/v1/library`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`读取已入库内容失败：HTTP ${response.status}`);
    const body = (await response.json()) as { entries?: unknown };
    return Array.isArray(body.entries) ? body.entries : [];
  }

  /** 固定知识星球计划使用的正文无关紧凑索引，供打开帖子前去重。 */
  async zsxqIndex(): Promise<ZsxqLibraryIndexEntry[]> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(`${baseUrl}/v1/library/zsxq-index`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`读取知识星球去重索引失败：HTTP ${response.status}`);
    const body = (await response.json()) as { entries?: unknown };
    if (!Array.isArray(body.entries)) throw new Error('知识星球去重索引响应无效');
    return body.entries as ZsxqLibraryIndexEntry[];
  }

  /** 固定采集计划状态（受 Bridge token 保护，不把令牌暴露给侧栏）。 */
  async planStatus(): Promise<unknown> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(`${baseUrl}/v1/plans/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`读取采集任务失败：HTTP ${response.status}`);
    return response.json();
  }

  /** 立即运行一条固定计划；force 用于用户明确点击的重试/补跑。 */
  async runPlan(planId: CollectionPlanId, force = false): Promise<unknown> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(`${baseUrl}/v1/plans/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planId, ...(force ? { force: true } : {}) }),
    });
    if (!response.ok) throw new Error(`启动采集任务失败：HTTP ${response.status}`);
    return response.json();
  }

  /** 读一条已入库内容的正文（供侧栏「查看内容」）。 */
  async libraryEntry(id: string): Promise<unknown> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(
      `${baseUrl}/v1/library/entry?id=${encodeURIComponent(id)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) throw new Error('这一条已经不在本机知识库里了');
    if (!response.ok) throw new Error(`读取内容失败：HTTP ${response.status}`);
    return response.json();
  }

  /** 把已入库条目同步到目标仓库收件箱；pending 表示「全部未同步的」。 */
  async syncLibrary(input: { ids?: string[]; pending?: boolean }): Promise<unknown> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(`${baseUrl}/v1/library/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`同步失败：HTTP ${response.status}`);
    return response.json();
  }

  /** 删除已入库条目；all 为 true 表示清空（必须由调用方显式指定）。 */
  async deleteLibrary(input: { ids?: string[]; all?: boolean }): Promise<{ deleted: number }> {
    const { baseUrl, token } = await this.authorized();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(`${baseUrl}/v1/library/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`删除失败：HTTP ${response.status}`);
    return (await response.json()) as { deleted: number };
  }

  private async authorized(): Promise<{ baseUrl: string; token: string }> {
    const settings = await this.settings();
    if (!settings.token) throw new Error('浏览器扩展仍在自动连接 Bridge');
    return { baseUrl: `http://127.0.0.1:${settings.port}`, token: settings.token };
  }

  async reveal(path: string): Promise<void> {
    const settings = await this.settings();
    if (!settings.token) throw new Error('浏览器扩展仍在自动连接 Bridge');
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(
      `http://127.0.0.1:${settings.port}/v1/reveal`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ path }),
      },
    );
    if (!response.ok) throw new Error(`打开知识库文件失败：HTTP ${response.status}`);
  }

  private async settings(): Promise<{ token?: string; port: number; status?: string }> {
    const values = await this.dependencies.storage.get([
      'bridgeToken',
      'bridgePort',
      'bridgeStatus',
    ]);
    return {
      ...(!this.ignoreStoredToken && typeof values.bridgeToken === 'string'
        ? { token: values.bridgeToken }
        : {}),
      port: typeof values.bridgePort === 'number' ? values.bridgePort : DEFAULT_PORT,
      ...(typeof values.bridgeStatus === 'string' ? { status: values.bridgeStatus } : {}),
    };
  }

  private async invalidateStoredToken(): Promise<void> {
    if (this.tokenInvalidation) return this.tokenInvalidation;
    this.ignoreStoredToken = true;
    const invalidation = this.dependencies.storage.remove('bridgeToken').catch(() => undefined);
    this.tokenInvalidation = invalidation;
    try {
      await invalidation;
    } finally {
      if (this.tokenInvalidation === invalidation) this.tokenInvalidation = undefined;
    }
  }

  private async handleMessage(
    raw: string,
    generation: number,
    isCurrent: () => boolean,
    authorize: (token: string) => Promise<void>,
  ): Promise<void> {
    try {
      const message = wsEnvelopeSchema.parse(JSON.parse(raw));
      if (!isCurrent()) return;
      if (message.type === 'bridge.authorized') {
        const payload = bridgeAuthorizedPayloadSchema.parse(message.payload);
        await authorize(payload.token);
      } else if (message.type === 'job.collect') {
        const payload = jobCollectPayloadSchema.parse(message.payload);
        if (isCurrent()) {
          await this.transitionJob(generation, isCurrent, {
            lastJobId: message.requestId,
            lastJobStatus: 'collecting',
            lastJobUrl: payload.url,
            lastJobError: '',
            lastOutputPath: '',
            lastSinkIds: [],
          });
          // transitionJob=false 只表示侧栏状态已被更新的一条覆盖，绝不表示这个任务可丢弃。
          // 牛客一批会快速下发 12 条，存储写入重叠时每条仍必须进入采集队列。
          if (isCurrent()) {
            await this.collectHandler?.(message.requestId, payload.url, payload.interactive);
          }
        }
      } else if (message.type === 'plan.collect') {
        const payload = planCollectPayloadSchema.parse(message.payload);
        if (isCurrent()) await this.planCollectHandler?.(message.requestId, {
          batchId: payload.batchId,
          planId: payload.planId,
          attempt: payload.attempt,
          ...(payload.force === undefined ? {} : { force: payload.force }),
          ...(payload.zsxqMode ? { zsxqMode: payload.zsxqMode } : {}),
          ...(payload.targetDays ? { targetDays: payload.targetDays } : {}),
          ...(payload.resumeCursor ? { resumeCursor: payload.resumeCursor } : {}),
        });
      } else if (message.type === 'job.saved' && isCurrent()) {
        // Bridge 的 job.saved 载荷为 { outputPath, results }（多 sink 后的首要产出路径）。
        const payload = jobSavedPayloadSchema.parse(message.payload);
        this.recordJobTerminal(message.requestId, {
          status: 'saved',
          ...(payload.attempt ? { attempt: payload.attempt } : {}),
        });
        // 真正写成功的去向要留下来：默认路由可能同时写两处，结果屏光说「本地知识库」
        // 是在骗人——用户正是因此搞不清内容到底进了哪里。
        const sinkIds = Array.isArray(payload.results)
          ? (payload.results as { sinkId?: unknown; ok?: unknown }[])
              .filter(result => result?.ok === true && typeof result.sinkId === 'string')
              .map(result => result.sinkId as string)
          : [];
        await this.transitionJob(generation, isCurrent, {
          lastJobId: message.requestId,
          lastJobStatus: 'saved',
          lastSinkIds: sinkIds,
          ...(typeof payload.outputPath === 'string'
            ? { lastOutputPath: payload.outputPath }
            : {}),
        });
      } else if (message.type === 'job.failed' && isCurrent()) {
        const payload = jobFailedPayloadSchema.parse(message.payload);
        this.recordJobTerminal(message.requestId, {
          status: 'failed',
          message: payload.message,
          ...(payload.attempt ? { attempt: payload.attempt } : {}),
        });
        await this.transitionJob(generation, isCurrent, {
          lastJobId: message.requestId,
          lastJobStatus: 'failed',
          lastJobError: payload.message,
        });
      }
    } catch {
      if (isCurrent()) {
        await this.transition(generation, { bridgeStatus: 'protocol_error' });
      }
    }
  }

  private startKeepalive(): void {
    if (this.pingTimer !== undefined) this.dependencies.clearInterval(this.pingTimer);
    this.pingTimer = this.dependencies.setInterval(() => {
      if (this.socket?.readyState === 1) {
        this.send('bridge.ping', 'keepalive', {});
      }
    }, 20_000);
  }

  private async markDisconnected(generation: number): Promise<void> {
    if (!(await this.transition(generation, { bridgeStatus: 'disconnected' }))) return;
    if (!this.isCurrent(generation) || this.reconnectTimer !== undefined) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.dependencies.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start();
    }, delay);
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private async transition(
    generation: number,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    const transition = { generation, values };
    this.latestTransition = transition;
    await this.dependencies.storage.set(values);
    if (this.latestTransition !== transition) {
      let latest = this.latestTransition;
      while (latest) {
        await this.dependencies.storage.set(latest.values);
        if (this.latestTransition === latest) break;
        latest = this.latestTransition;
      }
      return false;
    }
    return this.isCurrent(generation);
  }

  private async transitionJob(
    generation: number,
    isCurrent: () => boolean,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    // 单页任务也必须有心跳时间：若 Service Worker 中途被回收，旧的 collecting
    // 不能永远阻止扩展加载新版。每个真实状态跃迁都会刷新这枚时间戳。
    const stampedValues: Record<string, unknown> = { ...values, lastJobUpdatedAt: Date.now() };
    const previous = this.latestJobTransition?.values;
    const transitionValues =
      previous?.lastJobId === stampedValues.lastJobId
        ? { ...previous, ...stampedValues }
        : stampedValues;
    const transition = { generation, values: transitionValues };
    this.latestJobTransition = transition;
    await this.dependencies.storage.set(stampedValues);
    if (this.latestJobTransition !== transition) {
      let latest = this.latestJobTransition;
      while (latest) {
        await this.dependencies.storage.set(latest.values);
        if (this.latestJobTransition === latest) break;
        latest = this.latestJobTransition;
      }
      return false;
    }
    return isCurrent();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.dependencies.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
