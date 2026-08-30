import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  canonicalizeUrl,
  descriptorForHost,
  parseSupportedUrl,
  stableContentId,
  type CollectedDocument,
  type FeJourneyCandidateMetadata,
  type Source,
} from '@data-collector/shared';
import {
  atomicWriteText,
  DirectedLocalLibraryCorruptError,
  preflightDirectedLocalLibrary,
  type DirectedLocalDocumentTarget,
} from '../library/writer.js';
import { recoverDirectedLibraryTransactions } from '../library/directedTransactionJournal.js';
import { classify } from '../organize/index.js';
import { hammingDistance64, questionFingerprint } from './fingerprint.js';
import { enrichNowcoderEvidence } from './nowcoderEvidence.js';
import { scoreFeJourneyCandidate } from './quality.js';
import {
  libraryCatalogLockHeld,
  withExistingFeJourneyCandidateLock,
  withFeJourneyCandidateLock,
} from './fileLock.js';

interface CandidateIndexEntry {
  id: string;
  source: Extract<Source, 'nowcoder' | 'github'>;
  url: string;
  contentHash: string;
  simHash: string;
  questionHash?: string;
  company?: string;
  authorKey?: string;
  evidenceGrade?: string;
  questionCount?: number;
  clusterId: string;
  representativeId: string;
  qualityScore: number;
  projectScore?: number;
  updatedAt: string;
}

interface CandidateCatalog {
  version: 1;
  entries: CandidateIndexEntry[];
}

export class FeJourneyCandidateCatalogError extends Error {
  readonly code = 'DIRECTED_CANDIDATE_CATALOG_CORRUPT' as const;

  constructor() {
    super('fe-journey 候选索引格式无效');
    this.name = 'FeJourneyCandidateCatalogError';
  }
}

export interface PreparedFeJourneyCandidate {
  document: CollectedDocument;
  commit(): Promise<void>;
}

const NEAR_DUPLICATE_DISTANCE = 12;

function isCandidateSource(source: Source): source is CandidateIndexEntry['source'] {
  return source === 'nowcoder' || source === 'github';
}

function normalizedAuthor(author: string | undefined): string | undefined {
  const value = author
    ?.normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
  return value ? value : undefined;
}

function metadataString(document: CollectedDocument, key: string): string | undefined {
  const value = document.sourceMetadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function metadataNumber(document: CollectedDocument, key: string): number | undefined {
  const value = document.sourceMetadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function candidateDocumentBase(document: CollectedDocument): {
  candidate: CollectedDocument;
  score: ReturnType<typeof scoreFeJourneyCandidate>;
  evidenceGrade: string | undefined;
} {
  const evidenced = enrichNowcoderEvidence(document);
  const score = scoreFeJourneyCandidate(evidenced);
  const evidenceGrade = metadataString(evidenced, 'evidenceGrade');
  const candidate = evidenced.source === 'nowcoder'
    && (evidenceGrade === 'A' || evidenceGrade === 'B')
    && score.candidateKinds.includes('interview')
    ? { ...evidenced, suggestedCategory: '人工智能' }
    : evidenced;
  return { candidate, score, evidenceGrade };
}

/** Pure preview: computes only deterministic local path fields and never reads candidate entries. */
export function previewFeJourneyLocalTarget(document: CollectedDocument): DirectedLocalDocumentTarget {
  const { candidate, score } = candidateDocumentBase(document);
  const category = classify({
    title: candidate.title,
    text: candidate.text,
    ...(candidate.suggestedCategory ? { suggestedCategory: candidate.suggestedCategory } : {}),
    ...(candidate.suggestedTags ? { suggestedTags: candidate.suggestedTags } : {}),
    ...(candidate.userCategory ? { userCategory: candidate.userCategory } : {}),
    ...(candidate.userTags ? { userTags: candidate.userTags } : {}),
  }).category;
  return {
    source: candidate.source,
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    category,
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
    collectedAt: candidate.collectedAt,
    contentHash: score.contentHash,
  };
}

function parseCatalog(value: unknown, strictIdentity = false): CandidateCatalog {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    throw new FeJourneyCandidateCatalogError();
  }
  const entries = (value as { entries: unknown[] }).entries;
  const allowed = new Set([
    'id', 'source', 'url', 'contentHash', 'simHash', 'questionHash', 'company', 'authorKey',
    'evidenceGrade', 'questionCount', 'clusterId', 'representativeId', 'qualityScore',
    'projectScore', 'updatedAt',
  ]);
  const valid = entries.every(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return Object.keys(item).every(key => allowed.has(key))
      && typeof item.id === 'string' && item.id.length > 0
      && (item.source === 'nowcoder' || item.source === 'github')
      && typeof item.url === 'string'
      && typeof item.contentHash === 'string' && /^[a-f0-9]{16}$/u.test(item.contentHash)
      && typeof item.simHash === 'string' && /^[a-f0-9]{16}$/u.test(item.simHash)
      && (item.questionHash === undefined
        || (typeof item.questionHash === 'string' && /^[a-f0-9]{16}$/u.test(item.questionHash)))
      && (item.company === undefined || typeof item.company === 'string')
      && (item.authorKey === undefined || typeof item.authorKey === 'string')
      && (item.evidenceGrade === undefined || typeof item.evidenceGrade === 'string')
      && (item.questionCount === undefined || typeof item.questionCount === 'number')
      && typeof item.clusterId === 'string' && item.clusterId.length > 0
      && typeof item.representativeId === 'string' && item.representativeId.length > 0
      && typeof item.qualityScore === 'number'
      && (item.projectScore === undefined || typeof item.projectScore === 'number')
      && typeof item.updatedAt === 'string';
  });
  if (!valid) throw new FeJourneyCandidateCatalogError();
  const typed = entries as CandidateIndexEntry[];
  // Ordinary indexing preserves the existing permissive catalog behavior.
  // Directed delivery opts into the stronger identity/uniqueness boundary below.
  if (!strictIdentity) return { version: 1, entries: typed };
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const entry of typed) {
    try {
      const parsed = parseSupportedUrl(entry.url);
      if (canonicalizeUrl(parsed).href !== entry.url
        || descriptorForHost(parsed.hostname)?.id !== entry.source
        || (entry.source === 'nowcoder' && parsed.hostname !== 'www.nowcoder.com')
        || stableContentId(entry.url) !== entry.id
        || !Number.isFinite(entry.qualityScore)
        || (entry.projectScore !== undefined && !Number.isFinite(entry.projectScore))
        || (entry.questionCount !== undefined && !Number.isFinite(entry.questionCount))
        || ids.has(entry.id)
        || urls.has(entry.url)) throw new Error('invalid identity');
      ids.add(entry.id);
      urls.add(entry.url);
    } catch {
      throw new FeJourneyCandidateCatalogError();
    }
  }
  const entriesById = new Map(typed.map(entry => [entry.id, entry]));
  if (typed.some(entry => {
    const representative = entriesById.get(entry.representativeId);
    return !representative
      || representative.clusterId !== entry.clusterId
      || representative.representativeId !== representative.id;
  })) {
    throw new FeJourneyCandidateCatalogError();
  }
  return { version: 1, entries: typed };
}

export interface DirectedCandidateCatalogIo {
  lstat: typeof lstat;
  open?: typeof open;
  readFile: typeof readFile;
  realpath: typeof realpath;
}

const directedCandidateCatalogIo: DirectedCandidateCatalogIo = { lstat, open, readFile, realpath };

export async function readDirectedCandidateCatalog(
  canonicalRoot: string,
  io: DirectedCandidateCatalogIo = directedCandidateCatalogIo,
): Promise<CandidateCatalog> {
  try {
    const catalogDirectory = join(canonicalRoot, '_catalog');
    const parent = await io.lstat(catalogDirectory);
    if (parent.isSymbolicLink() || !parent.isDirectory()
      || await io.realpath(catalogDirectory) !== catalogDirectory) throw new Error('invalid catalog parent');
    const path = join(catalogDirectory, 'fe-journey.json');
    let metadata;
    try {
      metadata = await io.lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const currentParent = await io.lstat(catalogDirectory);
      if (currentParent.isSymbolicLink() || !currentParent.isDirectory()
        || currentParent.dev !== parent.dev
        || currentParent.ino !== parent.ino
        || await io.realpath(catalogDirectory) !== catalogDirectory) throw error;
      return { version: 1, entries: [] };
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('invalid catalog leaf');
    // Only the initial leaf lstat may establish genuine absence. A later ENOENT is a race.
    const canonical = await io.realpath(path);
    const rel = relative(canonicalRoot, canonical);
    if (canonical !== path
      || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('catalog escaped root');
    const handle = await (io.open ?? open)(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw: string;
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()
        || openedMetadata.dev !== metadata.dev
        || openedMetadata.ino !== metadata.ino) throw new Error('candidate catalog changed during validation');
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    return parseCatalog(JSON.parse(raw) as unknown, true);
  } catch (error) {
    if (error instanceof FeJourneyCandidateCatalogError) throw error;
    throw new FeJourneyCandidateCatalogError();
  }
}

/** 本机库中仅供 fe-journey 使用的候选聚合索引。 */
export class FeJourneyCandidateIndex {
  private readonly catalogPath: string;
  private entries: CandidateIndexEntry[];
  private candidateSaveQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly libraryRoot: string, catalog: CandidateCatalog) {
    this.catalogPath = join(libraryRoot, '_catalog', 'fe-journey.json');
    this.entries = catalog.entries;
  }

  static async open(libraryRoot: string): Promise<FeJourneyCandidateIndex> {
    const catalogPath = join(libraryRoot, '_catalog', 'fe-journey.json');
    try {
      return new FeJourneyCandidateIndex(
        libraryRoot,
        parseCatalog(JSON.parse(await readFile(catalogPath, 'utf8')) as unknown),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new FeJourneyCandidateIndex(libraryRoot, { version: 1, entries: [] });
      }
      throw error;
    }
  }

  /**
   * prepare 必须和本机落盘、索引 commit 属于同一个临界区。否则两个并行详情
   * 会同时读取旧 entries，虽然 contentHash 相同，却都缺少 duplicateOf。
   */
  private async runWithHeldLibraryLock<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const catalog = parseCatalog(JSON.parse(await readFile(this.catalogPath, 'utf8')) as unknown);
      this.entries = catalog.entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.entries = [];
      else if (error instanceof FeJourneyCandidateCatalogError) throw error;
      else throw new FeJourneyCandidateCatalogError();
    }
    return await operation();
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    // A nested remove already owns the shared library lease. It must bypass this instance queue:
    // a prior candidate waiter may be blocked on that same OS lock and would otherwise form ABBA.
    if (await libraryCatalogLockHeld(this.libraryRoot)) {
      return await this.runWithHeldLibraryLock(operation);
    }
    const result = this.candidateSaveQueue.then(() => withFeJourneyCandidateLock(
      this.libraryRoot,
      async () => await this.runWithHeldLibraryLock(operation),
    ));
    this.candidateSaveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Directed saves preflight both catalogs before lock creation and revalidate after lock. */
  async runDirectedExclusive<T>(operation: () => Promise<T>, target: DirectedLocalDocumentTarget): Promise<T> {
    if (await libraryCatalogLockHeld(this.libraryRoot)) {
      try {
        await recoverDirectedLibraryTransactions(this.libraryRoot);
        const canonicalRoot = await preflightDirectedLocalLibrary(this.libraryRoot, target);
        const catalog = await readDirectedCandidateCatalog(canonicalRoot);
        this.entries = catalog.entries;
        return await operation();
      } catch (error) {
        if (error instanceof DirectedLocalLibraryCorruptError
          || error instanceof FeJourneyCandidateCatalogError) throw error;
        throw new DirectedLocalLibraryCorruptError();
      }
    }
    const result = this.candidateSaveQueue.then(async () => {
      try {
        const canonicalRoot = await preflightDirectedLocalLibrary(this.libraryRoot, target);
        await readDirectedCandidateCatalog(canonicalRoot);
        return await withExistingFeJourneyCandidateLock(canonicalRoot, async () => {
          // Recovery is part of the same shared OS lease and precedes both authoritative local
          // baseline construction and candidate preparation for this directed document.
          await recoverDirectedLibraryTransactions(canonicalRoot);
          const revalidatedRoot = await preflightDirectedLocalLibrary(this.libraryRoot, target);
          if (revalidatedRoot !== canonicalRoot) throw new DirectedLocalLibraryCorruptError();
          const catalog = await readDirectedCandidateCatalog(canonicalRoot);
          this.entries = catalog.entries;
          return await operation();
        });
      } catch (error) {
        if (error instanceof DirectedLocalLibraryCorruptError
          || error instanceof FeJourneyCandidateCatalogError) throw error;
        throw new DirectedLocalLibraryCorruptError();
      }
    });
    this.candidateSaveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 删除本地库条目后同步清理候选索引，并在代表条目被删时重选簇代表。 */
  remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    const wanted = new Set(ids);
    return this.runExclusive(async () => {
      const remaining = this.entries.filter(entry => !wanted.has(entry.id));
      if (remaining.length === this.entries.length) return;

      const clusterRepresentatives = new Map<string, string>();
      for (const entry of remaining) {
        const current = clusterRepresentatives.get(entry.clusterId);
        if (!current || entry.id < current) clusterRepresentatives.set(entry.clusterId, entry.id);
      }
      this.entries = remaining
        .map(entry => {
          const representativeStillExists = remaining.some(
            candidate => candidate.id === entry.representativeId,
          );
          return representativeStillExists
            ? entry
            : { ...entry, representativeId: clusterRepresentatives.get(entry.clusterId) ?? entry.id };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      const catalog: CandidateCatalog = { version: 1, entries: this.entries };
      await atomicWriteText(
        this.libraryRoot,
        this.catalogPath,
        `${JSON.stringify(catalog, null, 2)}\n`,
      );
    });
  }

  prepare(document: CollectedDocument): PreparedFeJourneyCandidate {
    if (!isCandidateSource(document.source)) {
      return { document, commit: async () => undefined };
    }

    const { candidate, score, evidenceGrade } = candidateDocumentBase(document);
    const id = stableContentId(candidate.canonicalUrl);
    const company = metadataString(candidate, 'company');
    const authorKey = normalizedAuthor(candidate.author);
    const questionCount = metadataNumber(candidate, 'questionCount');
    const questionHash = candidate.source === 'nowcoder' &&
      (evidenceGrade === 'A' || evidenceGrade === 'B')
      ? questionFingerprint(candidate.text)
      : undefined;
    // URL identity is stronger than a changed body: edits and extraction differences must
    // update the existing candidate instead of silently moving it to a new cluster.
    const existing = this.entries.find(entry => entry.id === id);
    const candidates = this.entries.filter(entry => entry.id !== id);
    const exact = candidates.find(entry => entry.contentHash === score.contentHash);
    const questionDuplicate = exact || !questionHash || !company
      ? undefined
      : candidates.find(entry =>
          entry.source === 'nowcoder' &&
          entry.questionHash === questionHash &&
          entry.company === company &&
          (!entry.authorKey || !authorKey || entry.authorKey === authorKey) &&
          (entry.evidenceGrade === 'A' || entry.evidenceGrade === 'B'));
    const near = exact || questionDuplicate
      ? undefined
      : candidates
          .filter(entry => {
            if (entry.source !== document.source) return false;
            if (document.source !== 'nowcoder') return true;
            return Boolean(
              company &&
              authorKey &&
              entry.company === company &&
              entry.authorKey === authorKey,
            );
          })
          .map(entry => ({ entry, distance: hammingDistance64(entry.simHash, score.simHash) }))
          .filter(item => item.distance <= NEAR_DUPLICATE_DISTANCE)
          .sort((left, right) => left.distance - right.distance || left.entry.id.localeCompare(right.entry.id))[0]
          ?.entry;
    const duplicate = existing ?? exact ?? questionDuplicate ?? near;
    const representativeId = duplicate?.representativeId ?? id;
    const clusterId = duplicate?.clusterId ?? `cluster-${score.contentHash.slice(0, 12)}`;
    const feJourney: FeJourneyCandidateMetadata = {
      ...score,
      clusterId,
      ...(representativeId !== id ? { duplicateOf: representativeId } : {}),
    };
    const enriched: CollectedDocument = { ...candidate, feJourney };
    const entry: CandidateIndexEntry = {
      id,
      source: document.source,
      url: candidate.canonicalUrl,
      contentHash: score.contentHash,
      simHash: score.simHash,
      ...(questionHash ? { questionHash } : {}),
      ...(company ? { company } : {}),
      ...(authorKey ? { authorKey } : {}),
      ...(evidenceGrade ? { evidenceGrade } : {}),
      ...(questionCount !== undefined ? { questionCount } : {}),
      clusterId,
      representativeId,
      qualityScore: score.qualityScore,
      ...(score.projectScore !== undefined ? { projectScore: score.projectScore } : {}),
      updatedAt: candidate.collectedAt,
    };
    let committed = false;

    return {
      document: enriched,
      commit: async () => {
        if (committed) return;
        committed = true;
        const commitEntry = async () => {
          this.entries = this.entries
            .filter(existing => existing.id !== entry.id)
            .concat(entry)
            .sort((left, right) => left.id.localeCompare(right.id));
          const catalog: CandidateCatalog = { version: 1, entries: this.entries };
          await atomicWriteText(
            this.libraryRoot,
            this.catalogPath,
            `${JSON.stringify(catalog, null, 2)}\n`,
          ).catch(() => { throw new FeJourneyCandidateCatalogError(); });
        };
        if (await libraryCatalogLockHeld(this.libraryRoot)) await commitEntry();
        else await this.runExclusive(commitEntry);
      },
    };
  }
}
