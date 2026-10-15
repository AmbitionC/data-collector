import { describe, expect, it } from 'vitest';
import {
  NowcoderCollectionStopError,
  NowcoderRequestPacer,
  detectNowcoderResponseStop,
} from '../../packages/bridge/src/plans/nowcoderPacing.js';

function clock() {
  let time = 1000;
  const delays: number[] = [];
  return {
    now: () => time,
    delay: async (ms: number) => { delays.push(ms); time += ms; },
    advance: (ms: number) => { time += ms; },
    delays,
  };
}

describe('Nowcoder request pacing', () => {
  it('spaces sequential requests by two seconds from actual starts', async () => {
    const fake = clock();
    const pacer = new NowcoderRequestPacer(fake);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) await pacer.run(async () => { starts.push(fake.now()); });
    expect(starts).toEqual([1000, 3000, 5000]);
    expect(fake.delays).toEqual([2000, 2000]);
  });

  it('serializes concurrent requests across search and detail operations', async () => {
    const fake = clock();
    const pacer = new NowcoderRequestPacer(fake);
    const starts: number[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all([0, 1, 2].map(() => pacer.run(async () => {
      starts.push(fake.now());
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
    })));
    expect(starts).toEqual([1000, 3000, 5000]);
    expect(peak).toBe(1);
  });

  it('does not add an extra delay after a slow request already exceeds spacing', async () => {
    const fake = clock();
    const pacer = new NowcoderRequestPacer(fake);
    await pacer.run(async () => { fake.advance(5000); });
    let secondStart = 0;
    await pacer.run(async () => { secondStart = fake.now(); });
    expect(secondStart).toBe(6000);
    expect(fake.delays).toEqual([]);
  });

  it('never sends an operation that was stopped while waiting for spacing', async () => {
    let releaseDelay!: () => void;
    const delayStarted: number[] = [];
    const starts: string[] = [];
    const stop = new NowcoderCollectionStopError('CAPTCHA_REQUIRED', '牛客需要人工验证');
    const pacer = new NowcoderRequestPacer({
      now: () => 1000,
      delay: async ms => {
        delayStarted.push(ms);
        await new Promise<void>(resolve => { releaseDelay = resolve; });
      },
    });
    await pacer.run(async () => { starts.push('search'); });
    const waiting = pacer.run(async () => { starts.push('detail'); });
    const stopped = expect(waiting).rejects.toBe(stop);
    while (delayStarted.length === 0) await Promise.resolve();
    pacer.stop(stop);
    releaseDelay();
    await stopped;
    expect(starts).toEqual(['search']);
    expect(pacer.stopped()).toBe(stop);
  });

  it('rechecks the batch guard immediately before sending after a wait', async () => {
    const starts: string[] = [];
    let allowed = true;
    let time = 1000;
    const pacer = new NowcoderRequestPacer({
      now: () => time,
      delay: async ms => { time += ms; allowed = false; },
    });
    await pacer.run(async () => { starts.push('search'); });
    await expect(pacer.run(async () => { starts.push('detail'); }, () => allowed)).rejects.toThrow('已停止');
    expect(starts).toEqual(['search']);
  });

  it('latches a typed access error before releasing the next queued operation', async () => {
    const fake = clock();
    const pacer = new NowcoderRequestPacer(fake);
    const stop = new NowcoderCollectionStopError('RATE_LIMITED', '访问过于频繁');
    const first = pacer.run(async () => { throw stop; });
    let nextSent = false;
    const next = pacer.run(async () => { nextSent = true; });
    await expect(first).rejects.toBe(stop);
    await expect(next).rejects.toBe(stop);
    expect(nextSent).toBe(false);
  });

  it('lets a later queued request proceed after an ordinary operation failure', async () => {
    const fake = clock();
    const pacer = new NowcoderRequestPacer(fake);
    const first = pacer.run(async () => { throw new Error('temporary network failure'); });
    const next = pacer.run(async () => 'saved');
    await expect(first).rejects.toThrow('temporary network failure');
    await expect(next).resolves.toBe('saved');
  });
});

describe('Nowcoder response access detection', () => {
  it('keeps the original JSON body readable after checking a cloned response', async () => {
    const response = Response.json({ success: false, code: 12345, msg: '请先登录' });
    await expect(detectNowcoderResponseStop(response)).resolves.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(response.json()).resolves.toMatchObject({ code: 12345, msg: '请先登录' });
  });

  it('detects a visible SSR login form and ignores the same form hidden by an ancestor', async () => {
    await expect(detectNowcoderResponseStop(new Response('<form action="/login">请登录</form>'))).resolves.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(detectNowcoderResponseStop(new Response('<div style="display:none"><form action="/login">请登录</form></div><article>正常面经</article>'))).resolves.toBeUndefined();
  });
});


it('does not stop a readable SSR post for an ordinary header login entry', async () => {
  const html = '<title>Agent 面经 - 牛客网</title><header><form action="/login"><input type="password"><button>登录</button></form></header>'
    + '<article class="nc-post-content">面试官让设计验证码系统，讨论限流、缓存和失败重试，然后继续问 Agent 工具调用和 RAG 召回。</article>';
  await expect(detectNowcoderResponseStop(new Response(html))).resolves.toBeUndefined();
});

it('still stops an explicit reading wall in SSR HTML even when the body remains behind it', async () => {
  await expect(detectNowcoderResponseStop(new Response('<article>' + '真实面经问题。'.repeat(10)
    + '</article><div class="login-modal">登录后查看完整面经</div>'))).resolves.toMatchObject({ code: 'AUTH_REQUIRED' });
});


it.each([['429 Too Many Requests', 'RATE_LIMITED'], ['Access Denied', 'AUTH_REQUIRED']])('stops an explicit SSR access-error title returned with HTTP 200: %s', async (title, code) => {
  await expect(detectNowcoderResponseStop(new Response(`<title>${title}</title>`))).resolves.toMatchObject({ code });
});


it.each(['opacity:0', 'content-visibility:hidden', 'visibility:collapse'])('ignores inline %s login remnants in SSR responses', async style => {
  const readable = '<article>' + '面试官讨论 Agent 工具调用、缓存和失败重试。'.repeat(8) + '</article>';
  await expect(detectNowcoderResponseStop(new Response(readable + `<div class="login-modal" style="${style}">登录后查看完整面经</div>`))).resolves.toBeUndefined();
});

it.each([['', 'AUTH_REQUIRED'], ['pointer-events:none;', undefined]])('distinguishes a covering fixed SSR login layer from a noninteractive remnant: %s', async (extra, code) => {
  const html = '<article>' + 'Agent 工具调用和失败恢复问题。'.repeat(8) + '</article>'
    + `<div class="login-modal" style="${extra}position:fixed;inset:0;z-index:9999;background:white">手机号登录<input type="tel"></div>`;
  if (code) await expect(detectNowcoderResponseStop(new Response(html))).resolves.toMatchObject({ code });
  else await expect(detectNowcoderResponseStop(new Response(html))).resolves.toBeUndefined();
});
