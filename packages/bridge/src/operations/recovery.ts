import { z } from 'zod';
import { nowcoderPublishingStatusSchema, nowcoderVerificationPauseSchema, type NowcoderPublishingStatus, verificationBlocks } from '@data-collector/shared';

export const recoveryAttemptSchema = z.coerce.number().int().min(0).max(100).default(0);
export const recoveryAdviceSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(['ready', 'waiting', 'needs_user']),
  code: z.string().min(1), message: z.string().min(1), nextCheckAt: z.iso.datetime().nullable(),
  canPrepareNewWork: z.boolean(), requiresUser: z.boolean(),
  canPublishDirectly: z.literal(false), canCompleteVerification: z.literal(false), replaysFailedRuns: z.literal(false),
  limits: nowcoderPublishingStatusSchema.optional(), verification: nowcoderVerificationPauseSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.status === 'ready'
    ? !value.canPrepareNewWork || value.requiresUser || value.nextCheckAt !== null || !value.limits || verificationBlocks(value.limits.verification, 'comment')
      || value.limits.nextAllowedAt !== null || verificationBlocks(value.verification, 'comment')
      || value.limits.usage.lastHour >= value.limits.policy.maxPerHour || value.limits.usage.last24Hours >= value.limits.policy.maxPer24Hours
    : value.canPrepareNewWork || value.nextCheckAt === null || value.requiresUser !== (value.status === 'needs_user')) {
    ctx.addIssue({ code: 'custom', message: '恢复状态与允许动作不一致' });
  }
});
export type RecoveryAdvice = z.infer<typeof recoveryAdviceSchema>;
interface Runtime { connected: boolean; supported: boolean; buildMatches: boolean; busy: boolean; updating: boolean }
const backoff = [5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

function advice(status: RecoveryAdvice['status'], code: string, message: string, nextCheckAt: string | null,
  evidence: Pick<RecoveryAdvice, 'limits' | 'verification'> = {}): RecoveryAdvice {
  return { schemaVersion: 1, status, code, message, nextCheckAt, canPrepareNewWork: status === 'ready',
    requiresUser: status === 'needs_user', canPublishDirectly: false, canCompleteVerification: false, replaysFailedRuns: false, ...evidence };
}

export function getRecoveryFailureAdvice(input: { now: number; attempt: number; code: string; message: string; requiresUser: boolean }): RecoveryAdvice {
  const attempt = recoveryAttemptSchema.parse(input.attempt);
  const delay = input.requiresUser ? backoff[2] : backoff[Math.min(attempt, 2)]!;
  return advice(input.requiresUser ? 'needs_user' : 'waiting', input.code, input.message, new Date(input.now + delay).toISOString());
}

export function getNowcoderRecoveryAdvice(input: { now: number; attempt: number; runtime: Runtime; publishing: NowcoderPublishingStatus }): RecoveryAdvice {
  const { now, runtime, publishing } = input, attempt = recoveryAttemptSchema.parse(input.attempt);
  const evidence = { limits: publishing, verification: publishing.verification };
  const waiting = (code: string, message: string) => advice('waiting', code, message,
    new Date(now + backoff[Math.min(attempt, 2)]!).toISOString(), evidence);
  const handoff = (code: string, message: string) => advice('needs_user', code, message, new Date(now + backoff[2]).toISOString(), evidence);
  if (verificationBlocks(publishing.verification, 'comment')) return handoff('VERIFICATION_REQUIRED', '保留原验证页并通知用户完成；定时任务继续只读等待，用户明确完成后按原记录核验');
  const next = publishing.nextAllowedAt === null ? null : Date.parse(publishing.nextAllowedAt);
  if ((next !== null && !Number.isFinite(next))
    || ((publishing.usage.lastHour >= publishing.policy.maxPerHour || publishing.usage.last24Hours >= publishing.policy.maxPer24Hours) && !(next !== null && next > now))) {
    return handoff('PUBLISH_STATUS_INCONSISTENT', '额度与下次允许时间不一致，保留台账并诊断；只读监测，不猜测发送窗口');
  }
  if (next !== null && next > now) return advice('waiting', 'PUBLISH_WAIT', '等待台账中的真实发布窗口，不提高限制或清空记录', new Date(next).toISOString(), evidence);
  if (runtime.updating) return waiting('BRIDGE_UPDATING', '本机服务正在更新或交接，等待原连接恢复');
  if (!runtime.connected) return waiting('EXTENSION_DISCONNECTED', '等待已配置的采集评论插件自动重连，不切换账号或浏览器');
  if (!runtime.supported) return waiting('EXTENSION_CAPABILITY_REQUIRED', '等待支持牛客操作的当前插件版本就绪');
  if (!runtime.buildMatches) return waiting('BUILD_MISMATCH', '等待扩展与本机产物构建匹配，不在此状态发送');
  if (runtime.busy) return waiting('COLLECTOR_BUSY', '采集或牛客操作仍在执行，等待其正常结束，不打断其他任务');
  return advice('ready', 'READY', '可以准备独立的新工作；旧失败批次保持停止，待核验发送仍只核验原key', null, evidence);
}
