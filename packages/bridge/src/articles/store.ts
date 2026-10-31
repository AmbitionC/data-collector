import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { articleDraftSchema, articleDraftContentSchema, articleImportSchema, articleIdSchema, articlePublishSchema,
  articleReceiptSchema, articleResultSchema, nowcoderAccountIdentitySchema, operationPublicationSchema,
  type ArticleDraft, type ArticleReceipt, type ArticleResult, type NowcoderAccountIdentity, type OperationPublication } from '@data-collector/shared';
import { atomicWriteText } from '../library/writer.js';
import { HttpError } from '../server/http.js';
import type { PublicationAdmissionQueue } from '../operations/admission.js';

const previewSchema = z.object({ identity: nowcoderAccountIdentitySchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const recordSchema = articleDraftSchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  status: z.enum(['draft', 'published']), preview: previewSchema.optional(),
  publicationAttempts: z.array(operationPublicationSchema).max(20), receipt: articleReceiptSchema.optional(),
}).strict();
export type NowcoderArticle = z.infer<typeof recordSchema>;
const normalized = (value: string) => value.replace(/[\u200b-\u200d\ufeff]/gu, '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
export const articleContentHash = (draft: z.infer<typeof articleDraftContentSchema>): string => createHash('sha256').update(JSON.stringify(articleDraftContentSchema.parse({
  title: draft.title, body: draft.body, browser: draft.browser, accountId: draft.accountId, provenance: draft.provenance, sourceUrls: draft.sourceUrls,
}))).digest('hex');
const matches = (entry: ArticleDraft, receipt: ArticleReceipt): boolean => receipt.accountId === entry.accountId
  && normalized(receipt.title) === normalized(entry.title) && normalized(receipt.body) === normalized(entry.body);

export class NowcoderArticlesStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly root: string, private readonly options: { admission: PublicationAdmissionQueue;
    beforePublication: () => Promise<void>; afterPublication: () => Promise<void>; now?: () => number }) { this.now = options.now ?? Date.now; }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.pending.then(work); this.pending = result.catch(() => undefined); return result; }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  async get(rawId: string): Promise<NowcoderArticle | undefined> {
    const id = articleIdSchema.parse(rawId), path = join(this.root, `${id}.json`);
    try {
      const info = await lstat(path); if (!info.isFile() || info.size > 2_000_000) throw new Error('invalid file');
      const entry = recordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (entry.id !== id || entry.contentHash !== articleContentHash(entry)
        || (entry.preview && (entry.preview.contentHash !== entry.contentHash || entry.preview.identity.userId !== entry.accountId))
        || (entry.receipt && !matches(entry, entry.receipt))) throw new Error('article identity/hash mismatch');
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new HttpError(409, 'ARTICLE_CORRUPT', `文章记录损坏，请保留文件后核对：${id}`);
    }
  }
  async list(): Promise<NowcoderArticle[]> {
    let names: string[];
    try { names = (await readdir(this.root)).filter(name => name.endsWith('.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (names.length > 1000) throw new HttpError(409, 'ARTICLE_STORE_LIMIT', '本机文章超过1000条，请先核对整理');
    const entries: NowcoderArticle[] = [];
    for (const name of names) {
      const id = name.slice(0, -5); if (!articleIdSchema.safeParse(id).success) throw new HttpError(409, 'ARTICLE_CORRUPT', '文章记录文件名损坏，请保留后核对');
      const entry = await this.get(id); if (!entry) throw new HttpError(409, 'ARTICLE_CORRUPT', '文章记录读取时发生变化，请重试'); entries.push(entry);
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  private async save(raw: NowcoderArticle): Promise<NowcoderArticle> {
    const entry = recordSchema.parse(raw); await mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicWriteText(this.root, join(this.root, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`); return entry;
  }
  async import(raw: unknown): Promise<NowcoderArticle> {
    const input = articleImportSchema.parse(raw);
    return this.serialize(async () => {
      if (input.id === undefined && input.revision !== undefined) throw new HttpError(400, 'ARTICLE_IMPORT_INVALID', '新文章不接受修订号');
      const content = articleDraftContentSchema.parse({ title: input.title, body: input.body, browser: input.browser, accountId: input.accountId, provenance: input.provenance, sourceUrls: input.sourceUrls });
      if (content.provenance === 'compiled' && !/整理|备考|题单|模拟|练习/u.test(`${content.title}\n${content.body}`)) throw new HttpError(400, 'ARTICLE_DISCLOSURE_REQUIRED', '组合题目请明确标注整理版或备考题单');
      const now = this.timestamp();
      if (input.id) {
        const entry = await this.get(input.id); if (!entry) throw new HttpError(404, 'ARTICLE_NOT_FOUND', '文章记录不存在');
        if (entry.revision !== input.revision) throw new HttpError(409, 'ARTICLE_STALE', '文章已被修改，请重读当前版本');
        if (entry.publicationAttempts.some(a => a.state !== 'rejected') || entry.status === 'published') throw new HttpError(409, 'ARTICLE_UNRESOLVED', '文章已有发布记录，请只读核验，禁止改稿重发');
        const { preview, ...rest } = entry; void preview;
        return this.save({ ...rest, ...content, contentHash: articleContentHash(content), revision: entry.revision + 1, updatedAt: now });
      }
      if ((await this.list()).length >= 1000) throw new HttpError(409, 'ARTICLE_STORE_LIMIT', '本机文章达到1000条上限');
      return this.save({ schemaVersion: 1, id: `article-${randomBytes(6).toString('hex')}`, revision: 1, ...content,
        contentHash: articleContentHash(content), status: 'draft', publicationAttempts: [], createdAt: now, updatedAt: now });
    });
  }
  async savePreview(id: string, raw: NowcoderAccountIdentity): Promise<NowcoderArticle> {
    const identity = nowcoderAccountIdentitySchema.parse(raw);
    return this.serialize(async () => {
      const entry = await this.get(id); if (!entry) throw new HttpError(404, 'ARTICLE_NOT_FOUND', '文章记录不存在');
      if (entry.accountId !== identity.userId) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '当前账号与文章绑定不符，未保存预览');
      if (entry.publicationAttempts.some(a => a.state !== 'rejected')) throw new HttpError(409, 'ARTICLE_UNRESOLVED', '文章已有发布记录，请只读核验');
      return this.save({ ...entry, preview: { identity, contentHash: entry.contentHash }, updatedAt: this.timestamp() });
    });
  }
  async beginPublication(id: string, raw: unknown, requestId: string): Promise<{ entry: NowcoderArticle; publication: OperationPublication; dispatch: boolean }> {
    const input = articlePublishSchema.parse(raw);
    return this.serialize(() => this.options.admission.run(async () => {
      const entry = await this.get(id); if (!entry) throw new HttpError(404, 'ARTICLE_NOT_FOUND', '文章记录不存在');
      if (input.browser !== entry.browser || input.accountId !== entry.accountId) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '发送目标与文章绑定账号或浏览器不符');
      const prior = entry.publicationAttempts.find(a => a.key === input.key);
      if (prior) {
        if (prior.draftHash !== entry.contentHash || input.contentHash !== entry.contentHash || prior.requestedRevision !== input.revision) throw new HttpError(409, 'ARTICLE_KEY_CONFLICT', '发送键已用于其他内容或版本');
        return { entry, publication: prior, dispatch: false };
      }
      if (entry.status === 'published' || entry.publicationAttempts.some(a => a.state !== 'rejected')) throw new HttpError(409, 'ARTICLE_UNRESOLVED', '文章已有发布记录，请先核验，禁止重复发帖');
      if (entry.revision !== input.revision || entry.contentHash !== input.contentHash) throw new HttpError(409, 'ARTICLE_STALE', '文章内容或版本已变化，请重读');
      if (!entry.preview || entry.preview.contentHash !== entry.contentHash) throw new HttpError(409, 'ARTICLE_PREVIEW_REQUIRED', '请先预览文章并核对实际账号');
      const age = this.now() - Date.parse(entry.preview.identity.observedAt);
      if (age > 30 * 60000 || age < -60000) throw new HttpError(409, 'ARTICLE_PREVIEW_EXPIRED', '账号预览已过期或时钟已变化，请重新预览；有效期30分钟');
      if (entry.publicationAttempts.length >= 20) throw new HttpError(409, 'ARTICLE_ATTEMPT_LIMIT', '文章发送记录达到上限，请核对');
      const duplicate = (await this.list()).some(other => other.id !== entry.id && normalized(other.title) === normalized(entry.title) && normalized(other.body) === normalized(entry.body) && other.publicationAttempts.some(a => a.state !== 'rejected'));
      if (duplicate) throw new HttpError(409, 'ARTICLE_DUPLICATE', '相同文章已有发送记录，请核验原记录，禁止换ID重发');
      await this.options.beforePublication();
      const now = this.timestamp(), publication: OperationPublication = { key: input.key, requestId, draftHash: entry.contentHash, requestedRevision: input.revision, state: 'dispatching', createdAt: now, updatedAt: now };
      const saved = await this.save({ ...entry, publicationAttempts: [...entry.publicationAttempts, publication], revision: entry.revision + 1, updatedAt: now });
      await this.options.afterPublication(); return { entry: saved, publication, dispatch: true };
    }));
  }
  async finishPublication(id: string, key: string, raw: ArticleResult): Promise<OperationPublication> {
    const result = articleResultSchema.parse(raw);
    return this.serialize(async () => {
      const entry = await this.get(id), attempt = entry?.publicationAttempts.find(a => a.key === key);
      if (!entry || !attempt || attempt.state !== 'dispatching') throw new HttpError(409, 'ARTICLE_ATTEMPT_CHANGED', '文章发送记录已变化，请核验');
      const receipt = result.kind === 'article-published' && matches(entry, result.receipt) ? result.receipt : undefined;
      const publication: OperationPublication = { ...attempt, updatedAt: this.timestamp(),
        state: receipt ? 'published' : result.kind === 'attention' && result.submission === 'not_attempted' ? 'rejected' : 'uncertain',
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}), ...(result.kind === 'attention' ? { attentionCode: result.code } : {}),
        ...(receipt ? { postUrl: receipt.url, evidence: 'observed' } : { message: result.kind === 'attention' ? result.message : '文章回执内容或作者与草稿不符，结果待核验，禁止重发' }) };
      await this.save({ ...entry, publicationAttempts: entry.publicationAttempts.map(a => a.key === key ? publication : a),
        ...(receipt ? { receipt, status: 'published' } : {}), revision: entry.revision + 1, updatedAt: publication.updatedAt }); return publication;
    });
  }
  async reconcile(id: string, key: string, raw: ArticleResult): Promise<OperationPublication> {
    const result = articleResultSchema.parse(raw);
    return this.serialize(async () => {
      const entry = await this.get(id), attempt = entry?.publicationAttempts.find(a => a.key === key);
      if (!entry || !attempt) throw new HttpError(404, 'ARTICLE_ATTEMPT_REQUIRED', '没有需要核验的原始发送记录');
      if (attempt.state === 'published' || attempt.state === 'rejected') return attempt;
      if (result.kind !== 'article-verified' || result.identity.userId !== entry.accountId) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '只读核验未确认原绑定账号');
      const receipt = result.receipt && matches(entry, result.receipt) ? result.receipt : undefined;
      const publication: OperationPublication = { ...attempt, updatedAt: this.timestamp(),
        ...(receipt ? { state: 'published', postUrl: receipt.url, evidence: 'observed', message: '只读核验观察到完整匹配的本人文章' } : { message: '只读核验未找到唯一完整匹配文章，仍待核验，禁止重发' }) };
      await this.save({ ...entry, publicationAttempts: entry.publicationAttempts.map(a => a.key === key ? publication : a),
        ...(receipt ? { receipt, status: 'published' } : {}), revision: entry.revision + 1, updatedAt: publication.updatedAt }); return publication;
    });
  }
}
