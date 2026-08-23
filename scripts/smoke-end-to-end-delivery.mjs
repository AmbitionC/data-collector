import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const WORKSPACE = resolve(import.meta.dirname, '..');
const EXPECTED_VERSION = '0.4.21';
const CURRENT_BATCH = 'delivery-smoke-current';
const OLD_BATCH = 'delivery-smoke-old';

async function writeEntry(root, source, name, meta, body = '# fixture\n\n正文。\n') {
  const directory = join(root, '_inbox', source, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await writeFile(join(directory, 'original.md'), body, 'utf8');
  return directory;
}

function lifeMeta(id, overrides = {}) {
  return {
    id,
    source: 'zsxq',
    title: `知识星球 fixture ${id}`,
    sourceMetadata: {
      batchId: CURRENT_BATCH,
      planId: 'zsxq-chen-teacher',
      authorRole: 'owner',
    },
    ...overrides,
  };
}

function feMeta(id, overrides = {}) {
  return {
    id,
    source: 'nowcoder',
    title: `牛客 Agent 面经 fixture ${id}`,
    url: `https://www.nowcoder.com/discuss/${id}`,
    sourceMetadata: {
      batchId: CURRENT_BATCH,
      planId: 'nowcoder-agent-market',
      evidenceGrade: 'A',
    },
    feJourney: {
      candidateKinds: ['interview', 'knowledge'],
      qualityScore: 80,
      clusterId: 'cluster-agent-loop',
    },
    ...overrides,
  };
}

async function runManifest(repo) {
  const script = join(WORKSPACE, '.codex', 'skills', 'data-collector-delivery', 'scripts', 'inbox-manifest.mjs');
  const { stdout } = await execFileAsync(process.execPath, [
    script, '--repo', repo, '--batch', CURRENT_BATCH, '--source', 'zsxq',
  ]);
  return JSON.parse(stdout);
}

async function loadOwnedTabsRegistry(temporaryRoot) {
  const output = join(temporaryRoot, 'owned-tabs.mjs');
  await build({
    entryPoints: [join(WORKSPACE, 'packages', 'extension', 'src', 'background', 'ownedTabs.ts')],
    outfile: output,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    legalComments: 'none',
  });
  return import(`${pathToFileURL(output).href}?smoke=${Date.now()}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(WORKSPACE, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, EXPECTED_VERSION, `端到端交付烟测要求版本 ${EXPECTED_VERSION}`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'data-collector-delivery-smoke-'));
  try {
    const lifeRoot = join(temporaryRoot, 'life-teachers');
    const feRoot = join(temporaryRoot, 'front-end-journey-resource');
    await Promise.all([mkdir(lifeRoot, { recursive: true }), mkdir(feRoot, { recursive: true })]);

    const lifeEligible = await writeEntry(lifeRoot, 'zsxq', 'eligible', lifeMeta('111111111111'));
    const lifeBlocked = await writeEntry(lifeRoot, 'zsxq', 'blocked', lifeMeta('222222222222', { truncated: true }));
    await writeEntry(lifeRoot, 'zsxq', 'old-batch', lifeMeta('333333333333', {
      sourceMetadata: { batchId: OLD_BATCH, planId: 'zsxq-chen-teacher', authorRole: 'owner' },
    }));
    const life = await runManifest(lifeRoot);
    assert.deepEqual(life.matched.map(item => item.id), ['111111111111']);
    assert.deepEqual(life.blocked.map(item => item.id), ['222222222222']);

    const feEligibleA = await writeEntry(feRoot, 'nowcoder', 'eligible-a', feMeta('aaaaaaaaaaaa'));
    const feEligibleB = await writeEntry(feRoot, 'nowcoder', 'eligible-b', feMeta('bbbbbbbbbbbb', {
      sourceMetadata: { batchId: CURRENT_BATCH, planId: 'nowcoder-agent-market', evidenceGrade: 'B' },
    }));
    const feBlocked = await writeEntry(feRoot, 'nowcoder', 'blocked-c', feMeta('cccccccccccc', {
      sourceMetadata: { batchId: CURRENT_BATCH, planId: 'nowcoder-agent-market', evidenceGrade: 'C' },
      feJourney: { candidateKinds: ['interview'], qualityScore: 70, clusterId: 'cluster-c-only' },
    }));
    const operation = await writeEntry(feRoot, 'nowcoder', 'operation', feMeta('dddddddddddd', {
      feJourney: { candidateKinds: ['operation'], qualityScore: 75, clusterId: 'cluster-operation' },
    }));
    await writeEntry(feRoot, 'nowcoder', 'old-batch', feMeta('eeeeeeeeeeee', {
      sourceMetadata: { batchId: OLD_BATCH, planId: 'nowcoder-agent-market', evidenceGrade: 'A' },
      feJourney: { candidateKinds: ['interview'], qualityScore: 90, clusterId: 'cluster-old' },
    }));

    const inspectorPath = join(
      process.env.FE_JOURNEY_REPO ?? resolve(WORKSPACE, '..', 'front-end-journey-resource'),
      '.codex', 'skills', 'curate-fe-journey-inbox', 'scripts', 'inspect-batch.mjs',
    );
    const { inspectBatch } = await import(pathToFileURL(inspectorPath).href);
    const fe = await inspectBatch(feRoot, CURRENT_BATCH);
    assert.deepEqual(fe.publicContent.map(item => item.clusterId), ['cluster-agent-loop']);
    assert.deepEqual(fe.publicContent[0].sources.map(item => item.grade), ['A', 'B']);
    assert.deepEqual(fe.blocked.map(item => item.clusterId), ['cluster-c-only']);
    assert.deepEqual(fe.operation.map(item => item.clusterId), ['cluster-operation']);

    // 模拟仓库 Skill 成功提交后的精确消费：只删已完成的公开内容，阻塞项和运营候选保留。
    await Promise.all([
      rm(lifeEligible, { recursive: true }),
      rm(feEligibleA, { recursive: true }),
      rm(feEligibleB, { recursive: true }),
    ]);
    assert.equal(await exists(lifeEligible), false);
    assert.equal(await exists(feEligibleA), false);
    assert.equal(await exists(feEligibleB), false);
    assert.equal(await exists(lifeBlocked), true);
    assert.equal(await exists(feBlocked), true);
    assert.equal(await exists(operation), true);

    const { OwnedTabRegistry, OWNED_TABS_STORAGE_KEY } = await loadOwnedTabsRegistry(temporaryRoot);
    let stored = {};
    const removed = [];
    const registry = new OwnedTabRegistry({
      async get() { return stored; },
      async set(values) { stored = { ...stored, ...values }; },
    }, {
      async remove(id) { removed.push(id); },
    }, () => 1_777_000_000_000);
    await registry.track({ id: 41, url: 'https://www.nowcoder.com/discuss/41' }, 'remote-job');
    await registry.track({ id: 42, url: 'https://wx.zsxq.com/group/fixture' }, 'zsxq-plan');
    await registry.cleanupStale();
    assert.deepEqual(removed, [41, 42]);
    assert.deepEqual(stored[OWNED_TABS_STORAGE_KEY].owned, []);

    const report = {
      ok: true,
      version: packageJson.version,
      batch: CURRENT_BATCH,
      life: { matched: life.matched.length, blockedRetained: await exists(lifeBlocked) },
      nowcoder: {
        publicClusters: fe.publicContent.length,
        operationCandidates: fe.operation.length,
        blockedRetained: await exists(feBlocked),
      },
      consumed: 3,
      ownedTabsAtTerminal: stored[OWNED_TABS_STORAGE_KEY].owned.length,
    };
    const reportPath = join(WORKSPACE, 'artifacts', 'smoke-end-to-end-delivery.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
