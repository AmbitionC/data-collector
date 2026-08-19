import { describe, expect, it, vi } from 'vitest';
import {
  FE_JOURNEY_PRESET,
  discoverGithubProjects,
} from '../../packages/bridge/src/feJourney/index.js';

const NOW = () => '2026-08-19T00:00:00.000Z';

function repository(
  id: number,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const [owner, repo] = name.split('/');
  return {
    id,
    full_name: name,
    html_url: `https://github.com/${name}`,
    owner: { login: owner },
    name: repo,
    fork: false,
    archived: false,
    stargazers_count: 320,
    forks_count: 24,
    open_issues_count: 9,
    created_at: '2025-01-02T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    pushed_at: '2026-08-09T00:00:00.000Z',
    default_branch: 'main',
    license: { spdx_id: 'MIT' },
    language: 'TypeScript',
    description: 'An agent learning project',
    topics: ['ai-agent', 'mcp'],
    ...overrides,
  };
}

describe('fixed fe-journey GitHub discovery', () => {
  it('rejects forks/old repositories, deduplicates searches, fetches README, and isolates README failure', async () => {
    const alpha = repository(1, 'acme/agent-lab');
    const broken = repository(2, 'acme/broken-readme');
    const fork = repository(3, 'someone/forked-agent', { fork: true });
    const old = repository(4, 'legacy/old-agent', { updated_at: '2024-01-01T00:00:00.000Z' });
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/search/repositories') {
        return Response.json({ items: [alpha, alpha, fork, old, broken] });
      }
      if (url.pathname === '/repos/acme/agent-lab/readme') {
        return new Response([
          '# Agent Lab',
          'Production AI agent example with MCP tools and memory.',
          '## Quick start',
          'npm install && npm test',
          'Docker deployment, architecture, evaluation, CI and MIT license.',
        ].join('\n'));
      }
      if (url.pathname === '/repos/acme/broken-readme/readme') {
        return new Response('missing', { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    });

    const documents = await discoverGithubProjects(fetcher, NOW);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      source: 'github',
      kind: 'article',
      url: 'https://github.com/acme/agent-lab',
      canonicalUrl: 'https://github.com/acme/agent-lab',
      title: 'acme/agent-lab',
      author: 'acme',
      collectedAt: NOW(),
      sourceMetadata: {
        repositoryId: 1,
        stars: 320,
        forks: 24,
        openIssues: 9,
        license: 'MIT',
        language: 'TypeScript',
        updatedAt: '2026-08-10T00:00:00.000Z',
        defaultBranch: 'main',
      },
    });
    expect(documents[0]?.text).toContain('Quick start');
    const readmeCalls = fetcher.mock.calls.filter(([input]) => String(input).includes('/readme'));
    expect(readmeCalls).toHaveLength(2);
    expect(readmeCalls.filter(([input]) => String(input).includes('agent-lab'))).toHaveLength(1);
  });

  it('stops after the fixed maximum number of successfully mapped projects', async () => {
    const repositories = Array.from({ length: 15 }, (_, index) =>
      repository(100 + index, `team/agent-project-${index + 1}`));
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/search/repositories') return Response.json({ items: repositories });
      if (url.pathname.endsWith('/readme')) {
        return new Response('# Agent project\nQuick start: npm install. Includes tests and architecture.');
      }
      return new Response('unexpected', { status: 500 });
    });

    const documents = await discoverGithubProjects(fetcher, NOW);

    expect(documents).toHaveLength(FE_JOURNEY_PRESET.github.maxPerRun);
    expect(new Set(documents.map(document => document.canonicalUrl)).size).toBe(documents.length);
    expect(fetcher.mock.calls.filter(([input]) => String(input).includes('/readme'))).toHaveLength(12);
  });
});
