import type { NowcoderConversationSnapshot, NowcoderOperationAction, NowcoderOperationResult } from '@data-collector/shared';

/** Serialized by chrome.scripting: all runtime helpers must remain inside this function. */
export async function runNowcoderOperationPage(action: NowcoderOperationAction): Promise<NowcoderOperationResult> {
  let clicked = false;
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const normalized = (value: string) => value.replace(/[\s\u200b-\u200d\ufeff]+/gu, '').normalize('NFKC');
  const text = (node: Element | null) => ((node as HTMLElement | null)?.innerText ?? node?.textContent ?? '').trim();
  const attention = (code: string, message: string): NowcoderOperationResult => ({ kind: 'attention', code, message, submission: clicked ? 'uncertain' : 'not_attempted' });
  const visible = (node: Element) => {
    if (node.closest('[hidden],[aria-hidden="true"],.tw-hidden')) return false;
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      if ((parent as HTMLElement).style?.display === 'none' || (parent as HTMLElement).style?.visibility === 'hidden') return false;
    }
    return getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  };
  const canonical = (value: string) => { const u = new URL(value, location.href); return `${u.origin}${u.pathname.replace(/\/$/u, '')}`; };
  const challenge = () => {
    if ([...document.querySelectorAll('.captcha-modal,.nc-captcha-modal,.captcha-container,#captcha,.geetest_panel,.geetest_widget,.yidun_panel,.verify-dialog')].some(visible)
      || /^(安全验证|人机验证|访问验证|Access Verification|Security Verification)/iu.test(document.title)) return attention('VERIFICATION_REQUIRED', '牛客要求验证，请在保留的页面完成验证');
    if ([...document.querySelectorAll('.login-modal,.nc-login-modal,[class*="login-container"],form[action*="login"]')].some(visible)) return attention('LOGIN_REQUIRED', '牛客登录已失效，请在保留的页面登录');
    if (/^(403|429|Forbidden|Access Denied|请求过于频繁|访问被拒绝)/iu.test(document.title)) return attention('ACCESS_RESTRICTED', '牛客限制了当前访问，操作已停止');
    return undefined;
  };
  const images = (root: Element | null, limit: number) => [...new Set([...root?.querySelectorAll<HTMLImageElement>('img') ?? []]
    .map(img => [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original')].find(src => src && /^https:\/\//u.test(src)))
    .filter((src): src is string => Boolean(src)))].slice(0, limit);
  const permalink = (node: Element) => [...node.querySelectorAll<HTMLAnchorElement>('a[href*="/discuss/comment/"]')]
    .find(a => a.closest('.subcomment-box,.comment-box') === node && /^https:\/\/www\.nowcoder\.com\/discuss\/comment\/\d+$/u.test(canonical(a.getAttribute('href')!)));
  const readComments = (): NowcoderConversationSnapshot['comments'] => {
    const output: NowcoderConversationSnapshot['comments'] = [];
    const postAuthor = document.querySelector<HTMLAnchorElement>('.user-nickname a[href*="/users/"]')?.getAttribute('href');
    for (const node of document.querySelectorAll('.comment-box,.subcomment-box')) {
      if (!visible(node)) continue;
      const link = permalink(node); if (!link) continue;
      const own = (selector: string) => [...node.querySelectorAll(selector)].filter(item => item.closest('.subcomment-box,.comment-box') === node);
      const body = own('.comment-content-box')[0];
      if (!body) continue;
      const content = body.querySelector('.vue-ellipsis-js-content') ?? body;
      const parent = node.parentElement?.closest('.comment-box');
      const parentLink = parent ? permalink(parent) : undefined;
      const likeLabel = text(own('.comment-action-item')[0] ?? null).replace(/\s+/gu, '');
      const likeMatch = likeLabel.match(/^(?:点赞)?(\d+)(?:赞)?$/u);
      const authorScope = node.classList.contains('subcomment-box')
        ? node.parentElement?.querySelector(':scope > .sub-content-user-info')
        : node.querySelector('.content-user-info');
      const authorLink = authorScope?.querySelector<HTMLAnchorElement>('a[href*="/users/"]')?.getAttribute('href');
      output.push({ url: canonical(link.getAttribute('href')!), parentUrl: parentLink ? canonical(parentLink.getAttribute('href')!) : null,
        text: text(content).slice(0, 5000), images: images(content, 12),
        isAuthor: Boolean(postAuthor && authorLink ? canonical(authorLink) === canonical(postAuthor)
          : own('.author-tag,.is-author').some(item => /楼主/u.test(text(item)))),
        likes: likeMatch ? Number(likeMatch[1]) : null });
    }
    return output;
  };
  const fingerprint = (comments: NowcoderConversationSnapshot['comments']) => JSON.stringify(comments.map(c => [c.url, c.parentUrl, normalized(c.text), c.images, c.isAuthor]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  // Wait for semantic fingerprints, excluding likes/counters inside action controls.
  const settle = async (probe: () => string, minimumMs: number, maximumMs: number, changedFrom?: string, ready: () => boolean = () => true): Promise<boolean> => {
    const start = Date.now(); let previous = probe(), stableAt = start;
    while (Date.now() - start < maximumMs) {
      const blocked = challenge(); if (blocked) return false;
      await pause(100);
      const current = probe(); if (current !== previous) { stableAt = Date.now(); previous = current; }
      if (Date.now() - start >= minimumMs && Date.now() - stableAt >= 400 && (changedFrom === undefined || current !== changedFrom) && ready()) return true;
    }
    return false;
  };
  try {
    if (canonical(location.href) !== action.url) return attention('SOURCE_MISMATCH', '当前页不是指定原帖，未进行操作');
    let blocked = challenge(); if (blocked) return blocked;
    let body: Element | null = null, title = '';
    for (let i = 0; i < 40; i++) {
      body = document.querySelector('.feed-content-text,.nc-slate-editor-content,.post-topic-des,.nc-post-content');
      title = text(document.querySelector('h1,.post-title,.discuss-title'));
      if (body && text(body) && title && document.querySelector('.comment-title')) break;
      blocked = challenge(); if (blocked) return blocked;
      await pause(250);
    }
    if (!body || !title || !text(body)) return attention('POST_NOT_READY', '正文未完整加载，未进行操作');
    if (text(body).length > 24_000 || title.length > 500) return attention('CONTEXT_LIMIT', '原帖超过有界读取范围，未截断冒充全文');
    const readiness = () => JSON.stringify([text(document.querySelector('h1,.post-title,.discuss-title')), text(document.querySelector('.feed-content-text,.nc-slate-editor-content,.post-topic-des,.nc-post-content')), text(document.querySelector('.comment-title')), fingerprint(readComments()), Boolean(document.querySelector('.comment-list .loading,.comment-list [aria-busy="true"],.comment-list[aria-busy="true"]'))]);
    const initialTotal = text(document.querySelector('.comment-title')).match(/\d+/u);
    if (!await settle(readiness, initialTotal ? (Number(initialTotal[0]) === 0 ? 1000 : 500) : 2000, 5000, undefined, () => !document.querySelector('.comment-list .loading,.comment-list [aria-busy="true"],.comment-list[aria-busy="true"]'))) {
      blocked = challenge(); if (blocked) return blocked;
      return attention('CONTEXT_NOT_STABLE', '原帖或评论仍在变化，未读取稳定语境，请稍后重试');
    }
    title = text(document.querySelector('h1,.post-title,.discuss-title'));
    body = document.querySelector('.feed-content-text,.nc-slate-editor-content,.post-topic-des,.nc-post-content');
    if (!body || !title || !text(body)) return attention('POST_NOT_READY', '正文仍未就绪');
    if (text(body).length > 24_000 || title.length > 500) return attention('CONTEXT_LIMIT', '原帖超过有界读取范围，未截断冒充全文');
    const readTotal = () => { const match = text(document.querySelector('.comment-title')).match(/\d+/u); return match ? Number(match[0]) : null; };
    let total = readTotal();
    const gallery = document.querySelector('.feed-img,.feed-content-imgs');
    const galleryHasSlots = Boolean(gallery?.querySelector('.el-image,img'));
    if (gallery && galleryHasSlots && !images(gallery, 30).length) {
      gallery.scrollIntoView?.({ block: 'center' });
      const deadline = Date.now() + 2000;
      while (!images(gallery, 30).length && Date.now() < deadline) await pause(100);
    }
    const post = { title: title.slice(0, 500), body: text(body).slice(0, 24_000), images: [...new Set([...images(body, 30), ...images(document.querySelector('.feed-img,.feed-content-imgs'), 30)])].slice(0, 30) };
    const comments = new Map<string, NowcoderConversationSnapshot['comments'][number]>();
    const maxPages = action.kind === 'context' ? action.maxPages : action.expected.coverage.pagesRead;
    let pagesRead = 0, hasMore = false, textIncomplete = false;
    const limitations: string[] = [];
    if (gallery && galleryHasSlots && !images(gallery, 30).length) limitations.push('原帖配图尚未加载；需单独查看，不能据此判断没有配图');
    for (let page = 0; page < maxPages; page++) {
      if (page === 0 && (total ?? 0) > 0) {
        for (let i = 0; i < 20 && readComments().length === 0; i++) await pause(250);
      }
      const childScopes = new Set<Element>();
      const loading = (scope: Element) => [scope, ...scope.querySelectorAll('[aria-busy="true"],.loading,.is-loading,.el-loading-mask,[role="progressbar"],.subcomment-more')]
        .some(node => visible(node) && (node.getAttribute('aria-busy') === 'true' || node.matches('.loading,.is-loading,.el-loading-mask,[role="progressbar"]')
          || (node.matches('.subcomment-more') && /^(?:正在加载|加载中|loading)[\s.。…]*$/iu.test(text(node)))));
      const expanded = new Set<Element>();
      for (let i = 0; i < 6; i++) {
        const more = [...document.querySelectorAll<HTMLElement>('.subcomment-more')].find(node => visible(node) && !/收起/u.test(text(node)) && !expanded.has(node));
        if (!more) break;
        const owner = more.closest('.comment-box'), scope = owner ?? more.parentElement ?? document.body;
        childScopes.add(scope);
        const ownerLink = owner ? permalink(owner) : undefined;
        const ownerUrl = ownerLink ? canonical(ownerLink.getAttribute('href')!) : undefined;
        const beforeUrls = new Set(readComments().map(comment => comment.url));
        const controls = () => [...scope.querySelectorAll('.subcomment-more')].filter(visible);
        const priorControls = new Set(controls());
        const expansion = () => JSON.stringify([fingerprint(readComments()), readTotal(), controls().map(node => [text(node), node.getAttribute('aria-expanded'), node.getAttribute('aria-busy')]), loading(scope)]);
        const ready = () => !loading(scope) && (readComments().some(comment => !beforeUrls.has(comment.url) && (!ownerUrl || comment.parentUrl === ownerUrl))
          || controls().some(node => (node === more || !priorControls.has(node)) && node.getAttribute('aria-busy') === 'false' && (node.getAttribute('aria-expanded') === 'true' || /收起/u.test(text(node)))));
        const before = expansion(); expanded.add(more); more.click();
        if (!await settle(expansion, 400, 3000, before, ready)) { textIncomplete = true; limitations.push('子回复展开仍在加载或未观察到真实内容/明确完成状态'); }
      }
      const ellipses = [...document.querySelectorAll<HTMLElement>('.comment-box .vue-ellipsis-js-suffix,.subcomment-box .vue-ellipsis-js-suffix')].filter(visible);
      for (const suffix of ellipses.slice(0, 20)) {
        if (!/展开/u.test(text(suffix))) continue;
        const control = suffix.querySelector<HTMLElement>('span'); const before = fingerprint(readComments()); control?.click();
        if (control && !await settle(() => fingerprint(readComments()), 400, 2000, before)) textIncomplete = true;
      }
      if (ellipses.some(node => visible(node) && /展开/u.test(text(node)))) textIncomplete = true;
      // Expansion can replace its control and update the total after the first render.
      // Stabilize live comments + current total together, never reuse the pre-expansion count.
      const pageReady = () => [...childScopes].every(scope => !loading(scope));
      if (!await settle(() => JSON.stringify([fingerprint(readComments()), readTotal(), pageReady()]), 400, 3000, undefined, pageReady)) {
        textIncomplete = true; limitations.push('评论或总数在展开后尚未稳定');
      }
      total = readTotal();
      for (const comment of readComments()) {
        if (comment.text.length >= 5000) textIncomplete = true;
        if (comments.size < 200) comments.set(comment.url, comment);
      }
      pagesRead++;
      const next = document.querySelector<HTMLButtonElement>('.el-pagination .btn-next');
      const nextEnabled = Boolean(next && !next.disabled && next.getAttribute('aria-disabled') !== 'true' && !next.classList.contains('disabled'));
      const moreChildren = [...document.querySelectorAll('.subcomment-more')].some(node => visible(node) && !/收起/u.test(text(node)));
      hasMore = nextEnabled || moreChildren || !pageReady() || (total !== null && comments.size < total);
      if (!nextEnabled || page + 1 >= maxPages || comments.size >= 200) break;
      const before = fingerprint(readComments()); next!.click();
      let changed = false;
      for (let i = 0; i < 20; i++) { await pause(200); if (fingerprint(readComments()) !== before) { changed = true; break; } }
      if (!changed || !await settle(() => fingerprint(readComments()), 400, 2000)) { limitations.push('下一页未完成加载'); textIncomplete = true; break; }
    }
    if (post.images.length) limitations.push('图片仅返回引用，需单独查看后才能判断图片内容');
    if (textIncomplete) limitations.push('部分长评论仍未展开或达到文本截断上限');
    if (hasMore) limitations.push('达到有界读取范围，仍有未读评论或子回复');
    if (total === null) limitations.push('页面未提供可确认的评论总数');
    const snapshot: NowcoderConversationSnapshot = { sourceUrl: action.url, readAt: new Date().toISOString(), post, comments: [...comments.values()],
      coverage: { total, observed: comments.size, pagesRead, hasMore, complete: !hasMore && !textIncomplete && total !== null && comments.size === total, limitations } };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 1_400_000) return attention('CONTEXT_LIMIT', '评论上下文超过私有载荷上限，请缩小读取范围');
    if (action.kind === 'context') return { kind: 'context', snapshot };
    if (canonical(location.href) !== action.url) return attention('SOURCE_MISMATCH', '页面已离开指定原帖，未发送');
    if (normalized(post.title) !== normalized(action.expected.post.title) || normalized(post.body) !== normalized(action.expected.post.body)
      || JSON.stringify(post.images) !== JSON.stringify(action.expected.post.images)
      || fingerprint(snapshot.comments) !== fingerprint(action.expected.comments) || total !== action.expected.coverage.total) {
      const fields: Array<'title' | 'body' | 'images' | 'comments' | 'total'> = [];
      if (normalized(post.title) !== normalized(action.expected.post.title)) fields.push('title');
      if (normalized(post.body) !== normalized(action.expected.post.body)) fields.push('body');
      if (JSON.stringify(post.images) !== JSON.stringify(action.expected.post.images)) fields.push('images');
      if (fingerprint(snapshot.comments) !== fingerprint(action.expected.comments)) fields.push('comments');
      if (total !== action.expected.coverage.total) fields.push('total');
      const oldComments = new Map(action.expected.comments.map(c => [c.url, c])), newComments = new Map(snapshot.comments.map(c => [c.url, c]));
      const added = [...newComments.keys()].filter(url => !oldComments.has(url)), removed = [...oldComments.keys()].filter(url => !newComments.has(url));
      const changed = [...newComments.keys()].filter(url => oldComments.has(url) && fingerprint([oldComments.get(url)!]) !== fingerprint([newComments.get(url)!]));
      return { kind: 'attention', code: 'CONTEXT_CHANGED', message: '原帖或评论已有变化，请重新读取和审阅草稿', submission: 'not_attempted',
        contextChanges: { fields, comments: { added: added.slice(0, 30), removed: removed.slice(0, 30), changed: changed.slice(0, 30), truncated: [added, removed, changed].some(a => a.length > 30) }, total: { before: action.expected.coverage.total, after: total } } };
    }
    if (snapshot.comments.some(comment => normalized(comment.text) === normalized(action.text))) return attention('DUPLICATE_TEXT', '已有相同评论，未再次发送');
    const editor = document.querySelector<HTMLElement>('#nc-e-textarea-1[contenteditable="true"]');
    if (!editor || !visible(editor)) return attention('COMPOSER_UNAVAILABLE', '未找到可用的主评论编辑器，请确认登录状态');
    if (text(editor)) return attention('EXISTING_DRAFT', '编辑器已有内容，未覆盖或发送');
    let scope: Element | null = editor.parentElement, button: HTMLElement | undefined;
    for (let i = 0; i < 6 && scope && scope !== document.body; i++, scope = scope.parentElement) {
      const candidates = [...scope.querySelectorAll<HTMLElement>('button,[role="button"],.nc-button')].filter(node => text(node) === '评论' && visible(node));
      if (candidates.length === 1) { button = candidates[0]; break; }
      if (candidates.length > 1) break;
    }
    if (!button || !scope) return attention('COMPOSER_UNAVAILABLE', '无法唯一确认主评论提交按钮');
    if ([...scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].some(input => input.checked && /同时转发/u.test(text(input.closest('label') ?? input.parentElement)))) return attention('FORWARDING_ENABLED', '同时转发已开启，未发送');
    editor.focus();
    // Slate handles beforeinput by cancelling the browser edit and updating its own model.
    // execCommand alone can change its zero-width DOM leaf while leaving that model empty.
    const selection = window.getSelection(), range = document.createRange();
    const leaf = editor.querySelector('[data-slate-zero-width]') ?? editor.querySelector('[data-slate-leaf]');
    const point = leaf?.firstChild;
    if (point?.nodeType === Node.TEXT_NODE) range.setStart(point, point.textContent?.length ?? 0);
    else range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges(); selection?.addRange(range);
    const targetRanges = typeof StaticRange === 'function' ? [new StaticRange(range)] : [];
    const beforeInput = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: action.text, targetRanges });
    const browserEdit = editor.dispatchEvent(beforeInput);
    if (browserEdit && !document.execCommand('insertText', false, action.text)) return attention('COMPOSER_REJECTED', '编辑器未接受文本输入，未点击发送');
    const ready = () => normalized(text(editor)) === normalized(action.text) && button!.getAttribute('aria-disabled') !== 'true'
      && !(button as HTMLButtonElement).disabled && !button!.classList.contains('disabled') && !button!.classList.contains('is-disabled');
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) await pause(100);
    blocked = challenge(); if (blocked) return blocked;
    if (!ready()) return attention('COMPOSER_REJECTED', '编辑器未接受草稿，未点击发送');
    if (canonical(location.href) !== action.url) return attention('SOURCE_MISMATCH', '输入期间页面离开原帖，未点击发送');
    if (!editor.isConnected || !button.isConnected) return attention('COMPOSER_UNAVAILABLE', '输入期间编辑器已被替换，未点击发送');
    if ([...scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].some(input => input.checked && /同时转发/u.test(text(input.closest('label') ?? input.parentElement)))) return attention('FORWARDING_ENABLED', '输入期间同时转发被开启，未点击发送');
    const before = new Set(snapshot.comments.map(comment => comment.url));
    clicked = true; button.click();
    for (let i = 0; i < 60; i++) {
      if (canonical(location.href) !== action.url) return attention('SOURCE_MISMATCH', '点击后页面离开原帖，发送结果待核验');
      const observed = readComments().find(comment => !before.has(comment.url) && normalized(comment.text) === normalized(action.text));
      if (observed) return { kind: 'published', receipt: { sourceUrl: action.url, url: observed.url, text: action.text, observedAt: new Date().toISOString() } };
      blocked = challenge(); if (blocked) return blocked;
      await pause(200);
    }
    return attention('RECEIPT_NOT_OBSERVED', '已点击一次，但未观察到新评论链接；请核验，禁止自动重发');
  } catch {
    return attention('PAGE_OPERATION_FAILED', clicked ? '发送结果不确定，请核验，禁止自动重发' : '页面操作失败，未点击发送');
  }
}
