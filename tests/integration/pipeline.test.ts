import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  listLibrary,
  pendingIds,
  syncEntries,
} from '../../packages/bridge/src/library/index.js';
import { SinkRouter } from '../../packages/bridge/src/sinks/index.js';
import type { CollectedDocument } from '@data-collector/shared';
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
          // 临时仓库没有远端，push 必然失败——正好用来验证「推不上去不算同步失败」。
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

  it('空 id 列表是安全的空操作，绝不理解成「同步全部」', async () => {
    const { library, repo, router } = await pipeline();
    await router.save(organize(post()));

    expect(await syncEntries(library, [], source => router.syncTarget(source)))
      .toEqual({ synced: 0, failed: 0, entries: [] });
    expect(await inboxEntries(repo)).toEqual([]);
  });
});
