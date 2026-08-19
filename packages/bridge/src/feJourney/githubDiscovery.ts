import { canonicalizeUrl, type CollectedDocument } from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from './preset.js';

type Clock = () => string;

interface GithubRepository {
  id: number;
  fullName: string;
  htmlUrl: string;
  owner: string;
  stars: number;
  forks: number;
  openIssues: number;
  createdAt?: string;
  updatedAt: string;
  pushedAt?: string;
  defaultBranch: string;
  license?: string;
  language?: string;
  description?: string;
  topics?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseRepository(value: unknown, collectedAt: string): GithubRepository | undefined {
  if (!isRecord(value) || value.fork === true || value.archived === true) return undefined;
  const id = finiteNumber(value.id);
  const fullName = optionalString(value.full_name);
  const htmlUrl = optionalString(value.html_url);
  const owner = isRecord(value.owner) ? optionalString(value.owner.login) : undefined;
  const updatedAt = optionalString(value.updated_at);
  const defaultBranch = optionalString(value.default_branch) ?? 'main';
  if (!id || !fullName || !htmlUrl || !owner || !updatedAt) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return undefined;
  const updatedTime = Date.parse(updatedAt);
  const collectedTime = Date.parse(collectedAt);
  if (!Number.isFinite(updatedTime) || !Number.isFinite(collectedTime)) return undefined;
  if (collectedTime - updatedTime > 365 * 86_400_000) return undefined;
  try {
    const canonical = canonicalizeUrl(new URL(htmlUrl)).href;
    if (canonical.toLocaleLowerCase('en-US') !== `https://github.com/${fullName}`.toLocaleLowerCase('en-US')) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const license = isRecord(value.license) ? optionalString(value.license.spdx_id) : undefined;
  const topics = Array.isArray(value.topics)
    ? value.topics.filter((topic): topic is string => typeof topic === 'string').join(',')
    : undefined;

  return {
    id,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    owner,
    stars: finiteNumber(value.stargazers_count),
    forks: finiteNumber(value.forks_count),
    openIssues: finiteNumber(value.open_issues_count),
    ...(optionalString(value.created_at) ? { createdAt: optionalString(value.created_at)! } : {}),
    updatedAt,
    ...(optionalString(value.pushed_at) ? { pushedAt: optionalString(value.pushed_at)! } : {}),
    defaultBranch,
    ...(license && license !== 'NOASSERTION' ? { license } : {}),
    ...(optionalString(value.language) ? { language: optionalString(value.language)! } : {}),
    ...(optionalString(value.description) ? { description: optionalString(value.description)! } : {}),
    ...(topics ? { topics } : {}),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function fetchReadme(fetcher: typeof fetch, repository: GithubRepository): Promise<string | undefined> {
  const [owner, repo] = repository.fullName.split('/');
  if (!owner || !repo) return undefined;
  const response = await fetcher(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
    {
      headers: {
        accept: 'application/vnd.github.raw+json',
        'user-agent': 'data-collector-fe-journey/1.0',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const canUseRawFallback = response.status === 403 || response.status === 429 || response.status >= 500;
    if (!canUseRawFallback) {
      throw new Error(`GitHub README 获取失败（${repository.fullName}）：HTTP ${response.status}`);
    }
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(repository.defaultBranch)}/README.md`;
    const fallback = await fetcher(rawUrl, {
      headers: { 'user-agent': 'data-collector-fe-journey/1.0' },
    });
    if (!fallback.ok) {
      throw new Error(
        `GitHub README 获取失败（${repository.fullName}）：HTTP ${response.status}，raw fallback HTTP ${fallback.status}`,
      );
    }
    const fallbackReadme = (await fallback.text()).trim();
    return fallbackReadme.length > 0 ? fallbackReadme.slice(0, 1_000_000) : undefined;
  }
  const readme = (await response.text()).trim();
  return readme.length > 0 ? readme.slice(0, 1_000_000) : undefined;
}

function toDocument(
  repository: GithubRepository,
  readme: string,
  collectedAt: string,
  searchQuery: string,
): CollectedDocument {
  const text = [repository.description, readme].filter(Boolean).join('\n\n');
  return {
    schemaVersion: 1,
    source: 'github',
    kind: 'article',
    url: repository.htmlUrl,
    canonicalUrl: repository.htmlUrl,
    title: repository.fullName,
    author: repository.owner,
    ...(repository.createdAt && Number.isFinite(Date.parse(repository.createdAt))
      ? { publishedAt: new Date(repository.createdAt).toISOString() }
      : {}),
    collectedAt,
    html: `<article><pre>${escapeHtml(text)}</pre></article>`,
    text,
    images: [],
    sourceMetadata: {
      repositoryId: repository.id,
      stars: repository.stars,
      forks: repository.forks,
      openIssues: repository.openIssues,
      updatedAt: repository.updatedAt,
      defaultBranch: repository.defaultBranch,
      searchQuery,
      readmeBytes: Buffer.byteLength(readme, 'utf8'),
      ...(repository.pushedAt ? { pushedAt: repository.pushedAt } : {}),
      ...(repository.license ? { license: repository.license } : {}),
      ...(repository.language ? { language: repository.language } : {}),
      ...(repository.description ? { description: repository.description } : {}),
      ...(repository.topics ? { topics: repository.topics } : {}),
    },
  };
}

/** 使用固定 GitHub 搜索发现项目，并把 README 映射成采集文档。 */
export async function discoverGithubProjects(
  fetcher: typeof fetch,
  now: Clock,
): Promise<CollectedDocument[]> {
  const collectedAt = now();
  const documents: CollectedDocument[] = [];
  const seen = new Set<number>();

  for (const query of FE_JOURNEY_PRESET.github.queries) {
    const searchUrl = new URL('https://api.github.com/search/repositories');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('sort', 'updated');
    searchUrl.searchParams.set('order', 'desc');
    searchUrl.searchParams.set('per_page', '50');
    const response = await fetcher(searchUrl, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'data-collector-fe-journey/1.0',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub 项目搜索失败（${query}）：HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new Error(`GitHub 项目搜索响应格式无效（${query}）`);
    }

    for (const item of payload.items) {
      const repository = parseRepository(item, collectedAt);
      if (!repository || seen.has(repository.id)) continue;
      seen.add(repository.id);
      const readme = await fetchReadme(fetcher, repository);
      // 只有明确的 404 才表示仓库没有 README；限流、服务故障和网络错误必须上报。
      if (!readme) continue;
      documents.push(toDocument(repository, readme, collectedAt, query));
      if (documents.length >= FE_JOURNEY_PRESET.github.maxPerRun) return documents;
    }
  }

  return documents;
}
