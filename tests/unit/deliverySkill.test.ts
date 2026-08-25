import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

const repoRoot = resolve(import.meta.dirname, '..', '..');
const skillRoot = join(repoRoot, '.codex', 'skills', 'data-collector-delivery');
const execFileAsync = promisify(execFile);

async function runNode(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync(process.execPath, args, { cwd })).stdout;
}

async function entry(
  repo: string,
  source: 'zsxq' | 'nowcoder',
  name: string,
  meta: unknown,
): Promise<void> {
  const directory = join(repo, '_inbox', source, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

describe('data-collector-delivery skill', () => {
  it.each([
    ['触发知识星球内容收集', 'references/zsxq-delivery.md'],
    ['更新牛客产品内容', 'references/nowcoder-content-delivery.md'],
    ['生成牛客运营候选', 'references/operation-candidates.md'],
  ])('is repository-discoverable for the pressure scenario “%s”', async (_scenario, reference) => {
    const contents = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
    expect(contents).toContain('name: data-collector-delivery');
    expect(contents).toContain(reference);
  });

  it('emits only one batch, isolates malformed metadata, and blocks unsafe candidates', async () => {
    const repo = await temporaryDirectories.create('delivery-manifest-');
    await entry(repo, 'zsxq', 'eligible', {
      id: 'a1b2c3d4e5f6', source: 'zsxq', title: '完整星主内容',
      sourceMetadata: { batchId: 'batch-current', planId: 'zsxq-chen-teacher', authorRole: 'owner' },
    });
    await entry(repo, 'zsxq', 'truncated', {
      id: '0123456789ab', source: 'zsxq', title: '截断内容', truncated: true,
      sourceMetadata: { batchId: 'batch-current', planId: 'zsxq-chen-teacher', authorRole: 'owner' },
    });
    await entry(repo, 'zsxq', 'wrong-author', {
      id: '111111111111', source: 'zsxq', title: '非星主内容',
      sourceMetadata: { batchId: 'batch-current', planId: 'zsxq-chen-teacher', authorRole: 'member' },
    });
    await entry(repo, 'zsxq', 'old-batch', {
      id: '222222222222', source: 'zsxq', title: '历史内容',
      sourceMetadata: { batchId: 'batch-old', planId: 'zsxq-chen-teacher', authorRole: 'owner' },
    });
    const broken = join(repo, '_inbox', 'zsxq', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'meta.json'), '{broken-json');

    const output = await runNode([
      join(skillRoot, 'scripts', 'inbox-manifest.mjs'),
      '--repo', repo,
      '--batch', 'batch-current',
      '--source', 'zsxq',
    ], repo);
    const manifest = JSON.parse(output) as {
      matched: Array<{ id: string }>;
      blocked: Array<{ id: string; reason: string }>;
      malformed: Array<{ path: string; reason: string }>;
    };

    expect(manifest.matched.map(item => item.id)).toEqual(['a1b2c3d4e5f6']);
    expect(manifest.blocked).toEqual([
      expect.objectContaining({ id: '0123456789ab', reason: '正文被截断' }),
      expect.objectContaining({ id: '111111111111', reason: '非星主内容' }),
    ]);
    expect(manifest.malformed).toEqual([
      expect.objectContaining({ path: join('_inbox', 'zsxq', 'broken', 'meta.json') }),
    ]);
    expect(JSON.stringify(manifest)).not.toContain('历史内容');
  });

  it('scopes pooled Nowcoder entries by the delivery batch instead of their capture batch', async () => {
    const repo = await temporaryDirectories.create('delivery-nowcoder-manifest-');
    await entry(repo, 'nowcoder', 'current-delivery', {
      id: 'a1b2c3d4e5f6', source: 'nowcoder', title: '字节 Agent 面经',
      sourceMetadata: {
        batchId: 'capture-batch-old',
        sourceBatchId: 'capture-batch-old',
        deliveryBatchId: 'delivery-batch-current',
        planId: 'nowcoder-agent-market',
        evidenceGrade: 'A',
      },
    });
    await entry(repo, 'nowcoder', 'old-delivery', {
      id: '0123456789ab', source: 'nowcoder', title: '历史交付面经',
      sourceMetadata: {
        batchId: 'capture-batch-current',
        deliveryBatchId: 'delivery-batch-old',
        planId: 'nowcoder-agent-market',
        evidenceGrade: 'A',
      },
    });

    const output = await runNode([
      join(skillRoot, 'scripts', 'inbox-manifest.mjs'),
      '--repo', repo,
      '--batch', 'delivery-batch-current',
      '--source', 'nowcoder',
    ], repo);
    const manifest = JSON.parse(output) as { matched: Array<{ id: string }> };

    expect(manifest.matched.map(item => item.id)).toEqual(['a1b2c3d4e5f6']);
  });

  it('rejects source traversal before reading outside the repository', async () => {
    const repo = await temporaryDirectories.create('delivery-traversal-');
    await expect(runNode([
      join(skillRoot, 'scripts', 'inbox-manifest.mjs'),
      '--repo', repo,
      '--batch', 'batch-current',
      '--source', '../../outside',
    ], repo)).rejects.toThrow(/source/iu);
  });

  it('installs an idempotent global thin entry that points to the canonical repository skill', async () => {
    const root = await temporaryDirectories.create('delivery-skill-global-');
    const script = join(skillRoot, 'scripts', 'install-global-entry.mjs');
    const args = [script, '--target-root', root];
    const first = JSON.parse(await runNode(args, repoRoot)) as { path: string };
    const initial = await readFile(first.path, 'utf8');
    const second = JSON.parse(await runNode(args, repoRoot)) as { path: string };

    expect(second.path).toBe(first.path);
    expect(await readFile(second.path, 'utf8')).toBe(initial);
    expect(initial).toContain(join(skillRoot, 'SKILL.md'));
    expect(initial).not.toContain('执行顺序');
    expect(initial.length).toBeLessThan(900);
  });
});
