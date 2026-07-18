import { createHash } from 'node:crypto';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  validateExtensionDirectory,
  writeExtensionArchive,
} from '../../scripts/package-extension.mjs';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup/index.html',
  'popup/index.js',
  'popup/styles.css',
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
    expect(await validateExtensionDirectory(await fixture())).toEqual(REQUIRED_FILES.sort());
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
