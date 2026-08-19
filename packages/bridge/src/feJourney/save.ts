import type { CollectedDocument } from '@data-collector/shared';
import { organize } from '../organize/index.js';
import type { SinkResult } from '../sinks/types.js';
import type { SinkRouter } from '../sinks/router.js';
import type { FeJourneyCandidateIndex } from './candidateIndex.js';

/**
 * 复用现有 Markdown 落盘链路，只在前面给牛客/GitHub 补充候选元数据。
 * 索引必须等本机 Markdown 真正写成功后再提交，避免留下幽灵候选。
 */
export async function saveCollectedDocument(
  router: SinkRouter,
  candidateIndex: FeJourneyCandidateIndex,
  document: CollectedDocument,
  override?: readonly string[],
): Promise<SinkResult[]> {
  const prepared = candidateIndex.prepare(document);
  const results = await router.save(organize(prepared.document), override);
  if (results.some(result => result.sinkId === 'markdown' && result.ok)) {
    await prepared.commit();
  }
  return results;
}
