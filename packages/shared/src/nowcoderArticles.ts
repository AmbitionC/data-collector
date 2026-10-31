import { z } from 'zod';
import { nowcoderOperationDiagnosticsSchema } from './nowcoderConversation.js';

export const NOWCODER_ARTICLE_CAPABILITY = 'nowcoder-article-publishing-v1';
export const NOWCODER_ARTICLE_EDITOR_URL = 'https://www.nowcoder.com/creation/write/article';
export const browserFamilySchema = z.enum(['chrome', 'edge']);
export type BrowserFamily = z.infer<typeof browserFamilySchema>;
export const connectionRoleSchema = z.enum(['collector', 'articles']);
export type ConnectionRole = z.infer<typeof connectionRoleSchema>;
export const nowcoderAccountIdSchema = z.string().regex(/^\d{1,20}$/u);
export const articleIdSchema = z.string().regex(/^article-[a-f0-9]{12}$/u);
export const articlePostUrlSchema = z.string().url().max(4096).refine(value => /^https:\/\/www\.nowcoder\.com\/(?:discuss\/\d+|feed\/main\/detail\/[a-z0-9]+)$/iu.test(value), '必须是真实牛客详情地址');
export const nowcoderAccountIdentitySchema = z.object({
  userId: nowcoderAccountIdSchema, nickname: z.string().trim().min(1).max(200),
  profileUrl: z.string().url().max(4096), observedAt: z.iso.datetime(),
}).strict().refine(value => value.profileUrl === `https://www.nowcoder.com/users/${value.userId}`, '账号与主页不符');
export type NowcoderAccountIdentity = z.infer<typeof nowcoderAccountIdentitySchema>;
const title = z.string().trim().min(1).max(100).refine(value => [...value].length <= 50, '标题最多50字');
const body = z.string().trim().min(2).max(24_000);
const provenance = z.enum(['compiled', 'personal']);
const content = { title, body, browser: browserFamilySchema, accountId: nowcoderAccountIdSchema, provenance,
  sourceUrls: z.array(z.string().url().max(4096).refine(value => new URL(value).protocol === 'https:')).max(30) };
export const articleDraftContentSchema = z.object(content).strict();
export const articleDraftSchema = z.object({ schemaVersion: z.literal(1), id: articleIdSchema, revision: z.number().int().positive(), ...content }).strict();
export type ArticleDraft = z.infer<typeof articleDraftSchema>;
export const articleImportSchema = z.object({ schemaVersion: z.literal(1), id: articleIdSchema.optional(), revision: z.number().int().positive().optional(), ...content }).strict();
export const articleActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), expectedAccountId: nowcoderAccountIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('article-publish'), title, body, expectedAccountId: nowcoderAccountIdSchema, provenance }).strict(),
  z.object({ kind: z.literal('article-verify'), title, body, expectedAccountId: nowcoderAccountIdSchema, postUrl: articlePostUrlSchema.optional() }).strict(),
]);
export type ArticleAction = z.infer<typeof articleActionSchema>;
/** Local page preparation is not a remotely dispatchable publishing action. */
export type ArticlePageAction = ArticleAction | (Omit<Extract<ArticleAction, { kind: 'article-publish' }>, 'kind'> & { kind: 'article-prepare' });
export const articleReceiptSchema = z.object({ url: articlePostUrlSchema, title, body, accountId: nowcoderAccountIdSchema, observedAt: z.iso.datetime() }).strict();
export type ArticleReceipt = z.infer<typeof articleReceiptSchema>;
const diagnostics = nowcoderOperationDiagnosticsSchema.optional();
export const articleResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), identity: nowcoderAccountIdentitySchema, diagnostics }).strict(),
  z.object({ kind: z.literal('article-published'), receipt: articleReceiptSchema, diagnostics }).strict(),
  z.object({ kind: z.literal('article-verified'), identity: nowcoderAccountIdentitySchema, receipt: articleReceiptSchema.optional(), diagnostics }).strict(),
  z.object({ kind: z.literal('attention'), code: z.string().min(1).max(100), message: z.string().min(1).max(1000),
    submission: z.enum(['not_attempted', 'uncertain']), tabUrl: z.string().url().max(4096).optional(), diagnostics }).strict(),
]);
export type ArticleResult = z.infer<typeof articleResultSchema>;
export const articlePageResultSchema = z.union([
  articleResultSchema,
  z.object({ kind: z.literal('article-clicked'), diagnostics: nowcoderOperationDiagnosticsSchema }).strict(),
  z.object({ kind: z.literal('article-prepared'), diagnostics: nowcoderOperationDiagnosticsSchema }).strict(),
  z.object({ kind: z.literal('article-candidate'), url: articlePostUrlSchema, identity: nowcoderAccountIdentitySchema, diagnostics }).strict(),
]);
export type ArticlePageResult = z.infer<typeof articlePageResultSchema>;
export const articlePublishSchema = z.object({ revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  key: z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u), browser: browserFamilySchema, accountId: nowcoderAccountIdSchema, send: z.literal(true) }).strict();
