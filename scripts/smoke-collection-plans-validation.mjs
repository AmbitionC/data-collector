export function validateCollectionPlanSmoke(report) {
  if (!report || typeof report !== 'object') throw new Error('冒烟报告格式无效');
  if (report.zsxq?.unionedTopics < 1 || report.zsxq?.uniqueTopics > report.zsxq?.discovered) {
    throw new Error('知识星球 topic union 无效');
  }
  const coverage = report.nowcoder?.coverage ?? {};
  for (const company of ['bytedance', 'tencent', 'alibaba', 'ant']) {
    if (!Number.isInteger(coverage[company]) || coverage[company] < 0) {
      throw new Error(`公司覆盖缺失：${company}`);
    }
    if (coverage[company] > 4) throw new Error(`公司上限被突破：${company}`);
  }
  const batch = report.batch ?? {};
  const terminal = batch.saved + batch.skipped + batch.failed + batch.needsAttention;
  if (terminal !== batch.discovered) throw new Error('批次终态计数不诚实');
  const syncedIds = report.syncedIds ?? [];
  if (new Set(syncedIds).size !== syncedIds.length) throw new Error('发现重复同步');
  const questionClusters = report.reports?.questionClusters;
  if (!Array.isArray(questionClusters) || questionClusters.length === 0) {
    throw new Error('缺少问题簇报告');
  }
  const clusterKeys = questionClusters.map(cluster => cluster?.key);
  if (clusterKeys.some(key => typeof key !== 'string' || key.length === 0) ||
      new Set(clusterKeys).size !== clusterKeys.length) {
    throw new Error('报告包含重复问题簇');
  }
  for (const cluster of questionClusters) {
    if (!Array.isArray(cluster.evidence) || cluster.evidence.length === 0 ||
        cluster.evidence.some(item => !['A', 'B'].includes(item?.grade) ||
          typeof item?.url !== 'string' || !item.url.startsWith('https://'))) {
      throw new Error('问题簇只能链接 A/B 证据');
    }
  }
  return true;
}
