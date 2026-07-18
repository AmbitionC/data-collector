import { createHash } from 'node:crypto';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MANIFEST_PUBLIC_KEY, TRUSTED_EXTENSION_ID } from '@data-collector/shared';
import {
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
  for (const file of REQUIRED_FILES) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      file === 'manifest.json'
        ? '{"manifest_version":3,"minimum_chrome_version":"116"}'
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
      .not.toMatch(/popup|pair|unpaired/i);
    expect(contents.join('\n')).not.toMatch(/popup|pair|配对码|unpaired/i);
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
});
