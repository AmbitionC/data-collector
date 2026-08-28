import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ZSXQ_COMPLETE_CONTENT_CAPABILITY } from '@data-collector/shared';

const execFileAsync = promisify(execFile);

describe('ZSXQ owner-history acceptance audit script', () => {
  it('proves aggregate topic mapping, complete deliveries, and a continuous closed-day ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-audit-'));
    const plans = join(root, 'plans.json');
    const ledger = join(root, 'ledger.json');
    const catalog = join(root, 'catalog.json');
    const batchId = 'zsxq-history-accepted';
    await writeFile(plans, `${JSON.stringify({
      version: 1,
      batches: [{
        id: batchId,
        planId: 'zsxq-chen-teacher',
        status: 'completed',
        zsxqMode: 'owner-history',
        failed: 0,
        needsAttention: 0,
        deliveryIds: ['aaaaaaaaaaaa'],
        ownerAudit: {
          mode: 'owner-history',
          qualifying: 3,
          exactDuplicates: 1,
          semanticDuplicates: 1,
          saved: 1,
          repaired: 0,
          failed: 0,
          failedDays: 0,
          exhausted: true,
          safetyCapReached: false,
          oldestObservedAt: '2026-08-27T01:00:00.000Z',
        },
        jobIds: [],
      }],
    })}\n`);
    await writeFile(ledger, `${JSON.stringify({
      version: 1,
      planId: 'zsxq-chen-teacher',
      timeZone: 'Asia/Shanghai',
      coverageStartDay: '2026-08-27',
      lastHistoryAudit: {
        batchId,
        attempt: 'a1b2c3d4e5f60718',
        itemFacts: [
          { url: 'https://wx.zsxq.com/group/48844584441158/topic/1', day: '2026-08-27', outcome: 'exact', mappedUrl: 'https://wx.zsxq.com/group/48844584441158/topic/101' },
          { url: 'https://wx.zsxq.com/group/48844584441158/topic/2', day: '2026-08-27', outcome: 'semantic', mappedUrl: 'https://wx.zsxq.com/group/48844584441158/topic/102' },
          { url: 'https://wx.zsxq.com/group/48844584441158/topic/3', day: '2026-08-27', outcome: 'saved', mappedUrl: 'https://wx.zsxq.com/group/48844584441158/topic/3' },
        ],
      },
      days: {
        '2026-08-27': {
          status: 'completed_content', qualifyingCount: 3, exactDuplicateCount: 1,
          semanticDuplicateCount: 1, savedCount: 1, repairCount: 0,
          crossedDayBoundary: true, failedCount: 0, batchId,
          attemptToken: 'a1b2c3d4e5f60718',
        },
        '2026-08-28': {
          status: 'completed_empty', qualifyingCount: 0, exactDuplicateCount: 0,
          semanticDuplicateCount: 0, savedCount: 0, repairCount: 0,
          crossedDayBoundary: true, failedCount: 0, batchId,
          attemptToken: 'a1b2c3d4e5f60718',
        },
      },
    })}\n`);
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(catalog, `${JSON.stringify([{
      id: 'aaaaaaaaaaaa',
      source: 'zsxq',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/3',
      contentComplete: true,
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
    }, {
      id: 'bbbbbbbbbbbb',
      source: 'zsxq',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/101',
      contentComplete: true,
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
    }, {
      id: 'cccccccccccc',
      source: 'zsxq',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/102',
      contentComplete: true,
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
    }])}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/audit-zsxq-owner.mjs',
      '--batch', batchId,
      '--plans', plans,
      '--ledger', ledger,
      '--catalog', catalog,
      '--today', '2026-08-29',
    ], { cwd: process.cwd() });

    expect(JSON.parse(stdout)).toMatchObject({
      batchId,
      passed: true,
      unmappedQualifying: 0,
      incompleteQualifying: 0,
      duplicateDeliveryIds: 0,
      failedDays: 0,
      ledgerGaps: 0,
      currentDayFinalized: false,
      activeCheckpointPresent: false,
      topicFactsVerified: true,
      exactBatchDaysVerified: true,
      ledgerDayFactMismatches: 0,
    });

    const storedPlans = JSON.parse(await readFile(plans, 'utf8')) as { batches: Array<Record<string, unknown>> };
    storedPlans.batches.push({
      id: 'zsxq-daily-accepted',
      planId: 'zsxq-chen-teacher',
      status: 'completed',
      zsxqMode: 'daily-ledger',
      failed: 0,
      needsAttention: 0,
      deliveryIds: [],
      ownerAudit: {
        mode: 'daily-ledger', pagesFetched: 1, failed: 0, failedDays: 0,
        safetyCapReached: false,
      },
      jobIds: [],
    });
    await writeFile(plans, `${JSON.stringify(storedPlans)}\n`);
    const daily = await execFileAsync(process.execPath, [
      'scripts/audit-zsxq-owner.mjs',
      '--batch', 'zsxq-daily-accepted',
      '--plans', plans,
      '--ledger', ledger,
      '--catalog', catalog,
      '--today', '2026-08-29',
    ], { cwd: process.cwd() });
    expect(JSON.parse(daily.stdout)).toMatchObject({
      batchId: 'zsxq-daily-accepted',
      passed: true,
      mode: 'daily-ledger',
      ownerPagesFetched: 1,
      historicalDaysRewritten: 0,
      historyDeliveryOverlap: 0,
      currentDayFinalized: false,
      activeCheckpointPresent: false,
    });

    const catalogEntries = JSON.parse(await readFile(catalog, 'utf8')) as Array<{ url?: string }>;
    await writeFile(catalog, `${JSON.stringify(catalogEntries.filter(entry => !entry.url?.endsWith('/102')))}\n`);
    try {
      await execFileAsync(process.execPath, [
        'scripts/audit-zsxq-owner.mjs',
        '--batch', batchId,
        '--plans', plans,
        '--ledger', ledger,
        '--catalog', catalog,
        '--today', '2026-08-29',
      ], { cwd: process.cwd() });
      throw new Error('缺失语义映射时验收脚本不应成功');
    } catch (error) {
      const failed = error as { code?: number; stdout?: string };
      expect(failed.code).toBe(2);
      expect(JSON.parse(failed.stdout ?? '{}')).toMatchObject({
        passed: false,
        topicFactsVerified: false,
        invalidTopicMappings: 1,
      });
    }
  });
});
