import { z } from 'zod';
import type { CollectedDocument } from './model.js';

export const COLLECTION_PLAN_IDS = ['zsxq-chen-teacher', 'nowcoder-agent-market'] as const;
export type CollectionPlanId = (typeof COLLECTION_PLAN_IDS)[number];

export const BATCH_STATUSES = [
  'running',
  'completed',
  'completed_with_attention',
  'failed',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const ZSXQ_PLAN_VIEWS = ['最新', '精华', '只看星主'] as const;
export type ZsxqPlanView = (typeof ZSXQ_PLAN_VIEWS)[number];

export interface ZsxqViewDocuments {
  label: ZsxqPlanView;
  documents: readonly CollectedDocument[];
}

/** 按固定视图顺序合并 topic；元数据保持协议允许的 primitive 字符串。 */
export function unionZsxqViewDocuments(views: readonly ZsxqViewDocuments[]): CollectedDocument[] {
  const union = new Map<string, { document: CollectedDocument; labels: Set<ZsxqPlanView> }>();
  for (const view of views) {
    for (const document of view.documents) {
      const existing = union.get(document.canonicalUrl);
      if (existing) existing.labels.add(view.label);
      else union.set(document.canonicalUrl, { document, labels: new Set([view.label]) });
    }
  }
  return [...union.values()]
    .map(({ document, labels }) => ({
      ...document,
      sourceMetadata: {
        ...(document.sourceMetadata ?? {}),
        viewLabels: ZSXQ_PLAN_VIEWS.filter(label => labels.has(label)).join('、'),
      },
    }))
    .sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl));
}

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
  /** 需要二次筛选的计划用持久状态保证 Bridge 重启后可续跑。 */
  selectionStatus?: 'collecting' | 'pending' | 'completed';
  coverage?: Record<string, number>;
  /** 固定计划过滤原因的同源计数，便于审计为什么没入选。 */
  rejections?: Record<string, number>;
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
  selectionStatus: z.enum(['collecting', 'pending', 'completed']).optional(),
  coverage: z.record(z.string().trim().min(1).max(100), countSchema).optional(),
  rejections: z.record(z.string().trim().min(1).max(100), countSchema).optional(),
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
  if (terminalCount > batch.discovered) {
    context.addIssue({ code: 'custom', path: ['discovered'], message: '结果数不能超过发现数' });
  }
});
