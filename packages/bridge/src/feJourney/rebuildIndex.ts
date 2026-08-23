import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CollectedDocument } from '@data-collector/shared';
import { assertInsideRoot, listLibrary } from '../library/index.js';
import { atomicWriteText, SOURCE_FILE } from '../library/writer.js';
import type { OrganizedDocument } from '../organize/index.js';
import { FeJourneyCandidateIndex } from './candidateIndex.js';
import { withFeJourneyCandidateLock } from './fileLock.js';

interface RebuildCandidate {
  sourcePath: string;
  sourceText: string;
  organized: OrganizedDocument;
}

type WriteText = typeof atomicWriteText;

export interface RebuildFeJourneyIndexOptions {
  writeText?: WriteText;
}

function isCandidateDocument(document: CollectedDocument): boolean {
  return document.source === 'nowcoder' || document.source === 'github';
}

function documentOrder(left: RebuildCandidate, right: RebuildCandidate): number {
  const leftAt = left.organized.document.publishedAt ?? left.organized.document.collectedAt;
  const rightAt = right.organized.document.publishedAt ?? right.organized.document.collectedAt;
  return leftAt.localeCompare(rightAt) ||
    left.organized.document.canonicalUrl.localeCompare(right.organized.document.canonicalUrl);
}

async function readCandidates(libraryRoot: string): Promise<RebuildCandidate[]> {
  const candidates: RebuildCandidate[] = [];
  for (const entry of await listLibrary(libraryRoot)) {
    if (entry.source !== 'nowcoder' && entry.source !== 'github') continue;
    const markdownPath = assertInsideRoot(libraryRoot, join(libraryRoot, entry.relativePath));
    const sourcePath = assertInsideRoot(libraryRoot, join(dirname(markdownPath), SOURCE_FILE));
    const sourceText = await readFile(sourcePath, 'utf8');
    const organized = JSON.parse(sourceText) as OrganizedDocument;
    if (!organized.document || !isCandidateDocument(organized.document)) {
      throw new Error(`候选原始数据格式无效：${entry.id}`);
    }
    candidates.push({ sourcePath, sourceText, organized });
  }
  return candidates.sort(documentOrder);
}

/**
 * 从本机库保留的 source.json 重新计算候选簇，并同步修复候选索引与原始整理结果。
 * 所有计算先在临时目录完成；任一来源不可读时不会改写真实索引。
 */
export async function rebuildFeJourneyCandidateIndex(
  libraryRoot: string,
  options: RebuildFeJourneyIndexOptions = {},
): Promise<{ scanned: number; rebuilt: number }> {
  return withFeJourneyCandidateLock(libraryRoot, async () => {
    const candidates = await readCandidates(libraryRoot);
    const catalogPath = join(libraryRoot, '_catalog', 'fe-journey.json');
    let originalCatalog: string | undefined;
    try {
      originalCatalog = await readFile(catalogPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'data-collector-candidate-rebuild-'));
    try {
      const index = await FeJourneyCandidateIndex.open(temporaryRoot);
      const rebuilt: Array<{ sourcePath: string; organized: OrganizedDocument }> = [];
      for (const candidate of candidates) {
        const prepared = index.prepare(candidate.organized.document);
        await prepared.commit();
        rebuilt.push({
          sourcePath: candidate.sourcePath,
          organized: { ...candidate.organized, document: prepared.document },
        });
      }

      const temporaryCatalogPath = join(temporaryRoot, '_catalog', 'fe-journey.json');
      const catalog = candidates.length > 0
        ? await readFile(temporaryCatalogPath, 'utf8')
        : `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`;
      const writeText = options.writeText ?? atomicWriteText;
      try {
        for (const item of rebuilt) {
          await writeText(
            libraryRoot,
            item.sourcePath,
            `${JSON.stringify(item.organized, null, 2)}\n`,
          );
        }
        await writeText(libraryRoot, catalogPath, catalog);
      } catch (error) {
        const rollback = await Promise.allSettled([
          ...candidates.map(candidate => atomicWriteText(
            libraryRoot,
            candidate.sourcePath,
            candidate.sourceText,
          )),
          originalCatalog === undefined
            ? rm(catalogPath, { force: true })
            : atomicWriteText(libraryRoot, catalogPath, originalCatalog),
        ]);
        const rollbackErrors = rollback
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason);
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], '候选索引重建失败，且回滚未完整完成');
        }
        throw error;
      }
      return { scanned: candidates.length, rebuilt: rebuilt.length };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
