import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import {
  canonicalizeUrl,
  descriptorForHost,
  descriptorFor,
  parseSupportedUrl,
  SOURCES,
  stableContentId,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  type Source,
} from '@data-collector/shared';
import { renderMarkdown } from './markdown.js';
import type { OrganizedDocument } from '../organize/index.js';
import { downloadAssets } from './assets.js';
import type { AssetResult, ResolveAddresses } from './assets.js';
import { assertInsideRoot, assertSafeWritePath, safeSlug } from './paths.js';
import { withCatalogTransaction } from './catalogTransaction.js';
import { deliveryRevision } from './deliveryRevision.js';
import {
  projectOrganized,
  storeOrganized,
  type LocalDocumentEvidence,
} from './storedDocument.js';
import {
  createDirectedTransactionIntent,
  createDirectedTransactionJournal,
  DIRECTED_TRANSACTION_MARKER,
  directedBytesDigest,
  directedJournalPointerPath,
  directedRecoveryFingerprint,
  findDirectedRecoveryFingerprint,
  inventoryDirectedReplacementTree,
  newDirectedTransactionId,
  retireDirectedReplacedEntry,
  serializeDirectedTransactionIntent,
  serializeDirectedTransactionJournal,
  syncDirectedDirectory,
  type DirectedReplacementTreeEntry,
  type DirectedTransactionIntent,
  type DirectedTransactionJournal,
} from './directedTransactionJournal.js';

/**
 * 同步状态。本机库是唯一落点与去重依据，投递到仓库收件箱是**之后**的显式动作。
 * 采集时一律 pending：内容先落本地，由用户核对后再决定同步哪些。
 */
export type SyncState = 'pending' | 'synced' | 'failed';

export interface SyncInfo {
  state: SyncState;
  /** 同步到了哪个去向（sink id）。 */
  target?: string;
  /** 同步完成时刻。 */
  at?: string;
  /** 已提交到目标仓库的当前分支。 */
  committed?: boolean;
  /** 已推送到远端。 */
  pushed?: boolean;
  /**
   * 推送真失败——**算同步失败**（0.3.14 起）。
   * 和「没配置要推」区分开：后者 pushed 也是 false，但那是有意为之，不是问题。
   */
  pushFailed?: boolean;
  /** 失败原因，或推送失败之类的告警，如实展示。 */
  error?: string;
}

interface CatalogEntry {
  id: string;
  source: Source;
  title: string;
  url: string;
  category: string;
  relativePath: string;
  updatedAt: string;
  /** 帖子自己的发布时间；站点没给就没有这个字段（界面据此标注「录入」）。 */
  publishedAt?: string;
  /** 来源采集器是否确认正文完整；旧目录缺省为未知，供定向修复使用。 */
  contentComplete?: boolean;
  /** 完整性证明协议；只有当前协议的 true 才能阻止强制修复或较短的可信重采。 */
  contentCompletenessVersion?: string;
  /** 产生证明的扩展精确 build-id，供部署与历史审计。 */
  contentCompletenessBuildId?: string;
  /** Stable semantic revision represented by the current local snapshot. */
  deliveryRevision?: string;
  /** Fixed-plan delivery receipt retained while the semantic revision is unchanged. */
  deliveryBatchId?: string;
  sync?: SyncInfo;
}

/** 整理结果的留存文件名：同步到收件箱时原样重放它。 */
export const SOURCE_FILE = 'source.json';

export interface SavedContent {
  id: string;
  markdownPath: string;
  downloadedImages: number;
  failedImages: number;
}

export interface MarkdownLibraryOptions {
  root: string;
  fetch?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  /** @internal Deterministic I/O boundaries used to prove directed no-clobber semantics. */
  directedTransactionIo?: DirectedTransactionIo;
}

export type DirectedExclusiveCreateKind =
  | 'directory'
  | 'transaction-intent'
  | 'entry-index'
  | 'entry-source'
  | 'catalog-temp'
  | 'transaction-marker'
  | 'journal-pointer'
  | 'assets-directory'
  | 'asset';

export interface DirectedTransactionBoundaryContext {
  stagingDirectory: string;
  finalDirectory: string;
  finalParentDirectory: string;
  catalogPath: string;
  catalogTemporaryPath?: string;
}

export interface DirectedTransactionIo {
  beforeExclusiveCreate?(kind: DirectedExclusiveCreateKind, path: string): Promise<void>;
  afterExclusiveOpen?(kind: DirectedExclusiveCreateKind, path: string, handle: FileHandle): Promise<void>;
  afterIntentCommit?(pointerPath: string): Promise<void>;
  beforeManifestInstall?(
    kind: 'transaction-marker' | 'journal-pointer',
    temporaryPath: string,
    finalPath: string,
  ): Promise<void>;
  beforeEntryCommit?(context: DirectedTransactionBoundaryContext): Promise<void>;
  beforeCatalogCommit?(context: DirectedTransactionBoundaryContext): Promise<void>;
  afterCatalogCommit?(catalogPath: string, catalogTemporaryPath: string): Promise<void>;
  beforeUniqueCleanup?(path: string): Promise<void>;
}

const defaultDirectedTransactionIo: DirectedTransactionIo = {};

/** Pure path identity used by the lock-free directed readonly preflight. */
export interface DirectedLocalDocumentTarget {
  source: Source;
  canonicalUrl: string;
  title: string;
  category: string;
  publishedAt?: string;
  collectedAt: string;
  contentHash?: string;
}

export class DirectedLocalLibraryCorruptError extends Error {
  readonly code = 'DIRECTED_LOCAL_LIBRARY_CORRUPT' as const;

  constructor(cause?: unknown) {
    super('本机目录格式无效', cause === undefined ? undefined : { cause });
    this.name = 'DirectedLocalLibraryCorruptError';
  }
}

export interface DirectedCatalogReadIo {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

const directedCatalogReadIo: DirectedCatalogReadIo = { readFile };

function insideCanonicalRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Persist catalog paths with one platform-independent wire representation. */
export function toCatalogRelativePath(
  nativeRelativePath: string,
  nativeSeparator: string = sep,
): string {
  return nativeSeparator === '\\'
    ? nativeRelativePath.replaceAll('\\', '/')
    : nativeRelativePath;
}

/** Validate the persisted POSIX-slash protocol independently of the current host OS. */
export function isSafeCatalogRelativePath(value: string): boolean {
  const parts = value.split('/');
  if (value.length === 0
    || value.includes('\\')
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
    || /^[A-Za-z]:/u.test(value)
    || posix.normalize(value) !== value) return false;
  return parts.every(part => part !== ''
    && part !== '.'
    && part !== '..'
    && !/[<>:"|?*\u0000-\u001F]/u.test(part)
    && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part));
}

export function normalizeStoredCatalogRelativePath(
  value: string,
  platformSeparator: string = sep,
): string {
  if (isSafeCatalogRelativePath(value)) return value;
  // Old Windows writers persisted the native separator. Accept only an unmixed, relative,
  // host-native legacy value; the next successful save rewrites it to the POSIX protocol.
  if (platformSeparator === '\\' && value.includes('\\') && !value.includes('/')) {
    const migrated = toCatalogRelativePath(value, '\\');
    if (isSafeCatalogRelativePath(migrated)) return migrated;
  }
  throw new Error('invalid catalog path');
}

function catalogEntryPath(root: string, relativePath: string): string {
  return resolve(root, ...relativePath.split('/'));
}

interface StrictRegularFile {
  canonicalPath: string;
  contents: string;
  device: number;
  inode: number;
  linkCount: number;
}

async function strictExistingRegularFile(
  root: string,
  path: string,
  observedMetadata?: Stats,
): Promise<StrictRegularFile> {
  const metadata = observedMetadata ?? await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('not a regular file');
  const canonical = await realpath(path);
  if (canonical !== path || !insideCanonicalRoot(root, canonical)) throw new Error('path escaped root');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()
      || openedMetadata.dev !== metadata.dev
      || openedMetadata.ino !== metadata.ino
      || openedMetadata.nlink !== metadata.nlink) throw new Error('file changed during validation');
    return {
      canonicalPath: canonical,
      contents: await handle.readFile('utf8'),
      device: openedMetadata.dev,
      inode: openedMetadata.ino,
      linkCount: openedMetadata.nlink,
    };
  } finally {
    await handle.close();
  }
}

async function strictOptionalExistingRegularFile(root: string, path: string): Promise<StrictRegularFile | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parentPath = dirname(path);
    const parent = await lstat(parentPath);
    if (parent.isSymbolicLink() || !parent.isDirectory()
      || await realpath(parentPath) !== parentPath
      || !insideCanonicalRoot(root, parentPath)) throw error;
    return undefined;
  }
  // Once the leaf was observed, every later ENOENT or inode swap is a race/corruption
  // rather than genuine optional-leaf absence and must fail closed.
  return await strictExistingRegularFile(root, path, metadata);
}

function organizedTarget(
  input: OrganizedDocument,
  directedContentHash?: string,
): DirectedLocalDocumentTarget {
  return {
    source: input.document.source,
    canonicalUrl: input.document.canonicalUrl,
    title: input.document.title,
    category: input.category,
    ...(input.document.publishedAt ? { publishedAt: input.document.publishedAt } : {}),
    collectedAt: input.document.collectedAt,
    ...(directedContentHash ? { contentHash: directedContentHash } : {}),
  };
}

function directedNewDocumentRelativePath(
  target: DirectedLocalDocumentTarget,
  id: string,
): string {
  if (!target.contentHash || !/^[a-f0-9]{16}$/u.test(target.contentHash)) {
    throw new Error('directed content hash missing');
  }
  const year = (target.publishedAt ?? target.collectedAt).slice(0, 4);
  return posix.join(
    descriptorFor(target.source).label,
    safeSlug(target.category),
    year,
    `${id}-${target.contentHash}`,
    'index.md',
  );
}

function newDocumentRelativePath(target: DirectedLocalDocumentTarget, id: string): string {
  const year = (target.publishedAt ?? target.collectedAt).slice(0, 4);
  return posix.join(
    descriptorFor(target.source).label,
    safeSlug(target.category),
    year,
    `${id}-${safeSlug(target.title)}`,
    'index.md',
  );
}

interface StrictDirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

interface DirectedNewEntryPlan {
  id: string;
  markdownPath: string;
  sourcePath: string;
  entryDirectory: string;
  finalParentDirectory: string;
  nearestExistingDirectory: StrictDirectoryIdentity;
  missingDirectoryParts: string[];
}

interface DirectedOrphanPreflight {
  fingerprint: string;
  newEntryPlan?: DirectedNewEntryPlan;
  recoveryPending?: boolean;
}

async function directedReplacementEntryPlan(
  root: string,
  existingMarkdownPath: string,
  id: string,
  contentHash: string,
  transactionId: string,
): Promise<DirectedNewEntryPlan> {
  if (!/^[a-f0-9]{16}$/u.test(contentHash) || !/^[a-f0-9]{32}$/u.test(transactionId)) {
    throw new Error('directed replacement identity invalid');
  }
  const finalParentDirectory = dirname(dirname(existingMarkdownPath));
  const nearestExistingDirectory = await strictDirectoryIdentity(root, finalParentDirectory);
  const entryDirectory = join(
    finalParentDirectory,
    `${id}-${contentHash}-${transactionId}`,
  );
  const markdownPath = join(entryDirectory, 'index.md');
  const sourcePath = join(entryDirectory, SOURCE_FILE);
  await assertSafeWritePath(root, entryDirectory);
  try {
    await lstat(entryDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await assertDirectoryIdentity(root, nearestExistingDirectory);
      return {
        id,
        markdownPath,
        sourcePath,
        entryDirectory,
        finalParentDirectory,
        nearestExistingDirectory,
        missingDirectoryParts: [],
      };
    }
    throw error;
  }
  throw new Error('directed replacement path already exists');
}

async function strictDirectoryIdentity(root: string, path: string): Promise<StrictDirectoryIdentity> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || await realpath(path) !== path
    || !insideCanonicalRoot(root, path)) throw new Error('invalid directory identity');
  return { path, device: metadata.dev, inode: metadata.ino };
}

function sameDirectoryIdentity(left: StrictDirectoryIdentity, right: StrictDirectoryIdentity): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

function sameOptionalRegularSnapshot(
  left: StrictRegularFile | undefined,
  right: StrictRegularFile | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.canonicalPath === right.canonicalPath
    && left.device === right.device
    && left.inode === right.inode
    && left.linkCount === right.linkCount
    && left.contents === right.contents;
}

async function preflightOrphanTargetArtifacts(
  canonicalRoot: string,
  target: DirectedLocalDocumentTarget | undefined,
): Promise<DirectedOrphanPreflight> {
  if (!target) return { fingerprint: 'no-target' };
  const id = stableContentId(target.canonicalUrl);
  const pendingRecovery = await findDirectedRecoveryFingerprint({
    root: canonicalRoot,
    source: target.source,
    canonicalUrl: target.canonicalUrl,
    stableContentId: id,
  });
  if (pendingRecovery) {
    return {
      fingerprint: JSON.stringify(['pending-recovery', id, pendingRecovery]),
      recoveryPending: true,
    };
  }
  const legacyMarkdownPath = catalogEntryPath(canonicalRoot, newDocumentRelativePath(target, id));
  const legacySourcePath = join(dirname(legacyMarkdownPath), SOURCE_FILE);
  for (const legacyPath of [legacyMarkdownPath, legacySourcePath]) {
    await assertSafeWritePath(canonicalRoot, legacyPath);
    try {
      await lstat(legacyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('legacy deterministic orphan artifact exists');
  }
  const relativeMarkdownPath = directedNewDocumentRelativePath(target, id);
  const markdownPath = catalogEntryPath(canonicalRoot, relativeMarkdownPath);
  const entryDirectory = dirname(markdownPath);
  const sourcePath = join(entryDirectory, SOURCE_FILE);
  const finalParentDirectory = dirname(entryDirectory);
  const directoryParts = relative(canonicalRoot, finalParentDirectory).split(sep).filter(Boolean);
  if (directoryParts.length === 0 || relative(canonicalRoot, finalParentDirectory).startsWith('..')) {
    throw new Error('invalid orphan target path');
  }
  let currentDirectory = canonicalRoot;
  let nearestExistingDirectory = await strictDirectoryIdentity(canonicalRoot, canonicalRoot);
  let missingDirectoryParts: string[] = [];
  for (let index = 0; index < directoryParts.length; index += 1) {
    const nextDirectory = join(currentDirectory, directoryParts[index]!);
    try {
      nearestExistingDirectory = await strictDirectoryIdentity(canonicalRoot, nextDirectory);
      currentDirectory = nextDirectory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const revalidatedParent = await strictDirectoryIdentity(canonicalRoot, currentDirectory);
      if (!sameDirectoryIdentity(revalidatedParent, nearestExistingDirectory)) throw error;
      missingDirectoryParts = directoryParts.slice(index);
      break;
    }
  }
  if (missingDirectoryParts.length === 0) {
    nearestExistingDirectory = await strictDirectoryIdentity(canonicalRoot, finalParentDirectory);
  }
  await assertSafeWritePath(canonicalRoot, entryDirectory);
  let recoveryFingerprint: string | undefined;
  try {
    await lstat(entryDirectory);
    recoveryFingerprint = await directedRecoveryFingerprint({
      root: canonicalRoot,
      entryDirectory,
      source: target.source,
      canonicalUrl: target.canonicalUrl,
      stableContentId: id,
    });
    if (!recoveryFingerprint) {
      throw new Error('stable directed entry already exists without catalog identity');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (missingDirectoryParts.length === 0) {
        const revalidatedParent = await strictDirectoryIdentity(canonicalRoot, finalParentDirectory);
        if (!sameDirectoryIdentity(revalidatedParent, nearestExistingDirectory)) throw error;
      }
    } else {
      throw error;
    }
  }
  const newEntryPlan: DirectedNewEntryPlan = {
    id,
    markdownPath,
    sourcePath,
    entryDirectory,
    finalParentDirectory,
    nearestExistingDirectory,
    missingDirectoryParts,
  };
  return {
    fingerprint: JSON.stringify([
      'target-orphan',
      id,
      relativeMarkdownPath,
      [
        relative(canonicalRoot, nearestExistingDirectory.path).split(sep).join('/'),
        nearestExistingDirectory.device,
        nearestExistingDirectory.inode,
      ],
      missingDirectoryParts,
      recoveryFingerprint ? ['pending-recovery', recoveryFingerprint] : 'stable-entry-absent',
      'legacy-index-source-absent',
    ]),
    newEntryPlan,
    ...(recoveryFingerprint ? { recoveryPending: true } : {}),
  };
}

interface DirectedLocalLibraryPreflight {
  canonicalRoot: string;
  catalogDirectory: StrictDirectoryIdentity;
  catalogExisted: boolean;
  catalogSnapshot?: StrictRegularFile;
  catalog: CatalogEntry[];
  catalogFingerprint: string;
  sourceFingerprint: string;
  targetSourceSnapshot?: StrictRegularFile;
  newEntryPlan?: DirectedNewEntryPlan;
  recoveryPending?: boolean;
}

/**
 * Directed writes are fail-closed: validate the existing library and every
 * catalog path without creating a directory, lock file, or temporary file.
 */
async function preflightDirectedLocalLibraryState(
  root: string,
  target?: DirectedLocalDocumentTarget,
): Promise<DirectedLocalLibraryPreflight> {
  try {
    const absoluteRoot = resolve(root);
    const rootMetadata = await lstat(absoluteRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error('invalid root');
    const canonicalRoot = await realpath(absoluteRoot);
    const catalogDirectory = join(canonicalRoot, '_catalog');
    const catalogDirectoryMetadata = await lstat(catalogDirectory);
    if (catalogDirectoryMetadata.isSymbolicLink() || !catalogDirectoryMetadata.isDirectory()) {
      throw new Error('invalid catalog directory');
    }
    if (await realpath(catalogDirectory) !== catalogDirectory) throw new Error('catalog directory escaped root');
    const catalogDirectoryIdentity: StrictDirectoryIdentity = {
      path: catalogDirectory,
      device: catalogDirectoryMetadata.dev,
      inode: catalogDirectoryMetadata.ino,
    };
    const catalogPath = join(catalogDirectory, 'index.json');
    let catalogMetadata;
    try {
      catalogMetadata = await lstat(catalogPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // ENOENT is empty only when the already-validated parent still exists.
      const parent = await lstat(catalogDirectory);
      if (parent.isSymbolicLink() || !parent.isDirectory()
        || parent.dev !== catalogDirectoryMetadata.dev
        || parent.ino !== catalogDirectoryMetadata.ino
        || await realpath(catalogDirectory) !== catalogDirectory) throw error;
      const orphan = await preflightOrphanTargetArtifacts(canonicalRoot, target);
      return {
        canonicalRoot,
        catalogDirectory: catalogDirectoryIdentity,
        catalogExisted: false,
        catalog: [],
        catalogFingerprint: '[]',
        sourceFingerprint: orphan.fingerprint,
        ...(orphan.newEntryPlan ? { newEntryPlan: orphan.newEntryPlan } : {}),
        ...(orphan.recoveryPending ? { recoveryPending: true } : {}),
      };
    }
    if (catalogMetadata.isSymbolicLink()
      || !catalogMetadata.isFile()
      || catalogMetadata.nlink !== 1) throw new Error('invalid catalog leaf');
    // After observing the leaf, a later ENOENT is a mutation race and cannot be treated as empty.
    const catalogSnapshot = await strictExistingRegularFile(canonicalRoot, catalogPath, catalogMetadata);
    if (catalogSnapshot.linkCount !== 1) throw new Error('hard-linked catalog');
    const raw = catalogSnapshot.contents;
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || !value.every(isCatalogEntry)) throw new Error('invalid catalog');
    const ids = new Set<string>();
    const urls = new Set<string>();
    const paths = new Set<string>();
    const targetId = target ? stableContentId(target.canonicalUrl) : undefined;
    let targetRegistered = false;
    let targetSourceSnapshot: StrictRegularFile | undefined;
    let newEntryPlan: DirectedNewEntryPlan | undefined;
    let recoveryPending = false;
    const sourceFingerprints: unknown[] = [];
    const catalog: CatalogEntry[] = [];
    for (const entry of value) {
      const parsed = parseSupportedUrl(entry.url);
      const canonicalUrl = canonicalizeUrl(parsed).href;
      let normalizedRelativePath: string;
      try {
        normalizedRelativePath = normalizeStoredCatalogRelativePath(entry.relativePath);
      } catch {
        throw new Error('invalid catalog identity');
      }
      if (canonicalUrl !== entry.url
        || descriptorForHost(parsed.hostname)?.id !== entry.source
        || (entry.source === 'nowcoder' && parsed.hostname !== 'www.nowcoder.com')
        || stableContentId(canonicalUrl) !== entry.id
        || !isSafeCatalogRelativePath(normalizedRelativePath)) {
        throw new Error('invalid catalog identity');
      }
      const entryPath = catalogEntryPath(canonicalRoot, normalizedRelativePath);
      if (!insideCanonicalRoot(canonicalRoot, entryPath)
        || ids.has(entry.id)
        || urls.has(entry.url)
        || paths.has(entryPath)) throw new Error('duplicate or escaped catalog identity');
      ids.add(entry.id);
      urls.add(entry.url);
      paths.add(entryPath);
      catalog.push({ ...entry, relativePath: normalizedRelativePath });
      if (entry.id === targetId) targetRegistered = true;
      const canonicalEntryPath = (await strictExistingRegularFile(canonicalRoot, entryPath)).canonicalPath;
      const sourceSnapshot = await strictOptionalExistingRegularFile(
        canonicalRoot,
        join(dirname(canonicalEntryPath), SOURCE_FILE),
      );
      if (sourceSnapshot) {
        const stored = projectOrganized(JSON.parse(sourceSnapshot.contents) as unknown);
        if (stored.document.source !== entry.source
          || stored.document.canonicalUrl !== entry.url
          || stableContentId(stored.document.canonicalUrl) !== entry.id) {
          throw new Error('catalog source identity mismatch');
        }
      }
      sourceFingerprints.push([
        entry.id,
        sourceSnapshot
          ? [sourceSnapshot.device, sourceSnapshot.inode, sourceSnapshot.contents]
          : null,
      ]);
      if (entry.id === targetId) targetSourceSnapshot = sourceSnapshot;
    }
    if (!targetRegistered) {
      const orphan = await preflightOrphanTargetArtifacts(canonicalRoot, target);
      sourceFingerprints.push(orphan.fingerprint);
      newEntryPlan = orphan.newEntryPlan;
      recoveryPending = orphan.recoveryPending === true;
    } else if (target && await findDirectedRecoveryFingerprint({
      root: canonicalRoot,
      source: target.source,
      canonicalUrl: target.canonicalUrl,
      stableContentId: targetId!,
    })) {
      // A replacement transaction may be published while the old entry is still the catalog
      // authority. Mark it explicitly so the locked pass may recover the replacement before the
      // ordinary preflight snapshot comparison is applied.
      recoveryPending = true;
    }
    return {
      canonicalRoot,
      catalogDirectory: catalogDirectoryIdentity,
      catalogExisted: true,
      catalogSnapshot,
      catalog,
      catalogFingerprint: JSON.stringify(catalog),
      sourceFingerprint: JSON.stringify(sourceFingerprints),
      ...(targetSourceSnapshot ? { targetSourceSnapshot } : {}),
      ...(newEntryPlan ? { newEntryPlan } : {}),
      ...(recoveryPending ? { recoveryPending: true } : {}),
    };
  } catch (error) {
    if (error instanceof DirectedLocalLibraryCorruptError) throw error;
    throw new DirectedLocalLibraryCorruptError(error);
  }
}

export async function preflightDirectedLocalLibrary(
  root: string,
  target?: DirectedLocalDocumentTarget,
): Promise<string> {
  return (await preflightDirectedLocalLibraryState(root, target)).canonicalRoot;
}

async function writeAllBytes(
  handle: Pick<FileHandle, 'write'>,
  bytes: Uint8Array,
  position = 0,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten <= 0) throw new Error('short write made no progress');
    offset += result.bytesWritten;
  }
}

interface OwnedUniqueFile {
  path: string;
  kind: DirectedExclusiveCreateKind;
  relativeEntryPath?: string;
  handle: FileHandle;
  device: number;
  inode: number;
  linkCount: number;
  closed: boolean;
  sha256?: string;
  byteLength?: number;
}

interface DirectedCatalogStage {
  root: string;
  path: string;
  contents: string;
  preflight: DirectedLocalLibraryPreflight;
  temporary: OwnedUniqueFile;
  committed: boolean;
}

interface DirectedNewEntryTransaction {
  transactionId: string;
  root: string;
  plan: DirectedNewEntryPlan;
  preflight: DirectedLocalLibraryPreflight;
  io: DirectedTransactionIo;
  stagingDirectory: StrictDirectoryIdentity;
  finalParentDirectory?: StrictDirectoryIdentity;
  assetDirectory?: StrictDirectoryIdentity;
  entryFiles: Map<string, OwnedUniqueFile>;
  openFiles: OwnedUniqueFile[];
  catalogStage?: DirectedCatalogStage;
  intent: DirectedTransactionIntent;
  intentBytes: Buffer;
  journal?: DirectedTransactionJournal;
  markerFile?: OwnedUniqueFile;
  journalPointerFile?: OwnedUniqueFile;
  replacedTree?: DirectedReplacementTreeEntry[];
  entryPublished: boolean;
  catalogCommitted: boolean;
  cleanupDirectoryPath: string;
  context: DirectedTransactionBoundaryContext;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function assertDirectoryIdentity(
  root: string,
  expected: StrictDirectoryIdentity,
  path = expected.path,
): Promise<void> {
  const observed = await strictDirectoryIdentity(root, path);
  if (observed.device !== expected.device || observed.inode !== expected.inode) {
    throw new Error('directory identity changed');
  }
}

async function assertOwnedUniqueFile(
  root: string,
  file: OwnedUniqueFile,
  path = file.path,
): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.dev !== file.device
    || metadata.ino !== file.inode
    || metadata.nlink !== file.linkCount
    || metadata.nlink !== 1
    || await realpath(path) !== path
    || !insideCanonicalRoot(root, path)) {
    throw new Error('unique file identity changed');
  }
}

async function closeOwnedUniqueFile(file: OwnedUniqueFile): Promise<void> {
  if (file.closed) return;
  await file.handle.close();
  file.closed = true;
}

async function closeOwnedUniqueFiles(files: readonly OwnedUniqueFile[]): Promise<void> {
  const results = await Promise.allSettled(files.map(async file => await closeOwnedUniqueFile(file)));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

async function closeOwnedUniqueFilesForCleanup(
  files: readonly OwnedUniqueFile[],
): Promise<boolean> {
  try {
    await closeOwnedUniqueFiles(files);
    return true;
  } catch {
    try {
      // A transient close failure retains the descriptor as open, so cleanup gets one exact retry.
      await closeOwnedUniqueFiles(files);
      return true;
    } catch {
      return false;
    }
  }
}

async function openExclusiveOwnedFile(
  path: string,
  kind: DirectedExclusiveCreateKind,
  io: DirectedTransactionIo,
  registry: OwnedUniqueFile[],
  relativeEntryPath?: string,
  onRegistered?: (file: OwnedUniqueFile) => void,
): Promise<OwnedUniqueFile> {
  await io.beforeExclusiveCreate?.(kind, path);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  // Register the live descriptor before any fallible initialization. Cleanup can therefore
  // always close a successfully opened descriptor and only removes a path whose inode we bound.
  const owned: OwnedUniqueFile = {
    path,
    kind,
    ...(relativeEntryPath ? { relativeEntryPath } : {}),
    handle,
    device: -1,
    inode: -1,
    linkCount: -1,
    closed: false,
  };
  registry.push(owned);
  onRegistered?.(owned);
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('exclusive leaf invalid');
  owned.device = metadata.dev;
  owned.inode = metadata.ino;
  owned.linkCount = metadata.nlink;
  await io.afterExclusiveOpen?.(kind, path, handle);
  return owned;
}

async function initializeOwnedUniqueFile(
  root: string,
  file: OwnedUniqueFile,
  bytes: Uint8Array,
): Promise<void> {
  await writeAllBytes(file.handle, bytes);
  await file.handle.sync();
  await assertOwnedUniqueFile(root, file);
  file.sha256 = directedBytesDigest(bytes);
  file.byteLength = bytes.byteLength;
}

async function createUniqueStagingDirectory(
  root: string,
  catalogDirectory: StrictDirectoryIdentity,
  io: DirectedTransactionIo,
  transactionId: string,
): Promise<StrictDirectoryIdentity> {
  await assertDirectoryIdentity(root, catalogDirectory);
  const path = join(
    catalogDirectory.path,
    `.directed-entry-${transactionId}`,
  );
  await io.beforeExclusiveCreate?.('directory', path);
  await mkdir(path, { mode: 0o700 });
  const created = await strictDirectoryIdentity(root, path);
  await assertDirectoryIdentity(root, catalogDirectory);
  return created;
}

async function createDirectedNewEntryTransaction(
  root: string,
  plan: DirectedNewEntryPlan,
  preflight: DirectedLocalLibraryPreflight,
  io: DirectedTransactionIo,
  source: Source,
  canonicalUrl: string,
  transactionId = newDirectedTransactionId(),
): Promise<DirectedNewEntryTransaction> {
  const replacedCatalogEntry = preflight.catalog.find(entry => entry.id === plan.id);
  const replacedTree = replacedCatalogEntry
    ? await inventoryDirectedReplacementTree(
        root,
        posix.dirname(replacedCatalogEntry.relativePath),
      )
    : undefined;
  const intent = createDirectedTransactionIntent({
    transactionId,
    stableContentId: plan.id,
    source,
    canonicalUrl,
    entryRelativeDirectory: toCatalogRelativePath(relative(root, plan.entryDirectory)),
    ...(preflight.catalogSnapshot
      ? { catalogBeforeContents: preflight.catalogSnapshot.contents }
      : {}),
  });
  const intentBytes = serializeDirectedTransactionIntent(intent);
  const openFiles: OwnedUniqueFile[] = [];
  const pointerPath = directedJournalPointerPath(preflight.catalogDirectory.path, transactionId);
  const pointer = await openExclusiveOwnedFile(
    join(
      preflight.catalogDirectory.path,
      `.directed-intent-${transactionId}-${randomBytes(12).toString('hex')}.tmp`,
    ),
    'transaction-intent',
    io,
    openFiles,
  );
  try {
    await initializeOwnedUniqueFile(root, pointer, intentBytes);
    await closeOwnedUniqueFile(pointer);
    await assertDirectoryIdentity(root, preflight.catalogDirectory);
    try {
      await lstat(pointerPath);
      throw new Error('directed transaction intent appeared');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(pointer.path, pointerPath);
    pointer.path = pointerPath;
    await syncDirectedDirectory(preflight.catalogDirectory.path);
    await io.afterIntentCommit?.(pointer.path);
  } catch (error) {
    await closeOwnedUniqueFile(pointer).catch(() => undefined);
    try {
      await assertOwnedUniqueFile(root, pointer);
      await unlink(pointer.path);
      await syncDirectedDirectory(preflight.catalogDirectory.path);
    } catch {
      // Preserve an uncertain partial leaf; locked recovery remains fail-closed.
    }
    throw error;
  }
  const stagingDirectory = await createUniqueStagingDirectory(
    root,
    preflight.catalogDirectory,
    io,
    transactionId,
  );
  return {
    transactionId,
    root,
    plan,
    preflight,
    io,
    intent,
    intentBytes,
    stagingDirectory,
    entryFiles: new Map(),
    openFiles,
    journalPointerFile: pointer,
    ...(replacedTree ? { replacedTree } : {}),
    entryPublished: false,
    catalogCommitted: false,
    cleanupDirectoryPath: stagingDirectory.path,
    context: {
      stagingDirectory: stagingDirectory.path,
      finalDirectory: plan.entryDirectory,
      finalParentDirectory: plan.finalParentDirectory,
      catalogPath: join(preflight.catalogDirectory.path, 'index.json'),
    },
  };
}

async function stageDirectedEntryFile(
  transaction: DirectedNewEntryTransaction,
  relativeEntryPath: string,
  kind: DirectedExclusiveCreateKind,
  bytes: Uint8Array,
): Promise<OwnedUniqueFile> {
  if (transaction.entryFiles.has(relativeEntryPath)) throw new Error('duplicate staged entry leaf');
  const path = join(transaction.stagingDirectory.path, ...relativeEntryPath.split('/'));
  const file = await openExclusiveOwnedFile(
    path,
    kind,
    transaction.io,
    transaction.openFiles,
    relativeEntryPath,
    registered => transaction.entryFiles.set(relativeEntryPath, registered),
  );
  await initializeOwnedUniqueFile(transaction.root, file, bytes);
  return file;
}

async function stageDirectedAsset(
  transaction: DirectedNewEntryTransaction,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  if (!transaction.assetDirectory) {
    const assetsPath = join(transaction.stagingDirectory.path, 'assets');
    await transaction.io.beforeExclusiveCreate?.('assets-directory', assetsPath);
    await mkdir(assetsPath, { mode: 0o700 });
    transaction.assetDirectory = await strictDirectoryIdentity(transaction.root, assetsPath);
  }
  await assertDirectoryIdentity(transaction.root, transaction.stagingDirectory);
  await assertDirectoryIdentity(transaction.root, transaction.assetDirectory);
  await stageDirectedEntryFile(
    transaction,
    posix.join('assets', filename),
    'asset',
    bytes,
  );
  return posix.join('assets', filename);
}

async function assertDirectedEntryTree(
  transaction: DirectedNewEntryTransaction,
  directoryPath: string,
): Promise<void> {
  await assertDirectoryIdentity(
    transaction.root,
    transaction.stagingDirectory,
    directoryPath,
  );
  const expectedTopLevel = new Set<string>();
  for (const relativePath of transaction.entryFiles.keys()) {
    expectedTopLevel.add(relativePath.split('/')[0]!);
  }
  if (transaction.assetDirectory) expectedTopLevel.add('assets');
  const topLevel = await readdir(directoryPath);
  if (topLevel.length !== expectedTopLevel.size
    || topLevel.some(name => !expectedTopLevel.has(name))) {
    throw new Error('staged entry contains an unowned path');
  }
  if (transaction.assetDirectory) {
    await assertDirectoryIdentity(
      transaction.root,
      transaction.assetDirectory,
      join(directoryPath, 'assets'),
    );
    const expectedAssets = [...transaction.entryFiles.keys()]
      .filter(path => path.startsWith('assets/'))
      .map(path => path.slice('assets/'.length))
      .sort();
    const observedAssets = (await readdir(join(directoryPath, 'assets'))).sort();
    if (JSON.stringify(observedAssets) !== JSON.stringify(expectedAssets)) {
      throw new Error('staged assets contain an unowned path');
    }
  }
  for (const [relativePath, file] of transaction.entryFiles) {
    await assertOwnedUniqueFile(
      transaction.root,
      file,
      join(directoryPath, ...relativePath.split('/')),
    );
  }
}

async function ensureDirectedFinalParent(
  transaction: DirectedNewEntryTransaction,
): Promise<StrictDirectoryIdentity> {
  await assertDirectoryIdentity(transaction.root, transaction.plan.nearestExistingDirectory);
  let current = transaction.plan.nearestExistingDirectory;
  for (const part of transaction.plan.missingDirectoryParts) {
    await assertDirectoryIdentity(transaction.root, current);
    const nextPath = join(current.path, part);
    await transaction.io.beforeExclusiveCreate?.('directory', nextPath);
    await mkdir(nextPath, { mode: 0o700 });
    await syncDirectedDirectory(current.path);
    current = await strictDirectoryIdentity(transaction.root, nextPath);
  }
  if (current.path !== transaction.plan.finalParentDirectory) {
    throw new Error('final parent path mismatch');
  }
  transaction.finalParentDirectory = current;
  return current;
}

async function assertFinalEntryAbsent(
  transaction: DirectedNewEntryTransaction,
): Promise<void> {
  if (!transaction.finalParentDirectory) throw new Error('final parent not bound');
  await assertDirectoryIdentity(transaction.root, transaction.finalParentDirectory);
  try {
    await lstat(transaction.plan.entryDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await assertDirectoryIdentity(transaction.root, transaction.finalParentDirectory);
      return;
    }
    throw error;
  }
  throw new Error('final directed entry already exists');
}

async function assertDirectedCatalogAuthority(
  preflight: DirectedLocalLibraryPreflight,
  catalogPath: string,
): Promise<void> {
  await assertDirectoryIdentity(preflight.canonicalRoot, preflight.catalogDirectory);
  if (preflight.catalogExisted) {
    if (!preflight.catalogSnapshot || preflight.catalogSnapshot.linkCount !== 1) {
      throw new Error('catalog snapshot missing');
    }
    const observed = await strictExistingRegularFile(preflight.canonicalRoot, catalogPath);
    if (!sameOptionalRegularSnapshot(observed, preflight.catalogSnapshot)
      || observed.linkCount !== 1
      || sha256Text(observed.contents) !== sha256Text(preflight.catalogSnapshot.contents)) {
      throw new Error('catalog changed before commit');
    }
  } else {
    try {
      await lstat(catalogPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await assertDirectoryIdentity(preflight.canonicalRoot, preflight.catalogDirectory);
        return;
      }
      throw error;
    }
    throw new Error('catalog appeared before commit');
  }
  await assertDirectoryIdentity(preflight.canonicalRoot, preflight.catalogDirectory);
}

async function stageDirectedCatalog(
  root: string,
  catalogPath: string,
  contents: string,
  preflight: DirectedLocalLibraryPreflight,
  io: DirectedTransactionIo,
  registry: OwnedUniqueFile[],
  transactionId?: string,
): Promise<DirectedCatalogStage> {
  await assertDirectedCatalogAuthority(preflight, catalogPath);
  const temporaryPath = join(preflight.catalogDirectory.path, transactionId
    ? `.directed-catalog-${transactionId}.tmp`
    : `.directed-catalog-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  const temporary = await openExclusiveOwnedFile(
    temporaryPath,
    'catalog-temp',
    io,
    registry,
  );
  await initializeOwnedUniqueFile(root, temporary, Buffer.from(contents, 'utf8'));
  return { root, path: catalogPath, contents, preflight, temporary, committed: false };
}

/**
 * Transaction threat boundary: all data-collector writers for this library cooperate through the
 * caller's directed library lock and this process's catalog queue. Under that authority, the
 * pre-commit inode/hash check and one rename form the catalog commit. A same-UID process that
 * deliberately ignores the application lock is outside this protocol; no pathname-only Node API
 * can provide a portable compare-and-swap rename against such an actor.
 */
async function commitDirectedCatalog(
  stage: DirectedCatalogStage,
  io: DirectedTransactionIo,
): Promise<void> {
  await assertDirectedCatalogAuthority(stage.preflight, stage.path);
  await assertOwnedUniqueFile(stage.root, stage.temporary);
  await closeOwnedUniqueFile(stage.temporary);
  // The application lock excludes cooperating writers. The rename is therefore the one commit
  // primitive for both an existing and an absent catalog, and it never exposes partial JSON.
  await rename(stage.temporary.path, stage.path);
  stage.committed = true;
  // The catalog rename is durable before any entry marker can be removed. Recovery may therefore
  // treat catalog-after + pointer-only as committed, never catalog-before + pointer-only.
  await syncDirectedDirectory(dirname(stage.path));
  try {
    await io.afterCatalogCommit?.(stage.path, stage.temporary.path);
    const committed = await strictExistingRegularFile(stage.root, stage.path);
    if (committed.linkCount !== 1
      || committed.contents !== stage.contents
      || sha256Text(committed.contents) !== sha256Text(stage.contents)) {
      throw new Error('committed catalog identity mismatch');
    }
    await assertDirectoryIdentity(stage.root, stage.preflight.catalogDirectory);
  } catch {
    // Rename already made this exact full catalog authoritative. A post-commit diagnostic cannot
    // be reported as a failed save without splitting local evidence from its candidate receipt.
  }
}

async function unlinkOwnedUniqueFile(
  root: string,
  file: OwnedUniqueFile,
  io: DirectedTransactionIo,
  path = file.path,
): Promise<void> {
  await closeOwnedUniqueFile(file).catch(() => undefined);
  await io.beforeUniqueCleanup?.(path);
  await assertOwnedUniqueFile(root, file, path);
  await unlink(path);
}

async function cleanupDirectedNewEntryTransaction(
  transaction: DirectedNewEntryTransaction,
): Promise<void> {
  if (!await closeOwnedUniqueFilesForCleanup(transaction.openFiles)) return;
  if (transaction.catalogCommitted) return;
  if (!transaction.journal) {
    // Before a full manifest exists, an in-process error may be rolled back only while every
    // pathname is still descriptor-bound and the staging tree contains exactly those owned leaves.
    // A marker/pointer installation attempt is deliberately left to intent recovery instead.
    if (transaction.openFiles.some(file =>
      file.kind === 'transaction-marker' || file.kind === 'journal-pointer')) return;
    try {
      await transaction.io.beforeUniqueCleanup?.(transaction.stagingDirectory.path);
      await assertDirectedEntryTree(transaction, transaction.stagingDirectory.path);
      await rm(transaction.stagingDirectory.path, { recursive: true });
      await syncDirectedDirectory(transaction.preflight.catalogDirectory.path);
    } catch {
      return;
    }
    for (const file of transaction.openFiles.filter(candidate => candidate.kind === 'catalog-temp')) {
      try {
        await unlinkOwnedUniqueFile(transaction.root, file, transaction.io);
        await syncDirectedDirectory(transaction.preflight.catalogDirectory.path);
      } catch {
        return;
      }
    }
    const intentPointer = transaction.journalPointerFile;
    if (intentPointer) {
      try {
        await unlinkOwnedUniqueFile(transaction.root, intentPointer, transaction.io);
        await syncDirectedDirectory(transaction.preflight.catalogDirectory.path);
      } catch {
        return;
      }
    }
    return;
  }

  if (transaction.journal) {
    const incompletePointer = transaction.journalPointerFile;
    if (incompletePointer
      && (incompletePointer.sha256 === undefined || incompletePointer.byteLength === undefined)) {
      try {
        await unlinkOwnedUniqueFile(transaction.root, incompletePointer, transaction.io);
        await syncDirectedDirectory(transaction.preflight.catalogDirectory.path);
      } catch {
        // Preserve the complete marked stage/catalog temp. A malformed pointer is fail-closed;
        // it must never authorize deletion of the remaining recovery evidence.
      }
    }
    // Once the marker is durable, recovery resumes this exact transaction. Multi-path eager
    // rollback cannot provide a power-loss-safe ordering without another journal, so leave the
    // marker, catalog stage and any complete pointer intact.
    return;
  }

  if (transaction.entryPublished) {
    try {
      if (!transaction.finalParentDirectory) throw new Error('final parent not bound');
      await assertDirectoryIdentity(transaction.root, transaction.finalParentDirectory);
      await assertDirectedEntryTree(transaction, transaction.plan.entryDirectory);
      let cleanupPath = transaction.stagingDirectory.path;
      try {
        await assertDirectoryIdentity(transaction.root, transaction.preflight.catalogDirectory);
      } catch {
        // The original unique staging name moved with a replaced catalog parent. The final parent
        // is still descriptor-bound, so retreat to a new unique sibling before any recursive clean.
        cleanupPath = join(
          transaction.finalParentDirectory.path,
          `.directed-rollback-${process.pid}-${randomBytes(12).toString('hex')}`,
        );
      }
      try {
        await lstat(cleanupPath);
        throw new Error('cleanup path unexpectedly exists');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await assertDirectoryIdentity(transaction.root, transaction.finalParentDirectory);
      await rename(transaction.plan.entryDirectory, cleanupPath);
      transaction.cleanupDirectoryPath = cleanupPath;
      transaction.entryPublished = false;
    } catch {
      // The final path is no longer provably ours. Preserve it rather than unlink foreign bytes.
    }
  }

  // Once a durable pointer exists it is the recovery authority for the marked stage and staged
  // catalog. Remove that authority first, while both recovery inputs are still intact. If pointer
  // cleanup cannot be proved, preserve the whole transaction for the next locked recovery pass;
  // deleting the stage first would leave an unrecoverable pointer-only catalog-before state.
  if (transaction.entryPublished) return;
  const pointer = transaction.journalPointerFile;
  if (pointer) {
    try {
      await unlinkOwnedUniqueFile(transaction.root, pointer, transaction.io);
    } catch {
      return;
    }
  }

  if (!transaction.entryPublished) {
    try {
      await transaction.io.beforeUniqueCleanup?.(transaction.cleanupDirectoryPath);
      await assertDirectedEntryTree(transaction, transaction.cleanupDirectoryPath);
      await rm(transaction.cleanupDirectoryPath, { recursive: true });
    } catch {
      // A unique staging name with an unexpected inode/tree is preserved conservatively.
    }
  }

  const temporary = transaction.catalogStage?.temporary;
  if (temporary && !transaction.catalogStage?.committed) {
    await unlinkOwnedUniqueFile(transaction.root, temporary, transaction.io).catch(() => undefined);
  }
  for (const file of transaction.openFiles) {
    if (file.relativeEntryPath || file === temporary || file === pointer) continue;
    await unlinkOwnedUniqueFile(transaction.root, file, transaction.io).catch(() => undefined);
  }
}

async function stageDirectedTransactionJournal(
  transaction: DirectedNewEntryTransaction,
  catalogContents: string,
): Promise<void> {
  if (!transaction.catalogStage) throw new Error('directed catalog stage missing');
  const catalogValue = JSON.parse(catalogContents) as unknown;
  if (!Array.isArray(catalogValue)) throw new Error('directed staged catalog invalid');
  const catalogEntry = catalogValue.find(value =>
    isRecord(value) && value.id === transaction.plan.id) as Record<string, unknown> | undefined;
  if (!catalogEntry) throw new Error('directed staged catalog entry missing');
  const files = [...transaction.entryFiles.entries()].map(([relativePath, file]) => {
    if (!file.sha256 || file.byteLength === undefined) {
      throw new Error('directed staged file digest missing');
    }
    return { relativePath, sha256: file.sha256, byteLength: file.byteLength };
  });
  const journal = createDirectedTransactionJournal({
    transactionId: transaction.transactionId,
    stableContentId: transaction.plan.id,
    source: catalogEntry.source as Source,
    canonicalUrl: catalogEntry.url as string,
    entryRelativeDirectory: toCatalogRelativePath(
      relative(transaction.root, transaction.plan.entryDirectory),
    ),
    catalogTemporaryName: basename(transaction.catalogStage.temporary.path),
    ...(transaction.preflight.catalogSnapshot
      ? { catalogBeforeContents: transaction.preflight.catalogSnapshot.contents }
      : {}),
    intentDigest: directedBytesDigest(transaction.intentBytes),
    catalogAfterContents: catalogContents,
    catalogEntry,
    ...(transaction.preflight.catalog.find(entry => entry.id === transaction.plan.id)
      ? {
          replacedCatalogEntry: transaction.preflight.catalog.find(
            entry => entry.id === transaction.plan.id,
          ) as unknown as Record<string, unknown>,
          replacedTree: transaction.replacedTree,
        }
      : {}),
    files,
  });
  const bytes = serializeDirectedTransactionJournal(journal);
  const markerPath = join(transaction.stagingDirectory.path, DIRECTED_TRANSACTION_MARKER);
  const markerTemporary = await openExclusiveOwnedFile(
    join(
      transaction.stagingDirectory.path,
      `${DIRECTED_TRANSACTION_MARKER}.${randomBytes(12).toString('hex')}.tmp`,
    ),
    'transaction-marker',
    transaction.io,
    transaction.openFiles,
  );
  await initializeOwnedUniqueFile(transaction.root, markerTemporary, bytes);
  await closeOwnedUniqueFile(markerTemporary);
  await transaction.io.beforeManifestInstall?.(
    'transaction-marker',
    markerTemporary.path,
    markerPath,
  );
  if (transaction.assetDirectory) await syncDirectedDirectory(transaction.assetDirectory.path);
  await assertDirectoryIdentity(transaction.root, transaction.stagingDirectory);
  try {
    await lstat(markerPath);
    throw new Error('directed transaction marker appeared');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rename(markerTemporary.path, markerPath);
  markerTemporary.path = markerPath;
  markerTemporary.relativeEntryPath = DIRECTED_TRANSACTION_MARKER;
  transaction.entryFiles.set(DIRECTED_TRANSACTION_MARKER, markerTemporary);
  transaction.markerFile = markerTemporary;
  await syncDirectedDirectory(transaction.stagingDirectory.path);
  transaction.journal = journal;
  const pointerPath = directedJournalPointerPath(
    transaction.preflight.catalogDirectory.path,
    transaction.transactionId,
  );
  const intentPointer = transaction.journalPointerFile;
  if (!intentPointer) throw new Error('directed transaction intent missing');
  await assertOwnedUniqueFile(transaction.root, intentPointer);
  if (!(await readFile(pointerPath)).equals(transaction.intentBytes)) {
    throw new Error('directed transaction intent changed');
  }
  const pointer = await openExclusiveOwnedFile(
    join(
      transaction.preflight.catalogDirectory.path,
      `.directed-pointer-${transaction.transactionId}-${randomBytes(12).toString('hex')}.tmp`,
    ),
    'journal-pointer',
    transaction.io,
    transaction.openFiles,
  );
  await initializeOwnedUniqueFile(transaction.root, pointer, bytes);
  await closeOwnedUniqueFile(pointer);
  await transaction.io.beforeManifestInstall?.('journal-pointer', pointer.path, pointerPath);
  await assertOwnedUniqueFile(transaction.root, intentPointer);
  if (!(await readFile(pointerPath)).equals(transaction.intentBytes)) {
    throw new Error('directed transaction intent changed before manifest install');
  }
  await rename(pointer.path, pointerPath);
  pointer.path = pointerPath;
  const oldPointerIndex = transaction.openFiles.indexOf(intentPointer);
  if (oldPointerIndex >= 0) transaction.openFiles.splice(oldPointerIndex, 1);
  transaction.journalPointerFile = pointer;
  await syncDirectedDirectory(transaction.preflight.catalogDirectory.path);
}

async function clearCommittedDirectedTransactionJournal(
  transaction: DirectedNewEntryTransaction,
): Promise<void> {
  const marker = transaction.markerFile;
  const pointer = transaction.journalPointerFile;
  if (!marker || !pointer || !transaction.journal) {
    throw new Error('directed transaction journal missing after commit');
  }
  const finalMarkerPath = join(transaction.plan.entryDirectory, DIRECTED_TRANSACTION_MARKER);
  // Marker-first makes a crash between the two removals recoverable from the catalog pointer.
  await unlinkOwnedUniqueFile(transaction.root, marker, transaction.io, finalMarkerPath);
  transaction.entryFiles.delete(DIRECTED_TRANSACTION_MARKER);
  await syncDirectedDirectory(transaction.plan.entryDirectory);
  await unlinkOwnedUniqueFile(transaction.root, pointer, transaction.io);
  await syncDirectedDirectory(transaction.preflight.catalogDirectory.path);
}

async function commitDirectedNewEntryTransaction(
  transaction: DirectedNewEntryTransaction,
  catalogContents: string,
): Promise<void> {
  transaction.catalogStage = await stageDirectedCatalog(
    transaction.root,
    transaction.context.catalogPath,
    catalogContents,
    transaction.preflight,
    transaction.io,
    transaction.openFiles,
    transaction.transactionId,
  );
  transaction.context.catalogTemporaryPath = transaction.catalogStage.temporary.path;
  await stageDirectedTransactionJournal(transaction, catalogContents);
  await transaction.io.beforeEntryCommit?.(transaction.context);
  await assertDirectedCatalogAuthority(transaction.preflight, transaction.context.catalogPath);
  await assertDirectedEntryTree(transaction, transaction.stagingDirectory.path);
  await assertDirectoryIdentity(transaction.root, transaction.preflight.catalogDirectory);
  await ensureDirectedFinalParent(transaction);
  await assertFinalEntryAbsent(transaction);
  await closeOwnedUniqueFiles(transaction.openFiles.filter(file => file !== transaction.catalogStage!.temporary));
  // This stable-ID/content-hash leaf is absent while the same directed application lock is held.
  // As with catalog replacement, a same-UID actor that ignores that lock is outside the protocol;
  // Node does not expose a portable renameat2(RENAME_NOREPLACE) equivalent for directories.
  await rename(transaction.stagingDirectory.path, transaction.plan.entryDirectory);
  transaction.entryPublished = true;
  await syncDirectedDirectory(transaction.finalParentDirectory!.path);
  await syncDirectedDirectory(transaction.preflight.catalogDirectory.path);
  await assertDirectedEntryTree(transaction, transaction.plan.entryDirectory);

  await transaction.io.beforeCatalogCommit?.(transaction.context);
  await assertDirectedCatalogAuthority(transaction.preflight, transaction.context.catalogPath);
  await assertDirectoryIdentity(transaction.root, transaction.finalParentDirectory!);
  await assertDirectedEntryTree(transaction, transaction.plan.entryDirectory);
  try {
    await commitDirectedCatalog(transaction.catalogStage, transaction.io);
  } finally {
    // Once the catalog path was atomically installed it is authoritative even if a post-commit
    // durability check fails. Never remove the entry that the committed catalog now references.
    transaction.catalogCommitted = transaction.catalogStage.committed;
  }
  if (transaction.catalogCommitted) {
    // A cleanup error after the catalog rename must not turn an authoritative save into a failure.
    // Any exact marker/pointer left behind is reconciled under the same lock on next startup.
    try {
      await retireDirectedReplacedEntry(transaction.root, transaction.journal!);
      await clearCommittedDirectedTransactionJournal(transaction);
    } catch {
      // Keep the journal authority until both old-version retirement and marker cleanup finish.
    }
  }
}

async function commitDirectedCatalogOnly(
  root: string,
  catalogPath: string,
  contents: string,
  preflight: DirectedLocalLibraryPreflight,
  io: DirectedTransactionIo,
  entryDirectory: string,
): Promise<void> {
  const registry: OwnedUniqueFile[] = [];
  let stage: DirectedCatalogStage | undefined;
  try {
    stage = await stageDirectedCatalog(root, catalogPath, contents, preflight, io, registry);
    await io.beforeCatalogCommit?.({
      stagingDirectory: entryDirectory,
      finalDirectory: entryDirectory,
      finalParentDirectory: dirname(entryDirectory),
      catalogPath,
      catalogTemporaryPath: stage.temporary.path,
    });
    await commitDirectedCatalog(stage, io);
  } finally {
    await closeOwnedUniqueFilesForCleanup(registry);
    if (!stage?.committed) {
      for (const file of registry) {
        await unlinkOwnedUniqueFile(root, file, io).catch(() => undefined);
      }
    }
  }
}

export async function atomicWriteText(root: string, path: string, contents: string): Promise<void> {
  await assertSafeWritePath(root, dirname(path));
  await mkdir(dirname(path), { recursive: true });
  await assertSafeWritePath(root, path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function frontMatter(input: OrganizedDocument, id: string, failedImages: number): string {
  const document = input.document;
  const lines = [
    '---',
    `id: ${yamlString(id)}`,
    'schema_version: 1',
    `source: ${yamlString(document.source)}`,
    `kind: ${yamlString(document.kind)}`,
    `title: ${yamlString(document.title)}`,
    `url: ${yamlString(document.canonicalUrl)}`,
    ...(document.author ? [`author: ${yamlString(document.author)}`] : []),
    ...(document.publishedAt ? [`published_at: ${yamlString(document.publishedAt)}`] : []),
    `collected_at: ${yamlString(document.collectedAt)}`,
    `updated_at: ${yamlString(document.collectedAt)}`,
    `category: ${yamlString(input.category)}`,
    'tags:',
    ...input.tags.map(tag => `  - ${yamlString(tag)}`),
    `summary: ${yamlString(input.summary)}`,
    `failed_images: ${failedImages}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    'id', 'source', 'title', 'url', 'category', 'relativePath', 'updatedAt', 'publishedAt',
    'contentComplete', 'contentCompletenessVersion', 'contentCompletenessBuildId',
    'deliveryRevision', 'deliveryBatchId', 'sync',
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) return false;
  if (typeof value.id !== 'string' || value.id.length === 0
    || typeof value.source !== 'string' || !SOURCES.includes(value.source as Source)
    || typeof value.title !== 'string' || typeof value.url !== 'string'
    || typeof value.category !== 'string' || typeof value.relativePath !== 'string' || value.relativePath.length === 0
    || typeof value.updatedAt !== 'string') return false;
  if (value.publishedAt !== undefined && typeof value.publishedAt !== 'string') return false;
  if (value.contentComplete !== undefined && typeof value.contentComplete !== 'boolean') return false;
  if (value.contentCompletenessVersion !== undefined && typeof value.contentCompletenessVersion !== 'string') return false;
  if (value.contentCompletenessBuildId !== undefined && typeof value.contentCompletenessBuildId !== 'string') return false;
  if (value.deliveryRevision !== undefined
    && (typeof value.deliveryRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.deliveryRevision))) return false;
  if (value.deliveryBatchId !== undefined && typeof value.deliveryBatchId !== 'string') return false;
  if (value.sync !== undefined) {
    if (!isRecord(value.sync)) return false;
    const syncAllowed = new Set(['state', 'target', 'at', 'committed', 'pushed', 'pushFailed', 'error']);
    if (Object.keys(value.sync).some(key => !syncAllowed.has(key))
      || (value.sync.state !== 'pending' && value.sync.state !== 'synced' && value.sync.state !== 'failed')
      || (value.sync.target !== undefined && typeof value.sync.target !== 'string')
      || (value.sync.at !== undefined && typeof value.sync.at !== 'string')
      || (value.sync.committed !== undefined && typeof value.sync.committed !== 'boolean')
      || (value.sync.pushed !== undefined && typeof value.sync.pushed !== 'boolean')
      || (value.sync.pushFailed !== undefined && typeof value.sync.pushFailed !== 'boolean')
      || (value.sync.error !== undefined && typeof value.sync.error !== 'string')) return false;
  }
  return true;
}

/** Strict directed read: only a leaf proven absent during preflight may become an empty catalog. */
export async function readDirectedCatalogFile(
  path: string,
  expectedExistingCatalog: boolean,
  io: DirectedCatalogReadIo = directedCatalogReadIo,
): Promise<unknown[]> {
  try {
    const value = JSON.parse(await io.readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(value) || !value.every(isCatalogEntry)) {
      throw new DirectedLocalLibraryCorruptError();
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !expectedExistingCatalog) return [];
    if (error instanceof DirectedLocalLibraryCorruptError) throw error;
    throw new DirectedLocalLibraryCorruptError(error);
  }
}

function normalizedVisibleBody(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

async function reliableCompleteZsxqBody(
  sourcePath: string,
  existing: CatalogEntry,
): Promise<string | undefined> {
  if (
    existing.source !== 'zsxq'
    || existing.contentComplete !== true
    || existing.contentCompletenessVersion !== ZSXQ_COMPLETE_CONTENT_CAPABILITY
  ) return undefined;

  // 只有目录确认完整、且留存快照的来源/身份/正文都能交叉验证时才阻止倒退。
  // 旧条目缺失或损坏 source.json 时无法可靠比较，继续正常写入，让本次完整采集自愈留存文件。
  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let document: OrganizedDocument['document'];
  try {
    document = projectOrganized(JSON.parse(raw) as unknown).document;
  } catch (error) {
    return undefined;
  }
  if (
    document.source !== 'zsxq' ||
    typeof document.canonicalUrl !== 'string' ||
    typeof document.text !== 'string' ||
    document.sourceMetadata?.contentCompletenessVersion
      !== existing.contentCompletenessVersion ||
    document.sourceMetadata?.contentCompletenessBuildId
      !== existing.contentCompletenessBuildId
  ) {
    return undefined;
  }
  try {
    if (stableContentId(document.canonicalUrl) !== existing.id) return undefined;
  } catch {
    return undefined;
  }
  return normalizedVisibleBody(document.text);
}

async function storedDeliveryRevision(
  sourcePath: string,
  existing: CatalogEntry,
  trustedContents?: string,
): Promise<string | undefined> {
  try {
    const raw = trustedContents ?? await readFile(sourcePath, 'utf8');
    const stored = projectOrganized(JSON.parse(raw) as unknown);
    if (
      stored?.document?.source !== existing.source
      || stored.document.canonicalUrl !== existing.url
      || stableContentId(stored.document.canonicalUrl) !== existing.id
    ) return undefined;
    return deliveryRevision(stored);
  } catch {
    return undefined;
  }
}

export class MarkdownLibrary {
  private readonly root: string;
  private readonly fetcher: typeof fetch;
  private readonly resolveAddresses: ResolveAddresses | undefined;
  private readonly directedTransactionIo: DirectedTransactionIo;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options: MarkdownLibraryOptions) {
    this.root = options.root;
    this.fetcher = options.fetch ?? fetch;
    this.resolveAddresses = options.resolveAddresses;
    this.directedTransactionIo = options.directedTransactionIo ?? defaultDirectedTransactionIo;
  }

  async save(input: OrganizedDocument, localEvidence?: LocalDocumentEvidence): Promise<SavedContent> {
    const result = this.saveQueue.then(async () => {
      const directedEvidence = localEvidence?.nowcoderDirected;
      const directed = directedEvidence !== undefined;
      try {
        const directedPreflight = directed
          ? await preflightDirectedLocalLibraryState(
              this.root,
              organizedTarget(input, directedEvidence.contentHash),
            )
          : undefined;
        const transactionRoot = directedPreflight?.canonicalRoot ?? this.root;
        return await withCatalogTransaction(
          transactionRoot,
          async () => {
            let authoritativePreflight = directedPreflight;
            if (directedPreflight) {
              const revalidated = await preflightDirectedLocalLibraryState(
                this.root,
                organizedTarget(input, directedEvidence!.contentHash),
              );
              if (revalidated.canonicalRoot !== directedPreflight.canonicalRoot
                || !sameDirectoryIdentity(
                  revalidated.catalogDirectory,
                  directedPreflight.catalogDirectory,
                )) {
                throw new DirectedLocalLibraryCorruptError();
              }
              authoritativePreflight = revalidated;
            }
            return await this.saveNow(input, localEvidence, authoritativePreflight);
          },
        );
      } catch (error) {
        if (directed && !(error instanceof DirectedLocalLibraryCorruptError)) {
          throw new DirectedLocalLibraryCorruptError(error);
        }
        throw error;
      }
    });
    this.saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async saveNow(
    input: OrganizedDocument,
    localEvidence?: LocalDocumentEvidence,
    directedPreflight?: DirectedLocalLibraryPreflight,
  ): Promise<SavedContent> {
    const root = directedPreflight?.canonicalRoot ?? this.root;
    await mkdir(root, { recursive: true });
    await assertSafeWritePath(root, root);
    const catalogPath = assertInsideRoot(root, join(root, '_catalog', 'index.json'));
    await assertSafeWritePath(root, catalogPath);
    const catalog = directedPreflight
      ? structuredClone(directedPreflight.catalog)
      : await this.readCatalog(catalogPath);
    const id = stableContentId(input.document.canonicalUrl);
    const existing = catalog.find(entry => entry.id === id);
    const directedEvidence = localEvidence?.nowcoderDirected;
    const directed = directedEvidence !== undefined;
    const directedNewEntry = directed && existing === undefined;
    const existingRelativePath = existing
      ? normalizeStoredCatalogRelativePath(existing.relativePath)
      : undefined;
    const existingMarkdownPath = existingRelativePath
      ? assertInsideRoot(root, catalogEntryPath(root, existingRelativePath))
      : undefined;
    const existingSourcePath = existingMarkdownPath
      ? assertInsideRoot(root, join(dirname(existingMarkdownPath), SOURCE_FILE))
      : undefined;
    const transactionId = directed ? newDirectedTransactionId() : undefined;
    let directedEntryPlan = directedNewEntry ? directedPreflight?.newEntryPlan : undefined;
    if (directed && existing && existingMarkdownPath && transactionId) {
      directedEntryPlan = await directedReplacementEntryPlan(
        root,
        existingMarkdownPath,
        id,
        directedEvidence.contentHash,
        transactionId,
      );
    }
    const relativePath = directedEntryPlan
      ? relative(root, directedEntryPlan.markdownPath).split(sep).join('/')
      : existingRelativePath ?? newDocumentRelativePath(organizedTarget(input), id);
    const markdownPath = assertInsideRoot(root, catalogEntryPath(root, relativePath));
    const entryDirectory = dirname(markdownPath);
    await assertSafeWritePath(root, entryDirectory);
    const sourcePath = assertInsideRoot(root, join(entryDirectory, SOURCE_FILE));
    if (directed && (
      !directedEntryPlan
      || directedEntryPlan.id !== id
      || directedEntryPlan.markdownPath !== markdownPath
      || directedEntryPlan.sourcePath !== sourcePath
      || directedEntryPlan.entryDirectory !== entryDirectory
    )) throw new DirectedLocalLibraryCorruptError();
    if (!directedEntryPlan) {
      await mkdir(entryDirectory, { recursive: true });
      await assertSafeWritePath(root, markdownPath);
    }
    const directedSourceSnapshot = localEvidence?.nowcoderDirected
      ? directedPreflight?.targetSourceSnapshot
      : undefined;

    let transaction: DirectedNewEntryTransaction | undefined;
    try {
    const completenessVersion = input.document.sourceMetadata?.contentCompletenessVersion;
    const completenessBuildId = input.document.sourceMetadata?.contentCompletenessBuildId;
    const hasCurrentCompletenessProof = input.document.source === 'zsxq'
      && input.document.truncated === false
      && completenessVersion === ZSXQ_COMPLETE_CONTENT_CAPABILITY;
    /*
     * “较长正文防回退”只能比较同一精确构建的两次观察。跨 build 时解析器、正文净化和
     * 身份规则可能刚被修正；旧 build 混入推荐区/重复块的污染正文往往反而更长。若仍按
     * 字数静默保留旧文件，强制修复会被报告 saved，磁盘上却一个字都没更新。
     */
    const sameExactCompletenessBuild = typeof completenessBuildId === 'string'
      && completenessBuildId.length > 0
      && existing?.contentCompletenessBuildId === completenessBuildId;
    if (existing && hasCurrentCompletenessProof && sameExactCompletenessBuild) {
      const existingBody = await reliableCompleteZsxqBody(existingSourcePath!, existing);
      const incomingBody = normalizedVisibleBody(input.document.text);
      if (
        existingBody !== undefined
        && (incomingBody.length < existingBody.length
          || (incomingBody.length === existingBody.length && incomingBody !== existingBody))
      ) {
        return {
          id,
          markdownPath: existingMarkdownPath!,
          downloadedImages: 0,
          failedImages: 0,
        };
      }
    }

    const incomingDeliveryRevision = deliveryRevision(input);
    const storedRevision = existing
      ? localEvidence?.nowcoderDirected
        ? directedSourceSnapshot === undefined
          ? undefined
          : await storedDeliveryRevision(existingSourcePath!, existing, directedSourceSnapshot.contents)
        : await storedDeliveryRevision(existingSourcePath!, existing)
      : undefined;
    // Existing catalogs have no revision yet. In that migration case, the verified source snapshot
    // is the receipt revision. Once persisted, both catalog and source must agree before inheriting it.
    const receiptRevision = existing?.deliveryRevision ?? storedRevision;
    const sameDeliveredContent = storedRevision !== undefined
      && storedRevision === incomingDeliveryRevision
      && receiptRevision === incomingDeliveryRevision;

    if (directedEntryPlan) {
      transaction = await createDirectedNewEntryTransaction(
        root,
        directedEntryPlan,
        directedPreflight!,
        this.directedTransactionIo,
        input.document.source,
        input.document.canonicalUrl,
        transactionId!,
      );
    }

    let assets: AssetResult;
    if (transaction) {
      assets = await downloadAssets({
        html: input.sanitizedHtml,
        images: input.document.images,
        entryDirectory: transaction.stagingDirectory.path,
        libraryRoot: root,
        fetch: this.fetcher,
        ...(this.resolveAddresses ? { resolveAddresses: this.resolveAddresses } : {}),
        writeAsset: async ({ filename, bytes }) => await stageDirectedAsset(
          transaction!,
          filename,
          bytes,
        ),
      });
    } else {
      assets = await downloadAssets({
        html: input.sanitizedHtml,
        images: input.document.images,
        entryDirectory,
        libraryRoot: root,
        fetch: this.fetcher,
        ...(this.resolveAddresses ? { resolveAddresses: this.resolveAddresses } : {}),
      });
    }
    const markdown = `${frontMatter(input, id, assets.failed)}# ${input.document.title}\n\n${renderMarkdown(assets.html)}\n`;
    if (transaction) {
      await stageDirectedEntryFile(
        transaction,
        'index.md',
        'entry-index',
        Buffer.from(markdown, 'utf8'),
      );
    } else {
      await atomicWriteText(root, markdownPath, markdown);
    }

    // 同步到收件箱时要原样重放这份内容，因此把整理结果一并留在条目目录里。
    // 不留的话就只能从 Markdown 反解，那是有损的。
    const sourceContents = `${JSON.stringify(storeOrganized(input, localEvidence), null, 2)}\n`;
    if (transaction) {
      await stageDirectedEntryFile(
        transaction,
        SOURCE_FILE,
        'entry-source',
        Buffer.from(sourceContents, 'utf8'),
      );
    } else {
      await atomicWriteText(root, sourcePath, sourceContents);
    }

    const nextEntry: CatalogEntry = {
      id,
      source: input.document.source,
      title: input.document.title,
      url: input.document.canonicalUrl,
      category: input.category,
      relativePath: toCatalogRelativePath(relative(root, markdownPath)),
      updatedAt: input.document.collectedAt,
      // 列表上要显示的是**帖子的发布时间**，不是我什么时候把它采下来的。
      ...(input.document.publishedAt ? { publishedAt: input.document.publishedAt } : {}),
      // 旧文档没有 truncated 时只能视为未知，不能把“没标记”升级成“已确认完整”。
      ...(input.document.truncated === undefined
        ? {}
        : {
            contentComplete: input.document.source === 'zsxq'
              ? hasCurrentCompletenessProof
              : input.document.truncated === false,
          }),
      ...(hasCurrentCompletenessProof
        ? {
            contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
            ...(typeof completenessBuildId === 'string'
              ? { contentCompletenessBuildId: completenessBuildId }
              : {}),
          }
        : {}),
      deliveryRevision: incomingDeliveryRevision,
      ...(sameDeliveredContent && existing?.deliveryBatchId
        ? { deliveryBatchId: existing.deliveryBatchId }
        : {}),
      // Transport-only recaptures keep their receipt; semantic changes require a new delivery.
      sync: sameDeliveredContent && existing?.sync
        ? { ...existing.sync }
        : { state: 'pending' },
    };
    const nextCatalog = catalog
      .filter(entry => entry.id !== id)
      .concat(nextEntry)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const nextCatalogContents = `${JSON.stringify(nextCatalog, null, 2)}\n`;
    if (transaction) {
      await commitDirectedNewEntryTransaction(transaction, nextCatalogContents);
    } else if (directedPreflight) {
      await commitDirectedCatalogOnly(
        root,
        catalogPath,
        nextCatalogContents,
        directedPreflight,
        this.directedTransactionIo,
        entryDirectory,
      );
    } else {
      await atomicWriteText(root, catalogPath, nextCatalogContents);
    }

    return {
      id,
      markdownPath,
      downloadedImages: assets.downloaded,
      failedImages: assets.failed,
    };
    } catch (error) {
      if (transaction) {
        await cleanupDirectedNewEntryTransaction(transaction);
      }
      throw error;
    }
  }

  private async readCatalog(
    path: string,
    strict = false,
    expectedExistingCatalog = false,
  ): Promise<CatalogEntry[]> {
    if (strict) {
      return await readDirectedCatalogFile(path, expectedExistingCatalog) as CatalogEntry[];
    }
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!Array.isArray(value)) {
        return [];
      }
      return value as CatalogEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
