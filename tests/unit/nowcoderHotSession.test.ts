import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractNowcoderHotList } from '../../packages/extension/src/extractors/nowcoder.js';
import { HotMaterialSession, type HotDependencies } from '../../packages/extension/src/background/hotMaterials.js';
import { hotMaterialId } from '@data-collector/shared';

function setup() {
  let stored: Record<string, unknown> = {};
  const documents = extractNowcoderHotList(new JSDOM('<article><a href="/discuss/123456">没有面邀</a><p>我说自己没有面邀</p></article>').window.document,
    new URL('https://www.nowcoder.com/'), () => '2026-10-10T12:00:00.000Z').documents;
  const saved: typeof documents = [];
  let fail = true;
  const deps: HotDependencies = {
    storage: { get: async () => stored, set: async value => { stored = { ...stored, ...value }; } },
    readList: async () => ({ documents, capped: false }), library: async () => [],
    save: async document => { if (fail) { fail = false; return 'failed'; } saved.push(document); return 'ok'; },
  };
  return { deps, saved, id: hotMaterialId(documents[0]!.canonicalUrl) };
}

describe('manual private hot-material session', () => {
  it('saves only checked snapshot IDs, retries failed writes and skips saved items after worker restart', async () => {
    const { deps, saved, id } = setup();
    const session = new HotMaterialSession(deps);
    const preview = await session.preview();
    const selected = [{ id, emotionTags: ['焦虑' as const], inspirationNote: '讨论等待面邀的时间预期', attribution: 'author-self-report' as const }];
    expect((await session.save(preview.token, selected)).failed).toBe(1);
    expect((await session.save(preview.token, selected)).saved).toBe(1);
    expect(saved[0]?.operationMaterial?.editorial.inspirationNote).toBe('讨论等待面邀的时间预期');
    expect(saved[0]?.operationMaterial?.evidence.attribution).toBe('author-self-report');
    const restarted = new HotMaterialSession(deps);
    expect((await restarted.save(preview.token, selected)).skipped).toBe(1);
    expect(saved).toHaveLength(1);
  });

  it('keeps the auto-reload busy signal set while a manual save awaits acknowledgement', async () => {
    const { deps, id } = setup();
    let finish!: (value: 'ok') => void;
    deps.save = async () => new Promise(resolve => { finish = resolve; });
    const session = new HotMaterialSession(deps);
    const preview = await session.preview();
    const saving = session.save(preview.token, [{ id, emotionTags: [], inspirationNote: '', attribution: 'source-quote' }]);
    while (!finish) await Promise.resolve();
    expect(session.processing).toBe(true);
    finish('ok');
    await saving;
    expect(session.processing).toBe(false);
  });

  it('rejects stale previews, unobserved IDs, duplicate selections and diagnostic tags', async () => {
    const { deps, id } = setup();
    const session = new HotMaterialSession(deps);
    const preview = await session.preview();
    const selected = { id, emotionTags: [], inspirationNote: '', attribution: 'source-quote' as const };
    await expect(session.save('stale', [selected])).rejects.toThrow('预览');
    await expect(session.save(preview.token, [{ ...selected, id: 'hot-000000000000' }])).rejects.toThrow('预览');
    await expect(session.save(preview.token, [selected, selected])).rejects.toThrow('重复');
    await expect(session.save(preview.token, [{ ...selected, emotionTags: ['抑郁症'] as any }])).rejects.toThrow();
  });

  it('dedupes against the local material catalog while allowing the same interview URL', async () => {
    const { deps, id } = setup();
    deps.library = async () => [{ id: id.slice(4), url: 'https://www.nowcoder.com/discuss/123456' }];
    expect((await new HotMaterialSession(deps).preview()).rows[0]?.alreadySaved).toBe(false);
    deps.library = async () => [{ id, materialKind: 'nowcoder-hot', url: 'https://www.nowcoder.com/discuss/123456' }];
    expect((await new HotMaterialSession(deps).preview()).rows[0]?.alreadySaved).toBe(true);
  });
});
