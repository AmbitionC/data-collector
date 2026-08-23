import { describe, expect, it } from 'vitest';
import {
  collectionBatchSchema,
  planCollectEnvelopeSchema,
  planResultEnvelopeSchema,
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
  coverage: { bytedance: 3, tencent: 3, alibaba: 2, ant: 0 },
} as const;

describe('fixed collection plan contracts', () => {
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
      payload: { planId: 'zsxq-chen-teacher', force: true },
    }).payload.force).toBe(true);
    expect(planResultEnvelopeSchema.parse({
      ...base,
      type: 'plan.result',
      payload: { batch: BATCH },
    }).payload.batch.saved).toBe(8);
    expect(planCollectEnvelopeSchema.safeParse({
      ...base,
      type: 'plan.collect',
      payload: { planId: 'arbitrary-user-plan' },
    }).success).toBe(false);
  });
});
