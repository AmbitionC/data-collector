import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  stableContentId,
  type CollectionBatch,
  type JobRecord,
} from '@data-collector/shared';

const CONFIGURED_REMOTE_TAB_LIMIT = 2;
const NOWCODER_COMPANIES = new Set(['bytedance', 'tencent', 'alibaba', 'ant']);
const EVIDENCE_GRADES = new Set(['A', 'B', 'C']);

interface BenchmarkJobMetadata {
  company?: string;
  evidenceGrade?: string;
  questionCount?: number;
  clusterId?: string;
}

export interface PlanBenchmarkOptions {
  metadataFor: (job: JobRecord) => unknown | Promise<unknown>;
  /** 只有扩展明确上报实测峰值时才传；配置上限不等于实测峰值。 */
  observedTabPeak?: number;
}

function millisecondsBetween(start: string, finish: string, label: string): number {
  const startTime = Date.parse(start);
  const finishTime = Date.parse(finish);
  if (!Number.isFinite(startTime) || !Number.isFinite(finishTime) || finishTime < startTime) {
    throw new Error(`${label}时间无效`);
  }
  return finishTime - startTime;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function allowlistedMetadata(value: unknown): BenchmarkJobMetadata {
  if (typeof value !== 'object' || value === null) return {};
  const candidate = value as Record<string, unknown>;
  const company = typeof candidate.company === 'string' && NOWCODER_COMPANIES.has(candidate.company)
    ? candidate.company
    : undefined;
  const evidenceGrade = typeof candidate.evidenceGrade === 'string' &&
    EVIDENCE_GRADES.has(candidate.evidenceGrade)
    ? candidate.evidenceGrade
    : undefined;
  const questionCount = typeof candidate.questionCount === 'number' &&
    Number.isSafeInteger(candidate.questionCount) &&
    candidate.questionCount >= 0
    ? candidate.questionCount
    : undefined;
  const clusterId = typeof candidate.clusterId === 'string' &&
    candidate.clusterId.trim().length > 0 &&
    candidate.clusterId.length <= 100
    ? candidate.clusterId
    : undefined;
  return {
    ...(company ? { company } : {}),
    ...(evidenceGrade ? { evidenceGrade } : {}),
    ...(questionCount !== undefined ? { questionCount } : {}),
    ...(clusterId ? { clusterId } : {}),
  };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
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

export async function writePlanBenchmark(
  root: string,
  batch: CollectionBatch,
  jobs: readonly JobRecord[],
  options: PlanBenchmarkOptions,
): Promise<string> {
  if (batch.status === 'running' || !batch.finishedAt) {
    throw new Error('运行中的采集批次不能写入基准报告');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(batch.id)) throw new Error('采集批次 ID 不能用于报告路径');
  if (
    options.observedTabPeak !== undefined &&
    (!Number.isSafeInteger(options.observedTabPeak) || options.observedTabPeak < 0)
  ) throw new Error('实测标签页峰值无效');

  const batchJobs = jobs.filter(job => job.batchId === batch.id);
  const measured = await Promise.all(batchJobs.map(async job => ({
    contentId: stableContentId(job.url),
    status: job.status,
    durationMs: millisecondsBetween(job.createdAt, job.updatedAt, `任务 ${job.id}`),
    ...allowlistedMetadata(await options.metadataFor(job)),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  })));
  measured.sort((left, right) => left.contentId.localeCompare(right.contentId));

  const durations = measured.map(item => item.durationMs).sort((left, right) => left - right);
  const createdTimes = measured.map(item => Date.parse(item.createdAt));
  const updatedTimes = measured.map(item => Date.parse(item.updatedAt));
  const detailWindowMs = measured.length === 0
    ? 0
    : Math.max(...updatedTimes) - Math.min(...createdTimes);
  const report = {
    schemaVersion: 1,
    runId: batch.id,
    batchId: batch.id,
    planId: batch.planId,
    status: batch.status,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    roundCount: batch.rounds ?? 0,
    contentIds: [...new Set(measured.map(item => item.contentId))],
    deliveryIds: [...batch.deliveryIds],
    terminalCounts: {
      discovered: batch.discovered,
      accepted: batch.accepted,
      saved: batch.saved,
      skipped: batch.skipped,
      failed: batch.failed,
      needsAttention: batch.needsAttention,
    },
    timing: {
      activeDurationMs: millisecondsBetween(batch.startedAt, batch.finishedAt, '批次'),
      detailWindowMs,
      jobDurationMs: {
        total: durations.reduce((total, duration) => total + duration, 0),
        p50: percentile(durations, 0.5),
        p90: percentile(durations, 0.9),
      },
    },
    remoteTabs: {
      configuredLimit: CONFIGURED_REMOTE_TAB_LIMIT,
      ...(options.observedTabPeak !== undefined
        ? { observedPeak: options.observedTabPeak }
        : {}),
    },
    jobs: measured.map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...job }) => job),
  };
  const path = join(root, 'benchmarks', `${batch.id}.json`);
  await atomicWrite(path, report);
  return path;
}
