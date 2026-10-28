// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindOperations } from '../../packages/extension/src/sidepanel/operations.js';

const sourceId = 'abcdef123456';
const entry = {
  schemaVersion: 1, visibility: 'private', id: 'ops-abcdef123456', sourceId,
  canonicalUrl: 'https://www.nowcoder.com/discuss/123456', title: '学了LangGraph，下一步做什么？',
  body: '学了LangGraph，下一步做什么？', contextHash: 'a'.repeat(64), revision: 2, status: 'drafted',
  collectedAt: '2026-10-28T06:00:00.000Z', createdAt: '2026-10-28T06:00:00.000Z', updatedAt: '2026-10-28T06:00:00.000Z', note: '',
  assessment: { fit: 'high', intent: 'learning', angle: '接住框架越学越多、项目却没落地的困惑。', reason: '有明确Agent项目求助。', limitations: ['未读取评论。'] },
  drafts: { primary: '先别给收藏夹进货了，挑一个能验收的小场景做完。', alternative: '框架先歇会儿，给已有项目补个失败重试，做完就有东西可聊了。', tone: 'light_humor', anchor: 'LangGraph', notes: '正文已足够回答，不引流。' },
};
const settle = async () => { for (let index = 0; index < 25; index++) await Promise.resolve(); };
beforeEach(async () => { document.body.innerHTML = await readFile('packages/extension/src/sidepanel/index.html', 'utf8'); });

function setup(failSave = false, failGet = false, options: { delayReload?: boolean; replied?: boolean } = {}) {
  const requests: any[] = [];
  let reads = 0, resolveReload: ((value: unknown) => void) | undefined, rejectReload: ((reason: Error) => void) | undefined;
  const fixtureEntry = options.replied ? { ...entry, status: 'replied', replyUrl: 'https://www.nowcoder.com/discuss/comment/22846505' } : entry;
  const clipboard = vi.fn(async (_value: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  const message = async <T>(request: any): Promise<T> => {
    requests.push(request);
    if (request.type === 'library.list') return { entries: [
      { id: sourceId, source: 'nowcoder', title: entry.title, url: entry.canonicalUrl },
      { id: 'hot-111111111111', source: 'nowcoder', title: '只有短摘', materialKind: 'nowcoder-hot' },
      { id: '222222222222', source: 'zsxq', title: '其他来源' },
    ] } as T;
    if (request.type === 'operations.list') return { entries: [fixtureEntry] } as T;
    if (request.type === 'operations.get' && failGet) throw new Error('这条运营记录读取失败，请重试');
    if (request.type === 'operations.get' && options.delayReload && ++reads > 1) {
      return new Promise((resolve, reject) => { resolveReload = resolve; rejectReload = reject; }) as Promise<T>;
    }
    if (request.type === 'operations.get' || request.type === 'operations.add') return { entry: structuredClone(fixtureEntry) } as T;
    if (request.type === 'operations.brief') return { type: 'nowcoder-reply-brief', sourceUntrusted: { body: entry.body } } as T;
    if (request.type === 'operations.update') {
      if (failSave) throw new Error('草稿已被修改，请保留当前编辑并重新读取最新记录');
      return { entry: { ...entry, ...request.patch, revision: 3 } } as T;
    }
    throw new Error(`unexpected ${request.type}`);
  };
  return { panel: bindOperations(document, message), requests, clipboard,
    finishReload: () => resolveReload?.({ entry: structuredClone(fixtureEntry) }),
    failReload: () => rejectReload?.(new Error('重读失败，请保留修改后重试')) };
}

describe('private operations panel', () => {
  it('preserves edits made after discard starts and before the delayed response arrives', async () => {
    const { panel, finishReload } = setup(false, false, { delayReload: true }); panel.show(); await settle();
    const field = document.querySelector<HTMLTextAreaElement>('#ops-primary')!;
    field.value = '准备放弃的旧修改'; field.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#ops-discard')!.click(); await settle();
    field.value = '重读还没完成时写下的新回复'; field.dispatchEvent(new Event('input'));
    finishReload(); await settle();
    expect(field.value).toBe('重读还没完成时写下的新回复');
  });

  it('retains dirty protection if an explicit reread fails', async () => {
    const { panel, failReload } = setup(false, false, { delayReload: true }); panel.show(); await settle();
    const field = document.querySelector<HTMLTextAreaElement>('#ops-primary')!;
    field.value = '需要保留的修改'; field.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#ops-discard')!.click(); await settle();
    failReload(); await settle();
    document.querySelector<HTMLButtonElement>('.ops-list-item')!.click(); await settle();
    expect(field.value).toBe('需要保留的修改');
    expect(document.querySelector('#ops-status')?.textContent).toContain('当前修改未保存');
  });

  it('does not offer editable unsavable fields on an already replied record', async () => {
    const { panel } = setup(false, false, { replied: true }); panel.show(); await settle();
    expect(document.querySelector<HTMLTextAreaElement>('#ops-feedback')?.readOnly).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('#ops-notes')?.readOnly).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#ops-reply-url')?.readOnly).toBe(true);
  });
  it('does not overwrite a detail read failure with list-loaded success', async () => {
    const { panel } = setup(false, true); panel.show(); await settle();
    expect(document.querySelector('#ops-status')?.textContent).toContain('记录读取失败');
  });
  it('shows full-post candidates, source-specific angle and two short editable replies', async () => {
    const { panel } = setup(); panel.show(); await settle();
    expect(document.querySelectorAll('#ops-source option')).toHaveLength(1);
    expect(document.querySelector('#ops-title')?.textContent).toBe(entry.title);
    expect(document.querySelector('#ops-angle')?.textContent).toContain('框架越学越多');
    expect(document.querySelector<HTMLTextAreaElement>('#ops-primary')?.value).toBe(entry.drafts.primary);
    expect(document.querySelector('#ops-limitations')?.textContent).toContain('未读取评论');
  });

  it('copies the current edited reply without saving or marking it as published', async () => {
    const { panel, clipboard, requests } = setup(); panel.show(); await settle();
    const field = document.querySelector<HTMLTextAreaElement>('#ops-primary')!;
    field.value = '收藏夹先放个假，挑一个小问题跑通就行。'; field.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#ops-copy-primary')!.click(); await settle();
    expect(clipboard).toHaveBeenCalledWith('收藏夹先放个假，挑一个小问题跑通就行。');
    expect(requests.some(request => request.type === 'operations.update')).toBe(false);
    expect(document.querySelector('#ops-status')?.textContent).toContain('未发布');
  });

  it('keeps unsaved text and stale-save errors across navigation and list refresh', async () => {
    const { panel } = setup(true); panel.show(); await settle();
    const field = document.querySelector<HTMLTextAreaElement>('#ops-primary')!;
    field.value = '框架差不多了，先把一个项目里的失败场景讲明白。'; field.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#ops-save')!.click(); await settle();
    panel.show(); await settle();
    expect(field.value).toContain('失败场景');
    expect(document.querySelector('#ops-status')?.textContent).toContain('草稿已被修改');
    document.querySelector<HTMLButtonElement>('#ops-refresh')!.click(); await settle();
    expect(field.value).toContain('失败场景');
  });

  it('saves revision and source binding while recording review as an explicit action', async () => {
    const { panel, requests } = setup(); panel.show(); await settle();
    document.querySelector<HTMLButtonElement>('#ops-reviewed')!.click(); await settle();
    expect(requests.find(request => request.type === 'operations.update')).toMatchObject({ id: entry.id,
      patch: { revision: 2, contextHash: entry.contextHash, status: 'reviewed', drafts: { primary: entry.drafts.primary, anchor: 'LangGraph' } } });
  });
});
