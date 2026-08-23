import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  canonicalizeUrl,
  parseSupportedUrl,
  type JobRecord,
  type JobStatus,
  type CollectionPlanId,
} from '@data-collector/shared';

interface JobStoreDependencies {
  now: () => string;
  id: () => string;
}

interface StoredJobs {
  version: 1;
  jobs: JobRecord[];
}

export interface CreateJobInput {
  id?: string;
  url: string;
  requestedBy: JobRecord['requestedBy'];
  batchId?: string;
  planId?: CollectionPlanId;
}

export interface JobTransitionPatch {
  outputPath?: string;
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
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly path: string,
    private readonly dependencies: JobStoreDependencies,
  ) {}

  static async open(
    path: string,
    overrides: Partial<JobStoreDependencies> = {},
  ): Promise<JobStore> {
    const store = new JobStore(path, {
      now: () => new Date().toISOString(),
      id: () => randomUUID(),
      ...overrides,
    });
    try {
      const data = JSON.parse(await readFile(path, 'utf8')) as StoredJobs;
      if (data.version !== 1 || !Array.isArray(data.jobs)) {
        throw new Error('任务文件格式无效');
      }
      for (const job of data.jobs) store.jobs.set(job.id, job);
      if (store.prune()) await store.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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

  async create(input: CreateJobInput): Promise<JobRecord> {
    return this.serializeMutation(async () => {
      const id = input.id ?? this.dependencies.id();
      const url = canonicalizeUrl(parseSupportedUrl(input.url)).href;
      const existing = this.jobs.get(id);
      if (existing) {
        if (existing.url !== url) throw new Error('任务 ID 已用于其他地址');
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

  async recover(): Promise<void> {
    await this.serializeMutation(async () => {
      let changed = false;
      for (const [id, job] of this.jobs) {
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
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(): Promise<void> {
    this.prune();
    await atomicWrite(this.path, { version: 1, jobs: this.list() });
  }

  private prune(): boolean {
    const terminal = [...this.jobs.values()]
      .filter(job => job.status === 'saved' || job.status === 'failed')
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
