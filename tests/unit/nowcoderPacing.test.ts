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
