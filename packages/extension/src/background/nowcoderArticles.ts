import {
  NOWCODER_ARTICLE_EDITOR_URL, articleActionSchema, articlePageResultSchema, articlePostUrlSchema,
  type ArticleAction, type ArticlePageAction, type ArticlePageResult, type ArticleResult, type NowcoderAccountIdentity, type NowcoderOperationDiagnostics,
} from '@data-collector/shared';

interface ArticleTabs {
  create(url: string): Promise<{ id?: number }>;
  wait(id: number): Promise<void>;
  execute(id: number, action: ArticlePageAction): Promise<unknown>;
  get?(id: number): Promise<{ url?: string }>;
  close(id: number): Promise<unknown>;
  handoff(id: number, url: string): Promise<unknown>;
}

export class NowcoderArticlesRunner {
  private running = false;
  get busy() { return this.running; }
  constructor(private readonly tabs: ArticleTabs) {}

  async run(raw: ArticleAction): Promise<ArticleResult> {
    const action = articleActionSchema.parse(raw);
    if (this.running) return { kind: 'attention', code: 'ARTICLES_BUSY', message: '另一个牛客文章页面操作正在执行', submission: 'not_attempted' };
    if (!action.expectedAccountId) return { kind: 'attention', code: 'ACCOUNT_ID_REQUIRED', message: '请指定需要核验的牛客账号ID', submission: 'not_attempted' };
    this.running = true;
    const profileUrl = `https://www.nowcoder.com/users/${action.expectedAccountId}`;
    const owned = new Map<number, string>(), keep = new Set<number>();
    let lastId: number | undefined, editorId: number | undefined;
    let mayHaveSubmitted = false;
    let clickDiagnostics: NowcoderOperationDiagnostics | undefined;
    const normalized = (value: string) => value.replace(/[\u200b-\u200d\ufeff]/gu, '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const canonical = (value: string) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 'www.nowcoder.com' || url.username || url.password || url.port) return undefined;
        return `${url.origin}${url.pathname.replace(/\/$/u, '')}`;
      } catch { return undefined; }
    };
    const attention = (code: string, message: string): Extract<ArticleResult, { kind: 'attention' }> => ({ kind: 'attention', code, message,
      submission: mayHaveSubmitted ? 'uncertain' : 'not_attempted', ...(clickDiagnostics ? { diagnostics: clickDiagnostics } : {}) });
    const diagnostics = (observed?: NowcoderOperationDiagnostics): NowcoderOperationDiagnostics | undefined => {
      if (!clickDiagnostics) return observed;
      return { ...observed, ...clickDiagnostics,
        ...(observed?.verificationObservedAt ? { verificationObservedAt: observed.verificationObservedAt } : {}),
        ...(observed?.receiptObservedAt ? { receiptObservedAt: observed.receiptObservedAt } : {}) };
    };
    const currentUrl = async (id: number) => {
      const current = await this.tabs.get?.(id).catch(() => undefined);
      return current?.url ?? owned.get(id)!;
    };
    const sourceUrl = async (id: number) => canonical(await currentUrl(id));
    const preserve = async (result: Extract<ArticleResult, { kind: 'attention' }>, id = lastId): Promise<ArticleResult> => {
      if (editorId !== undefined && mayHaveSubmitted) keep.add(editorId);
      if (id === undefined) return result;
      // Retention happens before the best-effort handoff, including a failed focus
      // or persistence operation. Neither may erase an observed challenge.
      keep.add(id);
      const tabUrl = await currentUrl(id);
      for (const keptId of keep) {
        if (keptId !== id) await this.tabs.handoff(keptId, await currentUrl(keptId)).catch(() => undefined);
      }
      await this.tabs.handoff(id, tabUrl).catch(() => undefined);
      const combined = diagnostics(result.diagnostics);
      return { ...result, submission: mayHaveSubmitted ? 'uncertain' : result.submission, tabUrl, ...(combined ? { diagnostics: combined } : {}) };
    };
    const wait = async (id: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.tabs.wait(id), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned article tab load timeout')), 15_000); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    const create = async (url: string) => {
      const { id } = await this.tabs.create(url);
      if (id === undefined) throw new Error('No owned article tab');
      owned.set(id, url); lastId = id;
      await wait(id); return id;
    };
    const execute = async (id: number, request: ArticlePageAction): Promise<ArticlePageResult> => {
      lastId = id;
      return articlePageResultSchema.parse(await this.tabs.execute(id, request));
    };
    const identityMatches = (identity: NowcoderAccountIdentity) => identity.userId === action.expectedAccountId && identity.profileUrl === profileUrl;
    const isBarrier = (result: ArticlePageResult) => result.kind === 'attention' && (['VERIFICATION_REQUIRED', 'LOGIN_REQUIRED', 'ACCESS_RESTRICTED'].includes(result.code) || Boolean(result.diagnostics?.verificationObservedAt));
    const verifyAction = (postUrl?: string): ArticleAction => {
      if (action.kind === 'account') throw new Error('No article content for account probe');
      return { kind: 'article-verify', title: action.title, body: action.body, expectedAccountId: action.expectedAccountId, ...(postUrl ? { postUrl } : {}) };
    };
    const receiptResult = async (result: ArticlePageResult, id: number, identity: NowcoderAccountIdentity, expectedUrl: string): Promise<ArticleResult> => {
      const receipt = result.kind === 'article-published' ? result.receipt : result.kind === 'article-verified' ? result.receipt : undefined;
      if (action.kind === 'account' || !receipt || !articlePostUrlSchema.safeParse(expectedUrl).success || receipt.url !== expectedUrl || receipt.accountId !== action.expectedAccountId
        || normalized(receipt.title) !== normalized(action.title) || normalized(receipt.body) !== normalized(action.body)
        || (result.kind === 'article-verified' && !identityMatches(result.identity))
        || await sourceUrl(id) !== expectedUrl) return preserve(attention('ARTICLE_RECEIPT_MISMATCH', '未观察到与指定文章、全文和作者一致的回执，禁止自动重发'), id);
      const combined = diagnostics(result.diagnostics);
      return action.kind === 'article-publish'
        ? { kind: 'article-published', receipt, ...(combined ? { diagnostics: combined } : {}) }
        : { kind: 'article-verified', identity, receipt, ...(combined ? { diagnostics: combined } : {}) };
    };
    const readDetail = async (url: string, identity: NowcoderAccountIdentity): Promise<ArticleResult> => {
      const id = await create(url), result = await execute(id, verifyAction(url));
      if (result.kind === 'attention') return preserve(result, id);
      return receiptResult(result, id, identity, url);
    };
    const readProfile = async (id: number, identity: NowcoderAccountIdentity): Promise<ArticleResult> => {
      const result = await execute(id, verifyAction());
      if (result.kind === 'attention') return preserve(result, id);
      if (await sourceUrl(id) !== profileUrl) return preserve(attention('ACCOUNT_MISMATCH', '查找文章期间离开指定本人主页，操作已停止'), id);
      if (result.kind === 'article-candidate') {
        if (!identityMatches(result.identity)) return preserve(attention('ACCOUNT_MISMATCH', '待核验文章来自其他账号主页，操作已停止'), id);
        return readDetail(result.url, identity);
      }
      if (result.kind === 'article-verified' && !result.receipt && identityMatches(result.identity)) {
        if (action.kind === 'article-verify') return { kind: 'article-verified', identity, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
        return preserve(attention('RECEIPT_NOT_OBSERVED', '已尝试一次发布，但未观察到唯一完整回执，请核验，禁止自动重发'), editorId ?? id);
      }
      return preserve(attention('ARTICLE_RECEIPT_MISMATCH', '本人主页没有提供可独立核验的文章详情，禁止自动重发'), id);
    };
    const recoverAfterPublish = async (id: number, identity: NowcoderAccountIdentity): Promise<ArticleResult> => {
      // A navigation may destroy executeScript before its click diagnostics return.
      // Never infer a click timestamp or dispatch a second publishing action.
      const deadline = Date.now() + 3000;
      do {
        const url = await sourceUrl(id);
        const detail = articlePostUrlSchema.safeParse(url);
        try {
          const observed = await execute(id, verifyAction(detail.success ? detail.data : undefined));
          if (isBarrier(observed) && observed.kind === 'attention') return preserve(observed, id);
          if (detail.success) {
            if (observed.kind === 'attention') return preserve(observed, id);
            return receiptResult(observed, id, identity, detail.data);
          }
          if (url === profileUrl && observed.kind === 'article-candidate') {
            if (!identityMatches(observed.identity)) return preserve(attention('ACCOUNT_MISMATCH', '发布后主页账号不符，操作已停止'), id);
            return readDetail(observed.url, identity);
          }
        } catch { /* Navigation recovery stays read-only and bounded. */ }
        if (!this.tabs.get || Date.now() >= deadline) break;
        await new Promise<void>(resolve => setTimeout(resolve, 250));
      } while (Date.now() <= deadline);
      return readProfile(await create(profileUrl), identity);
    };
    const duplicatePreflight = async (id: number, identity: NowcoderAccountIdentity): Promise<ArticleResult | undefined> => {
      const result = await execute(id, verifyAction());
      if (result.kind === 'attention') return preserve(result, id);
      if (await sourceUrl(id) !== profileUrl) return preserve(attention('ACCOUNT_MISMATCH', '发布前无法再次确认指定本人主页，操作已停止'), id);
      if (result.kind === 'article-verified' && !result.receipt && identityMatches(result.identity)) return undefined;
      if (result.kind !== 'article-candidate' || !identityMatches(result.identity)) return preserve(attention('ACCOUNT_MISMATCH', '发布前文章查重无法绑定指定本人账号，操作已停止'), id);
      const candidateId = await create(result.url), observed = await execute(candidateId, verifyAction(result.url));
      if (observed.kind === 'attention') {
        // A same-title article with a different full body is not an exact duplicate.
        // All barriers, unknown authors and incomplete content still stop safely.
        if (observed.code !== 'ARTICLE_CONTENT_MISMATCH' || isBarrier(observed)) return preserve(observed, candidateId);
        const rechecked = await execute(id, { kind: 'account', expectedAccountId: action.expectedAccountId });
        if (rechecked.kind === 'attention') return preserve(rechecked, id);
        if (rechecked.kind !== 'account' || !identityMatches(rechecked.identity) || await sourceUrl(id) !== profileUrl) return preserve(attention('ACCOUNT_MISMATCH', '查重后本人账号发生变化，未打开编辑器'), id);
        return undefined;
      }
      const existing = await receiptResult(observed, candidateId, identity, result.url);
      if (existing.kind !== 'article-published') return existing;
      return preserve(attention('DUPLICATE_ARTICLE', '本人主页已有相同完整标题和正文的文章，未再次发布'), candidateId);
    };
    try {
      const accountId = await create(profileUrl);
      const account = await execute(accountId, { kind: 'account', expectedAccountId: action.expectedAccountId });
      if (account.kind === 'attention') return await preserve(account, accountId);
      if (account.kind !== 'account' || !identityMatches(account.identity) || await sourceUrl(accountId) !== profileUrl) return await preserve(attention('ACCOUNT_MISMATCH', '当前登录账号与指定账号不符，未打开发文编辑器'), accountId);
      const identity = account.identity;
      if (action.kind === 'account') return account;
      if (action.kind === 'article-verify') return await (action.postUrl ? readDetail(action.postUrl, identity) : readProfile(accountId, identity));
      const duplicate = await duplicatePreflight(accountId, identity); if (duplicate) return duplicate;
      editorId = await create(NOWCODER_ARTICLE_EDITOR_URL);
      const prepared = await execute(editorId, { ...action, kind: 'article-prepare' });
      if (prepared.kind === 'attention') return await preserve(prepared, editorId);
      if (prepared.kind !== 'article-prepared') return await preserve(attention('ARTICLE_PREPARATION_INVALID', '编辑器未完成只读发送前准备，未点击发布'), editorId);
      // Account can change while the editor loads or accepts text. Reopen its
      // own profile after the echo and before the sole send-capable invocation.
      const finalAccountId = await create(profileUrl);
      const finalAccount = await execute(finalAccountId, { kind: 'account', expectedAccountId: action.expectedAccountId });
      if (finalAccount.kind === 'attention') { keep.add(editorId); return await preserve(finalAccount, finalAccountId); }
      if (finalAccount.kind !== 'account' || !identityMatches(finalAccount.identity) || await sourceUrl(finalAccountId) !== profileUrl) return await preserve(attention('ACCOUNT_MISMATCH', '编辑器准备后实际账号发生变化，未点击发布'), editorId);
      mayHaveSubmitted = true;
      let result: ArticlePageResult;
      try { result = await execute(editorId, action); }
      catch { return await recoverAfterPublish(editorId, identity); }
      if (result.kind === 'attention') {
        clickDiagnostics = result.diagnostics;
        mayHaveSubmitted = result.submission === 'uncertain' || Boolean(result.diagnostics?.submitClickedAt);
        return await preserve(result, editorId);
      }
      if (result.kind === 'article-clicked') {
        clickDiagnostics = result.diagnostics;
        return await recoverAfterPublish(editorId, identity);
      }
      if (result.kind === 'article-published') {
        const url = await sourceUrl(editorId);
        if (!url) return await preserve(attention('SOURCE_MISMATCH', '发布后页面离开牛客文章详情，禁止自动重发'), editorId);
        return await receiptResult(result, editorId, identity, url);
      }
      return await preserve(attention('ARTICLE_RESULT_INVALID', '编辑器没有返回实际点击或完整回执，禁止自动重发'), editorId);
    } catch {
      // A failed load can be a challenge page. Inspect it without any send-capable
      // action before falling back to an interruption; do not erase that evidence.
      if (lastId !== undefined) {
        try {
          const observed = await execute(lastId, { kind: 'account', expectedAccountId: action.expectedAccountId });
          if (isBarrier(observed) && observed.kind === 'attention') return await preserve(observed, lastId);
        } catch { /* Keep the original owned page even if inspection also fails. */ }
      }
      return await preserve(attention('EXTENSION_ARTICLE_FAILED', '文章页面操作中断，请核验保留的页面，禁止自动重发'));
    } finally {
      for (const id of owned.keys()) if (!keep.has(id)) await this.tabs.close(id).catch(() => undefined);
      this.running = false;
    }
  }
}
