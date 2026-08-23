import { z } from 'zod';

export const COLLECTION_PLAN_IDS = ['zsxq-chen-teacher', 'nowcoder-agent-market'] as const;
export type CollectionPlanId = (typeof COLLECTION_PLAN_IDS)[number];

export const BATCH_STATUSES = [
  'running',
  'completed',
  'completed_with_attention',
  'failed',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export interface CollectionBatch {
  id: string;
  planId: CollectionPlanId;
  status: BatchStatus;
  startedAt: string;
  finishedAt?: string;
  discovered: number;
  accepted: number;
  saved: number;
  skipped: number;
  failed: number;
  needsAttention: number;
  coverage?: Record<string, number>;
  error?: string;
}

const countSchema = z.number().int().min(0);
export const collectionPlanIdSchema = z.enum(COLLECTION_PLAN_IDS);
export const collectionBatchSchema = z.object({
  id: z.string().trim().min(1).max(200),
  planId: collectionPlanIdSchema,
  status: z.enum(BATCH_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  discovered: countSchema,
  accepted: countSchema,
  saved: countSchema,
  skipped: countSchema,
  failed: countSchema,
  needsAttention: countSchema,
  coverage: z.record(z.string().trim().min(1).max(100), countSchema).optional(),
  error: z.string().trim().min(1).max(2_000).optional(),
}).superRefine((batch, context) => {
  const terminal = batch.status !== 'running';
  if (terminal !== Boolean(batch.finishedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['finishedAt'],
      message: terminal ? '终态批次必须有完成时间' : '运行中批次不能有完成时间',
    });
  }
  if (batch.accepted > batch.discovered) {
    context.addIssue({ code: 'custom', path: ['accepted'], message: '接受数不能超过发现数' });
  }
  const terminalCount = batch.saved + batch.skipped + batch.failed + batch.needsAttention;
  if (terminal && terminalCount !== batch.accepted) {
    context.addIssue({ code: 'custom', path: ['accepted'], message: '终态结果数必须等于接受数' });
  }
});
