import { describe, expect, it } from 'vitest';
import {
  parseNowcoderCliArgs,
  runNowcoderCli,
  type CliIo,
} from '../../packages/bridge/src/cli.js';

const ATTEMPT = '0123456789abcdef';
const HASH = 'a'.repeat(64);
const URL = 'https://www.nowcoder.com/discuss/1001';

const session = {
  id: 'session-1',
  queries: ['Agent 面经'],
  queryHash: HASH,
  requestedSort: 'latest' as const,
  provider: 'nowcoder-json' as const,
  sortVerified: true as const,
  createdAt: '2026-08-30T00:00:00.000Z',
  expiresAt: '2026-08-30T00:30:00.000Z',
  candidates: [{
    id: 'candidate-1', canonicalUrl: URL, contentType: 'post' as const,
    matchedQueries: ['Agent 面经'], page: 1, rank: 1,
    publishedAt: '2026-08-29T00:00:00.000Z',
  }],
};

const buildEvidence = {
  applicationVersion: '0.4.33',
  bridgeBuildId: 'build-1',
  artifactBuildId: 'build-1',
  extensionVersion: '0.4.33',
  extensionBuildId: 'build-1',
  extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
  frozenAt: '2026-08-30T00:00:00.000Z',
};

function runningRun(id = 'run-1', key = 'key-1') {
  return {
    id, attempt: ATTEMPT, status: 'running' as const, phase: 'collecting' as const,
    scheduledCandidateIds: [],
    progress: {
      discovered: 1, detailScheduled: 0, detailSaved: 0, inspected: 0,
      qualified: 0, accepted: 0, delivered: 0, rejectionCounts: [],
      companies: [
        { company: 'bytedance' as const, count: 0 },
        { company: 'tencent' as const, count: 0 },
        { company: 'alibaba' as const, count: 0 },
        { company: 'ant' as const, count: 0 },
        { company: 'other' as const, count: 0 },
      ],
    },
    spec: {
      queries: ['Agent 面经'], queryHash: HASH, target: 1, sort: 'latest' as const,
      maxDetails: 24 as const, searchSessionId: session.id, idempotencyKey: key,
      deliveryMode: 'agent-journey-inbox' as const,
    },
    accepted: 0, delivered: 0, deliveryIds: [], publicDeliveryItems: [],
    activeOwnedTabs: 0, peakOwnedTabs: 0, terminalOwnedTabs: 0, buildEvidence,
  };
}

function completedRun(id = 'run-1', key = 'key-1') {
  const stableContentId = 'a1b2c3d4e5f6';
  const contentHash = '1'.repeat(16);
  const lineageId = 'b'.repeat(64);
  const markerHash = 'c'.repeat(64);
  return {
    ...runningRun(id, key),
    status: 'completed' as const,
    phase: 'publishing' as const,
    scheduledCandidateIds: ['candidate-1'],
    progress: {
      discovered: 1, detailScheduled: 1, detailSaved: 1, inspected: 1,
      qualified: 1, accepted: 1, delivered: 1, rejectionCounts: [],
      companies: [
        { company: 'bytedance' as const, count: 0 },
        { company: 'tencent' as const, count: 0 },
        { company: 'alibaba' as const, count: 0 },
        { company: 'ant' as const, count: 0 },
        { company: 'other' as const, count: 1 },
      ],
    },
    accepted: 1,
    delivered: 1,
    deliveryIds: [stableContentId],
    publicDeliveryItems: [{
      stableContentId, canonicalUrl: URL, contentHash, clusterId: 'cluster-1', lineageId,
    }],
    publishReceipt: {
      deliveryIds: [stableContentId], entryHashes: [contentHash], markerHash,
      publishedAt: '2026-08-30T00:10:00.000Z',
    },
  };
}

function io() {
  let stdout = '';
  let stderr = '';
  const target: CliIo = {
    stdout: value => { stdout += value; },
    stderr: value => { stderr += value; },
  };
  return { target, stdout: () => stdout, stderr: () => stderr };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe('minimal Nowcoder CLI', () => {
  it('parses only the bounded five-action grammar', () => {
    expect(parseNowcoderCliArgs([
      'preview', '--query', '字节 Agent 面经', '--query', '阿里 Agent 面经',
      '--target', '10', '--latest', '--port', '17321',
    ])).toMatchObject({ action: 'preview', queries: ['字节 Agent 面经', '阿里 Agent 面经'], target: 10 });
    expect(() => parseNowcoderCliArgs([
      'run', '--session', 's1', '--query', 'Agent', '--latest', '--deliver',
      '--idempotency-key', 'k1',
    ])).toThrow();
    expect(() => parseNowcoderCliArgs(['status', '--run', 'r1', '--run', 'r2'])).toThrow();
    expect(() => parseNowcoderCliArgs(['preview', '--query', '--target', '10', '--latest'])).toThrow();
    expect(() => parseNowcoderCliArgs(['preview', '--query', 'Agent', '--target', '10', '--unknown'])).toThrow();
  });

  it('runs one query preview, starts its exact session, and waits only on the returned run ID', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const output = io();
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.endsWith('/search-sessions')) return json({ session }, 201);
      if (url.endsWith('/runs') && method === 'POST') return json({ run: runningRun() }, 202);
      if (url.endsWith('/runs/run-1')) return json({ run: completedRun() });
      throw new Error(`unexpected ${method} ${url}`);
    };

    const code = await runNowcoderCli([
      'run', '--query', 'Agent 面经', '--target', '1', '--latest', '--deliver',
      '--idempotency-key', 'key-1', '--wait', '100',
    ], output.target, {
      authenticate: async () => ({ baseUrl: 'http://127.0.0.1:17321', token: 'secret' }),
      fetch: fetcher,
      sleep: async () => undefined,
      now: (() => { let value = 0; return () => (value += 10); })(),
    });

    expect(code).toBe(0);
    expect(output.stderr()).toBe('');
    expect(output.stdout().split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(output.stdout())).toEqual(completedRun());
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'POST http://127.0.0.1:17321/v1/nowcoder/search-sessions',
      'POST http://127.0.0.1:17321/v1/nowcoder/runs',
      'GET http://127.0.0.1:17321/v1/nowcoder/runs/run-1',
    ]);
    expect(calls[0]?.body).toEqual({ queries: ['Agent 面经'], target: 1, sort: 'latest' });
    expect(calls[1]?.body).toEqual({
      searchSessionId: session.id, selectedCandidateIds: [],
      idempotencyKey: 'key-1', deliveryAuthorized: true,
    });
  });

  it('cancels by GETting the exact run attempt first', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const output = io();
    const cancelled = {
      ...runningRun(), status: 'cancelled' as const,
      summary: '牛客定向采集已取消', actionable: '如需继续，请使用新的幂等键发起重试运行',
    };
    const code = await runNowcoderCli(['cancel', '--run', 'run-1'], output.target, {
      authenticate: async () => ({ baseUrl: 'http://127.0.0.1:17321', token: 'secret' }),
      fetch: async (input, init = {}) => {
        const url = String(input);
        const method = init.method ?? 'GET';
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, ...(body === undefined ? {} : { body }) });
        return method === 'GET' ? json({ run: runningRun() }) : json({ run: cancelled });
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:17321/v1/nowcoder/runs/run-1', method: 'GET' },
      {
        url: 'http://127.0.0.1:17321/v1/nowcoder/runs/run-1/cancel',
        method: 'POST', body: { attempt: ATTEMPT },
      },
    ]);
    expect(output.stdout().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('waits on the retry response run ID and emits one safe JSON error on failure', async () => {
    const output = io();
    const calls: string[] = [];
    const code = await runNowcoderCli([
      'retry', '--run', 'source-run', '--idempotency-key', 'key-2', '--wait', '100',
    ], output.target, {
      authenticate: async () => ({ baseUrl: 'http://127.0.0.1:17321', token: 'secret' }),
      fetch: async (input, init = {}) => {
        const url = String(input);
        calls.push(`${init.method ?? 'GET'} ${url}`);
        if (url.endsWith('/source-run/retry')) return json({ run: runningRun('run-2', 'key-2') }, 202);
        if (url.endsWith('/runs/run-2')) return json({
          error: { code: 'NOWCODER_DIRECTED_UNAVAILABLE', message: '定向收集服务暂时不可用' },
        }, 503);
        throw new Error('wrong run id');
      },
      sleep: async () => undefined,
      now: (() => { let value = 0; return () => (value += 10); })(),
    });
    expect(code).toBe(1);
    expect(calls).toEqual([
      'POST http://127.0.0.1:17321/v1/nowcoder/runs/source-run/retry',
      'GET http://127.0.0.1:17321/v1/nowcoder/runs/run-2',
    ]);
    expect(output.stdout().split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(output.stdout())).toEqual({
      error: { code: 'NOWCODER_DIRECTED_UNAVAILABLE', message: '定向收集服务暂时不可用' },
    });
    expect(output.stderr()).toBe('');
  });
});
