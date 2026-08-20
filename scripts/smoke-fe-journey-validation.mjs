/**
 * Validate an exact/near-duplicate pair without relying on library display order.
 * `listLibrary` sorts by display time and id, not by insertion order.
 *
 * @param {Array<{ feJourney?: { clusterId?: string, duplicateOf?: string } }>} documents
 * @returns {{ clusterId: string, duplicateOf: string }}
 */
export function duplicateCluster(documents) {
  if (documents.length !== 2) {
    throw new Error(`重复样本数量不符：${documents.length}`);
  }
  const clusterIds = new Set(documents.map(document => document.feJourney?.clusterId));
  if (clusterIds.size !== 1 || clusterIds.has(undefined)) {
    throw new Error('重复面经没有聚合到同一候选簇');
  }
  const duplicate = documents.find(document => document.feJourney?.duplicateOf);
  if (!duplicate?.feJourney?.duplicateOf) {
    throw new Error('重复面经缺少代表条目引用');
  }
  return {
    clusterId: duplicate.feJourney.clusterId,
    duplicateOf: duplicate.feJourney.duplicateOf,
  };
}
