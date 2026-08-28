#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const COMPLETE_PROTOCOL = 'zsxq-complete-content-v2';

function argumentsOf(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`参数无效：${key ?? '(缺失)'}`);
    values.set(key.slice(2), value);
  }
  const batchId = values.get('batch');
  if (!batchId) throw new Error('必须提供 --batch <BATCH_ID>');
  const configRoot = process.env.DATA_COLLECTOR_CONFIG
    ? resolve(process.env.DATA_COLLECTOR_CONFIG)
    : join(homedir(), '.data-collector');
  const libraryRoot = process.env.DATA_COLLECTOR_LIBRARY
    ? resolve(process.env.DATA_COLLECTOR_LIBRARY)
    : join(homedir(), 'Documents', 'data-collector');
  return {
    batchId,
    plans: resolve(values.get('plans') ?? join(configRoot, 'collection-plans.json')),
    ledger: resolve(values.get('ledger') ?? join(configRoot, 'zsxq-day-ledger.json')),
    catalog: resolve(values.get('catalog') ?? join(libraryRoot, '_catalog', 'index.json')),
    today: values.get('today'),
  };
}

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 格式无效`);
  }
  return value;
}

function count(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 不是非负整数`);
  return value;
}

function shanghaiDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

function shiftDay(day, offset) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

async function json(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const input = argumentsOf(process.argv.slice(2));
  const plans = object(await json(input.plans, '批次文件'), '批次文件');
  if (!Array.isArray(plans.batches)) throw new Error('批次文件缺少 batches 数组');
  const batch = plans.batches.find(candidate =>
    candidate && typeof candidate === 'object' && candidate.id === input.batchId);
  if (!batch) throw new Error(`找不到批次：${input.batchId}`);
  const audit = object(batch.ownerAudit, 'ownerAudit');
  const ledger = object(await json(input.ledger, '逐日账本'), '逐日账本');
  const days = object(ledger.days, '逐日账本 days');
  const catalog = await json(input.catalog, '本机目录');
  if (!Array.isArray(catalog)) throw new Error('本机目录不是数组');

  const todayInput = input.today ?? shanghaiDay();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(todayInput)) throw new Error('--today 必须是 YYYY-MM-DD');
  if (batch.zsxqMode === 'daily-ledger') {
    const dailyDeliveryIds = Array.isArray(batch.deliveryIds)
      ? batch.deliveryIds.filter(value => typeof value === 'string')
      : [];
    const dailyCatalogById = new Map(catalog
      .filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string')
      .map(entry => [entry.id, entry]));
    const duplicateDeliveryIds = dailyDeliveryIds.length - new Set(dailyDeliveryIds).size;
    const incompleteQualifying = dailyDeliveryIds.filter(id => {
      const entry = dailyCatalogById.get(id);
      return !entry
        || entry.source !== 'zsxq'
        || entry.contentComplete !== true
        || entry.contentCompletenessVersion !== COMPLETE_PROTOCOL;
    }).length;
    const historyBatchId = typeof ledger.lastHistoryAudit?.batchId === 'string'
      ? ledger.lastHistoryAudit.batchId
      : undefined;
    const historyAttempt = typeof ledger.lastHistoryAudit?.attempt === 'string'
      ? ledger.lastHistoryAudit.attempt
      : undefined;
    const historyBatch = plans.batches.find(candidate =>
      candidate && typeof candidate === 'object' && candidate.id === historyBatchId);
    const historyDeliveryIds = new Set(Array.isArray(historyBatch?.deliveryIds)
      ? historyBatch.deliveryIds.filter(value => typeof value === 'string')
      : []);
    const historyDeliveryOverlap = dailyDeliveryIds.filter(id => historyDeliveryIds.has(id)).length;
    const yesterday = shiftDay(todayInput, -1);
    const coverageStartDay = typeof ledger.coverageStartDay === 'string'
      ? ledger.coverageStartDay
      : undefined;
    let ledgerGaps = 0;
    let historicalDaysRewritten = 0;
    if (!coverageStartDay || !/^\d{4}-\d{2}-\d{2}$/u.test(coverageStartDay)) {
      ledgerGaps = 1;
    } else {
      for (let day = coverageStartDay; day <= yesterday; day = shiftDay(day, 1)) {
        const entry = days[day];
        const complete = entry
          && typeof entry === 'object'
          && (entry.status === 'completed_content' || entry.status === 'completed_empty')
          && entry.crossedDayBoundary === true
          && entry.failedCount === 0;
        if (!complete) ledgerGaps += 1;
        if (
          !entry
          || typeof entry !== 'object'
          || entry.batchId !== historyBatchId
          || entry.attemptToken !== historyAttempt
        ) historicalDaysRewritten += 1;
      }
    }
    const ownerPagesFetched = count(audit.pagesFetched, 'ownerAudit.pagesFetched');
    const currentDayFinalized = Object.hasOwn(days, todayInput);
    const activeCheckpointPresent = ledger.active !== undefined;
    const terminalFactsValid = batch.planId === 'zsxq-chen-teacher'
      && batch.status === 'completed'
      && batch.failed === 0
      && batch.needsAttention === 0
      && audit.mode === 'daily-ledger'
      && count(audit.failed, 'ownerAudit.failed') === 0
      && count(audit.failedDays, 'ownerAudit.failedDays') === 0
      && audit.safetyCapReached === false;
    const passed = terminalFactsValid
      && historyBatch?.status === 'completed'
      && ownerPagesFetched === 1
      && ledgerGaps === 0
      && historicalDaysRewritten === 0
      && historyDeliveryOverlap === 0
      && duplicateDeliveryIds === 0
      && incompleteQualifying === 0
      && !currentDayFinalized
      && !activeCheckpointPresent;
    process.stdout.write(`${JSON.stringify({
      batchId: input.batchId,
      mode: 'daily-ledger',
      passed,
      deliveryIds: dailyDeliveryIds,
      ownerPagesFetched,
      ledgerGaps,
      historicalDaysRewritten,
      historyDeliveryOverlap,
      duplicateDeliveryIds,
      incompleteQualifying,
      currentDayFinalized,
      activeCheckpointPresent,
      terminalFactsValid,
      historyBatchId,
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 2;
    return;
  }

  const qualifying = count(audit.qualifying, 'ownerAudit.qualifying');
  const exactDuplicates = count(audit.exactDuplicates, 'ownerAudit.exactDuplicates');
  const semanticDuplicates = count(audit.semanticDuplicates, 'ownerAudit.semanticDuplicates');
  const saved = count(audit.saved, 'ownerAudit.saved');
  const repaired = count(audit.repaired, 'ownerAudit.repaired');
  const mappedQualifying = exactDuplicates + semanticDuplicates + saved;
  const deliveryIds = Array.isArray(batch.deliveryIds)
    ? batch.deliveryIds.filter(value => typeof value === 'string')
    : [];
  const duplicateDeliveryIds = deliveryIds.length - new Set(deliveryIds).size;
  const catalogById = new Map(catalog
    .filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string')
    .map(entry => [entry.id, entry]));
  const catalogByUrl = new Map(catalog
    .filter(entry => entry && typeof entry === 'object' && typeof entry.url === 'string')
    .map(entry => [entry.url, entry]));
  const incompleteQualifying = deliveryIds.filter(id => {
    const entry = catalogById.get(id);
    return !entry
      || entry.source !== 'zsxq'
      || entry.contentComplete !== true
      || entry.contentCompletenessVersion !== COMPLETE_PROTOCOL;
  }).length;
  const historyFacts = ledger.lastHistoryAudit
    && typeof ledger.lastHistoryAudit === 'object'
    && ledger.lastHistoryAudit.batchId === input.batchId
    && Array.isArray(ledger.lastHistoryAudit.itemFacts)
    ? ledger.lastHistoryAudit.itemFacts
    : [];
  const factCounts = { exact: 0, semantic: 0, saved: 0, repaired: 0 };
  const candidateUrls = new Set();
  let invalidTopicMappings = 0;
  let duplicateTopicFacts = 0;
  for (const rawFact of historyFacts) {
    if (!rawFact || typeof rawFact !== 'object') {
      invalidTopicMappings += 1;
      continue;
    }
    const { url, mappedUrl, outcome } = rawFact;
    if (
      typeof url !== 'string'
      || typeof mappedUrl !== 'string'
      || typeof outcome !== 'string'
      || !Object.hasOwn(factCounts, outcome)
    ) {
      invalidTopicMappings += 1;
      continue;
    }
    factCounts[outcome] += 1;
    if (candidateUrls.has(url)) duplicateTopicFacts += 1;
    candidateUrls.add(url);
    const mapped = catalogByUrl.get(mappedUrl);
    if (
      !mapped
      || mapped.source !== 'zsxq'
      || mapped.contentComplete !== true
      || mapped.contentCompletenessVersion !== COMPLETE_PROTOCOL
    ) invalidTopicMappings += 1;
  }
  const missingTopicFacts = Math.max(0, qualifying - historyFacts.length);
  const overmappedQualifying = Math.max(0, historyFacts.length - qualifying);
  const topicCategoryMismatch = Math.abs(factCounts.exact - exactDuplicates)
    + Math.abs(factCounts.semantic - semanticDuplicates)
    + Math.abs(factCounts.repaired - repaired)
    + Math.abs((factCounts.saved + factCounts.repaired) - saved);
  const unmappedQualifying = missingTopicFacts + invalidTopicMappings;
  const topicFactsVerified = ledger.lastHistoryAudit?.batchId === input.batchId
    && historyFacts.length === qualifying
    && invalidTopicMappings === 0
    && duplicateTopicFacts === 0
    && topicCategoryMismatch === 0;

  const today = todayInput;
  const yesterday = shiftDay(today, -1);
  const oldestObservedAt = typeof audit.oldestObservedAt === 'string'
    ? audit.oldestObservedAt
    : undefined;
  if (!oldestObservedAt || !Number.isFinite(Date.parse(oldestObservedAt))) {
    throw new Error('ownerAudit 缺少有效 oldestObservedAt');
  }
  const oldestObservedDay = shanghaiDay(new Date(oldestObservedAt));
  const historyAttempt = typeof ledger.lastHistoryAudit?.attempt === 'string'
    ? ledger.lastHistoryAudit.attempt
    : undefined;
  const factsByDay = new Map();
  for (const fact of historyFacts) {
    if (!fact || typeof fact !== 'object' || typeof fact.day !== 'string') continue;
    const current = factsByDay.get(fact.day) ?? [];
    current.push(fact);
    factsByDay.set(fact.day, current);
  }
  let ledgerGaps = 0;
  let failedDays = 0;
  let exactBatchDayMismatches = 0;
  let ledgerDayFactMismatches = 0;
  for (let day = oldestObservedDay; day <= yesterday; day = shiftDay(day, 1)) {
    const entry = days[day];
    const valid = entry
      && typeof entry === 'object'
      && (entry.status === 'completed_content' || entry.status === 'completed_empty')
      && entry.crossedDayBoundary === true
      && entry.failedCount === 0
      && (entry.status !== 'completed_content' || entry.qualifyingCount > 0)
      && (entry.status !== 'completed_empty' || entry.qualifyingCount === 0);
    if (!valid) ledgerGaps += 1;
    if (entry && typeof entry === 'object' && entry.status === 'failed') failedDays += 1;
    if (
      !entry
      || typeof entry !== 'object'
      || entry.batchId !== input.batchId
      || entry.attemptToken !== historyAttempt
    ) exactBatchDayMismatches += 1;
    if (entry && typeof entry === 'object') {
      const dayFacts = factsByDay.get(day) ?? [];
      const dayCounts = { exact: 0, semantic: 0, saved: 0, repaired: 0 };
      for (const fact of dayFacts) {
        if (typeof fact?.outcome === 'string' && Object.hasOwn(dayCounts, fact.outcome)) {
          dayCounts[fact.outcome] += 1;
        }
      }
      if (
        entry.qualifyingCount !== dayFacts.length
        || entry.exactDuplicateCount !== dayCounts.exact
        || entry.semanticDuplicateCount !== dayCounts.semantic
        || entry.savedCount !== dayCounts.saved + dayCounts.repaired
        || entry.repairCount !== dayCounts.repaired
      ) ledgerDayFactMismatches += 1;
    }
  }
  failedDays = Math.max(failedDays, count(audit.failedDays, 'ownerAudit.failedDays'));
  const currentDayFinalized = Object.hasOwn(days, today);
  const activeCheckpointPresent = ledger.active !== undefined;
  const coverageStartMatches = ledger.coverageStartDay === oldestObservedDay;
  const exactBatchDaysVerified = exactBatchDayMismatches === 0
    && ledgerDayFactMismatches === 0;
  const terminalFactsValid = batch.planId === 'zsxq-chen-teacher'
    && batch.zsxqMode === 'owner-history'
    && batch.status === 'completed'
    && batch.failed === 0
    && batch.needsAttention === 0
    && audit.mode === 'owner-history'
    && audit.exhausted === true
    && audit.safetyCapReached === false
    && audit.failed === 0;
  const passed = terminalFactsValid
    && unmappedQualifying === 0
    && overmappedQualifying === 0
    && topicFactsVerified
    && incompleteQualifying === 0
    && duplicateDeliveryIds === 0
    && failedDays === 0
    && ledgerGaps === 0
    && exactBatchDaysVerified
    && !currentDayFinalized
    && !activeCheckpointPresent
    && coverageStartMatches;
  const result = {
    batchId: input.batchId,
    passed,
    deliveryIds,
    qualifying,
    mappedQualifying,
    unmappedQualifying,
    overmappedQualifying,
    topicFactsVerified,
    invalidTopicMappings,
    duplicateTopicFacts,
    topicCategoryMismatch,
    incompleteQualifying,
    duplicateDeliveryIds,
    failedDays,
    ledgerGaps,
    exactBatchDaysVerified,
    exactBatchDayMismatches,
    ledgerDayFactMismatches,
    oldestObservedDay,
    yesterday,
    currentDayFinalized,
    activeCheckpointPresent,
    coverageStartMatches,
    terminalFactsValid,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!passed) process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
