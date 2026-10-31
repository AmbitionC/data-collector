import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { articlePublishSchema, browserFamilySchema, nowcoderAccountIdSchema, nowcoderVerificationResumeSchema,
  publishingReferenceUrlSchema, NOWCODER_ARTICLE_EDITOR_URL, type ArticleAction, type ArticleResult, type BrowserFamily,
} from '@data-collector/shared';
import { HttpError } from '../server/http.js';
import type { NowcoderPublishingControl } from '../operations/publishingControl.js';
import type { NowcoderArticle, NowcoderArticlesStore } from './store.js';

interface Transport { assertAvailable(browser?: BrowserFamily): void; execute(action: ArticleAction, requestId: string, browser?: BrowserFamily): Promise<ArticleResult> }
export class NowcoderArticlesActivity {
  private active = 0;
  private readonly publishing = new Set<string>();
  constructor(private readonly store: NowcoderArticlesStore, private readonly transport: Transport, private readonly control: NowcoderPublishingControl) {}
  get busy(): boolean { return this.active > 0; }
  isPublishing(id: string): boolean { return this.publishing.has(id); }
  private async assertSiteAccess(): Promise<void> {
    if ((await this.control.status()).verification) throw new HttpError(409, 'PUBLISH_VERIFICATION_PAUSED', '牛客验证尚待处理，两个渠道均已暂停；请完成原页验证后显式核验恢复');
  }
  private reference(result: ArticleResult): string {
    if (result.kind === 'attention' && result.tabUrl) {
      const url = new URL(result.tabUrl); url.search = ''; url.hash = '';
      const parsed = publishingReferenceUrlSchema.safeParse(url.href); if (parsed.success) return parsed.data;
    }
    return NOWCODER_ARTICLE_EDITOR_URL;
  }
  private async observe(result: ArticleResult, requestId: string, browser: BrowserFamily, accountId: string, articleId?: string, key?: string): Promise<boolean> {
    const observed = (result.kind === 'attention' && result.code === 'VERIFICATION_REQUIRED') || Boolean(result.diagnostics?.verificationObservedAt);
    if (observed) await this.control.pause({ sourceUrl: this.reference(result), requestId, channel: 'article', browser, accountId,
      ...(articleId ? { articleId } : {}), ...(key ? { key } : {}) });
    return observed;
  }
  private async probe(browser: BrowserFamily, accountId: string, articleId?: string): Promise<ArticleResult> {
    await this.assertSiteAccess(); this.transport.assertAvailable(browser);
    const requestId = randomUUID(), result = await this.transport.execute({ kind: 'account', expectedAccountId: accountId }, requestId, browser);
    if (await this.observe(result, requestId, browser, accountId, articleId)) return { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '牛客要求验证，已暂停两个发布渠道，请在保留页面完成验证', submission: 'not_attempted', ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}), ...(result.kind === 'attention' && result.tabUrl ? { tabUrl: result.tabUrl } : {}) };
    if (result.kind === 'account' && result.identity.userId !== accountId) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '当前实际账号与文章绑定账号不符，未发送');
    if (result.kind !== 'account' && result.kind !== 'attention') throw new HttpError(409, 'ARTICLE_RESULT_INVALID', '账号核验返回了错误结果，未发送');
    return result;
  }
  async account(browserRaw: BrowserFamily, accountRaw: string): Promise<ArticleResult> {
    const browser = browserFamilySchema.parse(browserRaw), accountId = nowcoderAccountIdSchema.parse(accountRaw);
    this.active++; try { return await this.probe(browser, accountId); } finally { this.active--; }
  }
  private async required(id: string): Promise<NowcoderArticle> {
    const entry = await this.store.get(id); if (!entry) throw new HttpError(404, 'ARTICLE_NOT_FOUND', '文章记录不存在'); return entry;
  }
  async preview(id: string): Promise<unknown> {
    this.active++;
    try {
      const entry = await this.required(id);
      if (entry.publicationAttempts.some(a => a.state !== 'rejected')) return { entry, readOnly: true, message: '文章已有发布记录；请查看原回执或只读核验' };
      const result = await this.probe(entry.browser, entry.accountId, id);
      if (result.kind === 'attention') return { entry, attention: result };
      if (result.kind !== 'account') throw new HttpError(409, 'ARTICLE_RESULT_INVALID', '账号核验结果无效');
      return { entry: await this.store.savePreview(id, result.identity), limits: await this.control.articleStatus() };
    } finally { this.active--; }
  }
  async publish(id: string, raw: unknown): Promise<unknown> {
    const input = articlePublishSchema.parse(raw);
    if (this.publishing.has(id)) throw new HttpError(409, 'ARTICLE_BUSY', '该文章发送仍在执行，请等待原回执');
    this.active++; this.publishing.add(id);
    try {
      const entry = await this.required(id);
      if (entry.browser !== input.browser || entry.accountId !== input.accountId) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '发送目标与文章绑定账号或浏览器不符');
      if (!entry.publicationAttempts.some(a => a.key === input.key)) {
        if (entry.revision !== input.revision || entry.contentHash !== input.contentHash) throw new HttpError(409, 'ARTICLE_STALE', '文章内容或版本已变化，请重读');
        if (!entry.preview) throw new HttpError(409, 'ARTICLE_PREVIEW_REQUIRED', '请先预览文章并核对账号');
        await this.control.assertArticleCapacity();
        const actual = await this.probe(entry.browser, entry.accountId, id);
        if (actual.kind === 'attention') return { id, revision: entry.revision, attention: actual };
      }
      const started = await this.store.beginPublication(id, input, randomUUID());
      if (!started.dispatch) return { id, revision: started.entry.revision, publication: started.publication, ...(started.entry.receipt ? { receipt: started.entry.receipt } : {}) };
      let result: ArticleResult;
      try {
        // A context result on either channel can establish this latch while the
        // journal is being written. No await between final fence and dispatch.
        result = this.control.verificationPending
          ? { kind: 'attention', code: 'PUBLISH_VERIFICATION_PAUSED', message: '发送前出现待处理验证，本条未点击发送', submission: 'not_attempted' }
          : await this.transport.execute({ kind: 'article-publish', title: started.entry.title, body: started.entry.body,
            expectedAccountId: started.entry.accountId, provenance: started.entry.provenance }, started.publication.requestId, started.entry.browser);
      } catch { result = { kind: 'attention', code: 'ARTICLE_PUBLICATION_INTERRUPTED', message: '文章发送中断，结果待核验，禁止自动重发', submission: 'uncertain' }; }
      try { await this.observe(result, started.publication.requestId, started.entry.browser, started.entry.accountId, id, input.key); }
      catch (error) { await this.store.finishPublication(id, input.key, result); throw error; }
      const publication = await this.store.finishPublication(id, input.key, result), saved = await this.required(id);
      return { id, revision: saved.revision, publication, ...(saved.receipt ? { receipt: saved.receipt } : {}), ...(result.kind === 'attention' ? { attention: result } : {}) };
    } finally { this.active--; this.publishing.delete(id); }
  }
  private verificationAction(entry: NowcoderArticle, key: string): ArticleAction {
    const attempt = entry.publicationAttempts.find(a => a.key === key);
    if (!attempt) throw new HttpError(404, 'ARTICLE_ATTEMPT_REQUIRED', '未找到原始文章发送记录');
    return { kind: 'article-verify', title: entry.title, body: entry.body, expectedAccountId: entry.accountId, ...(attempt.postUrl ? { postUrl: attempt.postUrl } : {}) };
  }
  async verify(id: string, key: string): Promise<unknown> {
    z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u).parse(key);
    if (this.publishing.has(id)) throw new HttpError(409, 'ARTICLE_BUSY', '文章发送仍在执行，请等待原回执');
    this.active++;
    try {
      const entry = await this.required(id), attempt = entry.publicationAttempts.find(a => a.key === key);
      if (!attempt) throw new HttpError(404, 'ARTICLE_ATTEMPT_REQUIRED', '未找到原始文章发送记录');
      if (attempt.state === 'published' || attempt.state === 'rejected') return { id, publication: attempt, ...(entry.receipt ? { receipt: entry.receipt } : {}) };
      await this.assertSiteAccess(); this.transport.assertAvailable(entry.browser);
      const requestId = randomUUID(), result = await this.transport.execute(this.verificationAction(entry, key), requestId, entry.browser);
      if (await this.observe(result, requestId, entry.browser, entry.accountId, id, key) || result.kind === 'attention') return { id, publication: attempt, attention: result };
      return { id, publication: await this.store.reconcile(id, key, result), ...((await this.required(id)).receipt ? { receipt: (await this.required(id)).receipt } : {}) };
    } finally { this.active--; }
  }
  async resumeVerification(raw: unknown): Promise<unknown> {
    const input = nowcoderVerificationResumeSchema.parse(raw); this.active++;
    try {
      const pause = (await this.control.status()).verification;
      if (!pause || pause.id !== input.id || pause.channel !== 'article') throw new HttpError(409, 'PUBLISH_VERIFICATION_CHANGED', '待处理验证已变化，请重新读取状态');
      if (!pause.browser || !pause.accountId) throw new HttpError(409, 'ARTICLE_ACCOUNT_REQUIRED', '原验证记录缺少浏览器或账号绑定，保持暂停');
      const entry = pause.articleId ? await this.required(pause.articleId) : undefined;
      if (entry && (entry.browser !== pause.browser || entry.accountId !== pause.accountId)) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '原验证与当前文章绑定不符，保持暂停');
      this.transport.assertAvailable(pause.browser);
      const requestId = randomUUID(), result = await this.transport.execute(entry && pause.key ? this.verificationAction(entry, pause.key) : { kind: 'account', expectedAccountId: pause.accountId }, requestId, pause.browser);
      if (await this.observe(result, requestId, pause.browser, pause.accountId, pause.articleId, pause.key) || result.kind === 'attention') return { status: await this.control.status(), attention: result };
      if ((result.kind !== 'account' && result.kind !== 'article-verified') || result.identity.userId !== pause.accountId) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '未确认原账号，保持暂停');
      let publication;
      if (entry && pause.key) publication = await this.store.reconcile(entry.id, pause.key, result);
      else if (result.kind !== 'account' || result.identity.userId !== pause.accountId) throw new HttpError(409, 'ARTICLE_ACCOUNT_MISMATCH', '未确认原账号，保持暂停');
      await this.control.clearVerification(input.id);
      return { status: await this.control.status(), ...(publication ? { publication } : {}) };
    } finally { this.active--; }
  }
}
