import { z } from 'zod';
import { MAX_REPLY_CHARACTERS } from './nowcoderReplyStyle.js';

export const NOWCODER_OPERATIONS_CAPABILITY = 'nowcoder-operations-v1';
export const operationIdSchema = z.string().regex(/^ops-[a-f0-9]{12}$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const operationStatusSchema = z.enum(['queued', 'drafted', 'reviewed', 'replied', 'skipped']);
export const operationSourceUrlSchema = z.string().url().max(4096).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'www.nowcoder.com' && !url.username && !url.password
    && !url.port && /^(?:\/discuss\/\d+|\/feed\/main\/detail\/[a-z0-9]+)$/iu.test(url.pathname)
    && !url.search && !url.hash;
}, '需要规范的牛客帖子链接');
const replySchema = z.string().trim().min(1).max(1000)
  .refine(value => [...value].length <= MAX_REPLY_CHARACTERS, '回复最多160字，请缩短')
  .refine(value => !/https?:\/\//iu.test(value), '回复只使用裸域名，不带http或https前缀');
export const operationDraftsSchema = z.object({
  primary: replySchema,
  alternative: replySchema,
  tone: z.enum(['empathetic', 'light_humor', 'practical']),
  anchor: z.string().trim().min(2).max(180),
  notes: z.string().trim().max(2000).default(''),
}).strict();
export const operationAssessmentSchema = z.object({
  fit: z.enum(['high', 'medium', 'low']),
  intent: z.enum(['learning', 'interview', 'general']),
  angle: z.string().max(500),
  reason: z.string().max(1000),
  limitations: z.array(z.string().max(500)).max(8),
}).strict();
const replyUrlSchema = z.string().url().max(4096).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'www.nowcoder.com' && !url.username && !url.password
    && !url.port && /^\/discuss\/comment\/\d+$/u.test(url.pathname);
}, '请填写真实的牛客评论链接');
export const nowcoderOperationSchema = z.object({
  schemaVersion: z.literal(1), visibility: z.literal('private'),
  id: operationIdSchema, sourceId: z.string().regex(/^[a-f0-9]{12}$/u),
  canonicalUrl: operationSourceUrlSchema, title: z.string().trim().min(1).max(500),
  body: z.string().trim().min(2).max(24_000), contextHash: hashSchema,
  collectedAt: z.iso.datetime(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(), status: operationStatusSchema,
  assessment: operationAssessmentSchema, drafts: operationDraftsSchema.optional(),
  replyUrl: replyUrlSchema.optional(), note: z.string().max(2000).default(''),
}).strict().superRefine((entry, context) => {
  if (['drafted', 'reviewed', 'replied'].includes(entry.status) && !entry.drafts) {
    context.addIssue({ code: 'custom', path: ['drafts'], message: '该处理状态必须有回复草稿' });
  }
  if (entry.status === 'replied' && !entry.replyUrl) {
    context.addIssue({ code: 'custom', path: ['replyUrl'], message: '已回复状态必须有评论链接' });
  }
});
export const operationAddSchema = z.object({ sourceId: z.string().regex(/^[a-f0-9]{12}$/u) }).strict();
export const operationUpdateSchema = z.object({
  revision: z.number().int().positive(), contextHash: hashSchema.optional(),
  drafts: operationDraftsSchema.optional(), status: operationStatusSchema.optional(),
  replyUrl: replyUrlSchema.optional(), note: z.string().max(2000).optional(),
}).strict();
export const operationDraftImportSchema = z.object({
  schemaVersion: z.literal(1), opportunityId: operationIdSchema,
  revision: z.number().int().positive(), contextHash: hashSchema, drafts: operationDraftsSchema,
}).strict();
export type NowcoderOperation = z.infer<typeof nowcoderOperationSchema>;
export type NowcoderOperationSummary = Omit<NowcoderOperation, 'body'>;
export type OperationUpdate = z.infer<typeof operationUpdateSchema>;
export type OperationDrafts = z.infer<typeof operationDraftsSchema>;
