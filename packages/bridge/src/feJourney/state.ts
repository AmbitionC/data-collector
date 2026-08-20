import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export type FeJourneySource = 'nowcoder' | 'github';

export interface FeJourneySourceState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastWarning?: string;
}

export interface FeJourneyState {
  version: 1;
  sources: Record<FeJourneySource, FeJourneySourceState>;
}

function emptyState(): FeJourneyState {
  return { version: 1, sources: { nowcoder: {}, github: {} } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSourceState(value: unknown): FeJourneySourceState {
  if (!isRecord(value)) throw new Error('fe-journey 采集状态来源格式无效');
  const state: FeJourneySourceState = {};
  for (const field of ['lastAttemptAt', 'lastSuccessAt', 'lastError', 'lastWarning'] as const) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== 'string') throw new Error(`fe-journey 采集状态字段 ${field} 格式无效`);
    state[field] = fieldValue;
  }
  return state;
}

function parseState(value: unknown): FeJourneyState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sources)) {
    throw new Error('fe-journey 采集状态格式无效');
  }
  return {
    version: 1,
    sources: {
      nowcoder: parseSourceState(value.sources.nowcoder),
      github: parseSourceState(value.sources.github),
    },
  };
}

async function atomicWrite(path: string, state: FeJourneyState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export class FeJourneyStateStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(readonly path: string, private state: FeJourneyState) {}

  static async open(path: string): Promise<FeJourneyStateStore> {
    try {
      return new FeJourneyStateStore(path, parseState(JSON.parse(await readFile(path, 'utf8')) as unknown));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new FeJourneyStateStore(path, emptyState());
      }
      throw error;
    }
  }

  static empty(path: string): FeJourneyStateStore {
    return new FeJourneyStateStore(path, emptyState());
  }

  snapshot(): FeJourneyState {
    return structuredClone(this.state);
  }

  async record(
    source: FeJourneySource,
    attemptedAt: string,
    error?: string,
    warning?: string,
  ): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      this.state.sources[source] = {
        lastAttemptAt: attemptedAt,
        ...(error
          ? { lastError: error }
          : {
              lastSuccessAt: attemptedAt,
              ...(warning ? { lastWarning: warning } : {}),
            }),
      };
      await atomicWrite(this.path, this.state);
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }
}
