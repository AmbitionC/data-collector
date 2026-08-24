import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { unionZsxqViewDocuments } from '../packages/shared/dist/index.js';
import { JobStore } from '../packages/bridge/dist/jobs/store.js';
import {
  CollectionPlanService,
  CollectionPlanStore,
  selectNowcoderPlanCandidates,
} from '../packages/bridge/dist/plans/index.js';
import { validateCollectionPlanSmoke } from './smoke-collection-plans-validation.mjs';

const WORKSPACE = resolve(import.meta.dirname, '..');
const NOW = '2026-08-23T01:05:00.000Z';

function zsxqTopic(id, authorRole, title) {
  const url = `https://wx.zsxq.com/group/48844584441158/topic/${id}`;
  return {
    schemaVersion: 1,
    source: 'zsxq',
    kind: 'post',
    url,
    canonicalUrl: url,
    title,
    author: authorRole === 'owner' ? '陈老师' : '星球成员',
    publishedAt: '2026-08-22T01:00:00.000Z',
    collectedAt: NOW,
    html: `<p>${title}</p>`,
    text: `${title}，这是用于固定计划离线冒烟的匿名正文。`,
    images: [],
    sourceMetadata: { authorRole, topicId: id },
  };
}

const COMPANY_LABEL = {
  bytedance: '字节',
  tencent: '腾讯',
  alibaba: '阿里云',
  ant: '蚂蚁',
};

function nowcoderInterview(company, id, contentAccess = 'full') {
  const url = `https://www.nowcoder.com/discuss/${id}`;
  const label = COMPANY_LABEL[company];
  const text = `我参加了${label} AI 应用开发一面。1.Agent Loop 怎么设计？2.Tool 如何定义？3.Memory 如何实现？`;
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: `${label} AI 应用开发一面面经`,
    author: `匿名候选人-${id}`,
    publishedAt: '2026-08-20T01:00:00.000Z',
    collectedAt: NOW,
    html: `<p>${text}</p>`,
    text,
    images: [],
    sourceMetadata: { contentAccess },
  };
}

/**
 * 冒烟只验证报告契约：相同标准化问题无论来自几个 URL 都只占一行，
 * 行内可以保留多个 A/B 来源；C 级来源永远不会被带进建议。
 */
function buildQuestionClusterEvidence(documents) {
  const clusters = new Map();
  for (const document of documents) {
    const grade = document.sourceMetadata?.evidenceGrade;
    if (grade !== 'A' && grade !== 'B') continue;
    const questions = [...document.text.matchAll(/\d+\.\s*([^?？]{4,180}[?？])/gu)]
      .map(match => match[1]?.trim())
      .filter(Boolean);
    for (const question of questions) {
      const key = question.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
      const record = clusters.get(key) ?? { key, question, evidence: [] };
      if (!record.evidence.some(item => item.url === document.canonicalUrl)) {
        record.evidence.push({ grade, url: document.canonicalUrl });
      }
      clusters.set(key, record);
    }
  }
  return [...clusters.values()];
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'collection-plans-smoke-'));
  try {
    const owner = zsxqTopic('611111111111111', 'owner', '投资与创业项目经营复盘');
    const member = zsxqTopic('622222222222222', 'member', '成员的一般讨论');
    const zsxq = unionZsxqViewDocuments([
      { label: '最新', documents: [owner, member] },
      { label: '精华', documents: [owner] },
      { label: '只看星主', documents: [owner] },
    ]);

    const rawInterviews = [
      ...Array.from({ length: 3 }, (_, index) => nowcoderInterview('bytedance', 10_000 + index)),
      ...Array.from({ length: 3 }, (_, index) => nowcoderInterview('tencent', 11_000 + index)),
      ...Array.from({ length: 3 }, (_, index) => nowcoderInterview('alibaba', 12_000 + index)),
      nowcoderInterview('ant', 13_000, 'truncated'),
    ];
    const nowcoder = selectNowcoderPlanCandidates(rawInterviews, NOW);
    const questionClusters = buildQuestionClusterEvidence(nowcoder.accepted);

    const store = await CollectionPlanStore.open(join(temporaryRoot, 'plans.json'), () => NOW);
    const jobs = await JobStore.open(join(temporaryRoot, 'jobs.json'), {
      now: () => NOW,
      id: () => 'unused',
    });
    const syncedIds = [];
    const service = new CollectionPlanService({
      store,
      jobs,
      now: () => NOW,
      extensionConnected: () => true,
      discoverNowcoder: async () => [],
      dispatch: async () => undefined,
      collectZsxq: async () => undefined,
      shouldAutoSync: async job => job.planId === 'zsxq-chen-teacher',
      syncJob: async job => { syncedIds.push(job.id); },
    });
    const batch = await store.start('zsxq-chen-teacher');
    const preparing = await store.beginPreparation(batch.id);
    await store.markDiscovery(batch.id, zsxq.length);
    const job = await jobs.create({
      id: 'owner-topic',
      url: owner.canonicalUrl,
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: preparing.preparationAttempt,
    });
    await service.onJobCreated(job);
    await jobs.transition(job.id, 'collecting');
    const saved = await jobs.transition(job.id, 'saved', { outputPath: '/fixture/index.md' });
    await service.onJobTerminal(saved);
    await service.onJobTerminal(saved);
    const terminal = store.latest('zsxq-chen-teacher', 1)[0];

    const report = {
      ok: true,
      mode: 'fixtures',
      zsxq: {
        discovered: zsxq.length,
        uniqueTopics: zsxq.length,
        unionedTopics: zsxq.filter(document => String(document.sourceMetadata?.viewLabels).includes('、')).length,
        ownerAccepted: zsxq.filter(document => document.sourceMetadata?.authorRole === 'owner').length,
        viewLabels: zsxq.map(document => document.sourceMetadata?.viewLabels),
      },
      nowcoder: {
        discovered: rawInterviews.length,
        accepted: nowcoder.accepted.length,
        coverage: nowcoder.coverage,
      },
      batch: {
        discovered: terminal.discovered,
        saved: terminal.saved,
        skipped: terminal.skipped,
        failed: terminal.failed,
        needsAttention: terminal.needsAttention,
      },
      syncedIds,
      reports: { questionClusters },
      testedAt: new Date().toISOString(),
    };
    validateCollectionPlanSmoke(report);
    const reportPath = join(WORKSPACE, 'artifacts', 'smoke-collection-plans.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
