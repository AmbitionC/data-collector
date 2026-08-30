import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import {
  canonicalizeUrl,
  descriptorForHost,
  parseSupportedUrl,
  SOURCES,
  stableContentId,
  type Source,
} from '@data-collector/shared';
import { projectOrganized } from './storedDocument.js';

export const DIRECTED_TRANSACTION_MARKER = '.data-collector-directed-transaction.json';
export const DIRECTED_JOURNAL_PREFIX = '.directed-journal-';
const DIRECTED_ENTRY_PREFIX = '.directed-entry-';
const DIRECTED_CATALOG_PREFIX = '.directed-catalog-';
const DIRECTED_RETIRED_PREFIX = '.directed-retired-';
const HEX_64 = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID = /^[a-f0-9]{32}$/u;

export interface DirectedJournalFile {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface DirectedReplacementTreeEntry {
  relativePath: string;
  type: 'directory' | 'file';
  sha256?: string;
  byteLength?: number;
}

export interface DirectedTransactionJournal {
  version: 1;
  transactionId: string;
  stableContentId: string;
  source: Source;
  canonicalUrl: string;
  entryRelativeDirectory: string;
  markdownRelativePath: string;
  sourceRelativePath: string;
  catalogTemporaryName: string;
  catalogBeforeDigest: string | null;
  intentDigest?: string;
  catalogAfterDigest: string;
  catalogEntry: Record<string, unknown>;
  replacedCatalogEntry?: Record<string, unknown>;
  replacedEntryRelativeDirectory?: string;
  replacedTree?: DirectedReplacementTreeEntry[];
  files: DirectedJournalFile[];
}

export interface CreateDirectedTransactionJournalInput {
  transactionId: string;
  stableContentId: string;
  source: Source;
  canonicalUrl: string;
  entryRelativeDirectory: string;
  catalogTemporaryName: string;
  catalogBeforeContents?: string;
  intentDigest?: string;
  catalogAfterContents: string;
  catalogEntry: Record<string, unknown>;
  replacedCatalogEntry?: Record<string, unknown>;
  replacedTree?: DirectedReplacementTreeEntry[];
  files: DirectedJournalFile[];
}

export interface DirectedTransactionIntent {
  version: 1;
  state: 'intent';
  transactionId: string;
  stableContentId: string;
  source: Source;
  canonicalUrl: string;
  entryRelativeDirectory: string;
  catalogTemporaryName: string;
  catalogBeforeDigest: string | null;
}

export interface CreateDirectedTransactionIntentInput {
  transactionId: string;
  stableContentId: string;
  source: Source;
  canonicalUrl: string;
  entryRelativeDirectory: string;
  catalogBeforeContents?: string;
}

interface StrictFile {
  path: string;
  raw: Buffer;
  device: number;
  inode: number;
  linkCount: number;
}

interface StrictDirectory {
  path: string;
  device: number;
  inode: number;
}

interface DiscoveredJournal {
  transactionId: string;
  raw: Buffer;
  journal: DirectedTransactionJournal;
  pointerPath?: string;
  stagePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function directedBytesDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelativePath(value: string): boolean {
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

function resolveRelative(root: string, value: string): string {
  if (!safeRelativePath(value)) throw new Error('directed journal path invalid');
  const path = resolve(root, ...value.split('/'));
  if (!insideRoot(root, path)) throw new Error('directed journal path escaped root');
  return path;
}

async function strictDirectory(root: string, path: string): Promise<StrictDirectory> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || await realpath(path) !== path || !insideRoot(root, path)) {
    throw new Error('directed journal directory invalid');
  }
  return { path, device: metadata.dev, inode: metadata.ino };
}

async function assertSameDirectory(root: string, expected: StrictDirectory): Promise<void> {
  const observed = await strictDirectory(root, expected.path);
  if (observed.device !== expected.device || observed.inode !== expected.inode) {
    throw new Error('directed journal directory changed');
  }
}

async function strictFile(root: string, path: string): Promise<StrictFile> {
  const observed = await lstat(path);
  if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink !== 1
    || await realpath(path) !== path || !insideRoot(root, path)) {
    throw new Error('directed journal leaf invalid');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== observed.dev || opened.ino !== observed.ino) {
      throw new Error('directed journal leaf changed');
    }
    return {
      path,
      raw: await handle.readFile(),
      device: opened.dev,
      inode: opened.ino,
      linkCount: opened.nlink,
    };
  } finally {
    await handle.close();
  }
}

async function optionalStrictFile(root: string, path: string): Promise<StrictFile | undefined> {
  try {
    return await strictFile(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await strictDirectory(root, dirname(path));
    return undefined;
  }
}

function isCatalogEntry(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    'id', 'source', 'title', 'url', 'category', 'relativePath', 'updatedAt', 'publishedAt',
    'contentComplete', 'contentCompletenessVersion', 'contentCompletenessBuildId',
    'deliveryRevision', 'deliveryBatchId', 'sync',
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.source !== 'string' || !SOURCES.includes(value.source as Source)
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || typeof value.category !== 'string'
    || typeof value.relativePath !== 'string' || !safeRelativePath(value.relativePath)
    || typeof value.updatedAt !== 'string') return false;
  if (value.publishedAt !== undefined && typeof value.publishedAt !== 'string') return false;
  if (value.contentComplete !== undefined && typeof value.contentComplete !== 'boolean') return false;
  if (value.contentCompletenessVersion !== undefined
    && typeof value.contentCompletenessVersion !== 'string') return false;
  if (value.contentCompletenessBuildId !== undefined
    && typeof value.contentCompletenessBuildId !== 'string') return false;
  if (value.deliveryRevision !== undefined
    && (typeof value.deliveryRevision !== 'string' || !HEX_64.test(value.deliveryRevision))) return false;
  if (value.deliveryBatchId !== undefined && typeof value.deliveryBatchId !== 'string') return false;
  if (value.sync !== undefined) {
    if (!isRecord(value.sync)) return false;
    const allowedSync = new Set(['state', 'target', 'at', 'committed', 'pushed', 'pushFailed', 'error']);
    if (Object.keys(value.sync).some(key => !allowedSync.has(key))
      || !['pending', 'synced', 'failed'].includes(String(value.sync.state))) return false;
    for (const key of ['target', 'at', 'error'] as const) {
      if (value.sync[key] !== undefined && typeof value.sync[key] !== 'string') return false;
    }
    for (const key of ['committed', 'pushed', 'pushFailed'] as const) {
      if (value.sync[key] !== undefined && typeof value.sync[key] !== 'boolean') return false;
    }
  }
  return true;
}

function validateCatalogIdentity(entry: Record<string, unknown>): void {
  if (!isCatalogEntry(entry)) throw new Error('directed journal catalog entry invalid');
  const parsed = parseSupportedUrl(entry.url as string);
  const canonicalUrl = canonicalizeUrl(parsed).href;
  if (canonicalUrl !== entry.url
    || descriptorForHost(parsed.hostname)?.id !== entry.source
    || (entry.source === 'nowcoder' && parsed.hostname !== 'www.nowcoder.com')
    || stableContentId(canonicalUrl) !== entry.id) {
    throw new Error('directed journal catalog identity invalid');
  }
}

function parseAndValidateCatalog(
  root: string,
  raw: Buffer,
  journal: DirectedTransactionJournal,
): void {
  const value = JSON.parse(raw.toString('utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error('directed journal catalog invalid');
  const ids = new Set<string>();
  const urls = new Set<string>();
  const paths = new Set<string>();
  let exact = 0;
  for (const item of value) {
    validateCatalogIdentity(item as Record<string, unknown>);
    const entry = item as Record<string, unknown>;
    const entryPath = resolveRelative(root, entry.relativePath as string);
    if (ids.has(entry.id as string) || urls.has(entry.url as string) || paths.has(entryPath)) {
      throw new Error('directed journal catalog duplicate');
    }
    ids.add(entry.id as string);
    urls.add(entry.url as string);
    paths.add(entryPath);
    if (JSON.stringify(entry) === JSON.stringify(journal.catalogEntry)) exact += 1;
  }
  if (exact !== 1) throw new Error('directed journal catalog entry missing');
}

function parseJournal(raw: Buffer, expectedTransactionId?: string): DirectedTransactionJournal {
  const value = JSON.parse(raw.toString('utf8')) as unknown;
  if (!isRecord(value)) throw new Error('directed journal invalid');
  const allowed = new Set([
    'version', 'transactionId', 'stableContentId', 'source', 'canonicalUrl',
    'entryRelativeDirectory', 'markdownRelativePath', 'sourceRelativePath',
    'catalogTemporaryName', 'catalogBeforeDigest', 'intentDigest', 'catalogAfterDigest', 'catalogEntry',
    'replacedCatalogEntry', 'replacedEntryRelativeDirectory', 'replacedTree', 'files',
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))
    || value.version !== 1
    || typeof value.transactionId !== 'string' || !TRANSACTION_ID.test(value.transactionId)
    || (expectedTransactionId !== undefined && value.transactionId !== expectedTransactionId)
    || typeof value.stableContentId !== 'string' || value.stableContentId.length === 0
    || typeof value.source !== 'string' || !SOURCES.includes(value.source as Source)
    || typeof value.canonicalUrl !== 'string'
    || typeof value.entryRelativeDirectory !== 'string' || !safeRelativePath(value.entryRelativeDirectory)
    || typeof value.markdownRelativePath !== 'string' || !safeRelativePath(value.markdownRelativePath)
    || typeof value.sourceRelativePath !== 'string' || !safeRelativePath(value.sourceRelativePath)
    || typeof value.catalogTemporaryName !== 'string'
    || value.catalogTemporaryName !== `${DIRECTED_CATALOG_PREFIX}${value.transactionId}.tmp`
    || (value.catalogBeforeDigest !== null
      && (typeof value.catalogBeforeDigest !== 'string' || !HEX_64.test(value.catalogBeforeDigest)))
    || (value.intentDigest !== undefined
      && (typeof value.intentDigest !== 'string' || !HEX_64.test(value.intentDigest)))
    || typeof value.catalogAfterDigest !== 'string' || !HEX_64.test(value.catalogAfterDigest)
    || !isCatalogEntry(value.catalogEntry)
    || (value.replacedCatalogEntry !== undefined && !isCatalogEntry(value.replacedCatalogEntry))
    || (value.replacedEntryRelativeDirectory !== undefined
      && (typeof value.replacedEntryRelativeDirectory !== 'string'
        || !safeRelativePath(value.replacedEntryRelativeDirectory)))
    || ((value.replacedCatalogEntry === undefined)
      !== (value.replacedEntryRelativeDirectory === undefined))
    || (value.replacedTree !== undefined && !Array.isArray(value.replacedTree))
    || !Array.isArray(value.files)) throw new Error('directed journal invalid');
  const journal = value as unknown as DirectedTransactionJournal;
  if (stableContentId(journal.canonicalUrl) !== journal.stableContentId
    || journal.catalogEntry.id !== journal.stableContentId
    || journal.catalogEntry.source !== journal.source
    || journal.catalogEntry.url !== journal.canonicalUrl
    || journal.markdownRelativePath !== posix.join(journal.entryRelativeDirectory, 'index.md')
    || journal.sourceRelativePath !== posix.join(journal.entryRelativeDirectory, 'source.json')
    || journal.catalogEntry.relativePath !== journal.markdownRelativePath) {
    throw new Error('directed journal identity invalid');
  }
  validateCatalogIdentity(journal.catalogEntry);
  if (journal.replacedCatalogEntry && journal.replacedEntryRelativeDirectory) {
    validateCatalogIdentity(journal.replacedCatalogEntry);
    if (journal.replacedCatalogEntry.id !== journal.stableContentId
      || journal.replacedCatalogEntry.source !== journal.source
      || journal.replacedCatalogEntry.url !== journal.canonicalUrl
      || journal.replacedCatalogEntry.relativePath
        !== posix.join(journal.replacedEntryRelativeDirectory, 'index.md')
      || journal.replacedEntryRelativeDirectory === journal.entryRelativeDirectory) {
      throw new Error('directed journal replacement identity invalid');
    }
  }
  if (journal.replacedTree !== undefined) {
    if (!journal.replacedCatalogEntry) throw new Error('directed journal replacement tree invalid');
    const paths = new Set<string>();
    for (const item of journal.replacedTree) {
      if (!isRecord(item)
        || Object.keys(item).some(key => !['relativePath', 'type', 'sha256', 'byteLength'].includes(key))
        || typeof item.relativePath !== 'string' || !safeRelativePath(item.relativePath)
        || !['directory', 'file'].includes(String(item.type))
        || paths.has(item.relativePath)) {
        throw new Error('directed journal replacement tree invalid');
      }
      if (item.type === 'directory') {
        if (item.relativePath !== 'assets'
          || item.sha256 !== undefined || item.byteLength !== undefined) {
          throw new Error('directed journal replacement directory invalid');
        }
      } else if ((item.relativePath !== 'index.md'
          && item.relativePath !== 'source.json'
          && !/^assets\/[^/]+$/u.test(item.relativePath))
        || typeof item.sha256 !== 'string' || !HEX_64.test(item.sha256)
        || typeof item.byteLength !== 'number' || !Number.isSafeInteger(item.byteLength)
        || item.byteLength < 0) {
        throw new Error('directed journal replacement file invalid');
      }
      paths.add(item.relativePath);
    }
    if (!paths.has('index.md')
      || journal.replacedTree.map(item => item.relativePath).join('\n')
        !== [...journal.replacedTree].map(item => item.relativePath).sort().join('\n')) {
      throw new Error('directed journal replacement tree incomplete');
    }
  }
  const filePaths = new Set<string>();
  for (const file of journal.files) {
    if (!isRecord(file)
      || Object.keys(file).some(key => !['relativePath', 'sha256', 'byteLength'].includes(key))
      || typeof file.relativePath !== 'string' || !safeRelativePath(file.relativePath)
      || file.relativePath === DIRECTED_TRANSACTION_MARKER
      || (file.relativePath !== 'index.md'
        && file.relativePath !== 'source.json'
        && !/^assets\/[^/]+$/u.test(file.relativePath))
      || typeof file.sha256 !== 'string' || !HEX_64.test(file.sha256)
      || typeof file.byteLength !== 'number' || !Number.isSafeInteger(file.byteLength)
      || file.byteLength < 0 || filePaths.has(file.relativePath)) {
      throw new Error('directed journal file manifest invalid');
    }
    filePaths.add(file.relativePath);
  }
  if (!filePaths.has('index.md') || !filePaths.has('source.json')
    || journal.files.map(file => file.relativePath).join('\n')
      !== [...journal.files].map(file => file.relativePath).sort().join('\n')) {
    throw new Error('directed journal file manifest incomplete');
  }
  return journal;
}

export function serializeDirectedTransactionJournal(journal: DirectedTransactionJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8');
}

function parseIntent(raw: Buffer, expectedTransactionId?: string): DirectedTransactionIntent {
  const value = JSON.parse(raw.toString('utf8')) as unknown;
  if (!isRecord(value)) throw new Error('directed transaction intent invalid');
  const allowed = new Set([
    'version', 'state', 'transactionId', 'stableContentId', 'source', 'canonicalUrl',
    'entryRelativeDirectory', 'catalogTemporaryName', 'catalogBeforeDigest',
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))
    || value.version !== 1 || value.state !== 'intent'
    || typeof value.transactionId !== 'string' || !TRANSACTION_ID.test(value.transactionId)
    || (expectedTransactionId !== undefined && value.transactionId !== expectedTransactionId)
    || typeof value.stableContentId !== 'string' || value.stableContentId.length === 0
    || typeof value.source !== 'string' || !SOURCES.includes(value.source as Source)
    || typeof value.canonicalUrl !== 'string'
    || typeof value.entryRelativeDirectory !== 'string' || !safeRelativePath(value.entryRelativeDirectory)
    || typeof value.catalogTemporaryName !== 'string'
    || value.catalogTemporaryName !== `${DIRECTED_CATALOG_PREFIX}${value.transactionId}.tmp`
    || (value.catalogBeforeDigest !== null
      && (typeof value.catalogBeforeDigest !== 'string' || !HEX_64.test(value.catalogBeforeDigest)))) {
    throw new Error('directed transaction intent invalid');
  }
  const intent = value as unknown as DirectedTransactionIntent;
  const parsed = parseSupportedUrl(intent.canonicalUrl);
  if (canonicalizeUrl(parsed).href !== intent.canonicalUrl
    || descriptorForHost(parsed.hostname)?.id !== intent.source
    || (intent.source === 'nowcoder' && parsed.hostname !== 'www.nowcoder.com')
    || stableContentId(intent.canonicalUrl) !== intent.stableContentId) {
    throw new Error('directed transaction intent identity invalid');
  }
  return intent;
}

export function serializeDirectedTransactionIntent(intent: DirectedTransactionIntent): Buffer {
  return Buffer.from(`${JSON.stringify(intent, null, 2)}\n`, 'utf8');
}

export function createDirectedTransactionIntent(
  input: CreateDirectedTransactionIntentInput,
): DirectedTransactionIntent {
  const intent: DirectedTransactionIntent = {
    version: 1,
    state: 'intent',
    transactionId: input.transactionId,
    stableContentId: input.stableContentId,
    source: input.source,
    canonicalUrl: input.canonicalUrl,
    entryRelativeDirectory: input.entryRelativeDirectory,
    catalogTemporaryName: `${DIRECTED_CATALOG_PREFIX}${input.transactionId}.tmp`,
    catalogBeforeDigest: input.catalogBeforeContents === undefined
      ? null
      : directedBytesDigest(input.catalogBeforeContents),
  };
  return parseIntent(serializeDirectedTransactionIntent(intent), input.transactionId);
}

export function createDirectedTransactionJournal(
  input: CreateDirectedTransactionJournalInput,
): DirectedTransactionJournal {
  const journal: DirectedTransactionJournal = {
    version: 1,
    transactionId: input.transactionId,
    stableContentId: input.stableContentId,
    source: input.source,
    canonicalUrl: input.canonicalUrl,
    entryRelativeDirectory: input.entryRelativeDirectory,
    markdownRelativePath: posix.join(input.entryRelativeDirectory, 'index.md'),
    sourceRelativePath: posix.join(input.entryRelativeDirectory, 'source.json'),
    catalogTemporaryName: input.catalogTemporaryName,
    catalogBeforeDigest: input.catalogBeforeContents === undefined
      ? null
      : directedBytesDigest(input.catalogBeforeContents),
    ...(input.intentDigest ? { intentDigest: input.intentDigest } : {}),
    catalogAfterDigest: directedBytesDigest(input.catalogAfterContents),
    catalogEntry: input.catalogEntry,
    ...(input.replacedCatalogEntry
      ? {
          replacedCatalogEntry: input.replacedCatalogEntry,
          replacedEntryRelativeDirectory: posix.dirname(
            input.replacedCatalogEntry.relativePath as string,
          ),
          ...(input.replacedTree ? { replacedTree: input.replacedTree } : {}),
        }
      : {}),
    files: [...input.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
  return parseJournal(serializeDirectedTransactionJournal(journal), input.transactionId);
}

export function newDirectedTransactionId(): string {
  return randomBytes(16).toString('hex');
}

export function directedJournalPointerPath(catalogDirectory: string, transactionId: string): string {
  if (!TRANSACTION_ID.test(transactionId)) throw new Error('directed transaction id invalid');
  return join(catalogDirectory, `${DIRECTED_JOURNAL_PREFIX}${transactionId}.json`);
}

async function walkEntryFiles(root: string, directory: string, prefix = ''): Promise<string[]> {
  const names = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const item of names) {
    const relativePath = prefix ? posix.join(prefix, item.name) : item.name;
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('directed journal tree symlink');
    if (item.isDirectory()) {
      if (relativePath !== 'assets') throw new Error('directed journal tree directory invalid');
      await strictDirectory(root, path);
      result.push(...await walkEntryFiles(root, path, relativePath));
    } else if (item.isFile()) {
      result.push(relativePath);
    } else {
      throw new Error('directed journal tree leaf invalid');
    }
  }
  return result;
}

async function verifyEntryTree(
  root: string,
  directory: string,
  journal: DirectedTransactionJournal,
  markerRaw?: Buffer,
): Promise<void> {
  await strictDirectory(root, directory);
  const expected = journal.files.map(file => file.relativePath);
  if (markerRaw) expected.push(DIRECTED_TRANSACTION_MARKER);
  const observed = (await walkEntryFiles(root, directory)).sort();
  if (observed.join('\n') !== expected.sort().join('\n')) {
    throw new Error('directed journal tree differs from manifest');
  }
  for (const file of journal.files) {
    const saved = await strictFile(root, join(directory, ...file.relativePath.split('/')));
    if (saved.raw.byteLength !== file.byteLength || directedBytesDigest(saved.raw) !== file.sha256) {
      throw new Error('directed journal content hash mismatch');
    }
  }
  const stored = projectOrganized(JSON.parse(
    (await strictFile(root, join(directory, 'source.json'))).raw.toString('utf8'),
  ) as unknown);
  if (stored.document.source !== journal.source
    || stored.document.canonicalUrl !== journal.canonicalUrl
    || stableContentId(stored.document.canonicalUrl) !== journal.stableContentId) {
    throw new Error('directed journal source identity mismatch');
  }
  if (markerRaw) {
    const marker = await strictFile(root, join(directory, DIRECTED_TRANSACTION_MARKER));
    if (!marker.raw.equals(markerRaw)) throw new Error('directed journal marker mismatch');
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectedDirectory(path: string): Promise<void> {
  await syncDirectory(path);
}

async function removeExactFile(root: string, path: string, expected: Buffer): Promise<void> {
  const observed = await strictFile(root, path);
  if (!observed.raw.equals(expected)) throw new Error('directed journal cleanup identity mismatch');
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function currentCatalog(
  root: string,
  catalogPath: string,
): Promise<{ file?: StrictFile; digest: string | null }> {
  const file = await optionalStrictFile(root, catalogPath);
  return { ...(file ? { file } : {}), digest: file ? directedBytesDigest(file.raw) : null };
}

async function verifiedCatalogTemporary(
  root: string,
  catalogDirectory: string,
  journal: DirectedTransactionJournal,
): Promise<StrictFile> {
  const temporary = await strictFile(root, join(catalogDirectory, journal.catalogTemporaryName));
  if (directedBytesDigest(temporary.raw) !== journal.catalogAfterDigest) {
    throw new Error('directed journal catalog stage hash mismatch');
  }
  parseAndValidateCatalog(root, temporary.raw, journal);
  return temporary;
}

async function ensureRecoveryDirectory(root: string, path: string): Promise<StrictDirectory> {
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('directed recovery parent escaped root');
  }
  let current = await strictDirectory(root, root);
  for (const part of rel.split(sep)) {
    const next = join(current.path, part);
    try {
      current = await strictDirectory(root, next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await assertSameDirectory(root, current);
      await mkdir(next, { mode: 0o700 });
      await syncDirectory(current.path);
      current = await strictDirectory(root, next);
    }
  }
  return current;
}

async function ensureRecoveryPointer(
  root: string,
  catalogDirectory: StrictDirectory,
  discovered: DiscoveredJournal,
): Promise<string> {
  if (discovered.pointerPath) return discovered.pointerPath;
  const path = directedJournalPointerPath(catalogDirectory.path, discovered.transactionId);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(discovered.raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(catalogDirectory.path);
  const stored = await strictFile(root, path);
  if (!stored.raw.equals(discovered.raw)) throw new Error('directed recovery pointer mismatch');
  return path;
}

function intentMatchesJournal(
  intent: DirectedTransactionIntent,
  journal: DirectedTransactionJournal,
  raw: Buffer,
): boolean {
  return intent.transactionId === journal.transactionId
    && intent.stableContentId === journal.stableContentId
    && intent.source === journal.source
    && intent.canonicalUrl === journal.canonicalUrl
    && intent.entryRelativeDirectory === journal.entryRelativeDirectory
    && intent.catalogTemporaryName === journal.catalogTemporaryName
    && intent.catalogBeforeDigest === journal.catalogBeforeDigest
    && journal.intentDigest === directedBytesDigest(raw);
}

function pointerAuthorizesMarker(
  pointerRaw: Buffer,
  markerRaw: Buffer,
  markerJournal: DirectedTransactionJournal,
): boolean {
  if (pointerRaw.equals(markerRaw)
    || (pointerRaw.byteLength <= markerRaw.byteLength
      && markerRaw.subarray(0, pointerRaw.byteLength).equals(pointerRaw))) return true;
  try {
    return intentMatchesJournal(
      parseIntent(pointerRaw, markerJournal.transactionId),
      markerJournal,
      pointerRaw,
    );
  } catch {
    return false;
  }
}

async function atomicallyReplaceRecoveryPointer(
  root: string,
  catalogDirectory: StrictDirectory,
  transactionId: string,
  pointerPath: string,
  expected: Buffer,
  replacement: Buffer,
): Promise<void> {
  const current = await strictFile(root, pointerPath);
  if (!current.raw.equals(expected)) throw new Error('directed recovery pointer changed');
  const temporaryPath = join(
    catalogDirectory.path,
    `.directed-pointer-${transactionId}-${randomBytes(12).toString('hex')}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let installed = false;
  try {
    await handle.writeFile(replacement);
    await handle.sync();
    await handle.close();
    const staged = await strictFile(root, temporaryPath);
    if (!staged.raw.equals(replacement)) throw new Error('directed recovery pointer stage mismatch');
    await assertSameDirectory(root, catalogDirectory);
    const revalidated = await strictFile(root, pointerPath);
    if (!revalidated.raw.equals(expected)) throw new Error('directed recovery pointer changed');
    await rename(temporaryPath, pointerPath);
    installed = true;
    await syncDirectory(catalogDirectory.path);
    const stored = await strictFile(root, pointerPath);
    if (!stored.raw.equals(replacement)) throw new Error('directed recovery pointer install mismatch');
  } finally {
    await handle.close().catch(() => undefined);
    if (!installed) {
      const temporary = await optionalStrictFile(root, temporaryPath).catch(() => undefined);
      if (temporary?.raw.equals(replacement)) {
        await unlink(temporaryPath).catch(() => undefined);
        await syncDirectory(catalogDirectory.path).catch(() => undefined);
      }
    }
  }
}

async function removePointerUpgradeTemps(
  root: string,
  catalogDirectory: StrictDirectory,
  transactionId: string,
): Promise<void> {
  for (const name of await readdir(catalogDirectory.path)) {
    if (!new RegExp(`^\\.directed-pointer-${transactionId}-[a-f0-9]{24}\\.tmp$`, 'u').test(name)) {
      continue;
    }
    const temporary = await strictFile(root, join(catalogDirectory.path, name));
    await removeExactFile(root, temporary.path, temporary.raw);
  }
}

async function removeIncompleteIntentArtifacts(
  root: string,
  catalogDirectory: StrictDirectory,
  pointerPath: string,
  pointerRaw: Buffer,
  intent: DirectedTransactionIntent,
): Promise<void> {
  const catalog = await currentCatalog(root, join(catalogDirectory.path, 'index.json'));
  if (catalog.digest !== intent.catalogBeforeDigest) {
    throw new Error('directed intent catalog authority changed');
  }
  const finalDirectory = resolveRelative(root, intent.entryRelativeDirectory);
  if (await optionalStrictDirectoryWithMissingAncestors(root, finalDirectory)) {
    throw new Error('directed intent has an unmarked final directory');
  }
  const stagePath = join(catalogDirectory.path, `${DIRECTED_ENTRY_PREFIX}${intent.transactionId}`);
  const stage = await optionalStrictDirectory(root, stagePath);
  if (stage) {
    await assertSameDirectory(root, catalogDirectory);
    await rm(stage.path, { recursive: true });
    await syncDirectory(catalogDirectory.path);
  }
  const catalogTemporary = await optionalStrictFile(
    root,
    join(catalogDirectory.path, intent.catalogTemporaryName),
  );
  if (catalogTemporary) await removeExactFile(root, catalogTemporary.path, catalogTemporary.raw);
  await removePointerUpgradeTemps(root, catalogDirectory, intent.transactionId);
  await removeExactFile(root, pointerPath, pointerRaw);
}

async function prepareIntentRecovery(
  root: string,
  catalogDirectory: StrictDirectory,
): Promise<void> {
  for (const name of await readdir(catalogDirectory.path)) {
    const match = name.match(/^\.directed-intent-([a-f0-9]{32})-[a-f0-9]{24}\.tmp$/u);
    if (!match?.[1]) continue;
    const transactionId = match[1];
    if (await optionalStrictFile(
      root,
      directedJournalPointerPath(catalogDirectory.path, transactionId),
    ) || await optionalStrictDirectory(
      root,
      join(catalogDirectory.path, `${DIRECTED_ENTRY_PREFIX}${transactionId}`),
    ) || await optionalStrictFile(
      root,
      join(catalogDirectory.path, `${DIRECTED_CATALOG_PREFIX}${transactionId}.tmp`),
    )) {
      throw new Error('directed intent temporary has conflicting transaction artifacts');
    }
    const temporary = await strictFile(root, join(catalogDirectory.path, name));
    await removeExactFile(root, temporary.path, temporary.raw);
  }
  for (const name of await readdir(catalogDirectory.path)) {
    const match = name.match(/^\.directed-journal-([a-f0-9]{32})\.json$/u);
    if (!match?.[1]) continue;
    const transactionId = match[1];
    const pointerPath = join(catalogDirectory.path, name);
    const pointer = await strictFile(root, pointerPath);
    const stagePath = join(catalogDirectory.path, `${DIRECTED_ENTRY_PREFIX}${transactionId}`);
    const stage = await optionalStrictDirectory(root, stagePath);
    const marker = stage
      ? await optionalStrictFile(root, join(stage.path, DIRECTED_TRANSACTION_MARKER))
      : undefined;
    if (!marker) {
      try {
        const pointerJournal = parseJournal(pointer.raw, transactionId);
        const finalMarker = await optionalStrictFile(
          root,
          join(
            resolveRelative(root, pointerJournal.entryRelativeDirectory),
            DIRECTED_TRANSACTION_MARKER,
          ),
        ).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (finalMarker) {
          // The final marker is an independent authority candidate. Parse and bind every identity,
          // path and digest field before pointer repair; never use the already-parsed pointer as a
          // tautological substitute for validating the marker bytes.
          const finalJournal = parseJournal(finalMarker.raw, transactionId);
          if (!pointerAuthorizesMarker(pointer.raw, finalMarker.raw, finalJournal)) {
            throw new Error('directed final journal copies differ');
          }
          if (!pointer.raw.equals(finalMarker.raw)) {
            await atomicallyReplaceRecoveryPointer(
              root,
              catalogDirectory,
              transactionId,
              pointerPath,
              pointer.raw,
              finalMarker.raw,
            );
          }
          await removePointerUpgradeTemps(root, catalogDirectory, transactionId);
        }
        continue;
      } catch (journalError) {
        try {
          const intent = parseIntent(pointer.raw, transactionId);
          await removeIncompleteIntentArtifacts(
            root,
            catalogDirectory,
            pointerPath,
            pointer.raw,
            intent,
          );
          continue;
        } catch (intentError) {
          throw new AggregateError([journalError, intentError], 'directed intent recovery invalid');
        }
      }
    }
    const journal = parseJournal(marker.raw, transactionId);
    if (pointer.raw.equals(marker.raw)) {
      await removePointerUpgradeTemps(root, catalogDirectory, transactionId);
      continue;
    }
    const authorized = pointerAuthorizesMarker(pointer.raw, marker.raw, journal);
    if (!authorized) throw new Error('directed journal copies differ');
    await atomicallyReplaceRecoveryPointer(
      root,
      catalogDirectory,
      transactionId,
      pointerPath,
      pointer.raw,
      marker.raw,
    );
    await removePointerUpgradeTemps(root, catalogDirectory, transactionId);
  }
}

async function optionalStrictDirectory(
  root: string,
  path: string,
): Promise<StrictDirectory | undefined> {
  try {
    return await strictDirectory(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await strictDirectory(root, dirname(path));
    return undefined;
  }
}

async function optionalStrictDirectoryWithMissingAncestors(
  root: string,
  path: string,
): Promise<StrictDirectory | undefined> {
  try {
    return await strictDirectory(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function replacementFileManifest(
  root: string,
  path: string,
  relativePath: string,
): Promise<DirectedReplacementTreeEntry> {
  const observed = await lstat(path);
  if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink !== 1
    || await realpath(path) !== path || !insideRoot(root, path)) {
    throw new Error('directed replacement leaf invalid');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== observed.dev || opened.ino !== observed.ino) {
      throw new Error('directed replacement leaf changed');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, byteLength);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    const final = await handle.stat();
    if (!final.isFile() || final.nlink !== 1
      || final.dev !== opened.dev || final.ino !== opened.ino
      || final.size !== byteLength) {
      throw new Error('directed replacement leaf changed during inventory');
    }
    return {
      relativePath,
      type: 'file',
      sha256: hash.digest('hex'),
      byteLength,
    };
  } finally {
    await handle.close();
  }
}

async function inventoryReplacementTreeAtPath(
  root: string,
  directory: string,
  allowMissingManifestMembers = false,
): Promise<DirectedReplacementTreeEntry[]> {
  const boundDirectory = await strictDirectory(root, directory);
  const topNames = (await readdir(directory)).sort();
  if ((!allowMissingManifestMembers && !topNames.includes('index.md'))
    || topNames.some(name => !['assets', 'index.md', 'source.json'].includes(name))) {
    throw new Error('directed replacement tree contains an unexpected path');
  }
  const result: DirectedReplacementTreeEntry[] = [];
  for (const name of topNames) {
    const path = join(directory, name);
    if (name === 'assets') {
      const assetsDirectory = await strictDirectory(root, path);
      result.push({ relativePath: 'assets', type: 'directory' });
      const assetNames = (await readdir(path)).sort();
      for (const assetName of assetNames) {
        if (!safeRelativePath(assetName) || assetName.includes('/')) {
          throw new Error('directed replacement asset path invalid');
        }
        result.push(await replacementFileManifest(
          root,
          join(path, assetName),
          posix.join('assets', assetName),
        ));
      }
      await assertSameDirectory(root, assetsDirectory);
      if ((await readdir(path)).sort().join('\n') !== assetNames.join('\n')) {
        throw new Error('directed replacement assets changed during inventory');
      }
      continue;
    }
    result.push(await replacementFileManifest(root, path, name));
  }
  await assertSameDirectory(root, boundDirectory);
  if ((await readdir(directory)).sort().join('\n') !== topNames.join('\n')) {
    throw new Error('directed replacement tree changed during inventory');
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function replacementTreeIsExactSubset(
  observed: readonly DirectedReplacementTreeEntry[],
  expected: readonly DirectedReplacementTreeEntry[],
): boolean {
  const expectedByPath = new Map(expected.map(item => [item.relativePath, item]));
  return observed.every(item => {
    const expectedItem = expectedByPath.get(item.relativePath);
    return expectedItem !== undefined && JSON.stringify(item) === JSON.stringify(expectedItem);
  });
}

/** Bind the complete application-owned tree before creating any replacement transaction bytes. */
export async function inventoryDirectedReplacementTree(
  root: string,
  entryRelativeDirectory: string,
): Promise<DirectedReplacementTreeEntry[]> {
  return await inventoryReplacementTreeAtPath(root, resolveRelative(root, entryRelativeDirectory));
}

/** Retire only the previous catalog-authoritative directory named by this exact journal. */
export async function retireDirectedReplacedEntry(
  root: string,
  journal: DirectedTransactionJournal,
): Promise<void> {
  if (!journal.replacedEntryRelativeDirectory) return;
  const previous = resolveRelative(root, journal.replacedEntryRelativeDirectory);
  const parent = await strictDirectory(root, dirname(previous));
  const retired = join(parent.path, `${DIRECTED_RETIRED_PREFIX}${journal.transactionId}`);
  const previousDirectory = await optionalStrictDirectory(root, previous);
  const retiredDirectory = await optionalStrictDirectory(root, retired);
  if (previousDirectory && retiredDirectory) {
    throw new Error('directed replacement has two previous directories');
  }
  if (previousDirectory) {
    if (!journal.replacedTree) {
      throw new Error('directed replacement retirement proof missing');
    }
    const observedTree = await inventoryReplacementTreeAtPath(root, previous);
    if (JSON.stringify(observedTree) !== JSON.stringify(journal.replacedTree)) {
      throw new Error('directed replacement tree changed before retirement');
    }
    await assertSameDirectory(root, parent);
    await rename(previous, retired);
    await syncDirectory(parent.path);
  }
  if (previousDirectory || retiredDirectory) {
    if (!journal.replacedTree) {
      throw new Error('directed replacement retirement proof missing');
    }
    const boundRetired = await strictDirectory(root, retired);
    const observedTree = await inventoryReplacementTreeAtPath(root, retired, true);
    if (!replacementTreeIsExactSubset(observedTree, journal.replacedTree)) {
      throw new Error('directed retired tree changed before deletion');
    }
    await assertSameDirectory(root, boundRetired);
    await assertSameDirectory(root, parent);
    await rm(retired, { recursive: true });
    await syncDirectory(parent.path);
  }
}

async function recoverOne(
  root: string,
  catalogDirectory: StrictDirectory,
  discovered: DiscoveredJournal,
): Promise<void> {
  const { journal, raw } = discovered;
  const catalogPath = join(catalogDirectory.path, 'index.json');
  const finalDirectory = resolveRelative(root, journal.entryRelativeDirectory);
  const finalMarkerPath = join(finalDirectory, DIRECTED_TRANSACTION_MARKER);
  const stageDirectory = discovered.stagePath;
  const stageMarker = stageDirectory
    ? await optionalStrictFile(root, join(stageDirectory, DIRECTED_TRANSACTION_MARKER))
    : undefined;
  const finalMarker = await optionalStrictFile(root, finalMarkerPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (stageMarker && !stageMarker.raw.equals(raw)) throw new Error('directed stage marker mismatch');
  if (finalMarker && !finalMarker.raw.equals(raw)) throw new Error('directed final marker mismatch');
  if (stageMarker && finalMarker) throw new Error('directed journal has two entry trees');
  const catalog = await currentCatalog(root, catalogPath);

  if (catalog.digest === journal.catalogAfterDigest) {
    if (!catalog.file) throw new Error('directed committed catalog missing');
    parseAndValidateCatalog(root, catalog.file.raw, journal);
    if (stageMarker) throw new Error('directed committed catalog still points at staging');
    await verifyEntryTree(root, finalDirectory, journal, finalMarker?.raw);
    if (await optionalStrictFile(
      root,
      join(catalogDirectory.path, journal.catalogTemporaryName),
    )) throw new Error('directed committed catalog temp unexpectedly remains');
    await retireDirectedReplacedEntry(root, journal);
    if (finalMarker) await removeExactFile(root, finalMarkerPath, raw);
    if (discovered.pointerPath) await removeExactFile(root, discovered.pointerPath, raw);
    return;
  }

  if (catalog.digest !== journal.catalogBeforeDigest) {
    throw new Error('directed journal catalog authority changed');
  }
  let pointerPath = discovered.pointerPath;
  if (stageMarker) {
    const temporary = await verifiedCatalogTemporary(root, catalogDirectory.path, journal);
    try {
      await lstat(finalDirectory);
      throw new Error('directed journal final directory appeared');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await verifyEntryTree(root, stageDirectory!, journal, raw);
    // Recovery resumes the one durable transaction instead of attempting a multi-path abort.
    // A marker-only crash first gains a durable pointer; every later crash state is therefore the
    // same published/catalog commit state machine handled below.
    pointerPath = await ensureRecoveryPointer(root, catalogDirectory, discovered);
    const finalParent = await ensureRecoveryDirectory(root, dirname(finalDirectory));
    await assertSameDirectory(root, finalParent);
    await rename(stageDirectory!, finalDirectory);
    await syncDirectory(finalParent.path);
    await syncDirectory(catalogDirectory.path);
    await verifyEntryTree(root, finalDirectory, journal, raw);
    const revalidated = await currentCatalog(root, catalogPath);
    if (revalidated.digest !== journal.catalogBeforeDigest) {
      throw new Error('directed catalog changed during recovery');
    }
    await assertSameDirectory(root, catalogDirectory);
    await rename(temporary.path, catalogPath);
    await syncDirectory(catalogDirectory.path);
  } else if (!finalMarker) {
    // Compatibility for an interrupted older abort sequence: with catalog-before and no entry
    // tree, the exact pointer can only describe cleanup. Remove any still-exact catalog stage and
    // then the last authority. New writers never enter this state because they resume instead.
    if (!pointerPath) throw new Error('directed published transaction proof incomplete');
    try {
      await lstat(finalDirectory);
      throw new Error('directed unmarked final directory exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const leftoverTemporary = await optionalStrictFile(
      root,
      join(catalogDirectory.path, journal.catalogTemporaryName),
    );
    if (leftoverTemporary) {
      if (directedBytesDigest(leftoverTemporary.raw) !== journal.catalogAfterDigest) {
        throw new Error('directed cleanup catalog stage mismatch');
      }
      parseAndValidateCatalog(root, leftoverTemporary.raw, journal);
      await removeExactFile(root, leftoverTemporary.path, leftoverTemporary.raw);
    }
    await removeExactFile(root, pointerPath, raw);
    return;
  }

  if (!pointerPath) {
    throw new Error('directed published transaction proof incomplete');
  }
  await verifyEntryTree(root, finalDirectory, journal, raw);
  await assertSameDirectory(root, catalogDirectory);
  const revalidated = await currentCatalog(root, catalogPath);
  if (revalidated.digest !== journal.catalogBeforeDigest
    && revalidated.digest !== journal.catalogAfterDigest) {
    throw new Error('directed catalog changed during recovery');
  }
  if (revalidated.digest === journal.catalogBeforeDigest) {
    const temporary = await verifiedCatalogTemporary(root, catalogDirectory.path, journal);
    await rename(temporary.path, catalogPath);
    await syncDirectory(catalogDirectory.path);
  }
  const committed = await strictFile(root, catalogPath);
  if (directedBytesDigest(committed.raw) !== journal.catalogAfterDigest) {
    throw new Error('directed recovered catalog mismatch');
  }
  parseAndValidateCatalog(root, committed.raw, journal);
  await retireDirectedReplacedEntry(root, journal);
  await removeExactFile(root, finalMarkerPath, raw);
  await removeExactFile(root, pointerPath, raw);
}

async function discoverJournals(
  root: string,
  catalogDirectory: StrictDirectory,
): Promise<DiscoveredJournal[]> {
  await prepareIntentRecovery(root, catalogDirectory);
  const byTransaction = new Map<string, DiscoveredJournal>();
  const names = await readdir(catalogDirectory.path);
  // Discover the durable stage authority first. A pointer can exist with zero/partial bytes when
  // creation was interrupted, and only the exact marker under the matching transaction-ID stage
  // authorizes repairing that leaf.
  for (const name of names) {
    if (!name.startsWith(DIRECTED_ENTRY_PREFIX)) continue;
    const match = name.match(/^\.directed-entry-([a-f0-9]{32})$/u);
    const stagePath = join(catalogDirectory.path, name);
    const marker = await optionalStrictFile(root, join(stagePath, DIRECTED_TRANSACTION_MARKER));
    if (!marker) continue;
    if (!match?.[1]) throw new Error('directed staging name invalid');
    const journal = parseJournal(marker.raw, match[1]);
    const existing = byTransaction.get(match[1]);
    if (existing && !existing.raw.equals(marker.raw)) throw new Error('directed journal copies differ');
    byTransaction.set(match[1], {
      transactionId: match[1],
      raw: marker.raw,
      journal,
      ...(existing?.pointerPath ? { pointerPath: existing.pointerPath } : {}),
      stagePath,
    });
  }
  for (const name of names) {
    if (!name.startsWith(DIRECTED_JOURNAL_PREFIX)) continue;
    const match = name.match(/^\.directed-journal-([a-f0-9]{32})\.json$/u);
    if (!match?.[1]) throw new Error('directed journal pointer name invalid');
    const pointerPath = join(catalogDirectory.path, name);
    const pointer = await strictFile(root, pointerPath);
    let journal: DirectedTransactionJournal;
    try {
      journal = parseJournal(pointer.raw, match[1]);
    } catch (error) {
      const stage = byTransaction.get(match[1]);
      if (!stage?.stagePath) throw error;
      // The exact valid stage marker proves this same transaction owns the malformed pointer name.
      // Remove only the inode/bytes just read; recoverOne recreates and fsyncs the full pointer.
      await removeExactFile(root, pointerPath, pointer.raw);
      continue;
    }
    const existing = byTransaction.get(match[1]);
    if (existing && !existing.raw.equals(pointer.raw)) throw new Error('directed journal copies differ');
    byTransaction.set(match[1], {
      transactionId: match[1],
      raw: pointer.raw,
      journal,
      pointerPath,
      ...(existing?.stagePath ? { stagePath: existing.stagePath } : {}),
    });
  }
  return [...byTransaction.values()].sort((left, right) =>
    left.transactionId.localeCompare(right.transactionId));
}

/** Called only while the shared OS catalog lease is held. */
export async function recoverDirectedLibraryTransactions(root: string): Promise<void> {
  const canonicalRoot = await realpath(resolve(root));
  const catalogDirectory = await strictDirectory(canonicalRoot, join(canonicalRoot, '_catalog'));
  for (const journal of await discoverJournals(canonicalRoot, catalogDirectory)) {
    await recoverOne(canonicalRoot, catalogDirectory, journal);
  }
}

/**
 * Lock-free recognition used by directed preflight. It accepts only a fully bound final marker +
 * pointer + catalog stage for this exact target; recovery itself still occurs later under the OS
 * lease. Any malformed or unmarked deterministic orphan remains fail-closed.
 */
export async function directedRecoveryFingerprint(options: {
  root: string;
  entryDirectory: string;
  source: Source;
  canonicalUrl: string;
  stableContentId: string;
}): Promise<string | undefined> {
  const marker = await optionalStrictFile(
    options.root,
    join(options.entryDirectory, DIRECTED_TRANSACTION_MARKER),
  );
  if (!marker) return undefined;
  const journal = parseJournal(marker.raw);
  if (journal.source !== options.source
    || journal.canonicalUrl !== options.canonicalUrl
    || journal.stableContentId !== options.stableContentId
    || resolveRelative(options.root, journal.entryRelativeDirectory) !== options.entryDirectory) {
    throw new Error('directed recovery target mismatch');
  }
  const catalogDirectory = await strictDirectory(options.root, join(options.root, '_catalog'));
  const pointer = await strictFile(
    options.root,
    directedJournalPointerPath(catalogDirectory.path, journal.transactionId),
  );
  if (!pointerAuthorizesMarker(pointer.raw, marker.raw, journal)) {
    throw new Error('directed recovery pointer mismatch');
  }
  await verifyEntryTree(options.root, options.entryDirectory, journal, marker.raw);
  const catalog = await currentCatalog(options.root, join(catalogDirectory.path, 'index.json'));
  if (catalog.digest === journal.catalogBeforeDigest) {
    await verifiedCatalogTemporary(options.root, catalogDirectory.path, journal);
  } else if (catalog.digest === journal.catalogAfterDigest) {
    if (!catalog.file) throw new Error('directed recovery committed catalog missing');
    parseAndValidateCatalog(options.root, catalog.file.raw, journal);
    if (await optionalStrictFile(
      options.root,
      join(catalogDirectory.path, journal.catalogTemporaryName),
    )) throw new Error('directed recovery committed catalog temp remains');
  } else {
    throw new Error('directed recovery catalog mismatch');
  }
  return directedBytesDigest(marker.raw);
}

/** Find a published, not-yet-catalogued transaction even when its final directory is versioned. */
export async function findDirectedRecoveryFingerprint(options: {
  root: string;
  source: Source;
  canonicalUrl: string;
  stableContentId: string;
}): Promise<string | undefined> {
  const catalogDirectory = await strictDirectory(options.root, join(options.root, '_catalog'));
  let fingerprint: string | undefined;
  const names = await readdir(catalogDirectory.path);
  const pointerTransactions = new Set<string>();
  for (const name of names) {
    const match = name.match(/^\.directed-journal-([a-f0-9]{32})\.json$/u);
    if (!match?.[1]) {
      if (name.startsWith(DIRECTED_JOURNAL_PREFIX)) {
        throw new Error('directed journal pointer name invalid');
      }
      continue;
    }
    pointerTransactions.add(match[1]);
    const pointer = await strictFile(options.root, join(catalogDirectory.path, name));
    let journal: DirectedTransactionJournal;
    try {
      journal = parseJournal(pointer.raw, match[1]);
    } catch (error) {
      let intent: DirectedTransactionIntent | undefined;
      try {
        intent = parseIntent(pointer.raw, match[1]);
      } catch {
        intent = undefined;
      }
      if (intent) {
        if (intent.source !== options.source
          || intent.canonicalUrl !== options.canonicalUrl
          || intent.stableContentId !== options.stableContentId) continue;
        const catalog = await currentCatalog(options.root, join(catalogDirectory.path, 'index.json'));
        if (catalog.digest !== intent.catalogBeforeDigest) {
          throw new Error('directed recovery intent catalog mismatch');
        }
        if (await optionalStrictDirectoryWithMissingAncestors(
          options.root,
          resolveRelative(options.root, intent.entryRelativeDirectory),
        )) {
          throw new Error('directed recovery intent final directory exists');
        }
        const stageDirectory = join(catalogDirectory.path, `${DIRECTED_ENTRY_PREFIX}${match[1]}`);
        await optionalStrictDirectory(options.root, stageDirectory);
        if (fingerprint !== undefined) throw new Error('multiple directed recovery transactions');
        fingerprint = directedBytesDigest(pointer.raw);
        continue;
      }
      const stageDirectory = join(catalogDirectory.path, `${DIRECTED_ENTRY_PREFIX}${match[1]}`);
      const stageMarker = await optionalStrictFile(
        options.root,
        join(stageDirectory, DIRECTED_TRANSACTION_MARKER),
      );
      if (!stageMarker) throw error;
      journal = parseJournal(stageMarker.raw, match[1]);
      if (journal.source !== options.source
        || journal.canonicalUrl !== options.canonicalUrl
        || journal.stableContentId !== options.stableContentId) continue;
      await verifyEntryTree(options.root, stageDirectory, journal, stageMarker.raw);
      await verifiedCatalogTemporary(options.root, catalogDirectory.path, journal);
      const catalog = await currentCatalog(options.root, join(catalogDirectory.path, 'index.json'));
      if (catalog.digest !== journal.catalogBeforeDigest) {
        throw new Error('directed recovery stage catalog mismatch');
      }
      if (fingerprint !== undefined) throw new Error('multiple directed recovery transactions');
      fingerprint = directedBytesDigest(stageMarker.raw);
      continue;
    }
    if (journal.source !== options.source
      || journal.canonicalUrl !== options.canonicalUrl
      || journal.stableContentId !== options.stableContentId) continue;
    const entryDirectory = resolveRelative(options.root, journal.entryRelativeDirectory);
    let hasFinalMarker = false;
    try {
      await lstat(join(entryDirectory, DIRECTED_TRANSACTION_MARKER));
      hasFinalMarker = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let found: string | undefined;
    if (hasFinalMarker) {
      found = await directedRecoveryFingerprint({
        ...options,
        entryDirectory,
      });
    } else {
      const stageDirectory = join(catalogDirectory.path, `${DIRECTED_ENTRY_PREFIX}${journal.transactionId}`);
      const stageMarker = await optionalStrictFile(
        options.root,
        join(stageDirectory, DIRECTED_TRANSACTION_MARKER),
      );
      if (!stageMarker) continue;
      if (!pointerAuthorizesMarker(pointer.raw, stageMarker.raw, journal)) {
        throw new Error('directed recovery stage mismatch');
      }
      await verifyEntryTree(options.root, stageDirectory, journal, stageMarker.raw);
      await verifiedCatalogTemporary(options.root, catalogDirectory.path, journal);
      const catalog = await currentCatalog(options.root, join(catalogDirectory.path, 'index.json'));
      if (catalog.digest !== journal.catalogBeforeDigest) {
        throw new Error('directed recovery stage catalog mismatch');
      }
      found = directedBytesDigest(stageMarker.raw);
    }
    if (fingerprint !== undefined) throw new Error('multiple directed recovery transactions');
    fingerprint = found;
  }
  for (const name of names) {
    if (!name.startsWith(DIRECTED_ENTRY_PREFIX)) continue;
    const match = name.match(/^\.directed-entry-([a-f0-9]{32})$/u);
    const stageDirectory = join(catalogDirectory.path, name);
    const stageMarker = await optionalStrictFile(
      options.root,
      join(stageDirectory, DIRECTED_TRANSACTION_MARKER),
    );
    if (!stageMarker) continue;
    if (!match?.[1]) throw new Error('directed staging name invalid');
    if (pointerTransactions.has(match[1])) continue;
    const journal = parseJournal(stageMarker.raw, match[1]);
    if (journal.source !== options.source
      || journal.canonicalUrl !== options.canonicalUrl
      || journal.stableContentId !== options.stableContentId) continue;
    await verifyEntryTree(options.root, stageDirectory, journal, stageMarker.raw);
    await verifiedCatalogTemporary(options.root, catalogDirectory.path, journal);
    const catalog = await currentCatalog(options.root, join(catalogDirectory.path, 'index.json'));
    if (catalog.digest !== journal.catalogBeforeDigest) {
      throw new Error('directed recovery stage catalog mismatch');
    }
    if (fingerprint !== undefined) throw new Error('multiple directed recovery transactions');
    fingerprint = directedBytesDigest(stageMarker.raw);
  }
  return fingerprint;
}
