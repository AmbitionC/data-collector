import { z } from 'zod';

export const NOWCODER_BROWSER_OPERATIONS_CAPABILITY = 'nowcoder-browser-operations-v1';
const sourceUrl = z.string().url().max(4096).refine(value => /^https:\/\/www\.nowcoder\.com\/(?:discuss\/\d+|feed\/main\/detail\/[a-z0-9]+)$/iu.test(value));
const commentUrl = z.string().url().max(4096).refine(value => /^https:\/\/www\.nowcoder\.com\/discuss\/comment\/\d+$/u.test(value));
const imageUrl = z.string().url().max(4096).refine(value => new URL(value).protocol === 'https:');
export const nowcoderConversationSchema = z.object({
  sourceUrl,
  readAt: z.iso.datetime(),
  post: z.object({ title: z.string().min(1).max(500), body: z.string().min(2).max(24_000), images: z.array(imageUrl).max(30) }).strict(),
  comments: z.array(z.object({
    url: commentUrl, parentUrl: commentUrl.nullable(), text: z.string().max(5000),
    images: z.array(imageUrl).max(12), isAuthor: z.boolean(), likes: z.number().int().nonnegative().nullable(),
  }).strict()).max(200),
  coverage: z.object({
    total: z.number().int().nonnegative().nullable(), observed: z.number().int().nonnegative().max(200),
    pagesRead: z.number().int().min(1).max(3), hasMore: z.boolean(), complete: z.boolean(),
    limitations: z.array(z.string().max(300)).max(10),
  }).strict(),
}).strict().refine(snapshot => new TextEncoder().encode(JSON.stringify(snapshot)).length <= 1_400_000, '评论上下文超过私有载荷上限');
export type NowcoderConversationSnapshot = z.infer<typeof nowcoderConversationSchema>;
export const nowcoderOperationActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), url: sourceUrl, maxPages: z.number().int().min(1).max(3).default(1) }).strict(),
  z.object({ kind: z.literal('publish'), url: sourceUrl, text: z.string().trim().min(1).max(2000)
    .refine(value => [...value].length <= 1000 && !/https?:\/\//iu.test(value)), expected: nowcoderConversationSchema }).strict()
    .refine(value => value.url === value.expected.sourceUrl, '上下文必须属于当前原帖'),
]);
export type NowcoderOperationAction = z.infer<typeof nowcoderOperationActionSchema>;
export const nowcoderPublishReceiptSchema = z.object({
  sourceUrl, url: commentUrl, text: z.string().min(1).max(2000), observedAt: z.iso.datetime(),
}).strict();
export const nowcoderContextChangesSchema = z.object({
  fields: z.array(z.enum(['title', 'body', 'images', 'comments', 'total'])).max(5),
  comments: z.object({ added: z.array(commentUrl).max(30), removed: z.array(commentUrl).max(30), changed: z.array(commentUrl).max(30), truncated: z.boolean() }).strict(),
  total: z.object({ before: z.number().int().nonnegative().nullable(), after: z.number().int().nonnegative().nullable() }).strict(),
}).strict();
export const nowcoderOperationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), snapshot: nowcoderConversationSchema }).strict(),
  z.object({ kind: z.literal('published'), receipt: nowcoderPublishReceiptSchema }).strict(),
  z.object({ kind: z.literal('attention'), code: z.string().min(1).max(100), message: z.string().min(1).max(1000),
    submission: z.enum(['not_attempted', 'uncertain']), tabUrl: z.string().url().max(4096).optional(), contextChanges: nowcoderContextChangesSchema.optional() }).strict(),
]);
export type NowcoderOperationResult = z.infer<typeof nowcoderOperationResultSchema>;
export const operationPublishSchema = z.object({
  revision: z.number().int().positive(), contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
  key: z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u), send: z.literal(true),
}).strict();
