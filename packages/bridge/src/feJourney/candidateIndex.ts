import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  stableContentId,
  type CollectedDocument,
  type FeJourneyCandidateMetadata,
  type Source,
} from '@data-collector/shared';
import { atomicWriteText } from '../library/writer.js';
import { hammingDistance64, questionFingerprint } from './fingerprint.js';
import { enrichNowcoderEvidence } from './nowcoderEvidence.js';
import { scoreFeJourneyCandidate } from './quality.js';

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

function parseCatalog(value: unknown): CandidateCatalog {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    throw new Error('fe-journey 候选索引格式无效');
  }
  return value as CandidateCatalog;
}

/** 本机库中仅供 fe-journey 使用的候选聚合索引。 */
export class FeJourneyCandidateIndex {
  private readonly catalogPath: string;
  private entries: CandidateIndexEntry[];
  private commitQueue: Promise<void> = Promise.resolve();
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
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.candidateSaveQueue.then(operation);
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

    const evidenced = enrichNowcoderEvidence(document);
    const score = scoreFeJourneyCandidate(evidenced);
    const evidenceGrade = metadataString(evidenced, 'evidenceGrade');
    const candidate = evidenced.source === 'nowcoder' &&
      (evidenceGrade === 'A' || evidenceGrade === 'B') &&
      score.candidateKinds.includes('interview')
      ? { ...evidenced, suggestedCategory: '人工智能' }
      : evidenced;
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
        const operation = this.commitQueue.then(async () => {
          this.entries = this.entries
            .filter(existing => existing.id !== entry.id)
            .concat(entry)
            .sort((left, right) => left.id.localeCompare(right.id));
          const catalog: CandidateCatalog = { version: 1, entries: this.entries };
          await atomicWriteText(
            this.libraryRoot,
            this.catalogPath,
            `${JSON.stringify(catalog, null, 2)}\n`,
          );
        });
        this.commitQueue = operation.then(
          () => undefined,
          () => undefined,
        );
        await operation;
      },
    };
  }
}
