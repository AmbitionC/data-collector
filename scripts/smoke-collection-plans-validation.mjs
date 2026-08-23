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
  return true;
}
