import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  FeJourneyCandidateIndex,
  saveCollectedDocument,
} from '../../packages/bridge/src/feJourney/index.js';
import {
  listLibrary,
  pendingIds,
  syncEntries,
} from '../../packages/bridge/src/library/index.js';
import { SinkRouter } from '../../packages/bridge/src/sinks/index.js';
import {
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  type CollectedDocument,
} from '@data-collector/shared';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

/**
 * 走通整条产品链路，一步不跳：
 *
 *   采集 → **只落本机库**（唯一落点、唯一去重依据）
 *        → 在「已入库」里核对（增删改查都在本地）
 *        → **显式同步**到目标仓库收件箱（可逐条、可批量）
 *        → 用户自己在 Agent 里拉收件箱归档
 *
 * 这份测试的存在理由：这条链路是分三段的，任何一段悄悄提前或跳过都会让用户
 * 失去中间那道审阅——而「采集时就直接投递」正是之前的做法。
 */

const run = promisify(execFile);
const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function post(overrides: Partial<CollectedDocument> = {}): CollectedDocument {
  const url = overrides.canonicalUrl ?? 'https://wx.zsxq.com/group/1/topic/511111111111111';
  return {
    schemaVersion: 1,
    source: 'zsxq',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: '创业板跌破 60 日线',
    author: '重远',
    collectedAt: '2026-07-31T00:00:00.000Z',
    html: '<p>跌破 60 日线就该降仓，这是纪律问题，不是判断问题。</p>',
    text: '跌破 60 日线就该降仓，这是纪律问题，不是判断问题。',
    images: [],
    truncated: false,
    sourceMetadata: {
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
      contentCompletenessBuildId: 'v0.4.29 · pipeline-test',
    },
    ...overrides,
  };
}

/** 目标仓库必须是个真 git 仓库，否则 commit 那一步没法真实验证。 */
async function gitRepository(): Promise<string> {
  const repo = await temporaryDirectories.create('sync-repo-');
  await run('git', ['init', '--quiet'], { cwd: repo });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# repo\n', 'utf8');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '--quiet', '-m', 'init'], { cwd: repo });
  return repo;
}

async function pipeline(): Promise<{ library: string; repo: string; router: SinkRouter }> {
  const library = await temporaryDirectories.create('sync-library-');
  const repo = await gitRepository();
  const router = SinkRouter.build(
    {
      sinks: {
        markdown: { type: 'markdown' },
        'life-teachers': {
          type: 'repo-inbox',
          repoPath: repo,
          label: 'life-teachers 收件箱',
          // 这一组不推（本机库 → 仓库工作区就够）；推送失败的语义另有专门用例。
          push: false,
        },
      },
      routes: { zsxq: ['life-teachers'] },
    },
    { libraryRoot: library },
  );
  return { library, repo, router };
}

async function inboxEntries(repo: string): Promise<string[]> {
  const inbox = join(repo, '_inbox', 'zsxq');
  return existsSync(inbox) ? readdir(inbox) : [];
}

describe('采集 → 本地 → 同步 → 归档 的完整链路', () => {
  it('enriches only fe-journey sources before the existing Markdown pipeline', async () => {
    const { library, router } = await pipeline();
    const candidateIndex = await FeJourneyCandidateIndex.open(library);
    const nowcoderUrl = 'https://www.nowcoder.com/discuss/9001';
    const nowcoder = post({
      source: 'nowcoder',
      kind: 'post',
      url: nowcoderUrl,
      canonicalUrl: nowcoderUrl,
      title: 'Agent 全栈研发一面面经',
      text: '一面面试官追问 RAG 向量召回、重排、评测和部署的实现原理。',
      html: '<p>一面面试官追问 RAG 向量召回、重排、评测和部署的实现原理。</p>',
    });
    await saveCollectedDocument(router, candidateIndex, nowcoder);
    await saveCollectedDocument(router, candidateIndex, post());

    const entries = await listLibrary(library);
    const nowcoderEntry = entries.find(entry => entry.source === 'nowcoder')!;
    const zsxqEntry = entries.find(entry => entry.source === 'zsxq')!;
    const nowcoderSource = JSON.parse(await readFile(
      join(library, nowcoderEntry.relativePath.replace(/index\.md$/, 'source.json')),
      'utf8',
    ));
    const zsxqSource = JSON.parse(await readFile(
      join(library, zsxqEntry.relativePath.replace(/index\.md$/, 'source.json')),
      'utf8',
    ));

    expect(nowcoderSource.document.feJourney).toMatchObject({
      candidateKinds: ['interview', 'knowledge'],
      qualityScore: expect.any(Number),
      clusterId: expect.stringMatching(/^cluster-[a-f0-9]{12}$/),
    });
    expect(zsxqSource.document.feJourney).toBeUndefined();
    const index = JSON.parse(await readFile(join(library, '_catalog', 'fe-journey.json'), 'utf8'));
    expect(index.entries).toHaveLength(1);
  });

  it('采集只写本机库，绝不提前投递到收件箱', async () => {
    const { library, repo, router } = await pipeline();

    await router.save(organize(post()));

    // 本机库有了。
    const entries = await listLibrary(library);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: '创业板跌破 60 日线', source: 'zsxq' });
    // 状态是「未同步」——用户还没点过同步。
    expect(entries[0]?.sync?.state ?? 'pending').toBe('pending');
    // 收件箱**必须还是空的**：这一步不该有任何投递。
    expect(await inboxEntries(repo)).toEqual([]);
  });

  it('同步后收件箱才出现条目，并且真的提交进了仓库', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));
    const [entry] = await listLibrary(library);

    const outcome = await syncEntries(library, [entry!.id], source => router.syncTarget(source));

    expect(outcome).toMatchObject({ synced: 1, failed: 0 });
    const [name] = await inboxEntries(repo);
    expect(name).toBeDefined();
    const original = await readFile(
      join(repo, '_inbox', 'zsxq', name!, 'original.md'),
      'utf8',
    );
    expect(original).toContain('创业板跌破 60 日线');
    expect(original).toContain('跌破 60 日线就该降仓');
    // meta.json 是 Agent 归档时读的那份机器可读元信息。
    const meta = JSON.parse(
      await readFile(join(repo, '_inbox', 'zsxq', name!, 'meta.json'), 'utf8'),
    );
    expect(meta).toMatchObject({ source: 'zsxq', title: '创业板跌破 60 日线' });

    // 真的提交了：工作区干净，且最新提交带上了这个条目。
    const status = await run('git', ['status', '--porcelain'], { cwd: repo });
    expect(status.stdout.trim()).toBe('');

    // 本机库里的状态同步更新，「已入库」页据此展示。
    const after = await listLibrary(library);
    expect(after[0]?.sync).toMatchObject({ state: 'synced', target: 'life-teachers' });
  });

  it('拒绝同步正文不完整或完整性未知的历史知识星球条目', async () => {
    const { library, repo, router } = await pipeline();
    const incomplete = post({
      canonicalUrl: 'https://wx.zsxq.com/group/1/topic/522222222222221',
      title: '明确不完整',
      truncated: true,
    });
    const unknown = post({
      canonicalUrl: 'https://wx.zsxq.com/group/1/topic/522222222222222',
      title: '历史未知完整性',
    });
    delete unknown.truncated;
    await router.save(organize(incomplete));
    await router.save(organize(unknown));

    const outcome = await syncEntries(
      library,
      await pendingIds(library),
      source => router.syncTarget(source),
    );

    expect(outcome).toMatchObject({ synced: 0, failed: 2 });
    expect(outcome.entries.every(item => item.sync.error?.includes('正文尚未确认完整')))
      .toBe(true);
    expect(await inboxEntries(repo)).toEqual([]);
    expect((await pendingIds(library)).sort()).toEqual(
      outcome.entries.map(item => item.id).sort(),
    );
  });

  it('rejects a legacy catalog true that has no current completeness protocol', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));
    const catalogPath = join(library, '_catalog', 'index.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<Record<string, unknown>>;
    delete catalog[0]!.contentCompletenessVersion;
    delete catalog[0]!.contentCompletenessBuildId;
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    const outcome = await syncEntries(
      library,
      await pendingIds(library),
      source => router.syncTarget(source),
    );

    expect(outcome).toMatchObject({ synced: 0, failed: 1 });
    expect(outcome.entries[0]?.sync.error).toContain('正文尚未确认完整');
    expect(await inboxEntries(repo)).toEqual([]);
  });

  it.each([
    ['source', (source: Record<string, any>) => { source.document.source = 'nowcoder'; }],
    ['URL and stable id', (source: Record<string, any>) => {
      source.document.url = 'https://wx.zsxq.com/group/1/topic/599999999999999';
      source.document.canonicalUrl = 'https://wx.zsxq.com/group/1/topic/599999999999999';
    }],
    ['truncation state', (source: Record<string, any>) => { source.document.truncated = true; }],
    ['completeness protocol', (source: Record<string, any>) => {
      source.document.sourceMetadata.contentCompletenessVersion = 'zsxq-complete-content-v0';
    }],
    ['extension build', (source: Record<string, any>) => {
      source.document.sourceMetadata.contentCompletenessBuildId = 'v0.4.29 · different-build';
    }],
  ])('rejects a ZSXQ source.json whose %s disagrees with the catalog proof', async (_field, mutate) => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));
    const [entry] = await listLibrary(library);
    const sourcePath = join(library, entry!.relativePath.replace(/index\.md$/, 'source.json'));
    const source = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, any>;
    mutate(source);
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');

    const outcome = await syncEntries(library, [entry!.id], source => router.syncTarget(source));

    expect(outcome).toMatchObject({ synced: 0, failed: 1 });
    expect(outcome.entries[0]?.sync.error).toContain('source.json');
    expect(await inboxEntries(repo)).toEqual([]);
  });

  it('does not lose a capture added while another catalog entry is synchronizing', async () => {
    const { library, router } = await pipeline();
    await router.save(organize(post()));
    const [first] = await listLibrary(library);
    let releaseSave!: () => void;
    let markSaveStarted!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const saveStarted = new Promise<void>(resolve => { markSaveStarted = resolve; });
    const syncing = syncEntries(library, [first!.id], () => ({
      id: 'blocking-sink',
      label: 'blocking sink',
      categories: [],
      root: library,
      save: async () => {
        markSaveStarted();
        await saveGate;
        return { sinkId: 'blocking-sink', ok: true, outputRef: 'saved' };
      },
    }));
    await saveStarted;

    await router.save(organize(post({
      canonicalUrl: 'https://wx.zsxq.com/group/1/topic/522222222222299',
      title: '同步期间新采集的第二条',
    })));
    releaseSave();
    await syncing;

    const after = await listLibrary(library);
    expect(after.map(entry => entry.title).sort()).toEqual([
      '创业板跌破 60 日线',
      '同步期间新采集的第二条',
    ]);
    expect(after.find(entry => entry.id === first!.id)?.sync?.state).toBe('synced');
  });

  it('同步过的不再算「待同步」，重复点同步也不会重复建条目', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));
    const ids = await pendingIds(library);
    expect(ids).toHaveLength(1);

    await syncEntries(library, ids, source => router.syncTarget(source));
    expect(await pendingIds(library)).toEqual([]);

    // 再同步一次：条目名由稳定内容 ID 派生，只会覆盖，不会长出第二个。
    await syncEntries(library, ids, source => router.syncTarget(source));
    expect(await inboxEntries(repo)).toHaveLength(1);
  });

  it('fixed-plan sync does not commit an unchanged recapture again', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post({
      collectedAt: '2026-08-25T01:00:00.000Z',
      sourceMetadata: {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.30 · build-A',
        batchId: 'capture-batch-A',
        planId: 'zsxq-chen-teacher',
      },
    })));
    const [entry] = await listLibrary(library);
    const resolveTarget = (source: string) => router.syncTarget(source);
    const first = await syncEntries(
      library,
      [entry!.id],
      resolveTarget,
      undefined,
      { skipDelivered: true },
    );
    expect(first).toMatchObject({ synced: 1, failed: 0 });
    expect(Number((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim()))
      .toBe(2);

    await router.save(organize(post({
      collectedAt: '2026-08-25T02:00:00.000Z',
      sourceMetadata: {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.30 · build-B',
        batchId: 'capture-batch-B',
        planId: 'zsxq-chen-teacher',
      },
    })));
    const duplicate = await syncEntries(
      library,
      [entry!.id],
      resolveTarget,
      undefined,
      { skipDelivered: true },
    );

    expect(duplicate).toMatchObject({ synced: 1, failed: 0 });
    expect(Number((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim()))
      .toBe(2);
    expect(await inboxEntries(repo)).toHaveLength(1);

    const explicitRedelivery = await syncEntries(
      library,
      [entry!.id],
      resolveTarget,
    );
    expect(explicitRedelivery).toMatchObject({ synced: 1, failed: 0 });
    expect(Number((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim()))
      .toBe(3);

    await router.save(organize(post({
      collectedAt: '2026-08-25T03:00:00.000Z',
      html: '<p>跌破 60 日线就该降仓；新增条件是放量破位后不得在当日抄底。</p>',
      text: '跌破 60 日线就该降仓；新增条件是放量破位后不得在当日抄底。',
      sourceMetadata: {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.30 · build-C',
        batchId: 'capture-batch-C',
        planId: 'zsxq-chen-teacher',
      },
    })));
    const changed = await syncEntries(
      library,
      [entry!.id],
      resolveTarget,
      undefined,
      { skipDelivered: true },
    );

    expect(changed).toMatchObject({ synced: 1, failed: 0 });
    expect(Number((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim()))
      .toBe(4);
  });

  it('does not trust a delivered catalog receipt when source.json has a different revision', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));
    const [entry] = await listLibrary(library);
    await syncEntries(library, [entry!.id], source => router.syncTarget(source));
    const sourcePath = join(library, entry!.relativePath.replace(/index\.md$/u, 'source.json'));
    const source = JSON.parse(await readFile(sourcePath, 'utf8')) as {
      document: { html: string; text: string };
    };
    source.document.html = '<p>进程中断后只写入 source.json 的新正文。</p>';
    source.document.text = '进程中断后只写入 source.json 的新正文。';
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');

    const outcome = await syncEntries(
      library,
      [entry!.id],
      sourceName => router.syncTarget(sourceName),
      undefined,
      { skipDelivered: true },
    );

    expect(outcome).toMatchObject({ synced: 0, failed: 1 });
    expect(outcome.entries[0]?.sync.error).toContain('投递版本');
    expect(Number((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim()))
      .toBe(2);
  });

  it('does not overwrite a concurrent sync state while another entry is being delivered', async () => {
    const { library, router } = await pipeline();
    const stableUrl = 'https://wx.zsxq.com/group/1/topic/533333333333331';
    const changedUrl = 'https://wx.zsxq.com/group/1/topic/533333333333332';
    await router.save(organize(post({
      canonicalUrl: stableUrl,
      url: stableUrl,
      title: '已经投递且本轮不变',
      collectedAt: '2026-08-25T03:00:00.000Z',
    })));
    await router.save(organize(post({
      canonicalUrl: changedUrl,
      url: changedUrl,
      title: '本轮需要投递',
      collectedAt: '2026-08-25T01:00:00.000Z',
    })));
    const initial = await listLibrary(library);
    const sinkRoot = await temporaryDirectories.create('sync-state-sink-');
    const immediateSink = {
      id: 'state-test-sink',
      label: 'state test sink',
      categories: [] as string[],
      root: sinkRoot,
      save: async () => ({ sinkId: 'state-test-sink', ok: true, outputRef: sinkRoot }),
    };
    await syncEntries(library, initial.map(item => item.id), () => immediateSink);

    await router.save(organize(post({
      canonicalUrl: changedUrl,
      url: changedUrl,
      title: '本轮需要投递',
      collectedAt: '2026-08-25T02:00:00.000Z',
      html: '<p>正文已经增加了新的投资纪律与复盘结论。</p>',
      text: '正文已经增加了新的投资纪律与复盘结论。',
      sourceMetadata: {
        contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
        contentCompletenessBuildId: 'v0.4.30 · state-build-B',
      },
    })));
    const entries = await listLibrary(library);
    const stable = entries.find(item => item.url === stableUrl)!;
    let releaseSave!: () => void;
    let markSaveStarted!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const saveStarted = new Promise<void>(resolve => { markSaveStarted = resolve; });
    const blockingSink = {
      ...immediateSink,
      save: async (input: ReturnType<typeof organize>) => {
        if (input.document.canonicalUrl === stableUrl) {
          throw new Error('unchanged entry must not reach the sink');
        }
        markSaveStarted();
        await saveGate;
        return { sinkId: 'state-test-sink', ok: true, outputRef: sinkRoot };
      },
    };
    const syncing = syncEntries(
      library,
      entries.map(item => item.id),
      () => blockingSink,
      undefined,
      { skipDelivered: true },
    );
    await saveStarted;

    const catalogPath = join(library, '_catalog', 'index.json');
    const concurrent = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<Record<string, any>>;
    concurrent.find(item => item.id === stable.id)!.sync = {
      state: 'failed',
      target: 'state-test-sink',
      at: '2026-08-25T04:00:00.000Z',
      error: 'concurrent manual sync failed',
    };
    await writeFile(catalogPath, `${JSON.stringify(concurrent, null, 2)}\n`, 'utf8');
    releaseSave();
    await syncing;

    expect((await listLibrary(library)).find(item => item.id === stable.id)?.sync).toEqual({
      state: 'failed',
      target: 'state-test-sink',
      at: '2026-08-25T04:00:00.000Z',
      error: 'concurrent manual sync failed',
    });
  });

  it('重采后再同步：收件箱仍是一份，绝不长出第二个目录', async () => {
    // 收件箱目录名里只有稳定内容 ID 是稳的：没有发布时间时日期退化成采集日期，
    // 标题取自正文首句（「展开全文」点没点上都会变）。按当次值重算目录名的话，
    // 重采再同步就会多出一份，而本机库仍是一条——Agent 会把同一篇归档两遍。
    // 而「重采 → 状态回到未同步 → 再同步」正是产品主动鼓励用户走的路径。
    const { library, repo, router } = await pipeline();
    await router.save(organize(post({ collectedAt: '2026-07-30T00:00:00.000Z' })));
    await syncEntries(library, await pendingIds(library), source => router.syncTarget(source));
    expect(await inboxEntries(repo)).toHaveLength(1);
    const [firstName] = await inboxEntries(repo);

    // 隔天重采，标题也变了一个字。
    await router.save(organize(post({
      collectedAt: '2026-07-31T00:00:00.000Z',
      title: '创业板跌破 60 日线（更新）',
    })));
    await syncEntries(library, await pendingIds(library), source => router.syncTarget(source));

    const names = await inboxEntries(repo);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(firstName);
    // 内容是新的：复用目录不等于不更新。
    expect(await readFile(join(repo, '_inbox', 'zsxq', names[0]!, 'original.md'), 'utf8'))
      .toContain('创业板跌破 60 日线（更新）');
  });

  it('重新采集同一地址：本地只有一条，且同步状态回到未同步', async () => {
    // 本机库是唯一的去重依据；内容更新了就该让用户重新过一遍同步这一关。
    const { library, router } = await pipeline();
    await router.save(organize(post()));
    await syncEntries(library, await pendingIds(library), source => router.syncTarget(source));

    await router.save(organize(post({ title: '创业板跌破 60 日线（更新）' })));

    const entries = await listLibrary(library);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe('创业板跌破 60 日线（更新）');
    expect(entries[0]?.sync?.state).toBe('pending');
  });

  it('没有配置同步去向时如实失败，绝不假装同步成功', async () => {
    const library = await temporaryDirectories.create('sync-library-');
    const router = SinkRouter.build(
      { sinks: { markdown: { type: 'markdown' } }, routes: {} },
      { libraryRoot: library },
    );
    await router.save(organize(post()));

    const outcome = await syncEntries(
      library,
      await pendingIds(library),
      source => router.syncTarget(source),
    );

    expect(outcome).toMatchObject({ synced: 0, failed: 1 });
    expect(outcome.entries[0]?.sync.error).toContain('没有为「zsxq」配置同步去向');
    // 失败状态要落进目录索引，用户在「已入库」里看得到，而不是一闪而过。
    expect((await listLibrary(library))[0]?.sync).toMatchObject({ state: 'failed' });
  });

  it('一条失败不影响同一批里的其余条目', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));
    await router.save(organize(post({
      canonicalUrl: 'https://wx.zsxq.com/group/1/topic/522222222222222',
      title: '第二条',
    })));
    const entries = await listLibrary(library);
    // 把其中一条的整理结果删掉，模拟本地文件损坏/缺失。
    const broken = entries[0]!;
    await mkdir(join(library, '_broken'), { recursive: true });
    await writeFile(join(library, broken.relativePath.replace(/index\.md$/, 'source.json')), '不是 JSON');

    const outcome = await syncEntries(
      library,
      entries.map(item => item.id),
      source => router.syncTarget(source),
    );

    expect(outcome.synced).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(await inboxEntries(repo)).toHaveLength(1);
  });

  it('旧版本采集的条目：说清是什么情况该怎么办，而不是甩一个 ENOENT', async () => {
    // 0.3.0 之前的条目没有留 source.json（当时不需要）。用户要能一眼知道该重采还是该删。
    const { library, router } = await pipeline();
    await router.save(organize(post()));
    const [entry] = await listLibrary(library);
    await rm(join(library, entry!.relativePath.replace(/index\.md$/, 'source.json')));

    const outcome = await syncEntries(library, [entry!.id], source => router.syncTarget(source));

    expect(outcome).toMatchObject({ synced: 0, failed: 1 });
    expect(outcome.entries[0]?.sync.error).toContain('旧版本采集的');
    expect(outcome.entries[0]?.sync.error).toContain('重新采集');
  });

  it('git 提交失败时绝不算「已同步」，并把报错翻成人能照做的一句话', async () => {
    // 实测：这台 Mac 的命令行工具坏了，16 条的 git add 全失败，
    // 面板却显示「已同步 16 条」外加 16 行一模一样的 xcrun 报错。
    const library = await temporaryDirectories.create('sync-library-');
    const repo = await temporaryDirectories.create('sync-broken-repo-');
    const router = SinkRouter.build(
      {
        sinks: {
          markdown: { type: 'markdown' },
          // 不是 git 仓库 → git add 必然失败。
          'life-teachers': { type: 'repo-inbox', repoPath: repo, label: 'life-teachers 收件箱' },
        },
        routes: { zsxq: ['life-teachers'] },
      },
      { libraryRoot: library },
    );
    await router.save(organize(post()));

    const outcome = await syncEntries(
      library,
      await pendingIds(library),
      source => router.syncTarget(source),
    );

    // 文件确实写进了 _inbox，但没提交进仓库——这不叫同步成功。
    expect(outcome).toMatchObject({ synced: 0, failed: 1 });
    expect(outcome.entries[0]?.sync.state).toBe('failed');
    expect(outcome.entries[0]?.sync.error).toContain('不是一个 git 仓库');
  });

  it('空 id 列表是安全的空操作，绝不理解成「同步全部」', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));

    expect(await syncEntries(library, [], source => router.syncTarget(source)))
      .toEqual({ synced: 0, failed: 0, entries: [] });
    expect(await inboxEntries(repo)).toEqual([]);
  });
});

describe('推送失败就算同步失败', () => {
  /**
   * 用户的 Agent 是从 GitHub 读收件箱的：只提交到本机仓库等于没送到。
   * 真出过一次——他在 Agent 里问「处理收件箱」得到「没有新的」，
   * 而侧栏那边二十条全绿。（远端确认：origin 上一条「采集:」提交都没有。）
   */
  async function pushingPipeline(): Promise<{ library: string; repo: string; router: SinkRouter }> {
    const library = await temporaryDirectories.create('sync-library-push-');
    const repo = await gitRepository();
    const router = SinkRouter.build(
      {
        sinks: {
          markdown: { type: 'markdown' },
          // 临时仓库没有远端，push 必然失败——正是要验证的那条路径。
          'life-teachers': { type: 'repo-inbox', repoPath: repo, push: true },
        },
        routes: { zsxq: ['life-teachers'] },
      },
      { libraryRoot: library },
    );
    return { library, repo, router };
  }

  it('推不上去的条目算失败，且留在「未同步」里等重试', async () => {
    const { library, repo, router } = await pushingPipeline();
    await router.save(organize(post()));
    const [entry] = await listLibrary(library);

    const outcome = await syncEntries(library, [entry!.id], source => router.syncTarget(source));

    expect(outcome).toMatchObject({ synced: 0, failed: 1 });
    expect(outcome.entries[0]?.sync.state).toBe('failed');
    // 提交本身是成功的，得如实说——文件确实在本机仓库里。
    expect(outcome.entries[0]?.sync.committed).toBe(true);
    expect(await inboxEntries(repo)).toHaveLength(1);
    // 关键：它必须回到待同步队列，点一次同步就重试，绝不让人以为已经送到了。
    expect(await pendingIds(library)).toContain(entry!.id);
  });
});
