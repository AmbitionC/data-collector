import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import { NowcoderDirectedSessionController } from '../../packages/bridge/src/nowcoderDirected/sessionController.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
import { knownNowcoderSources } from '../../packages/bridge/src/nowcoderDirected/knownSources.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const NOW = '2026-08-30T00:00:00.000Z';
const SESSION_ID = 'session-controller';
const LOCAL_URL = 'https://www.nowcoder.com/feed/main/detail/already-local';
const JOB_URL = 'https://www.nowcoder.com/feed/main/detail/already-job';
const NEWEST_URL = 'https://www.nowcoder.com/feed/main/detail/newest';
const OLDER_URL = 'https://www.nowcoder.com/feed/main/detail/older';
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(async () => {
  await temporaryDirectories.cleanup();
});

function searchResponse(
  records: Array<{ url: string; createTime: number }>,
  totalPage = 1,
): Response {
  return Response.json({
    success: true,
    code: 0,
    data: { totalPage, records: records.map(contentData => ({ contentData })) },
  });
}

describe('NowcoderDirectedSessionController', () => {
  it('preserves a configured source-history failure before attempting external discovery', async () => {
    const root = await temporaryDirectories.create('nowcoder-history-error-');
    const store = await NowcoderDirectedStore.open(join(root, 'directed.json'));
    const jobs = await JobStore.open(join(root, 'jobs.json'));
    const historyPath = join(root, 'missing-outside-history.json');
    const controller = new NowcoderDirectedSessionController({ store, jobs, libraryRoot: root,
      targetRoot: root, historyPath, fetch: async () => { throw new Error('network must not run'); } });
    await expect(controller.create({ queries: ['Agent'], target: 1, sort: 'latest' }))
      .rejects.toMatchObject({ code: 'DIRECTED_HISTORY_CORRUPT', message: '历史记录无法安全读取' });
  });
  it.each(['parent-escape', 'nested-symlink'])('rejects an unsafe configured inbox: %s', async reason => {
    const root = await temporaryDirectories.create('nowcoder-unsafe-inbox-');
    const target = join(root, 'target'), outside = join(root, 'outside');
    await mkdir(join(target, 'custom-inbox'), { recursive: true });
    await mkdir(join(outside, 'nowcoder'), { recursive: true });
    await symlink(outside, join(target, 'custom-inbox', 'linked'));
    const inboxDir = reason === 'parent-escape' ? '../outside' : 'custom-inbox/linked';
    await expect(knownNowcoderSources({ libraryRoot: root, targetRoot: target, jobs: [],
      ...{ inboxDir } })).rejects.toThrow();
  });

  it('also recognizes legacy source.json review entries without treating them as missing', async () => {
    const root=await temporaryDirectories.create('nowcoder-legacy-pending-');
    await mkdir(join(root,'_inbox','nowcoder','legacy'),{recursive:true});
    await writeFile(join(root,'_inbox','nowcoder','legacy','source.json'),JSON.stringify({document:{canonicalUrl:LOCAL_URL}}));
    const known=await knownNowcoderSources({libraryRoot:root,targetRoot:root,jobs:[]});
    expect(known.urls.has(LOCAL_URL)).toBe(true);
    expect(known.reasons.get(LOCAL_URL)).toBe('pending_inbox');
    expect(known.warnings).toEqual({});
  });
  it('persists undated hits for review and does not send them into automatic detail collection', async () => {
    const root=await temporaryDirectories.create('nowcoder-review-only-');
    const store=await NowcoderDirectedStore.open(join(root,'directed.json'));
    const jobs=await JobStore.open(join(root,'jobs.json'));
    const controller=new NowcoderDirectedSessionController({store,jobs,libraryRoot:root,
      fetch:async()=>Response.json({success:true,code:0,data:{totalPage:1,records:[{momentData:{uuid:'undated',title:'Agent 一面'}}]}}),
      id:()=>SESSION_ID,now:()=>new Date(NOW)});
    const session=await controller.create({queries:['Agent'],target:1,sort:'latest'});
    expect(session.candidates).toEqual([]);
    expect(session.reviewOnlyCandidates).toMatchObject([{canonicalUrl:'https://www.nowcoder.com/feed/main/detail/undated',reason:'missing_published_at'}]);
    expect((await NowcoderDirectedStore.open(join(root,'directed.json'))).getSession(SESSION_ID)?.reviewOnlyCandidates).toEqual(session.reviewOnlyCandidates);
  });

  it('stops before network search when the local deduplication catalog is corrupt', async () => {
    const root=await temporaryDirectories.create('nowcoder-search-corrupt-');
    await mkdir(join(root,'_catalog'));
    await writeFile(join(root,'_catalog','index.json'),'broken');
    const store=await NowcoderDirectedStore.open(join(root,'directed.json'));
    const jobs=await JobStore.open(join(root,'jobs.json'));const fetcher=vi.fn<typeof fetch>();
    const controller=new NowcoderDirectedSessionController({store,jobs,libraryRoot:root,fetch:fetcher});
    await expect(controller.create({queries:['Agent'],target:1,sort:'latest'})).rejects.toThrow('牛客最新搜索暂时不可用');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('excludes local pending sources, active jobs, pending inbox and processed history', async () => {
    const root = await temporaryDirectories.create('nowcoder-directed-session-controller-');
    const storePath = join(root, 'directed.json');
    const store = await NowcoderDirectedStore.open(storePath);
    const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
    await jobs.create({ id: 'known-job', url: JOB_URL, requestedBy: 'codex' });
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(join(root, '_catalog', 'index.json'), `${JSON.stringify([{
      id: 'known-local',
      source: 'nowcoder',
      title: 'already local',
      url: LOCAL_URL,
      category: 'interview',
      relativePath: 'nowcoder/known/index.md',
      updatedAt: NOW,
    }])}\n`, 'utf8');
    await mkdir(join(root, '.codex'), { recursive: true });
    await writeFile(join(root, '.codex', 'interview-source-history.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-08-30',
      records: {
        aaaaaaaaaaaa: {
          source: 'nowcoder', url: 'https://www.nowcoder.com/feed/main/detail/processed-only', contentHash: '1'.repeat(16),
          clusterId: 'cluster-known', evidenceGrade: 'B', status: 'skipped',
          publicFiles: [], knowledgeKeys: [], processedAt: NOW,
        },
      },
    })}\n`, 'utf8');
    await mkdir(join(root, '_inbox', 'nowcoder', 'pending'), {recursive:true});
    await writeFile(join(root, '_inbox', 'nowcoder', 'pending', 'meta.json'), JSON.stringify({url:'https://www.nowcoder.com/feed/main/detail/pending-inbox'}));
    const bodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      bodies.push(body);
      return body.page === 1
        ? searchResponse([
            { url: LOCAL_URL, createTime: Date.parse('2026-08-29T23:00:00.000Z') },
            { url: OLDER_URL, createTime: Date.parse('2026-08-28T00:00:00.000Z') },
            { url: JOB_URL, createTime: Date.parse('2026-08-27T00:00:00.000Z') },
            {url:'https://www.nowcoder.com/feed/main/detail/pending-inbox',createTime:Date.parse(NOW)},
            {url:'https://www.nowcoder.com/feed/main/detail/processed-only',createTime:Date.parse(NOW)},
          ], 2)
        : searchResponse([
            { url: NEWEST_URL, createTime: Date.parse('2026-08-29T00:00:00.000Z') },
          ], 2);
    });
    const controller = new NowcoderDirectedSessionController({
      store,
      jobs,
      libraryRoot: root,
      targetRoot: root,
      fetch: fetcher,
      now: () => new Date(NOW),
      id: () => SESSION_ID,
    });

    const session = await controller.create({
      queries: ['  Ａgent   面经 ', 'Agent 面经'],
      target: 2,
      sort: 'latest',
    });

    expect(bodies).toEqual([
      { type: 'post', query: 'Agent 面经', order: 'create', page: 1 },
      { type: 'post', query: 'Agent 面经', order: 'create', page: 2 },
    ]);
    expect(session).toMatchObject({
      id: SESSION_ID,
      queries: ['Agent 面经'],
      queryHash: '1fd8b738bec350512f43d0b844532d77ca315638b60a863160516210cf07a5a1',
      requestedSort: 'latest',
      provider: 'nowcoder-json',
      sortVerified: true,
      createdAt: NOW,
      expiresAt: '2026-08-30T00:30:00.000Z',
    });
    expect(session.candidates.map(candidate => candidate.canonicalUrl)).toEqual([
      NEWEST_URL,
      OLDER_URL,
    ]);
    expect(session.discovery?.knownSourcesRemoved).toBe(4);
    expect(session.discovery?.knownSourceCounts).toMatchObject({local_pending:1,active_or_saved_job:1,pending_inbox:1,processed_history:1});
    expect(session.discovery?.sourceIndexWarnings).toEqual({});
    expect(fetcher.mock.calls.every(([url]) =>
      new URL(String(url)).hostname === 'gw-c.nowcoder.com')).toBe(true);
    const reopened = await NowcoderDirectedStore.open(storePath);
    expect(reopened.getSession(SESSION_ID)).toEqual(session);
  });
});
