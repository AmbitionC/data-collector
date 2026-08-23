import { describe, expect, it } from 'vitest';
import {
  collectionBatchSchema,
  planCollectEnvelopeSchema,
  planResultEnvelopeSchema,
  unionZsxqViewDocuments,
} from '@data-collector/shared';

const BATCH = {
  id: 'batch-20260823-nowcoder-agent-market',
  planId: 'nowcoder-agent-market',
  status: 'completed_with_attention',
  startedAt: '2026-08-23T01:00:00.000Z',
  finishedAt: '2026-08-23T01:03:00.000Z',
  discovered: 16,
  accepted: 10,
  saved: 8,
  skipped: 1,
  failed: 0,
  needsAttention: 1,
  deliveryIds: ['a1b2c3d4e5f6', '0123456789ab'],
  coverage: { bytedance: 3, tencent: 3, alibaba: 2, ant: 0 },
} as const;

describe('fixed collection plan contracts', () => {
  it('unions the same ZSXQ topic across views with a deterministic primitive label field', () => {
    const topic = {
      schemaVersion: 1 as const,
      source: 'zsxq' as const,
      kind: 'post' as const,
      url: 'https://wx.zsxq.com/group/48844584441158/topic/611111111111111',
      canonicalUrl: 'https://wx.zsxq.com/group/48844584441158/topic/611111111111111',
      title: '投资创业观察',
      collectedAt: '2026-08-23T00:00:00.000Z',
      html: '<p>正文</p>',
      text: '正文',
      images: [],
    };
    const merged = unionZsxqViewDocuments([
      { label: '最新', documents: [topic] },
      { label: '精华', documents: [{ ...topic, title: '更新后的投资创业观察' }] },
      { label: '只看星主', documents: [topic] },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      title: '投资创业观察',
      sourceMetadata: { viewLabels: '最新、精华、只看星主' },
    });
  });

  it('accepts an honest terminal batch with zero company coverage', () => {
    expect(collectionBatchSchema.parse(BATCH)).toEqual(BATCH);
  });

  it('rejects unknown plan ids and inconsistent terminal timestamps', () => {
    expect(collectionBatchSchema.safeParse({ ...BATCH, planId: 'custom-plan' }).success).toBe(false);
    expect(collectionBatchSchema.safeParse({ ...BATCH, status: 'running' }).success).toBe(false);
  });

  it('validates plan.collect and plan.result websocket envelopes', () => {
    const base = {
      protocolVersion: 1,
      requestId: 'request-1',
      timestamp: '2026-08-23T01:00:00.000Z',
    } as const;
    expect(planCollectEnvelopeSchema.parse({
      ...base,
      type: 'plan.collect',
      payload: { planId: 'zsxq-chen-teacher', batchId: 'batch-zsxq-1', force: true },
    }).payload.force).toBe(true);
    expect(planResultEnvelopeSchema.parse({
      ...base,
      type: 'plan.result',
      payload: { batch: BATCH },
    }).payload.batch.saved).toBe(8);
    expect(planResultEnvelopeSchema.parse({
      ...base,
      type: 'plan.result',
      payload: { batchId: 'batch-zsxq-1', discovered: 17 },
    }).payload).toMatchObject({ batchId: 'batch-zsxq-1', discovered: 17 });
    expect(planCollectEnvelopeSchema.safeParse({
      ...base,
      type: 'plan.collect',
      payload: { planId: 'arbitrary-user-plan' },
    }).success).toBe(false);
  });
});
