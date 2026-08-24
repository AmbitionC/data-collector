import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MANIFEST_PUBLIC_KEY, TRUSTED_EXTENSION_ID } from '@data-collector/shared';
import {
  commitExtensionArtifacts,
  packageExtension,
  recoverInterruptedExtensionArtifacts,
  validateExtensionArchive,
  validateExtensionDirectory,
  writeExtensionArchive,
} from '../../scripts/package-extension.mjs';
import { acquireArtifactLease } from '../../scripts/artifact-lease.mjs';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const REQUIRED_FILES = [
  'background.js',
  // 构建标记：侧栏右下角显示的「这份产物来自哪个提交」。
  'build-id.txt',
  'content.js',
  'inject.js',
  'manifest.json',
  'sidepanel/index.html',
  'sidepanel/index.js',
  'sidepanel/styles.css',
];
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

async function fixture(): Promise<string> {
  const root = await temporaryDirectories.create('data-collector-package-');
  return writeFixture(root);
}

async function writeFixture(root: string): Promise<string> {
  for (const file of REQUIRED_FILES) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      file === 'manifest.json'
        ? '{"manifest_version":3,"minimum_chrome_version":"116","version":"0.2.0"}'
        : 'safe content',
    );
  }
  return root;
}

describe('extension package validation', () => {
  it('builds each workspace without recursively invoking the root build script', async () => {
    const workspaceRoot = join(import.meta.dirname, '..', '..');
    const rootPackage = JSON.parse(
      await readFile(join(workspaceRoot, 'package.json'), 'utf8'),
    ) as { scripts: { build: string } };

    expect(rootPackage.scripts.build).toBe(
      'npm --workspace=@data-collector/shared run build'
      + ' && npm --workspace=@data-collector/bridge run build'
      + ' && npm --workspace=@data-collector/extension run build',
    );
    expect(rootPackage.scripts.build).not.toContain('npm run build -w');
  });

  it('accepts only the complete production allowlist', async () => {
    expect(await validateExtensionDirectory(await fixture())).toEqual(REQUIRED_FILES);
  });

  it('declares the fixed Edge Side Panel identity without a popup', async () => {
    const manifestPath = join(
      import.meta.dirname,
      '..',
      '..',
      'packages',
      'extension',
      'manifest.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const digest = createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest();
    const derivedId = [...digest.subarray(0, 16)]
      .flatMap(byte => [byte >> 4, byte & 15])
      .map(nibble => String.fromCharCode(97 + nibble))
      .join('');

    expect(manifest.permissions).toContain('sidePanel');
    // 内容脚本缺失时靠注入自愈（绝不刷新页面，那会丢掉站内分类状态）。
    expect(manifest.permissions).toContain('scripting');
    // 主世界脚本必须在 document_start 就位，否则应用的首批接口响应就漏掉了。
    const mainWorld = manifest.content_scripts.find(
      (entry: { world?: string }) => entry.world === 'MAIN',
    );
    expect(mainWorld).toMatchObject({ run_at: 'document_start', js: ['inject.js'] });
    expect(mainWorld.matches.every((pattern: string) => pattern.includes('zsxq.com'))).toBe(true);
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel/index.html' });
    expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.key).toBe(MANIFEST_PUBLIC_KEY);
    expect(derivedId).toBe(TRUSTED_EXTENSION_ID);
    // 不钉死具体版本号（每次迭代都要 bump），钉的是「三处版本必须一致」——
    // 不一致会让 zip 名、侧栏右下角的构建标记和实际产物对不上。
    const packageVersion = JSON.parse(
      await readFile(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ).version;
    const extensionVersion = JSON.parse(
      await readFile(
        join(import.meta.dirname, '..', '..', 'packages', 'extension', 'package.json'),
        'utf8',
      ),
    ).version;
    expect(manifest.version).toBe(packageVersion);
    expect(extensionVersion).toBe(packageVersion);
  });

  it('contains no legacy popup or manual-pairing language in extension production inputs', async () => {
    const workspaceRoot = join(import.meta.dirname, '..', '..');
    const paths = [
      join(workspaceRoot, 'packages', 'extension', 'manifest.json'),
      join(workspaceRoot, 'packages', 'extension', 'scripts', 'build.mjs'),
      join(workspaceRoot, 'scripts', 'package-extension.mjs'),
    ];
    const sourceRoot = join(workspaceRoot, 'packages', 'extension', 'src');
    const sourceFiles = await Array.fromAsync(
      (await import('node:fs/promises')).glob('**/*.*', { cwd: sourceRoot }),
    );
    paths.push(...sourceFiles.map(file => join(sourceRoot, file)));
    const productionPaths = paths.filter(path => !path.endsWith('.map'));
    const contents = await Promise.all(productionPaths.map(path => readFile(path, 'utf8')));

    expect(productionPaths.map(path => path.slice(workspaceRoot.length + 1)).join('\n'))
      .not.toMatch(/popup|pair/i);
    expect(contents.join('\n')).not.toMatch(/popup|pair/i);
    expect(contents.join('\n')).not.toMatch(new RegExp(['配', '对码'].join('')));
  });

  it.each([
    ['background.js.map', '{}'],
    ['.env', 'TOKEN=secret'],
    ['debug.txt', 'safe content'],
  ])('rejects unexpected file %s', async (file, content) => {
    const root = await fixture();
    await writeFile(join(root, file), content);

    await expect(validateExtensionDirectory(root)).rejects.toThrow(/打包文件不在允许清单/);
  });

  it.each(['popup', 'sidepanel/extra'])('rejects unexpected directory %s even when empty', async directory => {
    const root = await fixture();
    await mkdir(join(root, directory), { recursive: true });

    await expect(validateExtensionDirectory(root)).rejects.toThrow(/不允许的目录/);
  });

  it('rejects a symlink before reading or copying its external target', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    const dist = await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    const external = join(await temporaryDirectories.create('data-collector-external-'), 'secret.txt');
    await writeFile(external, 'sk-example-secret-value');
    await symlink(external, join(dist, 'linked-secret.txt'));

    await expect(packageExtension(workspace)).rejects.toThrow(/符号链接.*linked-secret\.txt/);
    expect(await readFile(external, 'utf8')).toBe('sk-example-secret-value');
    expect(await readdir(join(workspace, 'artifacts'))).toEqual([]);
  });

  it('rejects credential-like content', async () => {
    const root = await fixture();
    await writeFile(join(root, 'background.js'), 'const key = "sk-example-secret-value";');

    await expect(validateExtensionDirectory(root)).rejects.toThrow(/疑似凭证/);
  });

  it('creates byte-for-byte reproducible archives without a system zip command', async () => {
    const root = await fixture();
    const output = await temporaryDirectories.create('data-collector-archive-');
    const first = join(output, 'first.zip');
    const second = join(output, 'second.zip');
    await writeExtensionArchive(root, first);
    await utimes(join(root, 'background.js'), new Date(), new Date('2030-01-01T00:00:00Z'));
    await writeExtensionArchive(root, second);

    const digest = async (path: string) =>
      createHash('sha256').update(await readFile(path)).digest('hex');
    expect(await digest(first)).toBe(await digest(second));
  });

  it('derives the archive name from the validated manifest and refreshes the stable directory', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    const dist = await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    const stable = join(workspace, 'artifacts', 'data-collector-extension');
    await mkdir(stable, { recursive: true });
    await writeFile(join(stable, 'stale.txt'), 'stale');
    await writeFile(join(workspace, 'artifacts', 'data-collector-extension-0.1.0.zip'), 'obsolete');
    await writeFile(join(workspace, 'artifacts', 'data-collector-extension-0.1.9.zip'), 'obsolete');
    await writeFile(join(workspace, 'artifacts', 'keep-me.zip'), 'unrelated artifact');

    expect(await packageExtension(workspace)).toBe(
      join(workspace, 'artifacts', 'data-collector-extension-0.2.0.zip'),
    );
    expect((await readdir(stable, { recursive: true })).sort()).toEqual(
      [...REQUIRED_FILES, 'sidepanel'].sort(),
    );
    expect(await readFile(join(stable, 'background.js'), 'utf8')).toBe(
      await readFile(join(dist, 'background.js'), 'utf8'),
    );
    await expect(stat(join(workspace, 'artifacts', 'data-collector-extension-0.1.0.zip')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(workspace, 'artifacts', 'data-collector-extension-0.1.9.zip')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'artifacts', 'keep-me.zip'), 'utf8'))
      .toBe('unrelated artifact');
  });

  it('does not commit the stable directory or archive until the shared artifact lease is available', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    const dist = await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    await writeFile(join(dist, 'build-id.txt'), 'build B', 'utf8');
    const stable = await writeFixture(join(workspace, 'artifacts', 'data-collector-extension'));
    await writeFile(join(stable, 'build-id.txt'), 'build A', 'utf8');
    const lease = await acquireArtifactLease(workspace, {
      role: 'zsxq-sink',
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    let committedValidationStarted = false;
    let packageSettled = false;
    const packaging = packageExtension(workspace, {
      validateCommittedDirectory: async root => {
        committedValidationStarted = true;
        return validateExtensionDirectory(root);
      },
    }).finally(() => { packageSettled = true; });

    await new Promise(resolve => setTimeout(resolve, 75));
    expect(packageSettled).toBe(false);
    expect(committedValidationStarted).toBe(false);
    expect(await readFile(join(stable, 'build-id.txt'), 'utf8')).toBe('build A');

    await lease.release();
    await packaging;
    expect(committedValidationStarted).toBe(true);
    expect(await readFile(join(stable, 'build-id.txt'), 'utf8')).toBe('build B');
  });

  it('does not turn a committed release into a build failure when old archive cleanup fails', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    const obsolete = join(workspace, 'artifacts', 'data-collector-extension-0.1.9.zip');
    await mkdir(join(obsolete, '..'), { recursive: true });
    await writeFile(obsolete, 'obsolete');
    let cleanupAttempts = 0;

    const archive = await packageExtension(workspace, {
      removeObsoleteArchive: async () => {
        cleanupAttempts += 1;
        throw new Error('injected cleanup denial');
      },
      warn: () => undefined,
    });

    expect(cleanupAttempts).toBe(1);
    expect(archive).toBe(join(workspace, 'artifacts', 'data-collector-extension-0.2.0.zip'));
    expect(await readFile(obsolete, 'utf8')).toBe('obsolete');
    expect(await validateExtensionDirectory(
      join(workspace, 'artifacts', 'data-collector-extension'),
    )).toEqual(REQUIRED_FILES);
    await expect(validateExtensionArchive(
      archive,
      join(workspace, 'artifacts', 'data-collector-extension'),
    )).resolves.toEqual(REQUIRED_FILES);
  });

  it('leaves the previous artifacts untouched when dist validation fails', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    const dist = await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    await writeFile(join(dist, 'manifest.json'), '{"manifest_version":3,"minimum_chrome_version":"116"}');
    const stableMarker = join(workspace, 'artifacts', 'data-collector-extension', 'existing.txt');
    const obsoleteArchive = join(workspace, 'artifacts', 'data-collector-extension-0.1.0.zip');
    await mkdir(join(stableMarker, '..'), { recursive: true });
    await writeFile(stableMarker, 'existing');
    await writeFile(obsoleteArchive, 'obsolete');

    await expect(packageExtension(workspace)).rejects.toThrow(/version/);
    expect(await readFile(stableMarker, 'utf8')).toBe('existing');
    expect(await readFile(obsoleteArchive, 'utf8')).toBe('obsolete');
  });

  it('validates the staged archive before touching existing artifacts', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    const artifacts = join(workspace, 'artifacts');
    const stable = join(artifacts, 'data-collector-extension');
    const archive = join(artifacts, 'data-collector-extension-0.2.0.zip');
    await mkdir(stable, { recursive: true });
    await writeFile(join(stable, 'existing.txt'), 'existing stable');
    await writeFile(archive, 'existing archive');

    await expect(packageExtension(workspace, {
      writeArchive: async (_root, destination) => { await writeFile(destination, 'not a zip'); },
    })).rejects.toThrow(/ZIP/);

    expect(await readFile(join(stable, 'existing.txt'), 'utf8')).toBe('existing stable');
    expect(await readFile(archive, 'utf8')).toBe('existing archive');
    expect((await readdir(artifacts)).sort()).toEqual([
      'data-collector-extension',
      'data-collector-extension-0.2.0.zip',
    ]);
  });

  it('rolls back the stable directory and archive when post-rename validation fails', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    const artifacts = join(workspace, 'artifacts');
    const stable = join(artifacts, 'data-collector-extension');
    const archive = join(artifacts, 'data-collector-extension-0.2.0.zip');
    await mkdir(stable, { recursive: true });
    await writeFile(join(stable, 'existing.txt'), 'existing stable');
    await writeFile(archive, 'existing archive');

    await expect(packageExtension(workspace, {
      validateCommittedDirectory: async () => { throw new Error('injected post-rename validation failure'); },
    })).rejects.toThrow(/injected post-rename validation failure/);

    expect(await readFile(join(stable, 'existing.txt'), 'utf8')).toBe('existing stable');
    expect(await readdir(stable)).toEqual(['existing.txt']);
    expect(await readFile(archive, 'utf8')).toBe('existing archive');
    expect((await readdir(artifacts)).sort()).toEqual([
      'data-collector-extension',
      'data-collector-extension-0.2.0.zip',
    ]);
  });

  it('rolls back both artifacts and removes transaction files when archive commit rename fails', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    const artifacts = join(workspace, 'artifacts');
    const stable = join(artifacts, 'data-collector-extension');
    const archive = join(artifacts, 'data-collector-extension-0.2.0.zip');
    await mkdir(stable, { recursive: true });
    await writeFile(join(stable, 'existing.txt'), 'existing stable');
    await writeFile(archive, 'existing archive');

    await expect(packageExtension(workspace, {
      rename: async (source, destination) => {
        if (source.endsWith('extension.zip') && destination === archive) {
          throw Object.assign(new Error('injected archive rename failure'), { code: 'EIO' });
        }
        await fsRename(source, destination);
      },
    })).rejects.toThrow(/injected archive rename failure/);

    expect(await readFile(join(stable, 'existing.txt'), 'utf8')).toBe('existing stable');
    expect(await readdir(stable)).toEqual(['existing.txt']);
    expect(await readFile(archive, 'utf8')).toBe('existing archive');
    expect((await readdir(artifacts)).sort()).toEqual([
      'data-collector-extension',
      'data-collector-extension-0.2.0.zip',
    ]);
  });

  it('recovers the previous artifact pair after a package process dies between renames', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    const dist = await writeFixture(join(workspace, 'packages', 'extension', 'dist'));
    await writeFile(join(dist, 'build-id.txt'), 'build B', 'utf8');
    const artifacts = join(workspace, 'artifacts');
    const stable = await writeFixture(join(artifacts, 'data-collector-extension'));
    await writeFile(join(stable, 'build-id.txt'), 'build A', 'utf8');
    const archive = join(artifacts, 'data-collector-extension-0.2.0.zip');
    await writeExtensionArchive(stable, archive);
    const archiveA = await readFile(archive);
    const interrupted = join(artifacts, '.data-collector-extension-transaction-interrupted');
    await mkdir(interrupted);
    await writeFile(join(interrupted, 'transaction.json'), JSON.stringify({
      version: 1,
      archiveName: 'data-collector-extension-0.2.0.zip',
      hadStableDirectory: true,
      hadArchive: true,
    }));
    await fsRename(stable, join(interrupted, 'previous-directory'));
    await fsRename(archive, join(interrupted, 'previous-archive.zip'));
    await writeFile(archive, 'partial archive B', 'utf8');

    await expect(packageExtension(workspace, {
      writeArchive: async () => { throw new Error('injected staging failure after recovery'); },
    })).rejects.toThrow('injected staging failure after recovery');

    expect(await readFile(join(stable, 'build-id.txt'), 'utf8')).toBe('build A');
    expect(await readFile(archive)).toEqual(archiveA);
    expect(await readdir(artifacts)).not.toContain('.data-collector-extension-transaction-interrupted');
  });

  it('removes an unpublished legacy staging directory that has no transaction journal', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    const orphan = join(
      workspace,
      'artifacts',
      '.data-collector-extension-transaction-unpublished',
    );
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'partial.txt'), 'staged but never published', 'utf8');

    await expect(recoverInterruptedExtensionArtifacts(workspace)).resolves.toBeUndefined();
    await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a completely committed artifact pair when recovery observes its transaction', async () => {
    const workspace = await temporaryDirectories.create('data-collector-workspace-');
    const artifacts = join(workspace, 'artifacts');
    const transactionRoot = join(
      artifacts,
      '.data-collector-extension-transaction-committed-window',
    );
    const stagedDirectory = await writeFixture(join(transactionRoot, 'unpacked'));
    const stagedArchive = join(transactionRoot, 'extension.zip');
    await writeExtensionArchive(stagedDirectory, stagedArchive);
    const stableDirectory = join(artifacts, 'data-collector-extension');
    const archive = join(artifacts, 'data-collector-extension-0.2.0.zip');

    await commitExtensionArtifacts({
      transactionRoot,
      stagedDirectory,
      stagedArchive,
      stableDirectory,
      archive,
    });
    await recoverInterruptedExtensionArtifacts(workspace);

    await expect(validateExtensionDirectory(stableDirectory)).resolves.toEqual(REQUIRED_FILES);
    await expect(validateExtensionArchive(archive, stableDirectory)).resolves.toEqual(REQUIRED_FILES);
    await expect(stat(transactionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
