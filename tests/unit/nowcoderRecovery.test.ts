import { expect, it } from 'vitest';

const now = Date.parse('2026-11-03T04:00:00.000Z');
const publishing = {
  schemaVersion: 1 as const, policy: { minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 },
  usage: { lastHour: 0, last24Hours: 16 }, nextAllowedAt: null as string | null, verification: null,
};
const runtime = { connected: true, supported: true, buildMatches: true, busy: false, updating: false };
async function advisor() {
  const module = await import('../../packages/bridge/src/operations/recovery.js').catch(() => undefined);
  expect(module, 'read-only recovery advice is available without replaying an operation').toBeDefined();
  return module!;
}

it('allows fresh preparation when the real transport and publishing budget are ready', async () => {
  const { getNowcoderRecoveryAdvice } = await advisor();
  expect(getNowcoderRecoveryAdvice({ now, attempt: 0, runtime, publishing })).toMatchObject({
    status: 'ready', code: 'READY', nextCheckAt: null, canPrepareNewWork: true,
    requiresUser: false, canPublishDirectly: false, canCompleteVerification: false, replaysFailedRuns: false,
  });
});

it.each([
  [0, '2026-11-03T04:05:00.000Z'],
  [1, '2026-11-03T04:15:00.000Z'],
  [2, '2026-11-03T04:30:00.000Z'],
  [100, '2026-11-03T04:30:00.000Z'],
])('backs off a busy collector without increasing publishing limits (attempt %s)', async (attempt, nextCheckAt) => {
  const { getNowcoderRecoveryAdvice } = await advisor();
  expect(getNowcoderRecoveryAdvice({ now, attempt, runtime: { ...runtime, busy: true }, publishing })).toMatchObject({
    status: 'waiting', code: 'COLLECTOR_BUSY', nextCheckAt, canPrepareNewWork: false, requiresUser: false,
  });
});

it.each([
  [{ ...runtime, connected: false }, 'EXTENSION_DISCONNECTED'],
  [{ ...runtime, supported: false }, 'EXTENSION_CAPABILITY_REQUIRED'],
  [{ ...runtime, buildMatches: false }, 'BUILD_MISMATCH'],
  [{ ...runtime, updating: true }, 'BRIDGE_UPDATING'],
])('waits for a recoverable transport condition (%s)', async (state, code) => {
  const { getNowcoderRecoveryAdvice } = await advisor();
  expect(getNowcoderRecoveryAdvice({ now, attempt: 0, runtime: state, publishing })).toMatchObject({
    status: 'waiting', code, nextCheckAt: '2026-11-03T04:05:00.000Z', canPrepareNewWork: false,
  });
});

it('uses the real quota opening rather than a guessed periodic retry', async () => {
  const { getNowcoderRecoveryAdvice } = await advisor();
  const limits = { ...publishing, usage: { lastHour: 5, last24Hours: 20 }, nextAllowedAt: '2026-11-03T11:58:21.385Z' };
  expect(getNowcoderRecoveryAdvice({ now, attempt: 0, runtime, publishing: limits })).toMatchObject({
    status: 'waiting', code: 'PUBLISH_WAIT', nextCheckAt: '2026-11-03T11:58:21.385Z', canPrepareNewWork: false,
  });
});

it('keeps verification for a human and never turns a healthy connection into permission to clear it', async () => {
  const { getNowcoderRecoveryAdvice } = await advisor();
  const verification = {
    id: '12345678-1234-4234-8234-123456789012', detectedAt: '2026-11-03T03:59:00.000Z',
    sourceUrl: 'https://www.nowcoder.com/discuss/123456', requestId: '12345678-1234-4234-8234-123456789013',
    opportunityId: 'ops-abcdef123456', key: 'original-comment-key',
  };
  const limits = { ...publishing, verification }; const original = structuredClone(limits);
  expect(getNowcoderRecoveryAdvice({ now, attempt: 0, runtime, publishing: limits })).toMatchObject({
    status: 'needs_user', code: 'VERIFICATION_REQUIRED', requiresUser: true, canPrepareNewWork: false,
    nextCheckAt: '2026-11-03T04:30:00.000Z', verification, canCompleteVerification: false,
  });
  expect(limits).toEqual(original);
});

it('does not invent a retry time for full quotas without a valid future ledger time', async () => {
  const { getNowcoderRecoveryAdvice } = await advisor();
  const limits = { ...publishing, usage: { lastHour: 5, last24Hours: 20 } };
  expect(getNowcoderRecoveryAdvice({ now, attempt: 0, runtime, publishing: limits })).toMatchObject({
    status: 'needs_user', code: 'PUBLISH_STATUS_INCONSISTENT', canPrepareNewWork: false,
    nextCheckAt: '2026-11-03T04:30:00.000Z', requiresUser: true,
  });
});
