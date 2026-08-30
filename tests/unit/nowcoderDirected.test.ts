import { describe, expect, it } from 'vitest';
import {
  NOWCODER_DETAIL_CAPABILITY,
  normalizeNowcoderDirectedQueries,
  nowcoderDirectedBuildEvidenceSchema,
  nowcoderDirectedAttentionReasonSchema,
  nowcoderSearchRequestSchema,
  publicNowcoderDirectedRunSchema,
  storedNowcoderDirectedRunSchema,
} from '@data-collector/shared';
import {
  directedTelemetryPayloadSchema,
  jobCancelPayloadSchema,
  jobCollectPayloadSchema,
} from '../../packages/shared/src/protocol.js';

const ATTEMPT = '0123456789abcdef';
const CONTENT_HASH = '0123456789abcdef';
const SECOND_CONTENT_HASH = 'fedcba9876543210';

const BUILD_EVIDENCE = {
  applicationVersion: '0.4.33',
  bridgeBuildId: 'v0.4.33 · abcdef1',
  artifactBuildId: 'v0.4.33 · abcdef1',
  extensionVersion: '0.4.33',
  extensionBuildId: 'v0.4.33 · abcdef1',
  extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
  frozenAt: '2026-08-30T00:00:00.000Z',
};

function publicCompletedRun() {
  return {
    id: 'directed-1',
    attempt: ATTEMPT,
    status: 'completed',
    phase: 'publishing',
    scheduledCandidateIds: ['candidate-1'],
    progress: {
      discovered: 1,
      detailScheduled: 1,
      detailSaved: 1,
      inspected: 1,
      qualified: 1,
      accepted: 1,
      delivered: 1,
      rejectionCounts: [],
      companies: [
        { company: 'bytedance', count: 0 },
        { company: 'tencent', count: 0 },
        { company: 'alibaba', count: 0 },
        { company: 'ant', count: 0 },
        { company: 'other', count: 1 },
      ],
    },
    spec: {
      queries: ['Agent 面经'],
      queryHash: 'a'.repeat(64),
      target: 1,
      sort: 'latest',
      maxDetails: 24,
      searchSessionId: 'session-1',
      idempotencyKey: 'start-key-1',
      deliveryMode: 'agent-journey-inbox',
    },
    accepted: 1,
    delivered: 1,
    deliveryIds: ['content-1'],
    publicDeliveryItems: [{
      stableContentId: 'content-1',
      canonicalUrl: 'https://www.nowcoder.com/discuss/1',
      contentHash: CONTENT_HASH,
      clusterId: 'cluster-1',
      lineageId: 'c'.repeat(64),
    }],
    publishReceipt: {
      deliveryIds: ['content-1'],
      entryHashes: [CONTENT_HASH],
      markerHash: 'd'.repeat(64),
      publishedAt: '2026-08-30T00:00:00.000Z',
    },
    activeOwnedTabs: 0,
    peakOwnedTabs: 2,
    terminalOwnedTabs: 0,
    buildEvidence: BUILD_EVIDENCE,
  };
}

describe('Nowcoder directed shared contracts', () => {
  it('enforces the exact safe message for every Task 5 attention code', () => {
    expect(() => nowcoderDirectedAttentionReasonSchema.parse({
      code: 'DIRECTED_HISTORY_CORRUPT',
      message: 'raw private history error',
      at: '2026-08-30T00:00:00.000Z',
      phase: 'selecting',
    })).toThrow();
    expect(nowcoderDirectedAttentionReasonSchema.parse({
      code: 'DIRECTED_HISTORY_CORRUPT',
      message: '历史记录无法安全读取',
      at: '2026-08-30T00:00:00.000Z',
      phase: 'selecting',
    }).message).toBe('历史记录无法安全读取');
  });

  it('validates the exact public Task 5 progress surface and redacts private identifiers', () => {
    const running = {
      ...publicCompletedRun(),
      status: 'running',
      phase: 'collecting',
      accepted: 0,
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
      publishReceipt: undefined,
      scheduledCandidateIds: ['candidate-1'],
      progress: {
        discovered: 2,
        detailScheduled: 1,
        detailSaved: 0,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [{
          code: 'DETAIL_NOT_SAVED',
          message: '详情尚未形成可验证快照',
          count: 1,
        }],
        companies: [
          { company: 'bytedance', count: 0 },
          { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 },
          { company: 'ant', count: 0 },
          { company: 'other', count: 0 },
        ],
      },
    };
    const parsed = publicNowcoderDirectedRunSchema.parse(running);
    expect(parsed.scheduledCandidateIds).toEqual(['candidate-1']);
    expect(JSON.stringify(parsed)).not.toMatch(/job-|\/Users\/|localEvidence|currentJobId/u);
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...running,
      progress: {
        ...running.progress,
        companies: [...running.progress.companies].reverse(),
      },
    })).toThrow();
  });

  it('requires a total rejection audit in every running and cancelling phase once details are scheduled', () => {
    const cancelling = {
      ...publicCompletedRun(),
      status: 'cancelling',
      phase: 'selecting',
      accepted: 0,
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
      publishReceipt: undefined,
      progress: {
        ...publicCompletedRun().progress,
        inspected: 1,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [{
          code: 'AGENT_RELEVANCE_INSUFFICIENT',
          message: '内容与 Agent 研发岗位关联不足',
          count: 1,
        }],
        companies: publicCompletedRun().progress.companies.map(item => ({ ...item, count: 0 })),
      },
    };
    for (const status of ['running', 'cancelling'] as const) {
      for (const phase of ['collecting', 'selecting'] as const) {
        const audited = { ...cancelling, status, phase };
        expect(publicNowcoderDirectedRunSchema.parse(audited)).toMatchObject({ status, phase });
        expect(() => publicNowcoderDirectedRunSchema.parse({
          ...audited,
          progress: { ...audited.progress, rejectionCounts: [] },
        })).toThrow('筛选审计必须精确覆盖未接受的已调度详情');
      }
    }

    const failed = { ...cancelling, status: 'failed' as const, phase: 'selecting' as const };
    expect(publicNowcoderDirectedRunSchema.parse(failed).status).toBe('failed');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...failed,
      progress: { ...failed.progress, rejectionCounts: [] },
    })).toThrow('筛选审计必须精确覆盖未接受的已调度详情');

    const cancelled = {
      ...cancelling,
      status: 'cancelled',
      phase: 'collecting',
      progress: {
        ...cancelling.progress,
        rejectionCounts: [],
      },
    };
    expect(publicNowcoderDirectedRunSchema.parse(cancelled)).toMatchObject({
      status: 'cancelled',
      progress: { detailSaved: 1, inspected: 1 },
    });
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...cancelled,
      progress: {
        ...cancelled.progress,
        rejectionCounts: cancelling.progress.rejectionCounts,
      },
    })).toThrow('已取消运行必须清空筛选审计');
  });

  it('requires running/cancelling staging and publishing to expose an exact target selection', () => {
    for (const status of ['running', 'cancelling'] as const) {
      const exact = {
        ...publicCompletedRun(),
        status,
        phase: 'staging',
        delivered: 0,
        deliveryIds: [],
        publicDeliveryItems: [],
        publishReceipt: undefined,
        progress: { ...publicCompletedRun().progress, delivered: 0 },
      };
      expect(publicNowcoderDirectedRunSchema.parse(exact)).toMatchObject({ status, phase: 'staging' });
      expect(() => publicNowcoderDirectedRunSchema.parse({
        ...exact,
        accepted: 0,
        progress: {
          ...exact.progress,
          qualified: 0,
          accepted: 0,
          rejectionCounts: [{
            code: 'AGENT_RELEVANCE_INSUFFICIENT',
            message: '内容与 Agent 研发岗位关联不足',
            count: 1,
          }],
          companies: exact.progress.companies.map(item => ({ ...item, count: 0 })),
        },
      })).toThrow('staging/publishing 必须精确筛得 target 条');
    }

    const publishingShortfall = {
      ...publicCompletedRun(),
      status: 'publishing',
      phase: 'publishing',
      accepted: 0,
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
      publishReceipt: undefined,
      progress: {
        ...publicCompletedRun().progress,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [{
          code: 'AGENT_RELEVANCE_INSUFFICIENT',
          message: '内容与 Agent 研发岗位关联不足',
          count: 1,
        }],
        companies: publicCompletedRun().progress.companies.map(item => ({ ...item, count: 0 })),
      },
    };
    expect(() => publicNowcoderDirectedRunSchema.parse(publishingShortfall))
      .toThrow('staging/publishing 必须精确筛得 target 条');
  });

  it('enforces the public status/phase matrix and forbids cancelled marker evidence', () => {
    const publishingBase = {
      ...publicCompletedRun(),
      status: 'publishing',
      phase: 'publishing',
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
      publishReceipt: undefined,
      progress: { ...publicCompletedRun().progress, delivered: 0 },
    };
    expect(publicNowcoderDirectedRunSchema.parse(publishingBase).status).toBe('publishing');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publishingBase,
      phase: 'staging',
    })).toThrow('运行状态与阶段不匹配');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicCompletedRun(),
      phase: 'staging',
    })).toThrow('运行状态与阶段不匹配');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publishingBase,
      status: 'failed',
    })).toThrow('运行状态与阶段不匹配');

    const attention = {
      ...publishingBase,
      status: 'completed_with_attention',
      accepted: 0,
      progress: {
        ...publishingBase.progress,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        rejectionCounts: [],
        companies: publishingBase.progress.companies.map(item => ({ ...item, count: 0 })),
      },
      attentionReason: {
        code: 'DIRECTED_HISTORY_CORRUPT',
        message: '历史记录无法安全读取',
        at: '2026-08-30T00:01:00.000Z',
        phase: 'publishing',
      },
    };
    expect(publicNowcoderDirectedRunSchema.parse(attention).status).toBe('completed_with_attention');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...attention,
      phase: 'staging',
    })).toThrow('运行状态与阶段不匹配');

    const cancelledWithMarker = {
      ...publicCompletedRun(),
      status: 'cancelled',
      accepted: 0,
      delivered: 1,
      verifiedMarkerHash: 'e'.repeat(64),
      progress: {
        ...publicCompletedRun().progress,
        qualified: 0,
        accepted: 0,
        delivered: 1,
        rejectionCounts: [],
        companies: publicCompletedRun().progress.companies.map(item => ({ ...item, count: 0 })),
      },
    };
    expect(() => publicNowcoderDirectedRunSchema.parse(cancelledWithMarker))
      .toThrow('已取消运行不能保留交付证据');
  });

  it('requires a pre-marker systemic attention to clear every selection and delivery counter', () => {
    const staleAttention = {
      ...publicCompletedRun(),
      status: 'completed_with_attention',
      phase: 'staging',
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
      publishReceipt: undefined,
      progress: {
        ...publicCompletedRun().progress,
        delivered: 0,
      },
      attentionReason: {
        code: 'DIRECTED_ARTIFACT_CHANGED',
        message: '扩展产物已变化',
        at: '2026-08-30T00:01:00.000Z',
        phase: 'staging',
      },
    };

    expect(() => publicNowcoderDirectedRunSchema.parse(staleAttention))
      .toThrow('系统需处理运行必须清空筛选与交付状态');
  });

  it('allows marker evidence only in publishing, completed, or publishing-phase attention recovery', () => {
    for (const status of ['running', 'cancelling', 'failed'] as const) {
      expect(() => publicNowcoderDirectedRunSchema.parse({
        ...publicCompletedRun(),
        status,
        phase: 'selecting',
        verifiedMarkerHash: 'd'.repeat(64),
      })).toThrow('发布证据与运行状态不匹配');
    }

    expect(publicNowcoderDirectedRunSchema.parse({
      ...publicCompletedRun(),
      status: 'publishing',
      phase: 'publishing',
      verifiedMarkerHash: 'd'.repeat(64),
    }).status).toBe('publishing');
    expect(publicNowcoderDirectedRunSchema.parse({
      ...publicCompletedRun(),
      status: 'completed_with_attention',
      phase: 'publishing',
      verifiedMarkerHash: 'd'.repeat(64),
      attentionReason: {
        code: 'DIRECTED_ARTIFACT_CHANGED',
        message: '扩展产物已变化',
        at: '2026-08-30T00:01:00.000Z',
        phase: 'publishing',
      },
    }).status).toBe('completed_with_attention');
  });

  it('requires marker-verified attention to retain a total selection audit', () => {
    const markerAttention = {
      ...publicCompletedRun(),
      status: 'completed_with_attention',
      phase: 'publishing',
      scheduledCandidateIds: ['candidate-1', 'candidate-2'],
      verifiedMarkerHash: 'd'.repeat(64),
      progress: {
        ...publicCompletedRun().progress,
        discovered: 2,
        detailScheduled: 2,
        rejectionCounts: [{
          code: 'DETAIL_NOT_SAVED',
          message: '详情尚未形成可验证快照',
          count: 1,
        }],
      },
      attentionReason: {
        code: 'DIRECTED_ARTIFACT_CHANGED',
        message: '扩展产物已变化',
        at: '2026-08-30T00:01:00.000Z',
        phase: 'publishing',
      },
    };
    expect(publicNowcoderDirectedRunSchema.parse(markerAttention).status)
      .toBe('completed_with_attention');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...markerAttention,
      progress: { ...markerAttention.progress, rejectionCounts: [] },
    })).toThrow('筛选审计必须精确覆盖未接受的已调度详情');
  });

  it.each(['publishing', 'completed_with_attention'] as const)(
    'cross-checks %s private/public/receipt/recovery delivery evidence and marker hashes',
    status => {
      const markerHash = 'd'.repeat(64);
      const run = {
        ...publicCompletedRun(),
        status,
        phase: 'publishing',
        verifiedMarkerHash: markerHash,
        ...(status === 'completed_with_attention' ? {
          attentionReason: {
            code: 'DIRECTED_ARTIFACT_CHANGED',
            message: '扩展产物已变化',
            at: '2026-08-30T00:01:00.000Z',
            phase: 'publishing',
          },
        } : {}),
        currentJobIds: ['job-1'],
        deliveryItems: [{
          jobId: 'job-1',
          stableContentId: 'content-1',
          canonicalUrl: 'https://www.nowcoder.com/discuss/1',
          contentHash: CONTENT_HASH,
          clusterId: 'cluster-1',
        }],
        idempotencyLineage: ['start-key-1'],
        recovery: {
          verifiedMarkerHash: markerHash,
          markerDeliveryIds: ['content-1'],
          markerEntryHashes: [CONTENT_HASH],
        },
        observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
      };
      expect(storedNowcoderDirectedRunSchema.parse(run).status).toBe(status);
      expect(() => storedNowcoderDirectedRunSchema.parse({
        ...run,
        deliveryItems: [{ ...run.deliveryItems[0], stableContentId: 'private-content-2' }],
      })).toThrow('私有与公开交付身份必须精确一致');
      expect(() => storedNowcoderDirectedRunSchema.parse({
        ...run,
        verifiedMarkerHash: 'e'.repeat(64),
      })).toThrow('marker hash 必须精确一致');
      expect(() => storedNowcoderDirectedRunSchema.parse({
        ...run,
        recovery: { ...run.recovery, markerDeliveryIds: ['other-content'] },
      })).toThrow('发布恢复证据必须精确匹配私有交付项');
    },
  );

  it('keeps target-unavailable attention below target and strictly pre-publication', () => {
    const targetUnavailable = {
      ...publicCompletedRun(),
      status: 'completed_with_attention',
      phase: 'selecting',
      accepted: 0,
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
      publishReceipt: undefined,
      progress: {
        ...publicCompletedRun().progress,
        // All inspected details may qualify before cluster/question dedupe still leaves
        // accepted below target; TARGET_UNAVAILABLE must remain legal in that case.
        qualified: 1,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [{
          code: 'AGENT_RELEVANCE_INSUFFICIENT',
          message: '内容与 Agent 研发岗位关联不足',
          count: 1,
        }],
        companies: publicCompletedRun().progress.companies.map(item => ({ ...item, count: 0 })),
      },
      attentionReason: {
        code: 'DIRECTED_TARGET_UNAVAILABLE',
        message: '在最多 24 篇详情中未筛得足量有效面经',
        at: '2026-08-30T00:01:00.000Z',
        phase: 'selecting',
      },
    };
    expect(publicNowcoderDirectedRunSchema.parse(targetUnavailable).status)
      .toBe('completed_with_attention');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...targetUnavailable,
      phase: 'publishing',
      accepted: 1,
      delivered: 1,
      deliveryIds: publicCompletedRun().deliveryIds,
      publicDeliveryItems: publicCompletedRun().publicDeliveryItems,
      publishReceipt: publicCompletedRun().publishReceipt,
      verifiedMarkerHash: 'd'.repeat(64),
      progress: publicCompletedRun().progress,
      attentionReason: { ...targetUnavailable.attentionReason, phase: 'publishing' },
    })).toThrow('目标不足终态必须保持在发布前');
  });

  it('normalizes queries and rejects invalid directed-search input limits', () => {
    expect(normalizeNowcoderDirectedQueries([' 字节  Agent　面经 ', '字节 Agent 面经']))
      .toEqual(['字节 Agent 面经']);
    expect(nowcoderSearchRequestSchema.parse({
      queries: [' 字节  Agent　面经 ', '字节 Agent 面经'], target: 10, sort: 'latest',
    }).queries).toEqual(['字节 Agent 面经']);
    expect(() => nowcoderSearchRequestSchema.parse({
      queries: ['Agent\u0000面经'], target: 10, sort: 'latest',
    })).toThrow();
    expect(() => nowcoderSearchRequestSchema.parse({
      queries: Array.from({ length: 13 }, (_, i) => `Agent ${i}`), target: 10, sort: 'latest',
    })).toThrow();
    expect(() => nowcoderSearchRequestSchema.parse({
      queries: ['Agent 面经'], target: 11, sort: 'latest',
    })).toThrow();
  });

  it('accepts stored document content hashes while retaining 64-character identity digests', () => {
    const documentContentHash = CONTENT_HASH;
    const publicRun = {
      ...publicCompletedRun(),
      publicDeliveryItems: [{
        ...publicCompletedRun().publicDeliveryItems[0],
        contentHash: documentContentHash,
      }],
      publishReceipt: {
        ...publicCompletedRun().publishReceipt,
        entryHashes: [documentContentHash],
      },
    };
    const storedRun = {
      ...publicRun,
      currentJobIds: ['job-1'],
      deliveryItems: [{
        jobId: 'job-1',
        stableContentId: 'content-1',
        canonicalUrl: 'https://www.nowcoder.com/discuss/1',
        contentHash: documentContentHash,
        clusterId: 'cluster-1',
      }],
      idempotencyLineage: ['start-key-1'],
      observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
    };

    expect(storedNowcoderDirectedRunSchema.parse(storedRun).deliveryItems[0]?.contentHash)
      .toBe(documentContentHash);
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicRun,
      spec: { ...publicRun.spec, queryHash: documentContentHash },
    })).toThrow();
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicRun,
      publicDeliveryItems: [{ ...publicRun.publicDeliveryItems[0], lineageId: documentContentHash }],
    })).toThrow();
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicRun,
      publishReceipt: { ...publicRun.publishReceipt, markerHash: documentContentHash },
    })).toThrow();
  });

  it('keeps private job lineage separate from public delivery data', () => {
    const publicRun = publicCompletedRun();
    expect(publicNowcoderDirectedRunSchema.parse(publicRun)).toEqual(publicRun);
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicRun,
      publicDeliveryItems: [{ ...publicRun.publicDeliveryItems[0], jobId: 'job-1' }],
    })).toThrow();

    expect(storedNowcoderDirectedRunSchema.parse({
      ...publicRun,
      currentJobIds: ['job-1'],
      deliveryItems: [{
        jobId: 'job-1',
        stableContentId: 'content-1',
        canonicalUrl: 'https://www.nowcoder.com/discuss/1',
        contentHash: CONTENT_HASH,
        clusterId: 'cluster-1',
      }],
      idempotencyLineage: ['start-key-1'],
      observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
    })).toMatchObject({ currentJobIds: ['job-1'] });
  });

  it('requires exact completed delivery and run ownership invariants', () => {
    const publicRun = publicCompletedRun();
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicRun,
      delivered: 0,
    })).toThrow();
    expect(() => storedNowcoderDirectedRunSchema.parse({
      ...publicRun,
      currentJobIds: ['job-1'],
      deliveryItems: [{
        jobId: 'job-2',
        stableContentId: 'content-1',
        canonicalUrl: 'https://www.nowcoder.com/discuss/1',
        contentHash: CONTENT_HASH,
        clusterId: 'cluster-1',
      }],
      idempotencyLineage: ['start-key-1'],
      observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
    })).toThrow();
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicRun,
      deliveryIds: ['not-the-public-content-id'],
    })).toThrow();
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...publicRun,
      publicDeliveryItems: [{
        ...publicRun.publicDeliveryItems[0],
        lineageId: 'f'.repeat(64),
      }, {
        ...publicRun.publicDeliveryItems[0],
        stableContentId: 'content-2',
        canonicalUrl: 'https://www.nowcoder.com/discuss/2',
        clusterId: 'cluster-2',
        contentHash: SECOND_CONTENT_HASH,
        lineageId: 'f'.repeat(64),
      }],
      deliveryIds: ['content-1', 'content-2'],
      accepted: 2,
      delivered: 2,
      spec: { ...publicRun.spec, target: 2 },
      publishReceipt: {
        ...publicRun.publishReceipt,
        deliveryIds: ['content-1', 'content-2'],
        entryHashes: [CONTENT_HASH, SECOND_CONTENT_HASH],
      },
    })).toThrow();
    expect(() => storedNowcoderDirectedRunSchema.parse({
      ...publicRun,
      currentJobIds: ['job-1'],
      deliveryItems: [{
        jobId: 'job-1',
        stableContentId: 'different-private-content',
        canonicalUrl: 'https://www.nowcoder.com/discuss/1',
        contentHash: CONTENT_HASH,
        clusterId: 'cluster-1',
      }],
      idempotencyLineage: ['start-key-1'],
      observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
    })).toThrow();
  });

  it('uses paired directed ownership for jobs, cancellation, and telemetry', () => {
    expect(jobCollectPayloadSchema.parse({
      url: 'https://www.nowcoder.com/discuss/1',
      interactive: false,
      directedRunId: 'directed-1',
      directedRunAttempt: ATTEMPT,
    })).toMatchObject({ directedRunId: 'directed-1', directedRunAttempt: ATTEMPT });
    expect(() => jobCollectPayloadSchema.parse({
      url: 'https://www.nowcoder.com/discuss/1', directedRunId: 'directed-1',
    })).toThrow();
    expect(jobCancelPayloadSchema.parse({
      directedRunId: 'directed-1', directedRunAttempt: ATTEMPT,
    })).toEqual({ directedRunId: 'directed-1', directedRunAttempt: ATTEMPT });
    expect(() => jobCancelPayloadSchema.parse({
      jobId: 'must-live-in-envelope-request-id',
      directedRunId: 'directed-1',
      directedRunAttempt: ATTEMPT,
    })).toThrow();
    expect(() => jobCancelPayloadSchema.parse({
      directedRunId: 'directed-1',
    })).toThrow();
    expect(() => directedTelemetryPayloadSchema.parse({
      directedRunId: 'directed-1', directedRunAttempt: ATTEMPT,
      activeOwnedTabs: 1, peakOwnedTabs: 3,
    })).toThrow();
    expect(NOWCODER_DETAIL_CAPABILITY).toBe('nowcoder-detail-v1');
  });

  it('requires normalized typed build evidence and structured attention without private runtime IDs', () => {
    expect(nowcoderDirectedBuildEvidenceSchema.parse(BUILD_EVIDENCE)).toEqual(BUILD_EVIDENCE);
    expect(() => nowcoderDirectedBuildEvidenceSchema.parse({
      ...BUILD_EVIDENCE,
      extensionCapabilities: ['zsxq-complete-content-v2', 'nowcoder-detail-v1'],
    })).toThrow();
    expect(() => nowcoderDirectedBuildEvidenceSchema.parse({
      ...BUILD_EVIDENCE,
      extensionCapabilities: ['nowcoder-detail-v1', 'nowcoder-detail-v1'],
    })).toThrow();

    const attention = {
      ...publicCompletedRun(),
      status: 'completed_with_attention',
      phase: 'collecting',
      accepted: 0,
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
      publishReceipt: undefined,
      progress: {
        ...publicCompletedRun().progress,
        detailSaved: 0,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        companies: publicCompletedRun().progress.companies.map(item => ({ ...item, count: 0 })),
      },
      attentionReason: {
        code: 'DIRECTED_EXTENSION_BUILD_CHANGED',
        message: '扩展构建已变化',
        at: '2026-08-30T00:01:00.000Z',
        phase: 'collecting',
      },
    };
    expect(publicNowcoderDirectedRunSchema.parse(attention)).not.toHaveProperty('observedRuntimeIds');
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...attention,
      attentionReason: undefined,
    })).toThrow();
    expect(storedNowcoderDirectedRunSchema.parse({
      ...attention,
      currentJobIds: [],
      deliveryItems: [],
      idempotencyLineage: ['start-key-1'],
      observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
    }).observedRuntimeIds).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(() => publicNowcoderDirectedRunSchema.parse({
      ...attention,
      observedRuntimeIds: ['11111111-1111-4111-8111-111111111111'],
    })).toThrow();
  });
});
