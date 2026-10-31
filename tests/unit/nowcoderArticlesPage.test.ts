// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleAction } from '@data-collector/shared';
import { runNowcoderArticlePage } from '../../packages/extension/src/background/nowcoderArticlesPage.js';

const profileUrl = 'https://www.nowcoder.com/users/544222414';
const editorUrl = 'https://www.nowcoder.com/creation/write/article';
const postUrl = 'https://www.nowcoder.com/discuss/123456';
const publish: Extract<ArticleAction, { kind: 'article-publish' }> = { kind: 'article-publish', title: 'Agent 一面整理版', body: '备考题单\n完整正文，包含 agent-journey.cn', expectedAccountId: '544222414', provenance: 'compiled' };
const verify: Extract<ArticleAction, { kind: 'article-verify' }> = { kind: 'article-verify', title: publish.title, body: publish.body, expectedAccountId: '544222414', postUrl };

function profile(owner = true) {
  vi.stubGlobal('location', new URL(profileUrl)); document.title = '妙脆角猫正在思考中 - 个人主页动态 - 牛客网';
  document.body.innerHTML = owner ? '<a href="/profile/544222414/account">账号设置</a>' : '<a href="/users/544222414">妙脆角猫正在思考中</a>';
}
function editor() {
  vi.stubGlobal('location', new URL(editorUrl)); document.title = '写文章 - 牛客网';
  document.body.innerHTML = '<div class="nc-nav-header-profile" hidden><div class="name"><a href="/users/544222414">本人</a></div></div><main><input placeholder="请输入标题" maxlength="50"><span>0/50</span><div id="nc-e-textarea-1" contenteditable="true"><p data-slate-node="element"><span data-slate-leaf="true"><span data-slate-zero-width="n">\ufeff<br></span></span></p></div><footer><button>发布</button><button>存草稿</button><button>MD编辑器</button></footer></main>';
}
function detail(author = '544222414', content = publish.body, title = publish.title) {
  vi.stubGlobal('location', new URL(postUrl)); document.title = `${title} - 牛客网`;
  document.body.innerHTML = '<main class="feed-detail"><h1></h1><div class="user-nickname"><a></a></div><div class="feed-content-text"></div></main>';
  document.querySelector('h1')!.textContent = title;
  const a = document.querySelector('a')!; a.setAttribute('href', `/users/${author}`); a.textContent = '作者名';
  document.querySelector('.feed-content-text')!.textContent = content;
}
async function run(action: ArticleAction) { const pending = runNowcoderArticlePage(action); await vi.runAllTimersAsync(); return pending; }
beforeEach(() => {
  vi.useFakeTimers(); profile();
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, text: string) => {
    document.querySelector('#nc-e-textarea-1')!.textContent = text; return true;
  }) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Nowcoder article DOM adapter', () => {
  it('proves own-account identity only from the expected profile and its visible owner-only settings link', async () => {
    expect(await run({ kind: 'account', expectedAccountId: '544222414' })).toMatchObject({ kind: 'account', identity: { userId: '544222414', nickname: '妙脆角猫正在思考中', profileUrl } });
  });
  it('does not infer login from a public author or arbitrary own-avatar link', async () => {
    profile(false);
    expect(await run({ kind: 'account', expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code: 'ACCOUNT_NOT_OWNED', submission: 'not_attempted' });
  });
  it('ignores a hidden owner settings link and rejects a foreign profile', async () => {
    document.querySelector('a')!.setAttribute('hidden', '');
    expect(await run({ kind: 'account', expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code: 'ACCOUNT_NOT_OWNED' });
    profile(); vi.stubGlobal('location', new URL('https://www.nowcoder.com/users/154061340'));
    expect(await run({ kind: 'account', expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code: 'ACCOUNT_MISMATCH' });
  });
  it.each([['.captcha-modal', 'VERIFICATION_REQUIRED'], ['.login-modal', 'LOGIN_REQUIRED']] as const)('stops at a visible %s before reading a ready profile', async (selector, code) => {
    document.body.insertAdjacentHTML('beforeend', `<div class="${selector.slice(1)}">阻断</div>`);
    expect(await run({ kind: 'account', expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code, submission: 'not_attempted' });
  });
  it('preserves a challenge that appears during bounded account readiness waits', async () => {
    profile(false); setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">验证</div>'), 200);
    const result = await run({ kind: 'account', expectedAccountId: '544222414' });
    expect(result).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', diagnostics: { verificationObservedAt: expect.any(String) } });
  });
  it('uses the native title input and cancelled Slate beforeinput model, then clicks publish once', async () => {
    editor(); const content = document.querySelector<HTMLElement>('[contenteditable]')!, button = document.querySelector('button')!;
    let model = '', clicks = 0, titleInput = '';
    document.querySelector('input')!.addEventListener('input', event => { titleInput = (event.target as HTMLInputElement).value; });
    content.addEventListener('beforeinput', event => { event.preventDefault(); model = (event as InputEvent).data ?? ''; content.textContent = model; });
    button.addEventListener('click', () => { clicks++; document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><button>发布</button></div>'); });
    expect(await run(publish)).toMatchObject({ kind: 'article-clicked', diagnostics: { beforeSubmitAt: expect.any(String), submitClickedAt: expect.any(String) } });
    expect(titleInput).toBe(publish.title); expect(model).toBe(publish.body); expect(clicks).toBe(1);
    expect(document.execCommand).not.toHaveBeenCalled();
  });
  it('prepares a complete editor echo without clicking a publishing button', async () => {
    editor(); const clicks = vi.fn(); document.querySelector('button')!.addEventListener('click', clicks);
    expect(await run({ ...publish, kind: 'article-prepare' } as any)).toMatchObject({ kind: 'article-prepared' });
    expect(document.querySelector('input')!.value).toBe(publish.title); expect(clicks).not.toHaveBeenCalled();
  });
  it('stops before the final click if the editor account changes during input', async () => {
    editor(); const clicks = vi.fn(); document.querySelector('button')!.addEventListener('click', clicks);
    document.querySelector('input')!.addEventListener('input', () => document.querySelector('.name a')!.setAttribute('href', '/users/154061340'));
    expect(await run(publish)).toMatchObject({ kind: 'attention', code: 'ACCOUNT_MISMATCH', submission: 'not_attempted' });
    expect(clicks).not.toHaveBeenCalled();
  });
  it('ignores the observed global header publish dropdown while using the editor native publish button', async () => {
    editor(); document.body.insertAdjacentHTML('afterbegin', '<header class="nc-header-create"><a role="button" class="el-dropdown-selfdefine">发布</a></header>');
    const headerClick = vi.fn(); document.querySelector('header a')!.addEventListener('click', headerClick);
    expect(await run(publish)).toMatchObject({ kind: 'article-clicked' });
    expect(headerClick).not.toHaveBeenCalled();
  });
  it('ignores Slate placeholder text as well as zero-width leaves when checking for an existing draft', async () => {
    editor(); document.querySelector('[contenteditable]')!.insertAdjacentHTML('afterbegin', '<span data-slate-placeholder="true" contenteditable="false">开始输入正文</span>');
    Object.defineProperty(document.querySelector('[contenteditable]')!, 'innerText', { configurable: true, get() { return this.textContent; } });
    expect(await run(publish)).toMatchObject({ kind: 'article-clicked' });
  });
  it.each(['title', 'body'] as const)('does not alter or submit an existing different %s draft', async field => {
    editor(); const title = document.querySelector('input')!, body = document.querySelector<HTMLElement>('[contenteditable]')!;
    if (field === 'title') title.value = '用户还没写完的标题'; else body.textContent = '用户还没写完的正文';
    const original = [title.value, body.textContent], clicks = vi.fn(); document.querySelector('button')!.addEventListener('click', clicks);
    expect(await run(publish)).toMatchObject({ kind: 'attention', code: 'EXISTING_DRAFT', submission: 'not_attempted' });
    expect([title.value, body.textContent]).toEqual(original); expect(clicks).not.toHaveBeenCalled();
  });
  it('submits an exactly matching draft without inserting the body again', async () => {
    editor(); document.querySelector('input')!.value = publish.title; document.querySelector<HTMLElement>('[contenteditable]')!.textContent = publish.body;
    expect(await run(publish)).toMatchObject({ kind: 'article-clicked' }); expect(document.execCommand).not.toHaveBeenCalled();
  });
  it('requires a compilation disclosure before writing a compiled article', async () => {
    editor(); const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click);
    expect(await run({ ...publish, title: '我的字节一面', body: '这里是第一轮面试问题，agent-journey.cn' })).toMatchObject({ kind: 'attention', code: 'COMPILATION_DISCLOSURE_REQUIRED', submission: 'not_attempted' });
    expect(document.querySelector('input')!.value).toBe(''); expect(click).not.toHaveBeenCalled();
  });
  it('does not accept a partial body echo or a disabled submit button', async () => {
    editor(); const content = document.querySelector<HTMLElement>('[contenteditable]')!, button = document.querySelector('button')!;
    content.addEventListener('beforeinput', event => { event.preventDefault(); content.textContent = '备考题单'; }); button.disabled = true;
    const click = vi.fn(); button.addEventListener('click', click);
    expect(await run(publish)).toMatchObject({ kind: 'attention', code: 'COMPOSER_REJECTED', submission: 'not_attempted' }); expect(click).not.toHaveBeenCalled();
  });
  it('stops for verification during an asynchronous composer echo wait', async () => {
    editor(); document.querySelector('button')!.disabled = true;
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">验证</div>'), 150);
    expect(await run(publish)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'not_attempted', diagnostics: { verificationObservedAt: expect.any(String) } });
  });
  it('reports a challenge after the one click as uncertain without any second confirmation click', async () => {
    editor(); let clicks = 0;
    document.querySelector('button')!.addEventListener('click', () => { clicks++; document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">验证</div>'); });
    expect(await run(publish)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'uncertain', diagnostics: { submitClickedAt: expect.any(String), verificationObservedAt: expect.any(String) } }); expect(clicks).toBe(1);
  });
  it('refuses to fill a composer on a different source URL', async () => {
    editor(); vi.stubGlobal('location', new URL('https://www.nowcoder.com/discuss/999999'));
    expect(await run(publish)).toMatchObject({ kind: 'attention', code: 'SOURCE_MISMATCH', submission: 'not_attempted' });
    expect(document.querySelector('input')!.value).toBe('');
  });
  it('checks navigation again after an asynchronous Slate model update before clicking', async () => {
    editor(); const button = document.querySelector('button')!, clicks = vi.fn(); button.disabled = true; button.addEventListener('click', clicks);
    setTimeout(() => { button.disabled = false; vi.stubGlobal('location', new URL('https://www.nowcoder.com/discuss/999999')); }, 150);
    expect(await run(publish)).toMatchObject({ kind: 'attention', code: 'SOURCE_MISMATCH', submission: 'not_attempted' }); expect(clicks).not.toHaveBeenCalled();
  });
  it('ignores hidden challenge markup but stops at an actual access restriction', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal" hidden>验证</div>');
    expect(await run({ kind: 'account', expectedAccountId: '544222414' })).toMatchObject({ kind: 'account' });
    document.title = '403 Forbidden';
    expect(await run({ kind: 'account', expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code: 'ACCESS_RESTRICTED', submission: 'not_attempted' });
  });
  it('extracts a full title, full body and scoped expected author from the real detail URL', async () => {
    detail(); expect(await run(verify)).toMatchObject({ kind: 'article-published', receipt: { url: postUrl, title: publish.title, body: publish.body, accountId: '544222414', observedAt: expect.any(String) } });
  });
  it('uses the observed main-user-top author and excludes unrelated recommendation-card nicknames', async () => {
    detail();
    const owner = document.querySelector('.user-nickname')!;
    const header = document.createElement('section'); header.className = 'main-user-top'; owner.replaceWith(header); header.append(owner);
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<section class="recommendations"><div class="user-nickname"><a href="/users/1111">推荐作者</a></div></section>');
    expect(await run(verify)).toMatchObject({ kind: 'article-published', receipt: { accountId: '544222414' } });
  });
  it('accepts site-added tracking query and fragment while returning only the canonical detail URL', async () => {
    detail(); vi.stubGlobal('location', new URL(`${postUrl}?sourceSSR=users#article`));
    expect(await run(verify)).toMatchObject({ kind: 'article-published', receipt: { url: postUrl } });
  });
  it.each(['author', 'body', 'title', 'url'] as const)('rejects a foreign detail %s instead of treating an excerpt as a receipt', async field => {
    detail(field === 'author' ? '154061340' : '544222414', field === 'body' ? '备考题单' : publish.body, field === 'title' ? '另一个题目' : publish.title);
    if (field === 'url') vi.stubGlobal('location', new URL('https://www.nowcoder.com/discuss/999999'));
    expect(await run(verify)).toMatchObject({ kind: 'attention', submission: 'not_attempted' });
  });
  it('does not use an arbitrary expected-user link to override the actual foreign post author', async () => {
    detail('154061340'); document.body.insertAdjacentHTML('beforeend', '<nav><a href="/users/544222414">我</a></nav>');
    expect(await run(verify)).toMatchObject({ kind: 'attention', code: 'AUTHOR_MISMATCH' });
  });
  it('preserves word boundaries rather than accepting a body with deleted spaces', async () => {
    detail('544222414', '备考题单\nagent tool 的问题');
    expect(await run({ ...verify, body: '备考题单\nagenttool 的问题' })).toMatchObject({ kind: 'attention', code: 'ARTICLE_CONTENT_MISMATCH' });
  });
  it('does not treat an explicitly collapsed full-looking body as a complete receipt', async () => {
    detail(); document.querySelector('.feed-content-text')!.insertAdjacentHTML('beforeend', '<button class="vue-ellipsis-js-suffix">查看全文</button>');
    expect(await run(verify)).toMatchObject({ kind: 'attention', code: 'ARTICLE_INCOMPLETE' });
  });
  it('returns only one typed candidate from an owned profile and never claims its excerpt is a receipt', async () => {
    profile(); const a = document.createElement('a'); a.href = `${postUrl}?sourceSSR=users`; a.textContent = publish.title; document.body.append(a);
    expect(await run({ ...verify, postUrl: undefined } as ArticleAction)).toMatchObject({ kind: 'article-candidate', url: postUrl, identity: { userId: '544222414' } });
    const other = a.cloneNode(true) as HTMLAnchorElement; other.href = 'https://www.nowcoder.com/discuss/999999'; document.body.append(other);
    expect(await run({ kind: 'article-verify', title: publish.title, body: publish.body, expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code: 'AMBIGUOUS_ARTICLE' });
  });
  it('waits for a delayed existing article when the visible profile declares published posts', async () => {
    profile(); document.body.insertAdjacentHTML('beforeend', '<div>发布(2)</div>');
    setTimeout(() => { const link = document.createElement('a'); link.href = `${postUrl}?sourceSSR=users`; link.textContent = publish.title; document.body.append(link); }, 3500);
    expect(await run({ kind: 'article-verify', title: publish.title, body: publish.body, expectedAccountId: '544222414' })).toMatchObject({ kind: 'article-candidate', url: postUrl });
  });
  it('does not report an empty recent-post scan while a visible profile loader persists', async () => {
    profile(); document.body.insertAdjacentHTML('beforeend', '<div>发布(2)</div><div class="loading">玩命加载中</div>');
    expect(await run({ kind: 'article-verify', title: publish.title, body: publish.body, expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code: 'ARTICLE_PROFILE_NOT_READY', submission: 'not_attempted' });
  });
  it('accepts stable visible recent cards while ignoring loaders hidden elsewhere on the profile', async () => {
    profile(); document.body.insertAdjacentHTML('beforeend', '<div>发布(2)</div><a href="/discuss/999999">另外一篇文章</a><div>暂无更多内容</div><div hidden><div class="loading">玩命加载中</div></div>');
    expect(await run({ kind: 'article-verify', title: publish.title, body: publish.body, expectedAccountId: '544222414' })).toMatchObject({ kind: 'article-verified', identity: { userId: '544222414' } });
  });
  it('records a challenge that appears while detail content is still loading', async () => {
    detail(); document.querySelector('.feed-content-text')!.textContent = '';
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">验证</div>'), 200);
    expect(await run(verify)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', diagnostics: { verificationObservedAt: expect.any(String) } });
  });
  it('runs after serialization without depending on any imported runtime helper', async () => {
    const serialized = new Function(`return (${runNowcoderArticlePage.toString()})`)() as typeof runNowcoderArticlePage;
    const pending = serialized({ kind: 'account', expectedAccountId: '544222414' }); await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'account', identity: { userId: '544222414' } });
  });
});
