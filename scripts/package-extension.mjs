import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const ALLOWED_FILES = [
  'background.js',
  'content.js',
  'manifest.json',
  'sidepanel/index.html',
  'sidepanel/index.js',
  'sidepanel/styles.css',
].sort();

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:DATA_COLLECTOR_TOKEN|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY)\s*=/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

async function filesBelow(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, absolute)));
    else if (entry.isFile()) files.push(relative(root, absolute).split('\\').join('/'));
  }
  return files.sort();
}

export async function validateExtensionDirectory(root) {
  const files = await filesBelow(root);
  const unexpected = files.filter(file => !ALLOWED_FILES.includes(file));
  const missing = ALLOWED_FILES.filter(file => !files.includes(file));
  if (unexpected.length || missing.length) {
    throw new Error(
      `打包文件不在允许清单：unexpected=${unexpected.join(',') || '-'} missing=${missing.join(',') || '-'}`,
    );
  }
  for (const file of files) {
    const contents = await readFile(join(root, file), 'utf8');
    if (SECRET_PATTERNS.some(pattern => pattern.test(contents))) {
      throw new Error(`打包内容包含疑似凭证：${file}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== '116') {
    throw new Error('manifest 必须是 MV3 且最低 Chrome 版本为 116');
  }
  if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){2,3}$/.test(manifest.version)) {
    throw new Error('manifest.version 必须是 Chrome 支持的数字版本');
  }
  return files;
}

export async function writeExtensionArchive(extensionRoot, archive) {
  const files = await validateExtensionDirectory(extensionRoot);
  const entries = {};
  const fixedTime = new Date(1980, 0, 1, 0, 0, 0);
  for (const file of files) {
    entries[file] = [
      new Uint8Array(await readFile(join(extensionRoot, file))),
      { level: 9, mtime: fixedTime, os: 3, attrs: 0o644 << 16 },
    ];
  }
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, zipSync(entries, { level: 9 }));
  return archive;
}

export async function packageExtension(workspaceRoot) {
  const extensionRoot = join(workspaceRoot, 'packages', 'extension', 'dist');
  const artifactDirectory = join(workspaceRoot, 'artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  await validateExtensionDirectory(extensionRoot);
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  const archive = join(artifactDirectory, `data-collector-extension-${manifest.version}.zip`);
  const stableDirectory = join(artifactDirectory, 'data-collector-extension');
  const obsoleteArchive = join(artifactDirectory, 'data-collector-extension-0.1.0.zip');
  const stagingRoot = await mkdtemp(join(artifactDirectory, '.data-collector-extension-'));
  const stagedDirectory = join(stagingRoot, 'unpacked');
  const stagedArchive = join(stagingRoot, 'extension.zip');
  const previousDirectory = join(stagingRoot, 'previous');
  let movedPrevious = false;
  try {
    await cp(extensionRoot, stagedDirectory, { recursive: true });
    await validateExtensionDirectory(stagedDirectory);
    await writeExtensionArchive(stagedDirectory, stagedArchive);
    await rename(stagedArchive, archive);
    try {
      await rename(stableDirectory, previousDirectory);
      movedPrevious = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    try {
      await rename(stagedDirectory, stableDirectory);
    } catch (error) {
      if (movedPrevious) await rename(previousDirectory, stableDirectory);
      throw error;
    }
    await validateExtensionDirectory(stableDirectory);
    if (obsoleteArchive !== archive) await rm(obsoleteArchive, { force: true });
    return archive;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.stdout.write(`${await packageExtension(workspaceRoot)}\n`);
}
