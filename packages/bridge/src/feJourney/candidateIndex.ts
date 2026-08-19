import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  stableContentId,
  type CollectedDocument,
  type FeJourneyCandidateMetadata,
  type Source,
} from '@data-collector/shared';
import { atomicWriteText } from '../library/writer.js';
import { hammingDistance64 } from './fingerprint.js';
import { scoreFeJourneyCandidate } from './quality.js';

interface CandidateIndexEntry {
  id: string;
  source: Extract<Source, 'nowcoder' | 'github'>;
  url: string;
  contentHash: string;
  simHash: string;
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

  prepare(document: CollectedDocument): PreparedFeJourneyCandidate {
    if (!isCandidateSource(document.source)) {
      return { document, commit: async () => undefined };
    }

    const id = stableContentId(document.canonicalUrl);
    const score = scoreFeJourneyCandidate(document);
    const candidates = this.entries.filter(entry => entry.id !== id);
    const exact = candidates.find(entry => entry.contentHash === score.contentHash);
    const near = exact
      ? undefined
      : candidates
          .map(entry => ({ entry, distance: hammingDistance64(entry.simHash, score.simHash) }))
          .filter(item => item.distance <= NEAR_DUPLICATE_DISTANCE)
          .sort((left, right) => left.distance - right.distance || left.entry.id.localeCompare(right.entry.id))[0]
          ?.entry;
    const duplicate = exact ?? near;
    const representativeId = duplicate?.representativeId ?? id;
    const clusterId = duplicate?.clusterId ?? `cluster-${score.contentHash.slice(0, 12)}`;
    const feJourney: FeJourneyCandidateMetadata = {
      ...score,
      clusterId,
      ...(representativeId !== id ? { duplicateOf: representativeId } : {}),
    };
    const enriched: CollectedDocument = { ...document, feJourney };
    const entry: CandidateIndexEntry = {
      id,
      source: document.source,
      url: document.canonicalUrl,
      contentHash: score.contentHash,
      simHash: score.simHash,
      clusterId,
      representativeId,
      qualityScore: score.qualityScore,
      ...(score.projectScore !== undefined ? { projectScore: score.projectScore } : {}),
      updatedAt: document.collectedAt,
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
