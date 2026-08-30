import { stableContentId, type CollectedDocument, type NowcoderDirectedRunAttempt } from '@data-collector/shared';
import { organize } from '../organize/index.js';
import { deliveryRevision } from '../library/deliveryRevision.js';
import type { LocalDocumentEvidence } from '../library/storedDocument.js';
import type { SinkResult } from '../sinks/types.js';
import type { SinkRouter } from '../sinks/router.js';
import {
  previewFeJourneyLocalTarget,
  type FeJourneyCandidateIndex,
} from './candidateIndex.js';

export class NowcoderDirectedSaveError extends Error {
  constructor(public readonly code:
    | 'DIRECTED_LOCAL_LIBRARY_CORRUPT'
    | 'DIRECTED_CANDIDATE_CATALOG_CORRUPT') {
    super(code === 'DIRECTED_LOCAL_LIBRARY_CORRUPT'
      ? '本地面经库无法安全读取'
      : '候选目录无法安全读取');
    this.name = 'NowcoderDirectedSaveError';
  }
}

/**
 * 复用现有 Markdown 落盘链路，只在前面给牛客/GitHub 补充候选元数据。
 * 索引必须等本机 Markdown 真正写成功后再提交，避免留下幽灵候选。
 */
export async function saveCollectedDocument(
  router: SinkRouter,
  candidateIndex: FeJourneyCandidateIndex | undefined,
  document: CollectedDocument,
  override?: readonly string[],
  directedEvidence?: {
    runId: string;
    attempt: NowcoderDirectedRunAttempt;
    currentJobId: string;
  },
): Promise<SinkResult[]> {
  if (!candidateIndex) {
    if (document.source === 'nowcoder' || document.source === 'github') {
      throw new Error('fe-journey 候选索引不可用，已停止候选来源落盘');
    }
    return router.save(organize(document), override);
  }
  const save = async (): Promise<SinkResult[]> => {
    const prepared = candidateIndex.prepare(document);
    const organized = organize(prepared.document);
    let localEvidence: LocalDocumentEvidence | undefined;
    if (directedEvidence) {
      const contentHash = organized.document.feJourney?.contentHash;
      const clusterId = organized.document.feJourney?.clusterId;
      if (!contentHash || !clusterId || organized.document.source !== 'nowcoder') {
        throw new Error('定向牛客本机证据缺少候选身份');
      }
      localEvidence = {
        nowcoderDirected: {
          ...directedEvidence,
          stableContentId: stableContentId(organized.document.canonicalUrl),
          canonicalUrl: organized.document.canonicalUrl,
          contentHash,
          clusterId,
          deliveryRevision: deliveryRevision(organized),
        },
      };
    }
    const results = await router.save(organized, override, localEvidence);
    if (directedEvidence) {
      const localFailure = results.find(result =>
        router.isTrustedLocalEvidenceResult(result)
        && result.ok === false);
      if (localFailure) throw new NowcoderDirectedSaveError('DIRECTED_LOCAL_LIBRARY_CORRUPT');
    }
    if (results.some(result => router.isTrustedLocalEvidenceResult(result) && result.ok)) {
      await prepared.commit();
    }
    return results;
  };
  try {
    // Compute only pure deterministic path fields: authoritative prepare -> organize remains
    // exactly once inside the cross-process critical section.
    const directedTarget = directedEvidence
      ? previewFeJourneyLocalTarget(document)
      : undefined;
    return await (document.source === 'nowcoder' || document.source === 'github'
      ? directedEvidence
        ? candidateIndex.runDirectedExclusive(save, directedTarget!)
        : candidateIndex.runExclusive(save)
      : save());
  } catch (error) {
    if (error instanceof NowcoderDirectedSaveError) throw error;
    if (directedEvidence && typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'DIRECTED_LOCAL_LIBRARY_CORRUPT') {
        throw new NowcoderDirectedSaveError('DIRECTED_LOCAL_LIBRARY_CORRUPT');
      }
      if (error.code === 'DIRECTED_CANDIDATE_CATALOG_CORRUPT') {
        throw new NowcoderDirectedSaveError('DIRECTED_CANDIDATE_CATALOG_CORRUPT');
      }
    }
    throw error;
  }
}
