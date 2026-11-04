import { afterEach, describe, expect, it, vi } from 'vitest';
import { NowcoderOperationsRunner } from '../../packages/extension/src/background/nowcoderOperations.js';

const action = { kind: 'context' as const, url: 'https://www.nowcoder.com/discuss/123456', maxPages: 1 };
afterEach(() => vi.useRealTimers());
describe('plugin operation owned tabs', () => {
  it('returns the original click checkpoint before a stalled script can strand the operation indefinitely', async () => {
    vi.useFakeTimers();
    let executionId = '', resolveExecution!: (value: unknown) => void, settled = false;
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 77 }), wait: async () => undefined,
      execute: async (_id, _action, nonce) => { executionId = nonce; return new Promise(resolve => { resolveExecution = resolve; }); },
      readProgress: async () => ({ executionId, actionKind: 'publish', url: action.url, pageStage: 'wait_receipt',
        diagnostics: { pageStartedAt: '2026-11-04T12:01:04.257Z', submitClickedAt: '2026-11-04T12:01:10.553Z' } }),
      close: async () => { throw new Error('A pending original page must be preserved'); }, handoff: async () => undefined });
    const publish = { kind: 'publish' as const, url: action.url, text: '先做一个项目', expected: { sourceUrl: action.url,
      readAt: '2026-11-04T12:00:00.000Z', post: { title: '项目', body: '讨论项目', images: [] }, comments: [],
      coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } };
    const pending = runner.run(publish); void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(70_000);
    try {
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ code: 'OPERATION_DEADLINE_EXCEEDED', submission: 'uncertain',
        diagnostics: { submitClickedAt: '2026-11-04T12:01:10.553Z' },
        failure: { stage: 'execute_script', pageStage: 'wait_receipt', clickState: 'invoked' } });
      expect(runner.busy).toBe(false);
    } finally { resolveExecution({ kind: 'attention', code: 'RECEIPT_NOT_OBSERVED', message: '未观察到回执', submission: 'uncertain' }); await pending; }
  });

  it('does not inject a late script after the owned page misses its load deadline', async () => {
    vi.useFakeTimers();
    let release!: () => void, settled = false, executions = 0;
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 78 }), wait: () => new Promise(resolve => { release = resolve; }),
      execute: async () => { executions++; return { kind: 'attention', code: 'TEST_DONE', message: '读取完成', submission: 'not_attempted' }; },
      close: async () => undefined, handoff: async () => undefined });
    const pending = runner.run(action); void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(70_000);
    try {
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ code: 'OPERATION_DEADLINE_EXCEEDED', submission: 'not_attempted', failure: { stage: 'wait_tab', clickState: 'not_attempted' } });
    } finally { release(); await pending; }
    expect(executions).toBe(0);
  });

  it('keeps a pre-injection deadline rejection explicitly not attempted when the load completes after a clock jump', async () => {
    vi.useFakeTimers();
    let executions = 0;
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 79 }),
      wait: async () => { vi.setSystemTime(Date.now() + 120_000); },
      execute: async () => { executions++; throw new Error('Expired work must never execute'); },
      close: async () => undefined, handoff: async () => undefined });
    const result = await runner.run({ kind: 'publish', url: action.url, text: '先做一个项目', expected: { sourceUrl: action.url,
      readAt: '2026-11-04T12:00:00.000Z', post: { title: '项目', body: '讨论项目', images: [] }, comments: [],
      coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } });
    expect(result).toMatchObject({ code: 'OPERATION_DEADLINE_EXCEEDED', submission: 'not_attempted', failure: { clickState: 'not_attempted' } });
    expect(executions).toBe(0);
  });

  it('bounds a missing checkpoint read and keeps the click unknown instead of declaring it unsent', async () => {
    vi.useFakeTimers();
    let settled = false;
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 80 }), wait: async () => undefined,
      execute: async () => new Promise(() => undefined), readProgress: async () => new Promise(() => undefined),
      close: async () => { throw new Error('Keep original'); }, handoff: async () => new Promise(() => undefined) });
    const pending = runner.run({ kind: 'publish', url: action.url, text: '先做一个项目', expected: { sourceUrl: action.url,
      readAt: '2026-11-04T12:00:00.000Z', post: { title: '项目', body: '讨论项目', images: [] }, comments: [],
      coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } });
    void pending.then(() => { settled = true; }); await vi.advanceTimersByTimeAsync(70_000);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ submission: 'uncertain', failure: { clickState: 'unknown' } });
    expect((await pending).diagnostics).toBeUndefined();
    expect(runner.busy).toBe(false);
  });

  it('hands off a late-created owned tab without injecting any abandoned work', async () => {
    vi.useFakeTimers();
    let release!: (tab: { id: number }) => void, executions = 0;
    const handedOff: number[] = [];
    const runner = new NowcoderOperationsRunner({ create: () => new Promise(resolve => { release = resolve; }), wait: async () => undefined,
      execute: async () => { executions++; throw new Error('Abandoned work'); },
      close: async () => undefined, handoff: async id => { handedOff.push(id); } });
    const pending = runner.run(action); await vi.advanceTimersByTimeAsync(70_000);
    expect(await pending).toMatchObject({ code: 'OPERATION_DEADLINE_EXCEEDED', submission: 'not_attempted', failure: { stage: 'create_tab' } });
    release({ id: 81 }); for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(handedOff).toEqual([81]); expect(executions).toBe(0);
  });

  it('retains an actually observed verification pause when the execution result is lost', async () => {
    let executionId = '';
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 77 }), wait: async () => undefined,
      execute: async (_id, _action, nonce) => { executionId = nonce; throw new Error('result lost'); },
      readProgress: async () => ({ executionId, actionKind: 'context', url: action.url, pageStage: 'read_context',
        diagnostics: { pageStartedAt: '2026-11-01T10:00:00.000Z', verificationObservedAt: '2026-11-01T10:00:01.000Z' } }),
      close: async () => undefined, handoff: async () => undefined });
    expect(await runner.run(action)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'not_attempted',
      diagnostics: { verificationObservedAt: '2026-11-01T10:00:01.000Z' }, failure: { stage: 'execute_script' } });
  });
  it.each(['create_tab', 'wait_tab', 'execute_script', 'parse_result'] as const)('retains the actual %s failure without leaking credentials or calling it verification', async stage => {
    const fault = new TypeError('browser failed\nAuthorization: Bearer secret-token\nCookie: sid=secret-cookie\nURL=https://example.test/task?token=secret-url');
    const runner = new NowcoderOperationsRunner({
      create: async () => { if (stage === 'create_tab') throw fault; return { id: 77 }; },
      wait: async () => { if (stage === 'wait_tab') throw fault; },
      execute: async () => { if (stage === 'execute_script') throw fault; return { kind: 'unrecognized' }; },
      close: async () => undefined, handoff: async () => undefined,
    });
    const result = await runner.run(action);
    expect(result).toMatchObject({ kind: 'attention', code: 'EXTENSION_OPERATION_FAILED', submission: 'not_attempted',
      failure: { stage, clickState: 'not_attempted', error: { name: stage === 'parse_result' ? 'ZodError' : 'TypeError' } } });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|secret-cookie|secret-url/u);
    if (stage !== 'parse_result') expect(JSON.stringify(result)).toContain('https://example.test/task');
    expect(result.diagnostics).toBeUndefined();
  });

  it('retains a bound click checkpoint after executeScript loses its result and never retries the click', async () => {
    let executionId = '', executions = 0, closed = false;
    const diagnostics = { pageStartedAt: '2026-11-01T10:00:00.000Z', beforeSubmitAt: '2026-11-01T10:00:01.000Z', submitClickedAt: '2026-11-01T10:00:01.001Z' };
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 77 }), wait: async () => undefined,
      execute: async (_id, _action, nonce) => { executionId = nonce!; executions++; throw new Error('execution context lost'); },
      readProgress: async () => ({ executionId, actionKind: 'publish', url: action.url, pageStage: 'wait_receipt', diagnostics }),
      close: async () => { closed = true; }, handoff: async () => { throw new Error('window closed'); },
    });
    const result = await runner.run({ kind: 'publish', url: action.url, text: '先做一个项目', expected: { sourceUrl: action.url,
      readAt: '2026-11-01T09:59:00.000Z', post: { title: '项目', body: '讨论项目', images: [] }, comments: [],
      coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } });
    expect(result).toMatchObject({ kind: 'attention', submission: 'uncertain', diagnostics,
      failure: { stage: 'execute_script', pageStage: 'wait_receipt', clickState: 'invoked', error: { message: 'execution context lost' } } });
    expect(executions).toBe(1);
    expect(closed).toBe(false);
  });

  it('ignores a checkpoint from another operation instead of inventing click evidence', async () => {
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 77 }), wait: async () => undefined,
      execute: async () => { throw new Error('context lost'); },
      readProgress: async () => ({ executionId: '00000000-0000-4000-8000-000000000000', actionKind: 'context', url: action.url,
        pageStage: 'wait_receipt', diagnostics: { pageStartedAt: '2026-11-01T10:00:00.000Z', submitClickedAt: '2026-11-01T10:00:01.000Z' } }),
      close: async () => undefined, handoff: async () => undefined });
    const result = await runner.run(action);
    expect(result).toMatchObject({ kind: 'attention', failure: { stage: 'execute_script', clickState: 'not_attempted' } });
    expect(result.diagnostics).toBeUndefined();
  });

  it('preserves a verification result and its owned page when showing the handoff fails', async () => {
    const close = vi.fn(async () => undefined), handoff = vi.fn(async () => { throw new Error('window no longer focused'); });
    const diagnostics = { pageStartedAt: '2026-10-31T10:00:00.000Z', verificationObservedAt: '2026-10-31T10:00:01.000Z' };
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 77 }), close, handoff, wait: async () => undefined,
      execute: async () => ({ kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '牛客要求验证', submission: 'not_attempted', diagnostics }) });
    expect(await runner.run(action)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', diagnostics, tabUrl: action.url });
    expect(close).not.toHaveBeenCalled(); expect(handoff).toHaveBeenCalledTimes(1);
  });
  it('owns an inactive tab, waits for load, and hands verification to the user without closing it', async () => {
    const create = vi.fn(async () => ({ id: 77 })), close = vi.fn(async () => undefined), handoff = vi.fn(async () => undefined), wait = vi.fn(async () => undefined);
    const runner = new NowcoderOperationsRunner({ create, close, handoff, wait,
      execute: async () => ({ kind: 'attention', code: 'LOGIN_REQUIRED', message: '请登录', submission: 'not_attempted' }) });
    expect(await runner.run(action)).toMatchObject({ kind: 'attention', tabUrl: action.url });
    expect(create).toHaveBeenCalledWith(action.url);
    expect(wait).toHaveBeenCalledWith(77);
    expect(handoff).toHaveBeenCalledWith(77, action.url);
    expect(close).not.toHaveBeenCalled();
    expect(runner.busy).toBe(false);
  });

  it('does not run a second operation while the first tab is active and always closes successful reads', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn(async () => undefined);
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 78 }), close, handoff: vi.fn(async () => undefined), wait: () => wait,
      execute: async () => ({ kind: 'context', snapshot: { sourceUrl: action.url, readAt: new Date().toISOString(),
        post: { title: '求方向', body: '项目不知道怎么做', images: [] }, comments: [], coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } }) });
    const first = runner.run(action);
    expect(runner.busy).toBe(true);
    expect(await runner.run(action)).toMatchObject({ kind: 'attention', code: 'OPERATIONS_BUSY', submission: 'not_attempted' });
    release(); await first;
    expect(close).toHaveBeenCalledWith(78);
  });
});
