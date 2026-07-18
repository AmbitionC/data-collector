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
  packageExtension,
  validateExtensionDirectory,
  writeExtensionArchive,
} from '../../scripts/package-extension.mjs';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const REQUIRED_FILES = [
  'background.js',
  'content.js',
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
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel/index.html' });
    expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.key).toBe(MANIFEST_PUBLIC_KEY);
    expect(derivedId).toBe(TRUSTED_EXTENSION_ID);
    expect(manifest.version).toBe('0.2.0');
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

    expect(await packageExtension(workspace)).toBe(
      join(workspace, 'artifacts', 'data-collector-extension-0.2.0.zip'),
    );
    expect((await readdir(stable, { recursive: true })).sort()).toEqual([
      'background.js',
      'content.js',
      'manifest.json',
      'sidepanel',
      'sidepanel/index.html',
      'sidepanel/index.js',
      'sidepanel/styles.css',
    ]);
    expect(await readFile(join(stable, 'background.js'), 'utf8')).toBe(
      await readFile(join(dist, 'background.js'), 'utf8'),
    );
    await expect(stat(join(workspace, 'artifacts', 'data-collector-extension-0.1.0.zip')))
      .rejects.toMatchObject({ code: 'ENOENT' });
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
});
