import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import { NowcoderDirectedSessionController } from '../../packages/bridge/src/nowcoderDirected/sessionController.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
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
  it('persists one normalized 30-minute session from JSON latest search and excludes local/job URLs', async () => {
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
    const bodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      bodies.push(body);
      return body.page === 1
        ? searchResponse([
            { url: LOCAL_URL, createTime: Date.parse('2026-08-29T23:00:00.000Z') },
            { url: OLDER_URL, createTime: Date.parse('2026-08-28T00:00:00.000Z') },
            { url: JOB_URL, createTime: Date.parse('2026-08-27T00:00:00.000Z') },
          ], 2)
        : searchResponse([
            { url: NEWEST_URL, createTime: Date.parse('2026-08-29T00:00:00.000Z') },
          ], 2);
    });
    const controller = new NowcoderDirectedSessionController({
      store,
      jobs,
      libraryRoot: root,
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
    expect(fetcher.mock.calls.every(([url]) =>
      new URL(String(url)).hostname === 'gw-c.nowcoder.com')).toBe(true);
    const reopened = await NowcoderDirectedStore.open(storePath);
    expect(reopened.getSession(SESSION_ID)).toEqual(session);
  });
});
