import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: root, encoding: 'utf8' });
  return stdout.trim();
}

async function fixture(): Promise<string> {
  const workspaceRoot = join(import.meta.dirname, '..', '..');
  const root = await temporaryDirectories.create('data-collector-build-stamp-');
  const extensionRoot = join(root, 'packages', 'extension');

  await mkdir(join(extensionRoot, 'src', 'sidepanel'), { recursive: true });
  await cp(
    join(workspaceRoot, 'packages', 'extension', 'scripts'),
    join(extensionRoot, 'scripts'),
    { recursive: true },
  );
  await writeFile(
    join(extensionRoot, 'manifest.json'),
    '{"manifest_version":3,"version":"9.8.7"}',
  );
  await writeFile(join(extensionRoot, 'src', 'sidepanel', 'index.html'), '<main></main>');
  await writeFile(join(extensionRoot, 'src', 'sidepanel', 'styles.css'), 'main {}');
  await writeFile(join(root, 'tracked.txt'), 'committed\n');
  await writeFile(
    join(root, '.gitignore'),
    ['node_modules/', 'dist/', 'artifacts/', 'ignored/'].join('\n') + '\n',
  );

  // 构建标记本身走真实脚本；只替换无关且耗时的 esbuild 打包器。
  const esbuildRoot = join(root, 'node_modules', 'esbuild');
  await mkdir(esbuildRoot, { recursive: true });
  await writeFile(
    join(esbuildRoot, 'package.json'),
    '{"name":"esbuild","type":"module","exports":"./index.js"}',
  );
  await writeFile(
    join(esbuildRoot, 'index.js'),
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      'export async function build(options) {',
      '  await mkdir(join(options.outdir, \'sidepanel\'), { recursive: true });',
      "  await writeFile(join(options.outdir, 'build-options.json'), JSON.stringify({",
      '    define: options.define,',
      '    entryPoints: Object.keys(options.entryPoints).sort(),',
      "  }));",
      "  if (process.env.DATA_COLLECTOR_TEST_MUTATE_DURING_BUILD === '1') {",
      "    await writeFile(join(options.outdir, '..', '..', '..', 'tracked.txt'), 'changed during build\\n');",
      '  }',
      '}',
    ].join('\n'),
  );

  await git(root, 'init');
  await git(root, 'config', 'user.name', 'Build Stamp Test');
  await git(root, 'config', 'user.email', 'build-stamp@example.test');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'fixture');
  return root;
}

async function buildId(root: string, env: Record<string, string> = {}): Promise<string> {
  await execFile(process.execPath, [join(root, 'packages', 'extension', 'scripts', 'build.mjs')], {
    cwd: root,
    env: { ...process.env, ...env },
  });
  return (await readFile(join(root, 'packages', 'extension', 'dist', 'build-id.txt'), 'utf8')).trim();
}

describe('extension build stamp', () => {
  it('fails closed instead of emitting an unknown build when git metadata is unavailable', async () => {
    const root = await fixture();
    await rm(join(root, '.git'), { recursive: true, force: true });

    await expect(buildId(root)).rejects.toThrow();
    await expect(readFile(
      join(root, 'packages', 'extension', 'dist', 'build-id.txt'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes and rejects artifacts when source identity changes during the build', async () => {
    const root = await fixture();

    await expect(buildId(root, {
      DATA_COLLECTOR_TEST_MUTATE_DURING_BUILD: '1',
    })).rejects.toThrow();
    await expect(readFile(
      join(root, 'packages', 'extension', 'dist', 'build-id.txt'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('injects the exact same build id into both content and main-world hook bundles', async () => {
    const root = await fixture();
    const exactBuildId = await buildId(root);
    const options = JSON.parse(await readFile(
      join(root, 'packages', 'extension', 'dist', 'build-options.json'),
      'utf8',
    )) as { define: Record<string, string>; entryPoints: string[] };

    expect(options.entryPoints).toContain('content');
    expect(options.entryPoints).toContain('inject');
    expect(options.define.__BUILD_ID__).toBe(JSON.stringify(exactBuildId));
  });

  it('uses only the short commit for a clean workspace', async () => {
    const root = await fixture();
    const commit = await git(root, 'rev-parse', '--short=7', 'HEAD');

    expect(await buildId(root)).toBe(`v9.8.7 · ${commit}`);
  });

  it('changes when tracked content changes and stays stable for identical content', async () => {
    const root = await fixture();
    const commit = await git(root, 'rev-parse', '--short=7', 'HEAD');
    await writeFile(join(root, 'tracked.txt'), 'first local revision\n');

    const first = await buildId(root);
    const repeated = await buildId(root);
    await writeFile(join(root, 'tracked.txt'), 'second local revision\n');
    const second = await buildId(root);

    expect(first).toMatch(new RegExp(`^v9\\.8\\.7 · ${commit}\\+dirty\\.[0-9a-f]{12}$`));
    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
  });

  it('can fingerprint a tracked diff larger than Node default stdout buffering', async () => {
    const root = await fixture();
    await writeFile(join(root, 'tracked.txt'), 'large local revision\n'.repeat(80_000));

    await expect(buildId(root)).resolves.toMatch(/^v9\.8\.7 · [0-9a-f]{7}\+dirty\.[0-9a-f]{12}$/u);
  });

  it('changes when an untracked file content changes', async () => {
    const root = await fixture();
    await writeFile(join(root, 'notes.txt'), 'first draft\n');
    const first = await buildId(root);
    const repeated = await buildId(root);

    await writeFile(join(root, 'notes.txt'), 'second draft\n');

    expect(repeated).toBe(first);
    expect(await buildId(root)).not.toBe(first);
  });

  it('includes the untracked path as well as its content', async () => {
    const root = await fixture();
    await writeFile(join(root, 'first-name.txt'), 'same bytes\n');
    const first = await buildId(root);

    await rename(join(root, 'first-name.txt'), join(root, 'second-name.txt'));

    expect(await buildId(root)).not.toBe(first);
  });

  it('ignores standard ignored files and generated artifacts', async () => {
    const root = await fixture();
    await writeFile(join(root, 'tracked.txt'), 'local revision\n');
    const before = await buildId(root);

    await mkdir(join(root, 'ignored'), { recursive: true });
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await writeFile(join(root, 'ignored', 'cache.txt'), 'ignored bytes\n');
    await writeFile(join(root, 'artifacts', 'package.zip'), 'generated bytes\n');

    expect(await buildId(root)).toBe(before);
  });
});
