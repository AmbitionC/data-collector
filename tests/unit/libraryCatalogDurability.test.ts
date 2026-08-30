import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { stableContentId, type CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { deleteEntries } from '../../packages/bridge/src/library/manage.js';
import {
  MarkdownLibrary,
  type DirectedTransactionBoundaryContext,
} from '../../packages/bridge/src/library/writer.js';
import { deliveryRevision } from '../../packages/bridge/src/library/deliveryRevision.js';
import { AssetCollisionTracker } from '../../packages/bridge/src/library/assets.js';
import { withCatalogTransaction } from '../../packages/bridge/src/library/catalogTransaction.js';
import { FeJourneyCandidateIndex } from '../../packages/bridge/src/feJourney/candidateIndex.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function collected(url: string, title: string): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title,
    publishedAt: '2026-08-29T00:00:00.000Z',
    collectedAt: '2026-08-30T00:00:00.000Z',
    html: `<p>${title}，包含 Agent 架构、工具调用、记忆与评测。</p>`,
    text: `${title}，包含 Agent 架构、工具调用、记忆与评测。`,
    images: [],
    feJourney: {
      candidateKinds: ['interview'],
      qualityScore: 90,
      qualitySignals: [],
      exclusionReasons: [],
      contentHash: '0123456789abcdef',
      simHash: '1111111111111111',
      clusterId: 'cluster-durability',
    },
  };
}

function directedEvidence(url: string, input: ReturnType<typeof organize>) {
  return {
    nowcoderDirected: {
      runId: 'run-catalog-durability',
      attempt: '0123456789abcdef' as const,
      currentJobId: `job-${stableContentId(url)}`,
      stableContentId: stableContentId(url),
      canonicalUrl: url,
      contentHash: '0123456789abcdef',
      clusterId: 'cluster-durability',
      deliveryRevision: deliveryRevision(input),
    },
  };
}

function waitForMarker(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!output.includes(`${marker}\n`)) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`lock child exited before ${marker}: ${code ?? 'null'}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`lock child failed: ${code ?? 'null'}`)));
  });
}

function waitForCheckpoint(child: ChildProcessWithoutNullStreams): Promise<Record<string, string>> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    let errorOutput = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const line = output.split('\n').find(candidate => candidate.startsWith('CHECKPOINT '));
      if (!line) return;
      cleanup();
      resolvePromise(JSON.parse(line.slice('CHECKPOINT '.length)) as Record<string, string>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `crash child exited before checkpoint: ${code ?? 'null'}/${signal ?? 'none'}`
        + (errorOutput.trim() ? `: ${errorOutput.trim()}` : ''),
      ));
    };
    const onErrorData = (chunk: Buffer) => { errorOutput += chunk.toString('utf8'); };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onErrorData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onErrorData);
    child.once('exit', onExit);
  });
}

async function killAtDirectedCheckpoint(options: {
  workspace: string;
  root: string;
  url: string;
  checkpoint:
    | 'afterIntentCommit'
    | 'catalogTempExclusiveOpen'
    | 'markerExclusiveOpen'
    | 'beforeMarkerInstall'
    | 'beforeEntryCommit'
    | 'beforeCatalogCommit'
    | 'afterCatalogCommit';
}): Promise<Record<string, string>> {
  const childPath = join(options.workspace, `directed-crash-${options.checkpoint}.cjs`);
  await build({
    entryPoints: [resolve('tests/fixtures/directedCatalogCrashChild.ts')],
    outfile: childPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
  const child = spawn(process.execPath, [
    childPath,
    JSON.stringify({ root: options.root, url: options.url, checkpoint: options.checkpoint }),
  ], { stdio: 'pipe' });
  const context = await waitForCheckpoint(child);
  const exited = new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (_code, signal) => signal === 'SIGKILL'
      ? resolvePromise()
      : reject(new Error(`expected SIGKILL, received ${signal ?? 'no signal'}`)));
  });
  child.kill('SIGKILL');
  await exited;
  return context;
}

async function prepareRetiredReplacementCrash(options: {
  name: string;
  url: string;
  assets?: boolean;
}): Promise<{
  root: string;
  catalogDirectory: string;
  pointerPath: string;
  pointerRaw: Buffer;
  previousDirectory: string;
  retiredDirectory: string;
}> {
  const workspace = await temporaryDirectories.create(`${options.name}-`);
  const root = join(workspace, 'library');
  const catalogDirectory = join(root, '_catalog');
  await mkdir(catalogDirectory, { recursive: true });
  await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
  const original = await new MarkdownLibrary({ root }).save(
    organize(collected(options.url, '清退前旧版本')),
  );
  const previousDirectory = dirname(original.markdownPath);
  if (options.assets) {
    await mkdir(join(previousDirectory, 'assets'));
    await writeFile(join(previousDirectory, 'assets', 'a.bin'), 'asset-a\n');
    await writeFile(join(previousDirectory, 'assets', 'b.bin'), 'asset-b\n');
  }
  await killAtDirectedCheckpoint({
    workspace,
    root,
    url: options.url,
    checkpoint: 'afterCatalogCommit',
  });
  const pointerName = (await readdir(catalogDirectory)).find(
    name => name.startsWith('.directed-journal-'),
  )!;
  const pointerPath = join(catalogDirectory, pointerName);
  const pointerRaw = await readFile(pointerPath);
  const journal = JSON.parse(pointerRaw.toString('utf8')) as { transactionId: string };
  const retiredDirectory = join(
    dirname(previousDirectory),
    `.directed-retired-${journal.transactionId}`,
  );
  await rename(previousDirectory, retiredDirectory);
  return {
    root,
    catalogDirectory,
    pointerPath,
    pointerRaw,
    previousDirectory,
    retiredDirectory,
  };
}

function spawnCatalogLockWriter(catalogPath: string, lockPath: string): ChildProcessWithoutNullStreams {
  const childEntry = {
    id: 'cross-process-entry',
    source: 'nowcoder',
    title: '跨进程先写条目',
    url: 'https://www.nowcoder.com/discuss/cross-process-entry',
    category: '人工智能',
    relativePath: '牛客网/人工智能/2026/cross-process-entry/index.md',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
  const script = [
    "const fs = require('node:fs');",
    'const catalogPath = process.argv[1];',
    'const entry = JSON.parse(process.argv[2]);',
    "process.stdout.write('LOCKED\\n');",
    "process.stdin.once('data', () => {",
    "  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));",
    '  catalog.push(entry);',
    "  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\\n');",
    '  process.exit(0);',
    '});',
    'process.stdin.resume();',
  ].join('\n');
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : '/usr/bin/flock';
  const args = process.platform === 'darwin'
    ? ['-k', '-s', '-t', '30', lockPath, process.execPath, '-e', script, catalogPath, JSON.stringify(childEntry)]
    : ['-w', '30', lockPath, process.execPath, '-e', script, catalogPath, JSON.stringify(childEntry)];
  return spawn(command, args, { stdio: 'pipe' });
}

describe('library catalog durability', () => {
  it('tracks thirty synthetic 10 MiB assets with bounded hash metadata and no retained bytes', async () => {
    let sequence = 0;
    const tracker = new AssetCollisionTracker(() => ({
      sha256: (sequence++).toString(16).padStart(64, '0'),
      byteLength: 10 * 1024 * 1024,
    }));
    for (let index = 0; index < 30; index += 1) {
      await tracker.resolve({
        filename: `asset-${index}.png`,
        bytes: new Uint8Array([index]),
        mime: 'image/png',
      }, async () => `assets/asset-${index}.png`);
    }

    const metadata = tracker.metadataSnapshot();
    expect(metadata).toHaveLength(30);
    expect(metadata.every(item => item.byteLength === 10 * 1024 * 1024)).toBe(true);
    expect(metadata.every(item => item.sha256.length === 64)).toBe(true);
    expect(metadata.some(item => Object.hasOwn(item, 'bytes'))).toBe(false);
    expect(JSON.stringify(metadata).length).toBeLessThan(8_000);
  });

  it('reuses an exact asset fingerprint and rejects a differing full-hash collision', async () => {
    const tracker = new AssetCollisionTracker();
    const write = async () => 'assets/same.png';
    await expect(tracker.resolve({
      filename: 'same.png', bytes: new Uint8Array([1, 2, 3]), mime: 'image/png',
    }, write)).resolves.toBe('assets/same.png');
    await expect(tracker.resolve({
      filename: 'same.png', bytes: new Uint8Array([1, 2, 3]), mime: 'image/png',
    }, async () => 'must-not-write')).resolves.toBe('assets/same.png');
    await expect(tracker.resolve({
      filename: 'same.png', bytes: new Uint8Array([1, 2, 4]), mime: 'image/png',
    }, async () => 'must-not-write')).rejects.toThrow('asset filename collision');
    expect(tracker.metadataSnapshot()).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'serializes an ordinary save behind the cross-process catalog lock and reloads the winner',
    async () => {
      const root = await temporaryDirectories.create('library-os-catalog-lock-');
      const catalogDirectory = join(root, '_catalog');
      const catalogPath = join(catalogDirectory, 'index.json');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(catalogPath, '[]\n');
      const child = spawnCatalogLockWriter(
        catalogPath,
        join(catalogDirectory, 'fe-journey.lock'),
      );
      await waitForMarker(child, 'LOCKED');

      const url = 'https://www.nowcoder.com/discuss/ordinary-after-process-lock';
      let settled = false;
      const saving = new MarkdownLibrary({ root })
        .save(organize(collected(url, '普通采集并发写入')))
        .finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(settled).toBe(false);

      const exited = waitForExit(child);
      child.stdin.end('commit\n');
      await exited;
      await saving;
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<{ id: string }>;
      expect(catalog.map(entry => entry.id).sort()).toEqual([
        'cross-process-entry',
        stableContentId(url),
      ].sort());
    },
  );

  it('serializes deleteEntries behind a blocked directed commit without losing either mutation', async () => {
    const root = await temporaryDirectories.create('library-delete-directed-lock-');
    const existingUrl = 'https://www.nowcoder.com/discuss/delete-before-directed';
    const existing = await new MarkdownLibrary({ root })
      .save(organize(collected(existingUrl, '稍后删除的旧条目')));
    const reachedCommit = deferred<void>();
    const releaseCommit = deferred<void>();
    const directedUrl = 'https://www.nowcoder.com/discuss/directed-before-delete';
    const directedInput = organize(collected(directedUrl, '并发定向新条目'));
    const directed = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeCatalogCommit: async (_context: DirectedTransactionBoundaryContext) => {
          reachedCommit.resolve();
          await releaseCommit.promise;
        },
      },
    }).save(directedInput, directedEvidence(directedUrl, directedInput));
    await reachedCommit.promise;

    let deletionSettled = false;
    const deletion = deleteEntries(root, [existing.id])
      .finally(() => { deletionSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(deletionSettled).toBe(false);

    releaseCommit.resolve();
    await expect(directed).resolves.toMatchObject({ id: stableContentId(directedUrl) });
    await expect(deletion).resolves.toEqual({ deleted: 1, missing: 0 });
    const catalog = JSON.parse(
      await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
    ) as Array<{ id: string }>;
    expect(catalog.map(entry => entry.id)).toEqual([stableContentId(directedUrl)]);
  });

  it('lets a lock-owning manage callback bypass a candidate waiter without queue/lock ABBA', async () => {
    const root = await temporaryDirectories.create('library-candidate-nested-lock-');
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(join(root, '_catalog', 'index.json'), '[]\n');
    const index = await FeJourneyCandidateIndex.open(root);
    const outerEntered = deferred<void>();
    const invokeNested = deferred<void>();
    const outer = withCatalogTransaction(root, async () => {
      outerEntered.resolve();
      await invokeNested.promise;
      await index.remove(['missing-candidate']);
    });
    await outerEntered.promise;
    let waiterRan = false;
    const waiter = index.runExclusive(async () => { waiterRan = true; });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 75));
    expect(waiterRan).toBe(false);

    invokeNested.resolve();
    await expect(Promise.race([
      outer.then(() => 'completed' as const),
      new Promise<'timeout'>(resolvePromise => setTimeout(() => resolvePromise('timeout'), 2_000)),
    ])).resolves.toBe('completed');
    await waiter;
    expect(waiterRan).toBe(true);
  });

  it.skipIf(process.platform === 'win32').each([
    'beforeEntryCommit',
    'beforeCatalogCommit',
    'afterCatalogCommit',
  ] as const)(
    'recovers an owned directed transaction after a child is killed at %s',
    async checkpoint => {
      const workspace = await temporaryDirectories.create(`library-directed-crash-${checkpoint}-`);
      const root = join(workspace, 'library');
      const catalogDirectory = join(root, '_catalog');
      const catalogPath = join(catalogDirectory, 'index.json');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(catalogPath, '[]\n');
      const url = `https://www.nowcoder.com/discuss/crash-${checkpoint}`;
      const childContext = await killAtDirectedCheckpoint({
        workspace,
        root,
        url,
        checkpoint,
      });

      const afterCrashCatalog = JSON.parse(await readFile(catalogPath, 'utf8')) as unknown[];
      expect(afterCrashCatalog).toHaveLength(checkpoint === 'afterCatalogCommit' ? 1 : 0);
      expect((await readdir(catalogDirectory)).some(name => name.startsWith('.directed-journal-')))
        .toBe(true);
      if (checkpoint === 'beforeCatalogCommit') {
        expect(await lstat(childContext.finalDirectory!)).toMatchObject({});
      }

      const input = organize(collected(url, `崩溃恢复 ${checkpoint}`));
      const saved = await new MarkdownLibrary({ root })
        .save(input, directedEvidence(url, input));
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<{
        id: string;
        relativePath: string;
      }>;
      expect(catalog).toEqual([
        expect.objectContaining({ id: stableContentId(url) }),
      ]);
      expect(saved.markdownPath).toBe(await realpath(
        join(root, ...catalog[0]!.relativePath.split('/')),
      ));
      expect(await readFile(saved.markdownPath, 'utf8')).toContain(`崩溃恢复 ${checkpoint}`);
      expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
        .toEqual([]);
      expect(await readdir(dirname(saved.markdownPath))).toEqual(['index.md', 'source.json']);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32').each([
    'afterIntentCommit',
    'catalogTempExclusiveOpen',
    'markerExclusiveOpen',
    'beforeMarkerInstall',
  ] as const)(
    'recovers an intent-owned partial transaction after a child is killed at %s',
    async checkpoint => {
      const workspace = await temporaryDirectories.create(`library-intent-crash-${checkpoint}-`);
      const root = join(workspace, 'library');
      const catalogDirectory = join(root, '_catalog');
      const catalogPath = join(catalogDirectory, 'index.json');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(catalogPath, '[]\n');
      const url = `https://www.nowcoder.com/discuss/intent-crash-${checkpoint}`;
      await killAtDirectedCheckpoint({ workspace, root, url, checkpoint });

      expect(JSON.parse(await readFile(catalogPath, 'utf8'))).toEqual([]);
      expect((await readdir(catalogDirectory)).some(name => name.startsWith('.directed-journal-')))
        .toBe(true);
      const input = organize(collected(url, `崩溃恢复 ${checkpoint}`));
      await expect(new MarkdownLibrary({ root }).save(input, directedEvidence(url, input)))
        .resolves.toMatchObject({ id: stableContentId(url) });
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<{ id: string }>;
      expect(catalog.map(entry => entry.id)).toEqual([stableContentId(url)]);
      expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
        .toEqual([]);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed without rewriting a valid-JSON pointer whose identity differs from its marker',
    async () => {
      const workspace = await temporaryDirectories.create('library-pointer-identity-mismatch-');
      const root = join(workspace, 'library');
      const catalogDirectory = join(root, '_catalog');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
      const url = 'https://www.nowcoder.com/discuss/pointer-identity-mismatch';
      const context = await killAtDirectedCheckpoint({
        workspace,
        root,
        url,
        checkpoint: 'beforeEntryCommit',
      });
      const markerRaw = await readFile(join(
        context.stagingDirectory!,
        '.data-collector-directed-transaction.json',
      ));
      const pointerName = (await readdir(catalogDirectory)).find(
        name => name.startsWith('.directed-journal-'),
      )!;
      const mismatched = Buffer.from(`${JSON.stringify({
        ...(JSON.parse(markerRaw.toString('utf8')) as Record<string, unknown>),
        canonicalUrl: 'https://www.nowcoder.com/discuss/a-different-identity',
      }, null, 2)}\n`);
      const pointerPath = join(catalogDirectory, pointerName);
      await writeFile(pointerPath, mismatched);
      const input = organize(collected(url, '不同身份的指针不得被修复'));

      await expect(new MarkdownLibrary({ root }).save(input, directedEvidence(url, input)))
        .rejects.toMatchObject({ code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT' });
      expect(await readFile(pointerPath)).toEqual(mismatched);
      expect(await readFile(join(
        context.stagingDirectory!,
        '.data-collector-directed-transaction.json',
      ))).toEqual(markerRaw);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'recovers every pending transaction before establishing an unrelated directed baseline',
    async () => {
      const workspace = await temporaryDirectories.create('library-recovery-before-baseline-');
      const root = join(workspace, 'library');
      const catalogDirectory = join(root, '_catalog');
      const catalogPath = join(catalogDirectory, 'index.json');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(catalogPath, '[]\n');
      const firstUrl = 'https://www.nowcoder.com/discuss/recovery-before-baseline-a';
      await killAtDirectedCheckpoint({
        workspace,
        root,
        url: firstUrl,
        checkpoint: 'beforeCatalogCommit',
      });

      const secondUrl = 'https://www.nowcoder.com/discuss/recovery-before-baseline-b';
      const second = organize(collected(secondUrl, '事务 B 在 A 恢复后建立基线'));
      await expect(new MarkdownLibrary({ root }).save(
        second,
        directedEvidence(secondUrl, second),
      )).resolves.toMatchObject({ id: stableContentId(secondUrl) });

      const first = organize(collected(firstUrl, '崩溃恢复 beforeCatalogCommit'));
      await expect(new MarkdownLibrary({ root }).save(
        first,
        directedEvidence(firstUrl, first),
      )).resolves.toMatchObject({ id: stableContentId(firstUrl) });
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Array<{ id: string }>;
      expect(catalog.map(entry => entry.id).sort()).toEqual([
        stableContentId(firstUrl),
        stableContentId(secondUrl),
      ].sort());
      expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
        .toEqual([]);
    },
    30_000,
  );

  it('durably installs a non-sensitive intent before creating the staging directory', async () => {
    const root = await temporaryDirectories.create('library-intent-before-stage-');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
    const url = 'https://www.nowcoder.com/discuss/intent-before-stage';
    const input = organize(collected(url, '敏感正文不得早于事务意图'));
    let observedIntent: unknown;
    const library = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeExclusiveCreate: async kind => {
          if (kind !== 'directory') return;
          const pointer = (await readdir(catalogDirectory)).find(
            name => name.startsWith('.directed-journal-'),
          );
          if (pointer) observedIntent = JSON.parse(await readFile(join(catalogDirectory, pointer), 'utf8'));
          throw new Error('stop before staging directory');
        },
      },
    });

    await expect(library.save(input, directedEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
    });
    expect(observedIntent).toMatchObject({
      version: 1,
      state: 'intent',
      stableContentId: stableContentId(url),
      source: 'nowcoder',
    });
    expect((await readdir(catalogDirectory)).some(name => name.startsWith('.directed-entry-')))
      .toBe(false);
  });

  it.skipIf(process.platform === 'win32').each([
    ['zero', (raw: Buffer) => raw.subarray(0, 0)],
    ['partial', (raw: Buffer) => raw.subarray(0, Math.floor(raw.byteLength / 2))],
    ['valid-short', (raw: Buffer) => raw.subarray(0, raw.byteLength - 1)],
  ] as const)(
    'atomically repairs a %s pointer from the validated full marker',
    async (_kind, corrupt) => {
      const workspace = await temporaryDirectories.create('library-pointer-repair-matrix-');
      const root = join(workspace, 'library');
      const catalogDirectory = join(root, '_catalog');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
      const url = `https://www.nowcoder.com/discuss/pointer-repair-${_kind}`;
      const context = await killAtDirectedCheckpoint({
        workspace,
        root,
        url,
        checkpoint: 'beforeEntryCommit',
      });
      const marker = await readFile(
        join(context.stagingDirectory!, '.data-collector-directed-transaction.json'),
      );
      const pointerName = (await readdir(catalogDirectory)).find(
        name => name.startsWith('.directed-journal-'),
      )!;
      await writeFile(join(catalogDirectory, pointerName), corrupt(marker));
      const input = organize(collected(url, '崩溃恢复 beforeEntryCommit'));

      await expect(new MarkdownLibrary({ root }).save(input, directedEvidence(url, input)))
        .resolves.toMatchObject({ id: stableContentId(url) });
      expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
        .toEqual([]);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a registered entry byte-stable when its directed replacement child dies before catalog commit',
    async () => {
      const workspace = await temporaryDirectories.create('library-directed-update-crash-');
      const root = join(workspace, 'library');
      const url = 'https://www.nowcoder.com/discuss/crash-registered-update';
      const original = await new MarkdownLibrary({ root })
        .save(organize(collected(url, '已有条目的旧版本')));
      const catalogPath = join(root, '_catalog', 'index.json');
      const catalogBefore = await readFile(catalogPath, 'utf8');
      const markdownBefore = await readFile(original.markdownPath, 'utf8');

      await killAtDirectedCheckpoint({
        workspace,
        root,
        url,
        checkpoint: 'beforeCatalogCommit',
      });

      expect(await readFile(catalogPath, 'utf8')).toBe(catalogBefore);
      expect(await readFile(original.markdownPath, 'utf8')).toBe(markdownBefore);
      const replacement = organize(collected(url, '崩溃恢复 beforeCatalogCommit'));
      const saved = await new MarkdownLibrary({ root })
        .save(replacement, directedEvidence(url, replacement));
      expect(await readFile(saved.markdownPath, 'utf8')).toContain('崩溃恢复 beforeCatalogCommit');
      expect(JSON.parse(await readFile(catalogPath, 'utf8'))).toEqual([
        expect.objectContaining({ id: stableContentId(url), title: '崩溃恢复 beforeCatalogCommit' }),
      ]);
      await expect(lstat(dirname(original.markdownPath))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(dirname(dirname(saved.markdownPath)))).toHaveLength(1);
    },
    30_000,
  );

  it('rejects an unexpected file in a registered tree before writing transaction artifacts', async () => {
    const root = await temporaryDirectories.create('library-retirement-unexpected-file-');
    const url = 'https://www.nowcoder.com/discuss/retirement-unexpected-file';
    const library = new MarkdownLibrary({ root });
    const originalInput = organize(collected(url, '旧版本含用户文件'));
    const original = await library.save(originalInput);
    const userFile = join(dirname(original.markdownPath), 'user-notes.txt');
    await writeFile(userFile, 'do not delete\n');
    const catalogPath = join(root, '_catalog', 'index.json');
    const catalogBefore = await readFile(catalogPath, 'utf8');
    const incoming = organize(collected(url, '新版本不得删除用户文件'));

    await expect(library.save(incoming, directedEvidence(url, incoming))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });
    expect(await readFile(userFile, 'utf8')).toBe('do not delete\n');
    expect(await readFile(catalogPath, 'utf8')).toBe(catalogBefore);
    expect((await readdir(join(root, '_catalog'))).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('preserves a registered tree that changes after its retirement inventory is bound', async () => {
    const root = await temporaryDirectories.create('library-retirement-tree-change-');
    const url = 'https://www.nowcoder.com/discuss/retirement-tree-change';
    const original = await new MarkdownLibrary({ root }).save(
      organize(collected(url, '旧版本等待替换')),
    );
    const oldDirectory = dirname(original.markdownPath);
    const userFile = join(oldDirectory, 'late-user-notes.txt');
    const incoming = organize(collected(url, '新版本已提交'));
    const saved = await new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeCatalogCommit: async () => {
          await writeFile(userFile, 'arrived after inventory\n');
        },
      },
    }).save(incoming, directedEvidence(url, incoming));

    expect(await readFile(saved.markdownPath, 'utf8')).toContain('新版本已提交');
    expect(await readFile(userFile, 'utf8')).toBe('arrived after inventory\n');
    expect((await readdir(join(root, '_catalog'))).some(
      name => name.startsWith('.directed-journal-'),
    )).toBe(true);
    expect((await lstat(oldDirectory)).isDirectory()).toBe(true);
  });

  it('preserves a recoverable published journal after a pre-commit failure', async () => {
    const root = await temporaryDirectories.create('library-pointer-cleanup-failure-');
    const catalogDirectory = join(root, '_catalog');
    const catalogPath = join(catalogDirectory, 'index.json');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogPath, '[]\n');
    const url = 'https://www.nowcoder.com/discuss/pointer-cleanup-failure';
    const input = organize(collected(url, '清理失败后可恢复'));
    let boundary: DirectedTransactionBoundaryContext | undefined;
    const failing = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeCatalogCommit: async context => {
          boundary = context;
          throw new Error('injected pre-commit failure');
        },
        beforeUniqueCleanup: async path => {
          if (path.includes('.directed-journal-')) {
            throw new Error('injected journal pointer cleanup failure');
          }
        },
      },
    });

    await expect(failing.save(input, directedEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });
    const leaves = await readdir(catalogDirectory);
    expect(leaves.some(name => name.startsWith('.directed-journal-'))).toBe(true);
    expect(leaves.some(name => name.startsWith('.directed-catalog-'))).toBe(true);
    expect(await readFile(
      join(boundary!.finalDirectory, '.data-collector-directed-transaction.json'),
      'utf8',
    )).toContain('"version": 1');

    await expect(new MarkdownLibrary({ root }).save(input, directedEvidence(url, input)))
      .resolves.toMatchObject({ id: stableContentId(url) });
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('preserves the complete journal instead of entering a partial pre-commit cleanup', async () => {
    const root = await temporaryDirectories.create('library-stage-cleanup-failure-');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
    const url = 'https://www.nowcoder.com/discuss/stage-cleanup-failure';
    const input = organize(collected(url, '隐藏条目清理失败后可恢复'));
    let cleanupAttempted = false;
    let boundary: DirectedTransactionBoundaryContext | undefined;
    const failing = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeCatalogCommit: async context => {
          boundary = context;
          throw new Error('injected pre-commit failure');
        },
        beforeUniqueCleanup: async path => {
          if (path.includes('.directed-entry-')) {
            cleanupAttempted = true;
            throw new Error('injected entry-stage cleanup failure');
          }
        },
      },
    });

    await expect(failing.save(input, directedEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });
    const interrupted = await readdir(catalogDirectory);
    expect(cleanupAttempted).toBe(false);
    expect(interrupted.some(name => name.startsWith('.directed-journal-'))).toBe(true);
    expect(interrupted.some(name => name.startsWith('.directed-catalog-'))).toBe(true);
    expect(await readFile(
      join(boundary!.finalDirectory, '.data-collector-directed-transaction.json'),
      'utf8',
    )).toContain('"version": 1');

    await expect(new MarkdownLibrary({ root }).save(input, directedEvidence(url, input)))
      .resolves.toMatchObject({ id: stableContentId(url) });
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('repairs a partial pointer from the durable exact stage marker', async () => {
    const root = await temporaryDirectories.create('library-partial-pointer-recovery-');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
    const url = 'https://www.nowcoder.com/discuss/partial-pointer-recovery';
    const input = organize(collected(url, '指针初始化中断后可恢复'));
    const failing = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        afterExclusiveOpen: async kind => {
          if (kind === 'journal-pointer') {
            throw new Error('injected pointer initialization failure');
          }
        },
      },
    });

    await expect(failing.save(input, directedEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
      message: '本机目录格式无效',
    });
    const stageName = (await readdir(catalogDirectory)).find(
      name => name.startsWith('.directed-entry-'),
    );
    expect(stageName).toBeDefined();
    const transactionId = stageName!.slice('.directed-entry-'.length);
    const pointerPath = join(catalogDirectory, `.directed-journal-${transactionId}.json`);
    const marker = await readFile(join(
      catalogDirectory,
      stageName!,
      '.data-collector-directed-transaction.json',
    ));
    await writeFile(pointerPath, marker.subarray(0, Math.floor(marker.byteLength / 2)));

    await expect(new MarkdownLibrary({ root }).save(input, directedEvidence(url, input)))
      .resolves.toMatchObject({ id: stableContentId(url) });
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('recognizes and resumes a durable marker plus intent before full-pointer installation', async () => {
    const root = await temporaryDirectories.create('library-marker-only-recovery-');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
    const url = 'https://www.nowcoder.com/discuss/marker-only-recovery';
    const input = organize(collected(url, '仅有持久标记时继续原事务'));
    const failing = new MarkdownLibrary({
      root,
      directedTransactionIo: {
        afterExclusiveOpen: async kind => {
          if (kind === 'journal-pointer') throw new Error('injected pointer-open failure');
        },
      },
    });

    await expect(failing.save(input, directedEvidence(url, input))).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
    });
    const leaves = await readdir(catalogDirectory);
    expect(leaves.some(name => name.startsWith('.directed-entry-'))).toBe(true);
    expect(leaves.some(name => name.startsWith('.directed-journal-'))).toBe(true);

    await expect(new MarkdownLibrary({ root }).save(input, directedEvidence(url, input)))
      .resolves.toMatchObject({ id: stableContentId(url) });
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
  });

  it('reconciles a committed pointer left after marker-first cleanup', async () => {
    const root = await temporaryDirectories.create('library-committed-pointer-recovery-');
    const catalogDirectory = join(root, '_catalog');
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, 'index.json'), '[]\n');
    const url = 'https://www.nowcoder.com/discuss/committed-pointer-recovery';
    const input = organize(collected(url, '目录已落盘但指针清理中断'));
    let injected = false;
    const saved = await new MarkdownLibrary({
      root,
      directedTransactionIo: {
        beforeUniqueCleanup: async path => {
          if (!injected && path.includes('.directed-journal-')) {
            injected = true;
            throw new Error('injected committed pointer cleanup failure');
          }
        },
      },
    }).save(input, directedEvidence(url, input));

    expect(injected).toBe(true);
    expect((await readdir(catalogDirectory)).some(name => name.startsWith('.directed-journal-')))
      .toBe(true);
    expect(await readdir(dirname(saved.markdownPath))).toEqual(['index.md', 'source.json']);

    const otherUrl = 'https://www.nowcoder.com/discuss/ordinary-after-pointer-recovery';
    await new MarkdownLibrary({ root }).save(organize(collected(otherUrl, '普通写入触发恢复')));
    expect((await readdir(catalogDirectory)).filter(name => name.startsWith('.directed-')))
      .toEqual([]);
    expect(JSON.parse(await readFile(join(catalogDirectory, 'index.json'), 'utf8')))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: stableContentId(url) }),
        expect.objectContaining({ id: stableContentId(otherUrl) }),
      ]));
  });

  it.skipIf(process.platform === 'win32').each([
    ['corrupt', (_raw: Buffer) => Buffer.from('{"foreign":true}\n')],
    ['foreign', (raw: Buffer) => {
      const foreignUrl = 'https://www.nowcoder.com/discuss/foreign-final-marker';
      const foreignId = stableContentId(foreignUrl);
      const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      return Buffer.from(`${JSON.stringify({
        ...value,
        stableContentId: foreignId,
        canonicalUrl: foreignUrl,
        catalogEntry: {
          ...(value.catalogEntry as Record<string, unknown>),
          id: foreignId,
          url: foreignUrl,
        },
      }, null, 2)}\n`);
    }],
  ] as const)(
    'fails closed on a %s published marker without rewriting its authoritative pointer',
    async (_kind, mutateMarker) => {
      const workspace = await temporaryDirectories.create('library-directed-crash-mismatch-');
      const root = join(workspace, 'library');
      const catalogDirectory = join(root, '_catalog');
      const catalogPath = join(catalogDirectory, 'index.json');
      await mkdir(catalogDirectory, { recursive: true });
      await writeFile(catalogPath, '[]\n');
      const url = 'https://www.nowcoder.com/discuss/crash-marker-mismatch';
      const context = await killAtDirectedCheckpoint({
        workspace,
        root,
        url,
        checkpoint: 'beforeCatalogCommit',
      });
      const markerPath = join(
        context.finalDirectory!,
        '.data-collector-directed-transaction.json',
      );
      const originalMarker = await readFile(markerPath);
      const pointerName = (await readdir(catalogDirectory)).find(
        name => name.startsWith('.directed-journal-'),
      )!;
      const pointerPath = join(catalogDirectory, pointerName);
      const originalPointer = await readFile(pointerPath);
      const mutatedMarker = mutateMarker(originalMarker);
      await writeFile(markerPath, mutatedMarker);
      const unrelatedUrl = `https://www.nowcoder.com/discuss/unrelated-after-${_kind}-marker`;
      const input = organize(collected(unrelatedUrl, '无关事务不得采用损坏标记'));

      await expect(new MarkdownLibrary({ root }).save(
        input,
        directedEvidence(unrelatedUrl, input),
      ))
        .rejects.toMatchObject({
          code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
          message: '本机目录格式无效',
        });
      expect(await readFile(catalogPath, 'utf8')).toBe('[]\n');
      expect(await readFile(markerPath)).toEqual(mutatedMarker);
      expect(await readFile(pointerPath)).toEqual(originalPointer);
      expect((await readdir(catalogDirectory)).some(name => name.startsWith('.directed-journal-')))
        .toBe(true);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32').each([
    'missing-index',
    'one-asset-with-nonempty-assets-directory',
    'empty-assets-directory',
    'missing-assets-subtree',
  ] as const)(
    'resumes deterministic retired-tree removal from the %s cut',
    async cut => {
      const url = `https://www.nowcoder.com/discuss/retired-subset-${cut}`;
      const context = await prepareRetiredReplacementCrash({
        name: `library-retired-subset-${cut}`,
        url,
        assets: true,
      });
      const assetsDirectory = join(context.retiredDirectory, 'assets');
      if (cut === 'missing-index') {
        await unlink(join(context.retiredDirectory, 'index.md'));
      } else if (cut === 'one-asset-with-nonempty-assets-directory') {
        await unlink(join(assetsDirectory, 'a.bin'));
      } else {
        await unlink(join(assetsDirectory, 'a.bin'));
        await unlink(join(assetsDirectory, 'b.bin'));
        if (cut === 'missing-assets-subtree') await rmdir(assetsDirectory);
      }
      const unrelatedUrl = `https://www.nowcoder.com/discuss/unrelated-after-${cut}`;
      const unrelated = organize(collected(unrelatedUrl, '无关事务触发部分清退恢复'));

      await expect(new MarkdownLibrary({ root: context.root }).save(
        unrelated,
        directedEvidence(unrelatedUrl, unrelated),
      )).resolves.toMatchObject({ id: stableContentId(unrelatedUrl) });
      await expect(lstat(context.retiredDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(context.previousDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(context.catalogDirectory)).filter(name => name.startsWith('.directed-')))
        .toEqual([]);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32').each([
    'unknown-path',
    'changed-source',
  ] as const)(
    'preserves a retired tree with %s and its journal after the retirement rename',
    async corruption => {
      const url = `https://www.nowcoder.com/discuss/retired-corrupt-${corruption}`;
      const context = await prepareRetiredReplacementCrash({
        name: `library-retired-corrupt-${corruption}`,
        url,
      });
      const preservedPath = corruption === 'unknown-path'
        ? join(context.retiredDirectory, 'user-notes.txt')
        : join(context.retiredDirectory, 'source.json');
      const preservedBytes = corruption === 'unknown-path'
        ? Buffer.from('created after retirement rename\n')
        : Buffer.from('{"changed":true}\n');
      await writeFile(preservedPath, preservedBytes);
      const unrelatedUrl = `https://www.nowcoder.com/discuss/unrelated-after-${corruption}`;
      const unrelated = organize(collected(unrelatedUrl, '无关事务触发损坏清退恢复'));

      await expect(new MarkdownLibrary({ root: context.root }).save(
        unrelated,
        directedEvidence(unrelatedUrl, unrelated),
      )).rejects.toMatchObject({
        code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
        message: '本机目录格式无效',
      });
      expect(await readFile(preservedPath)).toEqual(preservedBytes);
      expect(await readFile(context.pointerPath)).toEqual(context.pointerRaw);
      expect((await lstat(context.retiredDirectory)).isDirectory()).toBe(true);
      await expect(lstat(context.previousDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30_000,
  );
});
