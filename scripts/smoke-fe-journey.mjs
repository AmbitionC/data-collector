import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  FeJourneyCandidateIndex,
  discoverGithubProjects,
  discoverNowcoderUrls,
  saveCollectedDocument,
} from '../packages/bridge/dist/feJourney/index.js';
import { listLibrary, pendingIds, syncEntries } from '../packages/bridge/dist/library/index.js';
import { SinkRouter } from '../packages/bridge/dist/sinks/index.js';

const WORKSPACE = resolve(import.meta.dirname, '..');
const LIVE = process.env.LIVE === '1';

function fixtureRepository() {
  return {
    id: 991001,
    full_name: 'agent-journey/example-agent-lab',
    html_url: 'https://github.com/agent-journey/example-agent-lab',
    owner: { login: 'agent-journey' },
    fork: false,
    archived: false,
    stargazers_count: 360,
    forks_count: 31,
    open_issues_count: 7,
    created_at: '2025-03-01T00:00:00.000Z',
    updated_at: new Date().toISOString(),
    pushed_at: new Date().toISOString(),
    default_branch: 'main',
    license: { spdx_id: 'MIT' },
    language: 'TypeScript',
    description: 'A production-oriented AI Agent learning project.',
    topics: ['ai-agent', 'mcp', 'rag'],
  };
}

async function fixtureFetcher(input) {
  const url = new URL(String(input));
  if (url.hostname === 'www.nowcoder.com') {
    return new Response(await readFile(join(WORKSPACE, 'tests/fixtures/nowcoder-search.html'), 'utf8'));
  }
  if (url.pathname === '/search/repositories') {
    return Response.json({ items: [fixtureRepository()] });
  }
  if (url.pathname === '/repos/agent-journey/example-agent-lab/readme') {
    return new Response([
      '# Example Agent Lab',
      'MCP tools, RAG retrieval, memory and workflow orchestration.',
      '## Quick start',
      'npm install && npm test',
      'Includes Docker deployment, architecture, evaluation, CI and an MIT license.',
    ].join('\n'));
  }
  return new Response('unexpected fixture URL', { status: 500 });
}

async function liveFetcher(input, init) {
  const url = new URL(String(input));
  const token = process.env.GITHUB_TOKEN;
  return fetch(input, {
    ...init,
    ...(token && url.hostname === 'api.github.com'
      ? { headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), authorization: `Bearer ${token}` } }
      : {}),
  });
}

function nowcoderDocument(url, text, collectedAt) {
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: 'Agent 全栈研发一面面经',
    author: '冒烟样本',
    collectedAt,
    html: `<p>${text}</p>`,
    text,
    images: [],
    sourceMetadata: { discovery: LIVE ? 'live-public-search' : 'fixture-search' },
  };
}

async function main() {
  const fetcher = LIVE ? liveFetcher : fixtureFetcher;
  const collectedAt = new Date().toISOString();
  const [nowcoderUrls, githubDocuments] = await Promise.all([
    discoverNowcoderUrls(fetcher, new Set()),
    discoverGithubProjects(fetcher, () => collectedAt),
  ]);
  if (nowcoderUrls.length < 2) throw new Error(`牛客详情发现不足：${nowcoderUrls.length}`);
  if (githubDocuments.length < 1) throw new Error('没有发现可映射的 GitHub 项目');

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fe-journey-smoke-'));
  const libraryRoot = join(temporaryRoot, 'library');
  const inboxRepo = join(temporaryRoot, 'resource');
  await mkdir(inboxRepo, { recursive: true });
  try {
    const router = SinkRouter.build({
      sinks: {
        markdown: { type: 'markdown' },
        'fe-journey': {
          type: 'repo-inbox',
          repoPath: inboxRepo,
          commit: false,
          push: false,
        },
      },
      routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
    }, { libraryRoot, fetch: fetcher });
    const candidateIndex = await FeJourneyCandidateIndex.open(libraryRoot);
    const interviewText = '一面面试官追问 RAG 文档切分、向量召回、结果重排、答案评测、MCP 工具失败重试和生产部署的实现原理。';
    await saveCollectedDocument(
      router,
      candidateIndex,
      nowcoderDocument(nowcoderUrls[0], interviewText, collectedAt),
    );
    await saveCollectedDocument(
      router,
      candidateIndex,
      nowcoderDocument(nowcoderUrls[1], interviewText, collectedAt),
    );
    await saveCollectedDocument(router, candidateIndex, githubDocuments[0]);

    const entries = await listLibrary(libraryRoot);
    const sourceDocuments = await Promise.all(entries.map(async entry => {
      const sourcePath = join(libraryRoot, entry.relativePath.replace(/index\.md$/, 'source.json'));
      return JSON.parse(await readFile(sourcePath, 'utf8')).document;
    }));
    const nowcoderCandidates = sourceDocuments.filter(document => document.source === 'nowcoder');
    const githubCandidate = sourceDocuments.find(document => document.source === 'github');
    if (nowcoderCandidates.length !== 2 || !githubCandidate) throw new Error('候选落盘数量不符');
    const [first, duplicate] = nowcoderCandidates;
    if (!first.feJourney || !duplicate.feJourney || !githubCandidate.feJourney) {
      throw new Error('候选评分元数据缺失');
    }
    if (first.feJourney.clusterId !== duplicate.feJourney.clusterId || !duplicate.feJourney.duplicateOf) {
      throw new Error('重复面经没有聚合到同一候选簇');
    }
    if (!githubCandidate.feJourney.candidateKinds.includes('project')) {
      throw new Error('GitHub 文档没有进入项目候选');
    }

    const sync = await syncEntries(
      libraryRoot,
      await pendingIds(libraryRoot),
      source => router.syncTarget(source),
    );
    if (sync.failed !== 0 || sync.synced !== 3) throw new Error(`收件箱同步失败：${JSON.stringify(sync)}`);
    const nowcoderInbox = join(inboxRepo, '_inbox', 'nowcoder');
    const inboxEntries = await readdir(nowcoderInbox);
    const inboxMeta = JSON.parse(await readFile(join(nowcoderInbox, inboxEntries[0], 'meta.json'), 'utf8'));
    if (!inboxMeta.feJourney?.clusterId) throw new Error('Codex 收件箱缺少聚合元数据');

    const catalog = JSON.parse(await readFile(join(libraryRoot, '_catalog', 'fe-journey.json'), 'utf8'));
    const report = {
      ok: true,
      mode: LIVE ? 'live-public-discovery' : 'fixtures',
      nowcoderDiscovered: nowcoderUrls.length,
      githubDiscovered: githubDocuments.length,
      candidatesSaved: entries.length,
      candidateClusters: new Set(catalog.entries.map(entry => entry.clusterId)).size,
      duplicateClusterId: duplicate.feJourney.clusterId,
      projectScore: githubCandidate.feJourney.projectScore,
      inboxEntries: sync.synced,
      testedAt: collectedAt,
    };
    const reportPath = join(WORKSPACE, 'artifacts', 'smoke-fe-journey.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
