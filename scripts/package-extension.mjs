import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { withArtifactLease } from './artifact-lease.mjs';

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
const STAGING_PREFIX = '.data-collector-extension-staging-';
const TRANSACTION_PREFIX = '.data-collector-extension-transaction-';
const TRANSACTION_FILE = 'transaction.json';
const COMMITTED_FILE = 'committed';

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

async function writeTransactionRecord(transactionRoot, record) {
  const path = join(transactionRoot, TRANSACTION_FILE);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeCommittedMarker(transactionRoot) {
  const handle = await open(join(transactionRoot, COMMITTED_FILE), 'wx', 0o600);
  try {
    await handle.writeFile('committed\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseTransactionRecord(raw) {
  const record = JSON.parse(raw);
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || record.version !== 1
    || typeof record.archiveName !== 'string'
    || !/^data-collector-extension-\d+(?:\.\d+){2,3}\.zip$/u.test(record.archiveName)
    || typeof record.hadStableDirectory !== 'boolean'
    || typeof record.hadArchive !== 'boolean'
  ) throw new Error('扩展 artifact 事务记录无效，已停止自动恢复');
  return record;
}

/**
 * A process can die after any one of the directory/archive renames below, so caught-error rollback
 * is insufficient. Each transaction records the exact pre-commit artifact set. The next package run
 * restores that set under the same cross-process lease before it reads or stages a new release.
 */
export async function recoverInterruptedExtensionArtifacts(workspaceRoot) {
  const artifactDirectory = join(workspaceRoot, 'artifacts');
  const stableDirectory = join(artifactDirectory, 'data-collector-extension');
  await mkdir(artifactDirectory, { recursive: true });
  await withArtifactLease(workspaceRoot, { role: 'package-recovery' }, async () => {
    const transactions = (await readdir(artifactDirectory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith(TRANSACTION_PREFIX))
      .map(entry => entry.name)
      .sort();
    for (const name of transactions) {
      const transactionRoot = join(artifactDirectory, name);
      let rawRecord;
      try {
        rawRecord = await readFile(join(transactionRoot, TRANSACTION_FILE), 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          // Older package versions exposed their unpublished staging directory under the
          // transaction prefix. It has never touched stable artifacts and is safe to discard.
          await rm(transactionRoot, { recursive: true, force: true });
          continue;
        }
        throw error;
      }
      const record = parseTransactionRecord(rawRecord);
      const archive = join(artifactDirectory, record.archiveName);
      const previousDirectory = join(transactionRoot, 'previous-directory');
      const previousArchive = join(transactionRoot, 'previous-archive.zip');
      if (await pathExists(join(transactionRoot, COMMITTED_FILE))) {
        // Validation completed before this durable marker was published. A concurrent/next
        // packager must retain both new artifacts rather than treating the cleanup window as a crash.
        await validateExtensionDirectory(stableDirectory);
        await validateExtensionArchive(archive, stableDirectory);
        await rm(transactionRoot, { recursive: true, force: true });
        continue;
      }
      const previousDirectoryExists = await pathExists(previousDirectory);
      const previousArchiveExists = await pathExists(previousArchive);

      if (previousDirectoryExists) {
        await rm(stableDirectory, { recursive: true, force: true });
        await rename(previousDirectory, stableDirectory);
      } else if (!record.hadStableDirectory) {
        await rm(stableDirectory, { recursive: true, force: true });
      } else if (!await pathExists(stableDirectory)) {
        throw new Error('扩展 artifact 事务无法恢复 previous directory');
      }

      if (previousArchiveExists) {
        await rm(archive, { force: true });
        await rename(previousArchive, archive);
      } else if (!record.hadArchive) {
        await rm(archive, { force: true });
      } else if (!await pathExists(archive)) {
        throw new Error('扩展 artifact 事务无法恢复 previous archive');
      }

      if (record.hadStableDirectory) await validateExtensionDirectory(stableDirectory);
      if (record.hadStableDirectory && record.hadArchive) {
        await validateExtensionArchive(archive, stableDirectory);
      }
      await rm(transactionRoot, { recursive: true, force: true });
    }
  });
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
  const hadStableDirectory = options.hadStableDirectory
    ?? await pathExists(options.stableDirectory);
  const hadArchive = options.hadArchive ?? await pathExists(options.archive);
  if (options.transactionPrepared !== true) {
    await writeTransactionRecord(options.transactionRoot, {
      version: 1,
      archiveName: basename(options.archive),
      hadStableDirectory,
      hadArchive,
    });
  }

  try {
    if (hadStableDirectory) {
      await move(options.stableDirectory, previousDirectory);
      backedUpDirectory = true;
    }
    if (hadArchive) {
      await move(options.archive, previousArchive);
      backedUpArchive = true;
    }
    await move(options.stagedArchive, options.archive);
    committedArchive = true;
    await move(options.stagedDirectory, options.stableDirectory);
    committedDirectory = true;
    await validateCommittedDirectory(options.stableDirectory);
    await writeCommittedMarker(options.transactionRoot);
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
  await recoverInterruptedExtensionArtifacts(workspaceRoot);
  await validateExtensionDirectory(extensionRoot);
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  const archiveName = `data-collector-extension-${manifest.version}.zip`;
  const archive = join(artifactDirectory, archiveName);
  const stableDirectory = join(artifactDirectory, 'data-collector-extension');
  const stagingRoot = await mkdtemp(join(artifactDirectory, STAGING_PREFIX));
  const stagedDirectory = join(stagingRoot, 'unpacked');
  const stagedArchive = join(stagingRoot, 'extension.zip');
  try {
    await cp(extensionRoot, stagedDirectory, { recursive: true });
    await validateExtensionDirectory(stagedDirectory);
    const writeArchive = dependencies.writeArchive ?? writeExtensionArchive;
    await writeArchive(stagedDirectory, stagedArchive);
    await validateExtensionArchive(stagedArchive, stagedDirectory);
    // staging 与复验不触碰稳定产物，可以并行；真正替换 unpacked + ZIP 时必须与
    // Bridge 的知识星球 sink 共用跨进程租约，避免正文落库途中 A 被手工 package 成 B。
    await withArtifactLease(workspaceRoot, { role: 'package' }, async () => {
      const transactionRoot = join(
        artifactDirectory,
        `${TRANSACTION_PREFIX}${basename(stagingRoot).slice(STAGING_PREFIX.length)}`,
      );
      const hadStableDirectory = await pathExists(stableDirectory);
      const hadArchive = await pathExists(archive);
      // Prepare the recovery journal while the directory is still invisible to recovery, then
      // publish the whole transaction root with one rename under the shared lease.
      await writeTransactionRecord(stagingRoot, {
        version: 1,
        archiveName,
        hadStableDirectory,
        hadArchive,
      });
      await rename(stagingRoot, transactionRoot);
      try {
        await commitExtensionArtifacts({
          transactionRoot,
          stagedDirectory: join(transactionRoot, 'unpacked'),
          stagedArchive: join(transactionRoot, 'extension.zip'),
          stableDirectory,
          archive,
          hadStableDirectory,
          hadArchive,
          transactionPrepared: true,
        }, dependencies);
      } catch (error) {
        // A normal failure was fully rolled back by commitExtensionArtifacts. AggregateError means
        // rollback itself failed, so preserve the journal/backups for the next recovery pass.
        if (!(error instanceof AggregateError)) {
          await rm(transactionRoot, { recursive: true, force: true });
        }
        throw error;
      }
      // 清理也必须留在同一租约内：并发 package 可能刚提交另一个版本；若先释放，较旧
      // 进程会把后来者的当前 ZIP 当“历史包”删掉，破坏 stable directory/archive 配对。
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
      // The committed marker, backups and journal must disappear before releasing the lease.
      // Otherwise a concurrent recovery can still observe and roll back this completed release.
      await rm(transactionRoot, { recursive: true, force: true });
    });
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
