import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

const ALLOWED_FILES = [
  'background.js',
  'content.js',
  // 页面主世界脚本：旁观应用自己的接口响应，取回 DOM 上没有的帖子号。
  'inject.js',
  // 构建标记：侧栏右下角显示的「这份产物来自哪个提交」，排查时也能直接 cat。
  'build-id.txt',
  'manifest.json',
  'sidepanel/index.html',
  'sidepanel/index.js',
  'sidepanel/styles.css',
].sort();
const ALLOWED_DIRECTORIES = ['sidepanel'];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:DATA_COLLECTOR_TOKEN|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY)\s*=/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

async function entriesBelow(root, directory = root) {
  const files = [];
  const directories = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split('\\').join('/');
    if (entry.isSymbolicLink()) throw new Error(`打包目录不允许符号链接：${path}`);
    if (entry.isDirectory()) {
      directories.push(path);
      const nested = await entriesBelow(root, absolute);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`打包目录包含不允许的目录项：${path}`);
    }
  }
  return { files: files.sort(), directories: directories.sort() };
}

export async function validateExtensionDirectory(root) {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('打包根路径必须是普通目录');
  }
  const { files, directories } = await entriesBelow(root);
  const unexpectedDirectories = directories.filter(directory => !ALLOWED_DIRECTORIES.includes(directory));
  const missingDirectories = ALLOWED_DIRECTORIES.filter(directory => !directories.includes(directory));
  if (unexpectedDirectories.length || missingDirectories.length) {
    throw new Error(
      `打包包含不允许的目录：unexpected=${unexpectedDirectories.join(',') || '-'} missing=${missingDirectories.join(',') || '-'}`,
    );
  }
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

export async function validateExtensionArchive(archive, extensionRoot) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(await readFile(archive)));
  } catch (error) {
    throw new Error('扩展 ZIP 无法读取', { cause: error });
  }
  const files = Object.keys(entries).sort();
  const unexpected = files.filter(file => !ALLOWED_FILES.includes(file));
  const missing = ALLOWED_FILES.filter(file => !files.includes(file));
  if (unexpected.length || missing.length) {
    throw new Error(
      `扩展 ZIP 文件不在允许清单：unexpected=${unexpected.join(',') || '-'} missing=${missing.join(',') || '-'}`,
    );
  }
  for (const file of files) {
    const expected = await readFile(join(extensionRoot, file));
    if (!Buffer.from(entries[file]).equals(expected)) {
      throw new Error(`扩展 ZIP 内容与 staged directory 不一致：${file}`);
    }
  }
  return files;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function commitExtensionArtifacts(options, dependencies = {}) {
  const move = dependencies.rename ?? rename;
  const validateCommittedDirectory =
    dependencies.validateCommittedDirectory ?? validateExtensionDirectory;
  const previousDirectory = join(options.transactionRoot, 'previous-directory');
  const previousArchive = join(options.transactionRoot, 'previous-archive.zip');
  let backedUpDirectory = false;
  let backedUpArchive = false;
  let committedDirectory = false;
  let committedArchive = false;

  try {
    if (await pathExists(options.stableDirectory)) {
      await move(options.stableDirectory, previousDirectory);
      backedUpDirectory = true;
    }
    if (await pathExists(options.archive)) {
      await move(options.archive, previousArchive);
      backedUpArchive = true;
    }
    await move(options.stagedArchive, options.archive);
    committedArchive = true;
    await move(options.stagedDirectory, options.stableDirectory);
    committedDirectory = true;
    await validateCommittedDirectory(options.stableDirectory);
  } catch (error) {
    const rollbackErrors = [];
    if (committedDirectory) {
      try {
        await rm(options.stableDirectory, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (committedArchive) {
      try {
        await rm(options.archive, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (backedUpDirectory) {
      try {
        await move(previousDirectory, options.stableDirectory);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (backedUpArchive) {
      try {
        await move(previousArchive, options.archive);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], '扩展 artifacts 提交失败且回滚不完整');
    }
    throw error;
  }
}

export async function packageExtension(workspaceRoot, dependencies = {}) {
  const extensionRoot = join(workspaceRoot, 'packages', 'extension', 'dist');
  const artifactDirectory = join(workspaceRoot, 'artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  await validateExtensionDirectory(extensionRoot);
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  const archiveName = `data-collector-extension-${manifest.version}.zip`;
  const archive = join(artifactDirectory, archiveName);
  const stableDirectory = join(artifactDirectory, 'data-collector-extension');
  const stagingRoot = await mkdtemp(join(artifactDirectory, '.data-collector-extension-'));
  const stagedDirectory = join(stagingRoot, 'unpacked');
  const stagedArchive = join(stagingRoot, 'extension.zip');
  try {
    await cp(extensionRoot, stagedDirectory, { recursive: true });
    await validateExtensionDirectory(stagedDirectory);
    const writeArchive = dependencies.writeArchive ?? writeExtensionArchive;
    await writeArchive(stagedDirectory, stagedArchive);
    await validateExtensionArchive(stagedArchive, stagedDirectory);
    await commitExtensionArtifacts({
      transactionRoot: stagingRoot,
      stagedDirectory,
      stagedArchive,
      stableDirectory,
      archive,
    }, dependencies);
    // 新成品完整落盘并复验之后，历史安装包才失去价值。只删严格匹配版本命名的
    // Data Collector ZIP，不碰 artifacts 里可能存在的其他调试/交付文件。
    const versionedArchives = (await readdir(artifactDirectory)).filter(name =>
      /^data-collector-extension-\d+(?:\.\d+){2,3}\.zip$/u.test(name),
    );
    const removeObsoleteArchive = dependencies.removeObsoleteArchive
      ?? (path => rm(path, { force: true }));
    const cleanupResults = await Promise.allSettled(
      versionedArchives
        .filter(name => name !== archiveName)
        .map(name => removeObsoleteArchive(join(artifactDirectory, name))),
    );
    const cleanupFailures = cleanupResults.filter(result => result.status === 'rejected');
    if (cleanupFailures.length > 0) {
      const warn = dependencies.warn ?? console.warn;
      warn(`[package] 当前扩展成品已提交；${cleanupFailures.length} 个历史 ZIP 清理失败，将在下次打包重试。`);
    }
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
