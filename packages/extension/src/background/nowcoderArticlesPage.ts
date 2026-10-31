import type { ArticlePageAction, ArticlePageResult, NowcoderAccountIdentity, NowcoderOperationDiagnostics } from '@data-collector/shared';

/** Serialized by chrome.scripting: runtime helpers remain inside this function. */
export async function runNowcoderArticlePage(action: ArticlePageAction): Promise<ArticlePageResult> {
  const diagnostics: NowcoderOperationDiagnostics = { pageStartedAt: new Date().toISOString() };
  let clicked = false;
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  // Whitespace presentation may change between Slate paragraphs and rendered HTML.
  // Preserve word boundaries: "agent tool" must not equal "agenttool".
  const normalized = (value: string) => value.replace(/[\u200b-\u200d\ufeff]/gu, '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const visible = (node: Element) => {
    if (node.closest('[hidden],[aria-hidden="true"],[inert],.tw-hidden')) return false;
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const text = (node: Element | null): string => {
    if (!node) return '';
    const rendered = (node as HTMLElement).innerText;
    if (typeof rendered === 'string' && !node.querySelector('[data-slate-placeholder],[data-slate-zero-width]')) return rendered.replace(/[\u200b-\u200d\ufeff]/gu, '').trim();
    const read = (item: Node): string => {
      if (item.nodeType === Node.TEXT_NODE) return item.textContent ?? '';
      if (!(item instanceof Element) || !visible(item) || item.hasAttribute('data-slate-placeholder') || item.hasAttribute('data-slate-zero-width')) return '';
      if (item.tagName === 'BR') return '\n';
      const contents = [...item.childNodes].map(read).join('');
      return /^(P|DIV|LI|SECTION|BLOCKQUOTE|PRE|H[1-6])$/u.test(item.tagName) ? `\n${contents}\n` : contents;
    };
    return read(node).replace(/[\u200b-\u200d\ufeff]/gu, '').trim();
  };
  const attention = (code: string, message: string): ArticlePageResult => ({ kind: 'attention', code, message, submission: clicked ? 'uncertain' : 'not_attempted', diagnostics });
  const canonical = (value: string) => {
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'https:' || url.hostname !== 'www.nowcoder.com' || url.username || url.password || url.port) return undefined;
      return `${url.origin}${url.pathname.replace(/\/$/u, '')}`;
    } catch { return undefined; }
  };
  const detailUrl = (value: string) => {
    const url = canonical(value);
    return url && /^https:\/\/www\.nowcoder\.com\/(?:discuss\/\d+|feed\/main\/detail\/[a-z0-9]+)$/iu.test(url) ? url : undefined;
  };
  const guard = (): ArticlePageResult | undefined => {
    if (diagnostics.verificationObservedAt
      || [...document.querySelectorAll('.captcha-modal,.nc-captcha-modal,.captcha-container,#captcha,.geetest_panel,.geetest_widget,.yidun_panel,.verify-dialog,iframe[src*="captcha"],iframe[src*="geetest"]')].some(visible)
      || /^(安全验证|人机验证|访问验证|Access Verification|Security Verification)/iu.test(document.title)) {
      diagnostics.verificationObservedAt ??= new Date().toISOString();
      return attention('VERIFICATION_REQUIRED', '牛客要求验证，请在保留的页面完成验证');
    }
    if ([...document.querySelectorAll('.login-modal,.nc-login-modal,[class*="login-container"],form[action*="login"]')].some(visible)
      || /^(登录|注册登录|Login|Sign in)(?:\s|[-—|]|$)/iu.test(document.title)
      || /^\/login(?:\/|$)/u.test(location.pathname)) return attention('LOGIN_REQUIRED', '牛客登录已失效，请在保留的页面登录');
    if (/^(403|429|Forbidden|Access Denied|请求过于频繁|访问被拒绝)/iu.test(document.title)
      || [...document.querySelectorAll('.access-denied,.forbidden,[data-status="403"],[data-status="429"]')].some(visible)) return attention('ACCESS_RESTRICTED', '牛客限制了当前访问，操作已停止');
    return undefined;
  };
  const waitFor = async (ready: () => boolean, ms = 5000): Promise<ArticlePageResult | undefined> => {
    const end = Date.now() + ms;
    for (;;) {
      const blocked = guard(); if (blocked) return blocked;
      if (ready() || Date.now() >= end) return guard();
      await pause(100);
    }
  };
  const ownedProfile = (): NowcoderAccountIdentity | undefined => {
    if (!action.expectedAccountId) return undefined;
    const profileUrl = `https://www.nowcoder.com/users/${action.expectedAccountId}`;
    if (canonical(location.href) !== profileUrl) return undefined;
    const ownerUrl = `https://www.nowcoder.com/profile/${action.expectedAccountId}/account`;
    const owner = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].some(link => visible(link) && canonical(link.getAttribute('href')!) === ownerUrl);
    if (!owner) return undefined;
    const nickname = document.title.match(/^(.+?)\s*-\s*个人主页(?:动态|文章|帖子)?\s*-\s*牛客网$/u)?.[1]?.trim();
    if (!nickname || nickname.length > 200) return undefined;
    return { userId: action.expectedAccountId, nickname, profileUrl, observedAt: new Date().toISOString() };
  };
  const ownProfileResult = async (): Promise<ArticlePageResult> => {
    if (!action.expectedAccountId) return attention('ACCOUNT_ID_REQUIRED', '请指定需要核验的牛客账号ID');
    const expected = `https://www.nowcoder.com/users/${action.expectedAccountId}`;
    if (canonical(location.href) !== expected) return attention('ACCOUNT_MISMATCH', '当前页不是指定账号的主页，未进行操作');
    const blocked = await waitFor(() => Boolean(ownedProfile())); if (blocked) return blocked;
    const identity = ownedProfile();
    if (!identity) return attention('ACCOUNT_NOT_OWNED', '未观察到指定主页的本人账号设置入口，请核对当前登录账号');
    const boundary = guard(); if (boundary) return boundary;
    if (canonical(location.href) !== expected) return attention('ACCOUNT_MISMATCH', '核验期间离开指定账号主页，未进行操作');
    return { kind: 'account', identity, diagnostics };
  };
  try {
    const initial = guard(); if (initial) return initial;
    if (action.kind === 'account') return await ownProfileResult();
    if (action.kind === 'article-verify') {
      const current = canonical(location.href);
      const expectedProfile = `https://www.nowcoder.com/users/${action.expectedAccountId}`;
      if (!action.postUrl && current === expectedProfile) {
        const account = await ownProfileResult(); if (account.kind !== 'account') return account;
        const profileState = () => {
          const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible);
          const cards = [...new Set(links.map(link => detailUrl(link.getAttribute('href')!)).filter((url): url is string => Boolean(url)))];
          const matches = [...new Set(links.filter(link => normalized(text(link)) === normalized(action.title))
            .map(link => detailUrl(link.getAttribute('href')!)).filter((url): url is string => Boolean(url)))];
          const labels = [...document.querySelectorAll('a,button,[role="tab"],li,span,div')].filter(node => node.childElementCount <= 3 && visible(node)).map(text);
          const counts = labels.map(label => label.replace(/\s+/gu, '').match(/^发布(?:\((\d+)\)|（(\d+)）|(\d+))$/u))
            .filter((match): match is RegExpMatchArray => Boolean(match)).map(match => Number(match[1] ?? match[2] ?? match[3]));
          const declared = counts.length ? Math.max(...counts) : undefined;
          const loading = [...document.querySelectorAll('.loading,.nc-loading,.el-loading-mask,.ant-spin-spinning,[aria-busy="true"]')].some(visible)
            || labels.some(label => /^(?:玩命加载中|正在加载|加载中)(?:\.{1,3}|…)?$/u.test(label.trim()));
          const empty = labels.some(label => /^(?:暂无(?:更多)?(?:内容|动态|文章)|还没有(?:发布|动态|文章).*)$/u.test(label.trim()));
          return { cards, matches, declared, loading, empty };
        };
        let previous = '', stableAt = Date.now();
        const profileReady = () => {
          const state = profileState(), signature = JSON.stringify(state);
          if (signature !== previous) { previous = signature; stableAt = Date.now(); }
          return !state.loading && !(state.declared !== undefined && state.declared > 0 && !state.cards.length)
            && Boolean(state.cards.length || state.declared === 0 || state.empty) && Date.now() - stableAt >= 400;
        };
        const blocked = await waitFor(() => profileReady() || canonical(location.href) !== expectedProfile); if (blocked) return blocked;
        const identity = ownedProfile();
        if (!identity) return attention('ACCOUNT_NOT_OWNED', '查找文章期间无法再次确认本人主页');
        if (!profileReady()) return attention('ARTICLE_PROFILE_NOT_READY', '本人主页的近期文章仍在加载或未稳定，未将未加载内容当作查重结果');
        const { matches } = profileState();
        const boundary = guard(); if (boundary) return boundary;
        if (matches.length > 1) return attention('AMBIGUOUS_ARTICLE', '本人主页存在多篇同标题文章，请指定真实详情地址核验');
        if (matches[0]) return { kind: 'article-candidate', url: matches[0], identity, diagnostics };
        return { kind: 'article-verified', identity, diagnostics };
      }
      const expectedUrl = action.postUrl ? detailUrl(action.postUrl) : detailUrl(location.href);
      if (!expectedUrl || current !== expectedUrl) return attention('SOURCE_MISMATCH', '当前详情地址不符，未将其他页面当作文章回执');
      const nodes = (selector: string) => [...document.querySelectorAll(selector)].filter(visible).filter(node => !node.closest('.comment-box,.subcomment-box,.comment-list,aside,nav'));
      const fields = () => {
        const titles = nodes('h1,.post-title,.discuss-title');
        const allBodies = nodes('.feed-content-text,.nc-slate-editor-content,.post-topic-des,.nc-post-content');
        const bodies = allBodies.filter(node => !allBodies.some(other => other !== node && other.contains(node)));
        // The article's observed main-user-top header is a sibling of its body;
        // recommendation cards reuse user-nickname inside the same main section.
        const authors = nodes(document.querySelector('.main-user-top')
          ? '.main-user-top .user-nickname a[href*="/users/"]'
          : '.feed-detail > .user-nickname a[href*="/users/"],.post-author a[href*="/users/"],.feed-author a[href*="/users/"]') as HTMLAnchorElement[];
        const authorIds = [...new Set(authors.map(link => canonical(link.getAttribute('href')!)?.match(/^https:\/\/www\.nowcoder\.com\/users\/(\d+)$/u)?.[1]).filter((id): id is string => Boolean(id)))];
        return { titles, bodies, authorIds };
      };
      const ready = () => {
        const { titles, bodies, authorIds } = fields();
        return titles.length === 1 && bodies.length === 1 && Boolean(text(titles[0]!)) && Boolean(text(bodies[0]!)) && authorIds.length > 0;
      };
      const blocked = await waitFor(() => ready() || canonical(location.href) !== expectedUrl); if (blocked) return blocked;
      if (canonical(location.href) !== expectedUrl) return attention('SOURCE_MISMATCH', '核验期间离开指定文章，未确认发布结果');
      const { titles, bodies, authorIds } = fields();
      if (!ready()) return attention('ARTICLE_NOT_READY', '文章标题、全文或作者未完整加载，未确认发布结果');
      if (authorIds.length !== 1 || authorIds[0] !== action.expectedAccountId) return attention('AUTHOR_MISMATCH', '文章作者与指定账号不符，未确认发布结果');
      const title = text(titles[0]!), body = text(bodies[0]!);
      if (body.length > 24_000 || [...title].length > 50) return attention('ARTICLE_CONTENT_LIMIT', '正文超出有界核验范围，未以截断内容确认回执');
      if ([...bodies[0]!.querySelectorAll('.vue-ellipsis-js-suffix,[aria-expanded="false"],[aria-busy="true"],.loading')].some(node => visible(node)
        && (node.getAttribute('aria-busy') === 'true' || node.classList.contains('loading') || /展开|查看全文/u.test(text(node))))) return attention('ARTICLE_INCOMPLETE', '正文仍被折叠或加载中，未将摘要当作完整回执');
      if (normalized(title) !== normalized(action.title) || normalized(body) !== normalized(action.body)) return attention('ARTICLE_CONTENT_MISMATCH', '文章完整标题或正文与草稿不符，未确认发布结果');
      const boundary = guard(); if (boundary) return boundary;
      if (canonical(location.href) !== expectedUrl || fields().authorIds[0] !== action.expectedAccountId) return attention('SOURCE_MISMATCH', '确认回执前页面或作者发生变化');
      const observedAt = new Date().toISOString(); diagnostics.receiptObservedAt = observedAt;
      // This is an observed receipt, not a logged-in-account identity. The runner
      // binds it to a separately proven owned profile for readonly verification.
      return { kind: 'article-published', receipt: { url: expectedUrl, title, body, accountId: action.expectedAccountId, observedAt }, diagnostics };
    }

    const editorUrl = 'https://www.nowcoder.com/creation/write/article';
    if (canonical(location.href) !== editorUrl) return attention('SOURCE_MISMATCH', '当前页不是牛客文章编辑器，未写入或发送');
    if (action.provenance === 'compiled' && !/整理版|备考题单/u.test(`${action.title}\n${action.body}`)) return attention('COMPILATION_DISCLOSURE_REQUIRED', '整理内容需明确标注整理版或备考题单，未写入或发送');
    // The editor hides its site account dropdown. Its scoped rendered account
    // corroborates the runner's freshly loaded owner-profile proof; public
    // article author links must never be used here as login evidence.
    const composerAccount = () => [...new Set([...document.querySelectorAll<HTMLAnchorElement>('.nc-nav-header-profile .name a[href],.to-user-btn .self-header-desc a[href]')]
      .map(link => canonical(link.getAttribute('href')!)?.match(/^https:\/\/www\.nowcoder\.com\/users\/(\d+)$/u)?.[1]).filter((id): id is string => Boolean(id)))];
    const accountMatches = () => { const ids = composerAccount(); return ids.length === 1 && ids[0] === action.expectedAccountId; };
    const accountReady = await waitFor(() => composerAccount().length > 0 || canonical(location.href) !== editorUrl); if (accountReady) return accountReady;
    if (!accountMatches()) return attention('ACCOUNT_MISMATCH', '文章编辑器的本人账号与指定账号不符或不可确认，未写入或发送');
    const composer = () => {
      const titles = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[maxlength="50"],textarea[maxlength="50"],input[placeholder*="标题"],textarea[placeholder*="标题"]')]
        .filter(node => visible(node) && !node.disabled && !node.readOnly && (!('type' in node) || !['hidden', 'password'].includes(node.type)));
      const editors = [...document.querySelectorAll<HTMLElement>('#nc-e-textarea-1[contenteditable="true"]')].filter(visible);
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(node => visible(node) && text(node) === '发布');
      return { title: titles.length === 1 ? titles[0] : undefined, body: editors.length === 1 ? editors[0] : undefined, button: buttons.length === 1 ? buttons[0] : undefined };
    };
    const blocked = await waitFor(() => { const found = composer(); return Boolean(found.title && found.body && found.button) || canonical(location.href) !== editorUrl; }); if (blocked) return blocked;
    if (canonical(location.href) !== editorUrl) return attention('SOURCE_MISMATCH', '等待编辑器时离开指定页面，未写入或发送');
    const { title, body, button } = composer();
    if (!title || !body || !button) return attention('COMPOSER_UNAVAILABLE', '无法唯一确认文章标题、正文和发布按钮，未写入或发送');
    if ((normalized(title.value) && normalized(title.value) !== normalized(action.title)) || (normalized(text(body)) && normalized(text(body)) !== normalized(action.body))) return attention('EXISTING_DRAFT', '文章编辑器已有不同草稿，未覆盖或发送');
    if (!normalized(title.value)) {
      title.focus();
      const prototype = title instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) return attention('COMPOSER_REJECTED', '标题输入控件不可用，未点击发送');
      setter.call(title, action.title);
      title.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: action.title }));
    }
    const beforeBody = guard(); if (beforeBody) return beforeBody;
    if (!normalized(text(body))) {
      body.focus();
      // Same supported Slate input path as the existing comment composer: a
      // cancelled beforeinput owns the model update and must not insert twice.
      const selection = window.getSelection(), range = document.createRange();
      const leaf = body.querySelector('[data-slate-zero-width]') ?? body.querySelector('[data-slate-leaf]');
      const point = leaf?.firstChild;
      if (point?.nodeType === Node.TEXT_NODE) range.setStart(point, point.textContent?.length ?? 0);
      else range.selectNodeContents(body);
      range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range);
      const targetRanges = typeof StaticRange === 'function' ? [new StaticRange(range)] : [];
      const event = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: action.body, targetRanges });
      const browserEdit = body.dispatchEvent(event);
      if (browserEdit) {
        if (typeof document.execCommand !== 'function' || !document.execCommand('insertText', false, action.body)) return attention('COMPOSER_REJECTED', '正文编辑器未接受文本输入，未点击发送');
        body.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: action.body }));
      }
    }
    const enabled = () => button.getAttribute('aria-disabled') !== 'true' && !(button as HTMLButtonElement).disabled && !button.hasAttribute('disabled')
      && !button.classList.contains('disabled') && !button.classList.contains('is-disabled');
    const echo = () => normalized(title.value) === normalized(action.title) && normalized(text(body)) === normalized(action.body) && enabled();
    const echoed = await waitFor(() => echo() || canonical(location.href) !== editorUrl, 3000); if (echoed) return echoed;
    diagnostics.beforeSubmitAt = new Date().toISOString();
    const boundary = guard(); if (boundary) return boundary;
    if (canonical(location.href) !== editorUrl) return attention('SOURCE_MISMATCH', '输入期间页面离开文章编辑器，未点击发送');
    const current = composer();
    if (!title.isConnected || !body.isConnected || !button.isConnected || current.title !== title || current.body !== body || current.button !== button || !visible(button)) return attention('COMPOSER_UNAVAILABLE', '输入期间编辑器或发布按钮发生变化，未点击发送');
    if (!echo()) return attention('COMPOSER_REJECTED', '编辑器未完整接受标题和正文，未点击发送');
    if (!accountMatches()) return attention('ACCOUNT_MISMATCH', '输入期间编辑器账号发生变化，未点击发送');
    if (action.kind === 'article-prepare') return { kind: 'article-prepared', diagnostics };
    clicked = true; diagnostics.submitClickedAt = new Date().toISOString(); button.click();
    const afterClick = guard(); if (afterClick) return afterClick;
    // Return the actual click evidence before navigation can destroy this script.
    // The runner only inspects afterward; dialogs never trigger a blind click.
    return { kind: 'article-clicked', diagnostics };
  } catch {
    const blocked = guard(); if (blocked) return blocked;
    return attention('PAGE_OPERATION_FAILED', clicked ? '文章发送结果不确定，请核验，禁止自动重发' : '文章页面操作失败，未点击发送');
  }
}
