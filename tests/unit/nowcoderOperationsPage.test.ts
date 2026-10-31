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
  const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 });
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  const result = await pending;
  if (result.kind !== 'context') throw new Error(JSON.stringify(result));
  return result.snapshot;
}

describe('Nowcoder plugin page operations', () => {
  it('refuses a context result if expansion navigates away from the original source', async () => {
    vi.useFakeTimers();
    const control = document.createElement('button'); control.className = 'subcomment-more'; control.textContent = '查看回复';
    control.onclick = () => { vi.stubGlobal('location', new URL('https://www.nowcoder.com/discuss/234567')); control.textContent = '收起'; control.setAttribute('aria-busy', 'false'); };
    document.querySelector('.comment-box')!.append(control);
    const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'attention', code: 'SOURCE_MISMATCH', submission: 'not_attempted' });
  });
  it.each(['children', 'ellipsis', 'pagination'])('stops and retains the challenge if verification appears during %s loading', async mode => {
    vi.useFakeTimers();
    const challenge = () => document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">请完成验证</div>');
    if (mode === 'children') {
      const control = document.createElement('button'); control.className = 'subcomment-more'; control.textContent = '查看回复'; control.onclick = challenge;
      document.querySelector('.comment-box')!.append(control);
    } else if (mode === 'ellipsis') {
      document.querySelector('.comment-content-box')!.insertAdjacentHTML('beforeend', '<span class="vue-ellipsis-js-suffix"><span>展开</span></span>');
      document.querySelector<HTMLElement>('.vue-ellipsis-js-suffix span')!.onclick = challenge;
    } else {
      document.body.insertAdjacentHTML('beforeend', '<div class="el-pagination"><button class="btn-next">下一页</button></div>');
      document.querySelector<HTMLElement>('.btn-next')!.onclick = challenge;
    }
    const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 2 }); await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'not_attempted', diagnostics: { verificationObservedAt: expect.any(String) } });
  });
  it('records page start for a context read without inventing publication events', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-31T02:00:00.000Z');
    const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'context', diagnostics: { pageStartedAt: '2026-10-31T02:00:00.000Z' } });
    expect((await pending).diagnostics).toEqual({ pageStartedAt: '2026-10-31T02:00:00.000Z' });
  });

  it('timestamps a pre-existing visible verification challenge without editing or clicking', async () => {
    vi.useFakeTimers();
    const expected = await snapshot();
    vi.setSystemTime('2026-10-31T02:05:00.000Z');
    document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">请完成验证</div>');
    let clicks = 0; document.querySelector('button')!.addEventListener('click', () => { clicks++; });
    const result = await runNowcoderOperationPage({ kind: 'publish', url, text: '先做一个项目', expected });
    expect(result).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'not_attempted' });
    expect(result.diagnostics).toEqual({ pageStartedAt: '2026-10-31T02:05:00.000Z', verificationObservedAt: '2026-10-31T02:05:00.000Z' });
    expect(clicks).toBe(0);
    expect(document.querySelector('#nc-e-textarea-1')!.textContent).toBe('');
  });

  it('retains only page start when changed context blocks publication before the composer', async () => {
    vi.useFakeTimers();
    const expected = await snapshot();
    vi.setSystemTime('2026-10-31T02:10:00.000Z');
    document.querySelector('.feed-content-text')!.textContent = '原帖已经改了，问题已解决';
    const pending = runNowcoderOperationPage({ kind: 'publish', url, text: '先做一个项目', expected });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'attention', code: 'CONTEXT_CHANGED', submission: 'not_attempted' });
    expect((await pending).diagnostics).toEqual({ pageStartedAt: '2026-10-31T02:10:00.000Z' });
  });

  it.each([false, true])('records a post-click verification observation and stops after exactly one click, even with a visible receipt: %s', async withReceipt => {
    vi.useFakeTimers();
    const expected = await snapshot();
    vi.setSystemTime('2026-10-31T02:15:00.000Z');
    let clicks = 0, clickTime: string | undefined;
    document.querySelector('button')!.addEventListener('click', () => {
      clicks++; clickTime = new Date().toISOString();
      vi.setSystemTime('2026-10-31T02:15:10.000Z');
      document.body.insertAdjacentHTML('beforeend', '<div class="captcha-modal">请完成验证</div>');
      if (withReceipt) document.body.insertAdjacentHTML('beforeend', comment(102, '先做一个项目'));
    });
    const pending = runNowcoderOperationPage({ kind: 'publish', url, text: '先做一个项目', expected });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'uncertain' });
    expect(clicks).toBe(1);
    expect(result.diagnostics).toEqual({
      pageStartedAt: '2026-10-31T02:15:00.000Z', beforeSubmitAt: clickTime, submitClickedAt: clickTime,
      verificationObservedAt: '2026-10-31T02:15:10.000Z',
    });
  });

  it('records the actual receipt observation time independently from the click time', async () => {
    vi.useFakeTimers();
    const expected = await snapshot();
    vi.setSystemTime('2026-10-31T02:20:00.000Z');
    let clicks = 0, clickTime: string | undefined;
    document.querySelector('button')!.addEventListener('click', () => {
      clicks++; clickTime = new Date().toISOString();
      vi.setSystemTime('2026-10-31T02:20:10.000Z');
      document.body.insertAdjacentHTML('beforeend', comment(102, '先做一个项目'));
      document.querySelector('#nc-e-textarea-1')!.textContent = '';
    });
    const pending = runNowcoderOperationPage({ kind: 'publish', url, text: '先做一个项目', expected });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ kind: 'published', receipt: { observedAt: '2026-10-31T02:20:10.000Z', url: 'https://www.nowcoder.com/discuss/comment/102' } });
    expect(clicks).toBe(1);
    expect(result.diagnostics).toEqual({
      pageStartedAt: '2026-10-31T02:20:00.000Z', beforeSubmitAt: clickTime, submitClickedAt: clickTime,
      receiptObservedAt: '2026-10-31T02:20:10.000Z',
    });
  });

  it.each([
    '<div class="captcha-modal" style="display:none">请完成验证</div>',
    '<section hidden><div class="captcha-modal">请完成验证</div></section>',
    '<style>.hidden-captcha-shell { display:none }</style><section class="hidden-captcha-shell"><div class="captcha-modal">请完成验证</div></section>',
  ])('ignores hidden verification markers when collecting publication timings: %s', async marker => {
    vi.useFakeTimers();
    const expected = await snapshot();
    vi.setSystemTime('2026-10-31T02:25:00.000Z');
    document.body.insertAdjacentHTML('beforeend', marker);
    let clicks = 0;
    document.querySelector('button')!.addEventListener('click', () => {
      clicks++; document.body.insertAdjacentHTML('beforeend', comment(102, '先做一个项目'));
    });
    const pending = runNowcoderOperationPage({ kind: 'publish', url, text: '先做一个项目', expected });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ kind: 'published', diagnostics: { pageStartedAt: '2026-10-31T02:25:00.000Z' } });
    expect(result.diagnostics).not.toHaveProperty('verificationObservedAt');
    expect(clicks).toBe(1);
  });

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

  it('uses a cancelled beforeinput to update the Slate model without a second DOM insertion', async () => {
    const expected = await snapshot(), reply = '先把这个小项目做完整呗';
    const editor = document.querySelector<HTMLElement>('#nc-e-textarea-1')!, button = document.querySelector('button')!;
    editor.innerHTML = '<p data-slate-node="element"><span data-slate-leaf="true"><span data-slate-zero-width="n">\ufeff<br></span></span></p>';
    button.disabled = true;
    let model = '';
    editor.addEventListener('beforeinput', event => {
      const input = event as InputEvent;
      if (input.inputType !== 'insertText') return;
      event.preventDefault(); model = input.data ?? ''; editor.textContent = model; button.disabled = false;
    });
    button.addEventListener('click', () => { document.body.insertAdjacentHTML('beforeend', comment(102, model)); editor.textContent = ''; });
    expect(await runNowcoderOperationPage({ kind: 'publish', url, text: reply, expected })).toMatchObject({ kind: 'published', receipt: { text: reply } });
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('waits for lazy gallery references and explicitly reports unresolved images', async () => {
    const gallery = document.querySelector('.feed-img')!;
    gallery.innerHTML = '<div class="el-image"><div class="el-image__placeholder"></div></div>';
    vi.useFakeTimers();
    const pending = snapshot();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).coverage.limitations.join(' ')).toMatch(/配图.*加载/u);
  });

  it('does not label an empty gallery container as an unloaded post image', async () => {
    document.querySelector('.feed-img')!.replaceChildren();
    expect((await snapshot()).coverage.limitations).not.toContain('原帖配图尚未加载；需单独查看，不能据此判断没有配图');
  });

  it('rechecks the source and forwarding after the asynchronous editor model update', async () => {
    vi.useFakeTimers();
    for (const change of ['source', 'forward']) {
      fixture(); vi.stubGlobal('location', new URL(url));
      const expected = await snapshot(), editor = document.querySelector<HTMLElement>('#nc-e-textarea-1')!, button = document.querySelector('button')!;
      button.disabled = true;
      const click = vi.fn(); button.addEventListener('click', click);
      editor.addEventListener('beforeinput', event => {
        event.preventDefault(); editor.textContent = (event as InputEvent).data;
        setTimeout(() => {
          button.disabled = false;
          if (change === 'source') vi.stubGlobal('location', new URL('https://www.nowcoder.com/discuss/999999'));
          else (document.querySelector('input') as HTMLInputElement).checked = true;
        }, 150);
      });
      const pending = runNowcoderOperationPage({ kind: 'publish', url, text: '这条还没发送', expected });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ kind: 'attention', code: change === 'source' ? 'SOURCE_MISMATCH' : 'FORWARDING_ENABLED', submission: 'not_attempted' });
      expect(click).not.toHaveBeenCalled();
    }
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

it('waits for delayed comment totals and visible comments instead of treating an existing title as ready', async () => {
 vi.useFakeTimers(); document.querySelector('.comment-title')!.textContent = '全部评论';
 document.querySelector('.comment-box')!.remove();
 setTimeout(() => { document.querySelector('.comment-title')!.textContent = '全部评论 1'; document.body.insertAdjacentHTML('beforeend', comment(900, '稍晚加载的真实评论')); }, 700);
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 });
 await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { comments: [{ text: '稍晚加载的真实评论' }], coverage: { total: 1, observed: 1 } } });
});
it('waits for child expansion content beyond the old 300ms delay', async () => {
 vi.useFakeTimers(); document.querySelector('.subcomment-box')!.remove();
 const more = document.createElement('button'); more.className = 'subcomment-more'; more.textContent = '查看1条回复';
 more.onclick = () => { setTimeout(() => { document.querySelector('.comment-box')!.insertAdjacentHTML('beforeend', '<div class="subcomment-box"><div class="comment-content-box">迟到的楼主后续</div><a href="/discuss/comment/901">今天</a><span class="author-tag">楼主</span></div>'); more.textContent = '收起'; }, 900); };
 document.body.append(more);
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { comments: [{}, { text: '迟到的楼主后续', isAuthor: true }], coverage: { observed: 2 } } });
});
it('returns bounded structured semantic changes while ignoring likes and expansion labels', async () => {
 vi.useFakeTimers();
 const expected = await snapshot();
 document.querySelector('.feed-content-text')!.textContent = '原帖正文已修改';
 document.querySelector('.comment-box .comment-content-box')!.textContent = '评论也改变了';
 document.querySelector('.subcomment-box')!.remove();
 document.body.insertAdjacentHTML('beforeend', comment(902, '新增评论'));
 document.querySelector('.comment-title')!.textContent = '全部评论 3';
 const pending = runNowcoderOperationPage({ kind: 'publish', url, text: '先做个项目', expected }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'attention', code: 'CONTEXT_CHANGED', submission: 'not_attempted', contextChanges: { fields: ['body', 'comments', 'total'], comments: { added: ['https://www.nowcoder.com/discuss/comment/902'], removed: ['https://www.nowcoder.com/discuss/comment/101'], changed: ['https://www.nowcoder.com/discuss/comment/100'] }, total: { before: 2, after: 3 } } });
 expect(JSON.stringify(await pending)).not.toContain(expected.post.body);
});
it('preserves unknown total on a legitimate empty page and never claims complete coverage', async () => {
 vi.useFakeTimers(); document.querySelector('.comment-title')!.textContent = '全部评论'; document.querySelector('.comment-box')!.remove();
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { comments: [], coverage: { total: null, complete: false } } });
});
it('does not silently truncate a body that grows during readiness and does not accept a persistent loading marker', async () => {
 vi.useFakeTimers();
 setTimeout(() => { document.querySelector('.feed-content-text')!.textContent = '正文'.repeat(13000); }, 100);
 let pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'attention', code: 'CONTEXT_LIMIT' });
 fixture(); document.body.insertAdjacentHTML('beforeend', '<div class="comment-list" aria-busy="true">加载中</div>');
 pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'attention', code: 'CONTEXT_NOT_STABLE' });
});

it.each(['busy-control', 'replacement-placeholder'])('waits for delayed children and updated totals after an immediate control transition: %s', async mode => {
 vi.useFakeTimers(); document.querySelector('.subcomment-box')!.remove(); document.querySelector('.comment-title')!.textContent = '全部评论 1';
 const parent = document.querySelector('.comment-box')!, control = document.createElement('button'); control.className = 'subcomment-more'; control.textContent = '查看1条回复'; parent.append(control);
 control.onclick = () => {
   let live: HTMLElement = control;
   if (mode === 'replacement-placeholder') { live = document.createElement('div'); live.className = 'subcomment-more loading'; control.replaceWith(live); }
   live.textContent = mode === 'busy-control' ? '收起' : '加载中'; live.setAttribute('aria-expanded', 'true'); live.setAttribute('aria-busy', 'true');
   setTimeout(() => { parent.insertAdjacentHTML('beforeend', '<div class="subcomment-box"><div class="comment-content-box">延迟出现的楼主后续</div><a href="/discuss/comment/950">今天</a><span class="author-tag">楼主</span></div>'); live.textContent = '收起'; live.setAttribute('aria-busy', 'false'); live.classList.remove('loading'); document.querySelector('.comment-title')!.textContent = '全部评论 2'; }, 900);
 };
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { comments: [{}, { text: '延迟出现的楼主后续', isAuthor: true }], coverage: { total: 2, observed: 2, complete: true } } });
});
it('does not claim complete coverage when the child control stays busy after flipping to collapse', async () => {
 vi.useFakeTimers(); document.querySelector('.subcomment-box')!.remove(); document.querySelector('.comment-title')!.textContent = '全部评论 1';
 const control = document.createElement('button'); control.className = 'subcomment-more'; control.textContent = '查看回复';
 control.onclick = () => { control.textContent = '收起'; control.setAttribute('aria-busy', 'true'); control.setAttribute('aria-expanded', 'true'); };
 document.querySelector('.comment-box')!.append(control);
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { coverage: { complete: false, total: 1 } } });
});
it('does not use an unrelated collapsed control as completion proof for the requested expansion', async () => {
 vi.useFakeTimers(); document.querySelector('.subcomment-box')!.remove(); document.querySelector('.comment-title')!.textContent = '全部评论 1';
 const parent = document.querySelector('.comment-box')!;
 parent.insertAdjacentHTML('beforeend', '<button class="subcomment-more" aria-expanded="true" aria-busy="false">收起</button>');
 const control = document.createElement('button'); control.className = 'subcomment-more'; control.textContent = '查看回复'; parent.append(control);
 control.onclick = () => { control.textContent = '收起'; setTimeout(() => { parent.insertAdjacentHTML('beforeend', '<div class="subcomment-box"><div class="comment-content-box">目标展开的后续</div><a href="/discuss/comment/960">今天</a></div>'); document.querySelector('.comment-title')!.textContent = '全部评论 2'; }, 900); };
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { comments: [{}, { text: '目标展开的后续' }], coverage: { total: 2, complete: true } } });
});

it.each([
 '<div class="loading" style="display:none">加载中</div>',
 '<section style="display:none"><div class="loading">加载中</div></section>',
 '<style>.hidden-spinner-shell { display:none }</style><section class="hidden-spinner-shell"><div class="loading">加载中</div></section>',
 '<section hidden><div aria-busy="true">加载中</div></section>',
])('ignores persistent hidden initial loading markers without weakening semantic stability: %s', async marker => {
 vi.useFakeTimers(); document.body.insertAdjacentHTML('beforeend', `<div class="comment-list">${marker}</div>`);
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { comments: [{ text: '先做点东西' }, { text: '做过文档问答了' }], coverage: { total: 2, observed: 2, complete: true } } });
});
it('waits while initial loading is visible and proceeds only after real content stabilizes', async () => {
 vi.useFakeTimers(); document.querySelector('.comment-box')!.remove(); document.querySelector('.comment-title')!.textContent = '全部评论 0';
 document.body.insertAdjacentHTML('beforeend', '<div class="comment-list"><div class="loading">加载中</div></div>');
 setTimeout(() => { (document.querySelector('.loading') as HTMLElement).style.display = 'none'; document.querySelector('.comment-title')!.textContent = '全部评论 1'; document.body.insertAdjacentHTML('beforeend', comment(970, '加载完成才可见的真实评论')); }, 900);
 let settled = false; const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); void pending.then(() => { settled = true; });
 await vi.advanceTimersByTimeAsync(700); expect(settled).toBe(false); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'context', snapshot: { comments: [{ text: '加载完成才可见的真实评论' }], coverage: { total: 1, observed: 1, complete: true } } });
});
it('still refuses continuously changing semantic content even when loading placeholders are hidden', async () => {
 vi.useFakeTimers(); document.body.insertAdjacentHTML('beforeend', '<div class="comment-list"><div class="loading" style="display:none"></div></div>');
 for (let index = 1; index <= 70; index++) setTimeout(() => { document.querySelector('.feed-content-text')!.textContent = `正文仍在改变 ${index}`; }, index * 100);
 const pending = runNowcoderOperationPage({ kind: 'context', url, maxPages: 1 }); await vi.runAllTimersAsync();
 expect(await pending).toMatchObject({ kind: 'attention', code: 'CONTEXT_NOT_STABLE', submission: 'not_attempted' });
});
