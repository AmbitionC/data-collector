// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNowcoderOperationPage } from '../../packages/extension/src/background/nowcoderOperationsPage.js';

const url = 'https://www.nowcoder.com/discuss/123456';
const comment = (id: number, text: string, author = false) => `<div class="comment-box"><div class="comment-content-box">${text}</div><section><div class="comment-action-box"><span class="comment-action-item">点赞</span></div></section><a class="comment-publish-time" href="/discuss/comment/${id}">今天</a>${author ? '<span class="sub-box">楼主</span>' : ''}</div>`;
const fixture = () => {
  document.body.innerHTML = `<h1>求 Agent 学习方向</h1><div class="feed-content-text">学过 LangGraph，想做一个能用的项目</div><div class="feed-img"><img src="https://uploadfiles.nowcoder.com/resume.png"></div><div class="comment-title">全部评论 2</div>${comment(100, '先做点东西')}<div class="composer"><div contenteditable="true" id="nc-e-textarea-1"></div><div class="comment-editor-actions"><label><input type="checkbox">同时转发到我的动态</label><button>评论</button></div></div>`;
  const nested = document.createElement('div');
  nested.className = 'subcomment-box';
  nested.innerHTML = '<div class="comment-content-box">做过文档问答了</div><span class="author-tag">楼主</span><a class="comment-publish-time" href="/discuss/comment/101">今天</a><span class="comment-action-item">12</span>';
  document.querySelector('.comment-box')!.append(nested);
};
beforeEach(() => {
  vi.stubGlobal('location', new URL(url)); fixture();
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => {
    document.querySelector('#nc-e-textarea-1')!.textContent = value; return true;
  }) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function snapshot() {
  const result = await runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 });
  if (result.kind !== 'context') throw new Error(JSON.stringify(result));
  return result.snapshot;
}

describe('Nowcoder plugin page operations', () => {
  it('returns actual comment permalinks, nested authors, unknown likes and image references without quick replies', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div>一键发评：加油！</div>');
    const context = await snapshot();
    expect(context.comments).toHaveLength(2);
    expect(context.comments[0]).toMatchObject({ url: 'https://www.nowcoder.com/discuss/comment/100', text: '先做点东西', likes: null, isAuthor: false, parentUrl: null });
    expect(context.comments[1]).toMatchObject({ url: 'https://www.nowcoder.com/discuss/comment/101', text: '做过文档问答了', likes: 12, isAuthor: true, parentUrl: 'https://www.nowcoder.com/discuss/comment/100' });
    expect(context.post.images).toContain('https://uploadfiles.nowcoder.com/resume.png');
    expect(context.coverage).toMatchObject({ observed: 2, total: 2, hasMore: false });
  });

  it('reports page limits instead of claiming all comments were read', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="el-pagination"><button class="btn-next">下一页</button></div>');
    expect((await snapshot()).coverage).toMatchObject({ hasMore: true, complete: false, pagesRead: 1 });
  });

  it('does not call collapsed comment text complete just because comment IDs match the count', async () => {
    const body = document.querySelector('.comment-content-box')!;
    body.innerHTML = '<div class="vue-ellipsis-js"><span>这是一段没有展开的评论…</span><span class="vue-ellipsis-js-suffix"><span>展开</span></span></div>';
    const context = await snapshot();
    expect(context.coverage).toMatchObject({ observed: 2, complete: false });
    expect(context.coverage.limitations.join(' ')).toMatch(/展开|截断/u);
  });

  it('distinguishes an author reply from someone replying to the author badge', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<div class="user-nickname"><a href="/users/456">楼主名字</a></div>');
    const nested = document.querySelector('.subcomment-box')!;
    const wrapper = document.createElement('section'); wrapper.className = 'sub-box';
    nested.replaceWith(wrapper);
    wrapper.innerHTML = '<section class="sub-content-user-info"><a href="/users/789">另一个人</a>回复<a href="/users/456">楼主名字</a><span>楼主</span></section>';
    wrapper.append(nested);
    expect((await snapshot()).comments[1]?.isAuthor).toBe(false);
    wrapper.querySelector('a')!.setAttribute('href', '/users/456');
    expect((await snapshot()).comments[1]?.isAuthor).toBe(true);
  });

  it('rejects wrong pages and verification without interacting with a composer', async () => {
    vi.stubGlobal('location', new URL('https://www.nowcoder.com/discuss/987654'));
    expect(await runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 })).toMatchObject({ kind: 'attention', code: 'SOURCE_MISMATCH', submission: 'not_attempted' });
    vi.stubGlobal('location', new URL(url));
    document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">请完成验证</div>');
    expect(await runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 })).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED' });
  });

  it('does not click for stale source, existing drafts, duplicate text or forwarding', async () => {
    const expected = await snapshot();
    const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click);
    const publish = () => runNowcoderOperationPage({ kind: 'publish', url, text: '先做一个同事能用的工具呗', expected });
    document.querySelector('.feed-content-text')!.textContent = '原帖改了，已经解决';
    expect(await publish()).toMatchObject({ kind: 'attention', code: 'CONTEXT_CHANGED' });
    fixture(); document.querySelector('#nc-e-textarea-1')!.textContent = '未发出的用户编辑';
    expect(await publish()).toMatchObject({ kind: 'attention', code: 'EXISTING_DRAFT' });
    fixture(); document.querySelector('.comment-content-box')!.textContent = '先做一个同事能用的工具呗';
    expect(await publish()).toMatchObject({ kind: 'attention', submission: 'not_attempted' });
    fixture(); (document.querySelector('input') as HTMLInputElement).checked = true;
    expect(await publish()).toMatchObject({ kind: 'attention', code: 'FORWARDING_ENABLED' });
    expect(click).not.toHaveBeenCalled();
  });

  it('clicks once and returns only a newly observed exact matching permalink', async () => {
    const expected = await snapshot();
    const text = '先做一个同事能用的工具呗';
    const click = vi.fn(() => { document.body.insertAdjacentHTML('beforeend', comment(102, text)); document.querySelector('#nc-e-textarea-1')!.textContent = ''; });
    document.querySelector('button')!.addEventListener('click', click);
    const result = await runNowcoderOperationPage({ kind: 'publish', url, text, expected });
    expect(result).toMatchObject({ kind: 'published', receipt: { url: 'https://www.nowcoder.com/discuss/comment/102', text, sourceUrl: url } });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('excludes expansion controls from context and from a newly observed publication receipt', async () => {
    const full = '这是一段需要展开才能读完的正文，收起只是正文里一个正常的词';
    const body = document.querySelector('.comment-content-box')!;
    body.innerHTML = '<div class="vue-ellipsis-js"><span class="vue-ellipsis-js-content">前半段…</span><span class="vue-ellipsis-js-suffix"><span>展开</span></span></div>';
    body.querySelector('.vue-ellipsis-js-suffix span')!.addEventListener('click', () => {
      body.querySelector('.vue-ellipsis-js-content')!.textContent = full;
      body.querySelector('.vue-ellipsis-js-suffix')!.textContent = '收起';
    });
    const expected = await snapshot();
    expect(expected.comments[0]?.text).toBe(full);
    expect(expected.coverage.complete).toBe(true);
    const reply = '另一个完整回复，里面也可以写收起';
    document.querySelector('button')!.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', comment(102, `<span class="vue-ellipsis-js-content">${reply}</span><span class="vue-ellipsis-js-suffix">收起</span>`));
      document.querySelector('#nc-e-textarea-1')!.textContent = '';
    });
    expect(await runNowcoderOperationPage({ kind: 'publish', url, text: reply, expected })).toMatchObject({ kind: 'published', receipt: { text: reply } });
  });

  it('returns uncertain after a click without an observed new comment, never clicks again', async () => {
    vi.useFakeTimers();
    const expected = await snapshot(), click = vi.fn();
    document.querySelector('button')!.addEventListener('click', click);
    const pending = runNowcoderOperationPage({ kind: 'publish', url, text: '这条暂时没有回执', expected });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await pending).toMatchObject({ kind: 'attention', submission: 'uncertain' });
    expect(click).toHaveBeenCalledTimes(1);
  });
});
