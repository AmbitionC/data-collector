import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  canonicalizeUrl,
  parseSupportedUrl,
  type JobRecord,
  type JobStatus,
  type CollectionPlanAttempt,
  type CollectionPlanId,
  nowcoderDirectedRunAttemptSchema,
  type NowcoderDirectedRunAttempt,
} from '@data-collector/shared';

interface JobStoreDependencies {
  now: () => string;
  id: () => string;
  atomicWrite: (path: string, value: StoredJobs) => Promise<void>;
}

interface JobStoreOpenOptions extends Partial<JobStoreDependencies> {
  /**
   * A legacy jobs file may not contain directed pins yet. Startup must load the directed
   * run store and reconcile its exact active proof set before terminal pruning is safe.
   */
  deferPrune?: boolean;
}

interface StoredJobs {
  version: 1;
  jobs: JobRecord[];
  /** False means startup has not yet reconciled this file against the directed run store. */
  directedPinsBootstrapped?: boolean;
  directedPins?: Array<{
    runId: string;
    attempt: NowcoderDirectedRunAttempt;
    jobIds: string[];
  }>;
}

export interface CreateJobInput {
  id?: string;
  url: string;
  requestedBy: JobRecord['requestedBy'];
  batchId?: string;
  planId?: CollectionPlanId;
  planAttempt?: CollectionPlanAttempt;
  directedRunId?: string;
  directedRunAttempt?: NowcoderDirectedRunAttempt;
}

export interface JobTransitionPatch {
  outputPath?: string;
  markdownOutput?: { sinkId: 'markdown'; outputPath: string };
  errorCode?: string;
  errorMessage?: string;
}

const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['dispatched', 'collecting', 'failed'],
  dispatched: ['queued', 'collecting', 'needs_attention', 'failed'],
  collecting: ['queued', 'saved', 'needs_attention', 'failed'],
  saved: [],
  needs_attention: [],
  failed: [],
};

function assertDirectedOwnership(
  value: Pick<CreateJobInput, 'planId' | 'planAttempt' | 'directedRunId' | 'directedRunAttempt'>,
): void {
  const hasRun = value.directedRunId !== undefined;
  const hasAttempt = value.directedRunAttempt !== undefined;
  if (hasRun !== hasAttempt) {
    throw new Error('directedRunId 与 directedRunAttempt 必须同时提供');
  }
  if (hasRun && (value.planId !== undefined || value.planAttempt !== undefined)) {
    throw new Error('固定计划与定向运行不能同时拥有同一任务');
  }
  if (value.directedRunId !== undefined && value.directedRunId.trim().length === 0) {
    throw new Error('定向运行 ID 无效');
  }
  if (value.directedRunAttempt !== undefined) {
    nowcoderDirectedRunAttemptSchema.parse(value.directedRunAttempt);
  }
}

function validateStoredJob(value: JobRecord): void {
  try {
    assertDirectedOwnership(value);
    if (value.markdownOutput !== undefined && (
      value.markdownOutput.sinkId !== 'markdown'
      || typeof value.markdownOutput.outputPath !== 'string'
      || value.markdownOutput.outputPath.length === 0
    )) throw new Error('invalid markdown output');
  } catch {
    throw new Error('任务文件格式无效');
  }
}

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobStateError';
  }
}

async function atomicWrite(path: string, value: StoredJobs): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly directedPins = new Map<string, {
    runId: string;
    attempt: NowcoderDirectedRunAttempt;
    jobIds: Set<string>;
  }>();
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly path: string,
    private readonly dependencies: JobStoreDependencies,
    private pruningBootstrapped: boolean,
  ) {}

  static async open(
    path: string,
    options: JobStoreOpenOptions = {},
  ): Promise<JobStore> {
    const { deferPrune = false, ...overrides } = options;
    const store = new JobStore(path, {
      now: () => new Date().toISOString(),
      id: () => randomUUID(),
      atomicWrite,
      ...overrides,
    }, !deferPrune);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw error;
    }
    const data = JSON.parse(raw) as StoredJobs;
    if (data.version !== 1 || !Array.isArray(data.jobs)) {
      throw new Error('任务文件格式无效');
    }
    const hasDurablePinProtocol = Object.prototype.hasOwnProperty.call(data, 'directedPins');
    if (data.directedPinsBootstrapped !== undefined
      && typeof data.directedPinsBootstrapped !== 'boolean') throw new Error('任务文件格式无效');
    const pins = data.directedPins ?? [];
    if (!Array.isArray(pins)) throw new Error('任务文件格式无效');
    for (const pin of pins) {
      if (!pin || typeof pin !== 'object'
        || typeof pin.runId !== 'string'
        || pin.runId.trim().length === 0
        || !Array.isArray(pin.jobIds)
        || pin.jobIds.some(id => typeof id !== 'string' || id.length === 0)
        || new Set(pin.jobIds).size !== pin.jobIds.length) {
        throw new Error('任务文件格式无效');
      }
      const attempt = nowcoderDirectedRunAttemptSchema.parse(pin.attempt);
      const key = `${pin.runId}\u0000${attempt}`;
      if (store.directedPins.has(key)) throw new Error('任务文件格式无效');
      store.directedPins.set(key, {
        runId: pin.runId,
        attempt,
        jobIds: new Set(pin.jobIds),
      });
    }
    const ids = new Set<string>();
    for (const job of data.jobs) {
      validateStoredJob(job);
      if (ids.has(job.id)) throw new Error('任务文件格式无效');
      ids.add(job.id);
      store.jobs.set(job.id, job);
    }
    const hasLegacyDirectedJobs = [...store.jobs.values()].some(job => job.directedRunId !== undefined);
    store.pruningBootstrapped = deferPrune
      ? false
      : data.directedPinsBootstrapped
        ?? (hasDurablePinProtocol || !hasLegacyDirectedJobs);
    if (store.pruningBootstrapped && store.prune()) await store.persist();
    return store;
  }

  get(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  list(status?: JobStatus): JobRecord[] {
    return [...this.jobs.values()]
      .filter(job => !status || job.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(job => structuredClone(job));
  }

  /** Persist the exact active-attempt proof set before any corresponding job can be pruned. */
  async setDirectedAttemptPins(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    jobIds: readonly string[],
  ): Promise<void> {
    await this.serializeMutation(async () => {
      if (runId.trim().length === 0
        || new Set(jobIds).size !== jobIds.length
        || jobIds.some(id => id.length === 0)) throw new Error('定向任务保留证明无效');
      const parsedAttempt = nowcoderDirectedRunAttemptSchema.parse(attempt);
      const key = `${runId}\u0000${parsedAttempt}`;
      if (jobIds.length === 0) this.directedPins.delete(key);
      else this.directedPins.set(key, {
        runId,
        attempt: parsedAttempt,
        jobIds: new Set(jobIds),
      });
      await this.persist();
    });
  }

  async reconcileDirectedPins(
    active: ReadonlyArray<{
      runId: string;
      attempt: NowcoderDirectedRunAttempt;
      jobIds: readonly string[];
    }>,
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const next = new Map<string, { runId: string; attempt: NowcoderDirectedRunAttempt; jobIds: Set<string> }>();
      for (const item of active) {
        if (item.runId.trim().length === 0
          || new Set(item.jobIds).size !== item.jobIds.length
          || item.jobIds.some(id => id.length === 0)) throw new Error('定向任务保留证明无效');
        const attempt = nowcoderDirectedRunAttemptSchema.parse(item.attempt);
        const key = `${item.runId}\u0000${attempt}`;
        if (next.has(key)) throw new Error('定向任务保留证明重复');
        if (item.jobIds.length > 0) next.set(key, {
          runId: item.runId,
          attempt,
          jobIds: new Set(item.jobIds),
        });
      }
      this.directedPins.clear();
      for (const [key, value] of next) this.directedPins.set(key, value);
      this.pruningBootstrapped = true;
      await this.persist();
    });
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    return this.serializeMutation(async () => {
      assertDirectedOwnership(input);
      const id = input.id ?? this.dependencies.id();
      const url = canonicalizeUrl(parseSupportedUrl(input.url)).href;
      const existing = this.jobs.get(id);
      if (existing) {
        if (existing.url !== url) throw new Error('任务 ID 已用于其他地址');
        if (
          existing.planId !== input.planId
          || existing.planAttempt !== input.planAttempt
          || existing.directedRunId !== input.directedRunId
          || existing.directedRunAttempt !== input.directedRunAttempt
        ) throw new Error('任务 ID 已用于其他任务归属');
        return structuredClone(existing);
      }
      const timestamp = this.dependencies.now();
      const job: JobRecord = {
        id,
        url,
        requestedBy: input.requestedBy,
        status: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.planAttempt ? { planAttempt: input.planAttempt } : {}),
        ...(input.directedRunId && input.directedRunAttempt
          ? {
              directedRunId: input.directedRunId,
              directedRunAttempt: input.directedRunAttempt,
            }
          : {}),
      };
      this.jobs.set(id, job);
      await this.persist();
      return structuredClone(job);
    });
  }

  async transition(
    id: string,
    status: JobStatus,
    patch: JobTransitionPatch = {},
  ): Promise<JobRecord> {
    return this.serializeMutation(async () => {
      const current = this.jobs.get(id);
      if (!current) throw new JobStateError(`任务不存在：${id}`);
      if (!ALLOWED_TRANSITIONS[current.status].includes(status)) {
        throw new JobStateError(`非法任务状态：${current.status} → ${status}`);
      }
      const next: JobRecord = {
        ...current,
        status,
        updatedAt: this.dependencies.now(),
        ...(patch.outputPath ? { outputPath: patch.outputPath } : {}),
        ...(patch.markdownOutput ? { markdownOutput: structuredClone(patch.markdownOutput) } : {}),
        ...(patch.errorCode ? { errorCode: patch.errorCode } : {}),
        ...(patch.errorMessage ? { errorMessage: patch.errorMessage } : {}),
      };
      this.jobs.set(id, next);
      await this.persist();
      return structuredClone(next);
    });
  }

  /** Requeue a terminal collection failure without carrying stale output or error data. */
  async retry(id: string): Promise<JobRecord> {
    return this.serializeMutation(async () => {
      const current = this.jobs.get(id);
      if (!current) throw new JobStateError(`任务不存在：${id}`);
      if (current.status !== 'failed' && current.status !== 'needs_attention') {
        throw new JobStateError(`任务状态不可重试：${current.status}`);
      }
      const {
        outputPath: _outputPath,
        markdownOutput: _markdownOutput,
        errorCode: _errorCode,
        errorMessage: _errorMessage,
        ...retained
      } = current;
      const next: JobRecord = {
        ...retained,
        status: 'queued',
        updatedAt: this.dependencies.now(),
      };
      this.jobs.set(id, next);
      await this.persist();
      return structuredClone(next);
    });
  }

  async recover(excludedIds: ReadonlySet<string> = new Set()): Promise<void> {
    await this.serializeMutation(async () => {
      let changed = false;
      for (const [id, job] of this.jobs) {
        if (excludedIds.has(id)) continue;
        if (job.status !== 'dispatched' && job.status !== 'collecting') continue;
        this.jobs.set(id, {
          ...job,
          status: 'queued',
          updatedAt: this.dependencies.now(),
        });
        changed = true;
      }
      if (changed) await this.persist();
    });
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const transactionalOperation = async (): Promise<T> => {
      const snapshot = structuredClone(this.jobs);
      const pinSnapshot = structuredClone(this.directedPins);
      const pruningBootstrappedSnapshot = this.pruningBootstrapped;
      try {
        return await operation();
      } catch (error) {
        this.jobs.clear();
        for (const [id, job] of snapshot) this.jobs.set(id, job);
        this.directedPins.clear();
        for (const [key, pin] of pinSnapshot) this.directedPins.set(key, pin);
        this.pruningBootstrapped = pruningBootstrappedSnapshot;
        throw error;
      }
    };
    const result = this.mutationQueue.then(transactionalOperation, transactionalOperation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(): Promise<void> {
    if (this.pruningBootstrapped) this.prune();
    const directedPins = [...this.directedPins.values()]
      .sort((left, right) => (
        left.runId.localeCompare(right.runId) || left.attempt.localeCompare(right.attempt)
      ))
      .map(pin => ({
        runId: pin.runId,
        attempt: pin.attempt,
        jobIds: [...pin.jobIds].sort((left, right) => left.localeCompare(right)),
      }));
    await this.dependencies.atomicWrite(this.path, {
      version: 1,
      jobs: this.list(),
      directedPinsBootstrapped: this.pruningBootstrapped,
      directedPins,
    });
  }

  private prune(): boolean {
    const pinned = new Set([...this.directedPins.values()].flatMap(pin => [...pin.jobIds]));
    const terminal = [...this.jobs.values()]
      .filter(job => (job.status === 'saved' || job.status === 'failed') && !pinned.has(job.id))
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
      ));
    let changed = false;
    for (const job of terminal.slice(1_000)) {
      this.jobs.delete(job.id);
      changed = true;
    }
    return changed;
  }
}
