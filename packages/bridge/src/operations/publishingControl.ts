import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_NOWCODER_PUBLISHING_POLICY, nowcoderPublishingPolicySchema, nowcoderVerificationPauseSchema,
  operationIdSchema, operationSourceUrlSchema, operationPublicationSchema,
  type NowcoderPublishingPolicy, type NowcoderPublishingStatus, type NowcoderVerificationPause,
} from '@data-collector/shared';
import { atomicWriteText } from '../library/writer.js';
import { HttpError } from '../server/http.js';

const historyEntry = z.object({ opportunityId: operationIdSchema, sourceUrl: operationSourceUrlSchema, publication: operationPublicationSchema });
export type PublishingHistoryEntry = z.infer<typeof historyEntry>;
const stateSchema = z.object({
  schemaVersion: z.literal(1), policy: nowcoderPublishingPolicySchema,
  verification: nowcoderVerificationPauseSchema.nullable(),
  clearedRequestIds: z.array(z.string().uuid()).max(40_000),
  knownRequestIds: z.array(z.string().uuid()).max(40_000).default([]),
}).strict();
type State = z.infer<typeof stateSchema>;
const HOUR = 3_600_000, DAY = 24 * HOUR;

export class NowcoderPublishingControl {
  private pending: Promise<unknown> = Promise.resolve();
  private seenFile = false;
  private memoryPause: NowcoderVerificationPause | undefined;
  get verificationPending(): boolean { return this.memoryPause !== undefined; }
  readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly path: string, private readonly history: () => Promise<PublishingHistoryEntry[]>,
    options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work); this.pending = result.catch(() => undefined); return result;
  }
  private async write(state: State): Promise<void> {
    const checked = stateSchema.parse(state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await atomicWriteText(dirname(this.path), this.path, `${JSON.stringify(checked, null, 2)}\n`);
    this.seenFile = true;
  }
  private async read(): Promise<{ state: State; events: PublishingHistoryEntry[] }> {
    let events: PublishingHistoryEntry[];
    try { events = z.array(historyEntry).parse(await this.history()); }
    catch { throw new HttpError(409, 'PUBLISH_HISTORY_UNAVAILABLE', '发布历史记录不可用，请核对本机运营记录；已停止发布'); }
    let state: State, fresh = false;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.size > 5_000_000) throw new Error('invalid state file');
      state = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); this.seenFile = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.seenFile) {
        throw new HttpError(409, 'PUBLISH_CONTROL_CORRUPT', '发布保护记录损坏或丢失，请保留文件后核对；已停止发布');
      }
      state = { schemaVersion: 1, policy: { ...DEFAULT_NOWCODER_PUBLISHING_POLICY }, verification: null, clearedRequestIds: [], knownRequestIds: [] }; fresh = true;
    }
    const observed = new Set(events.map(event => event.publication.requestId));
    if (state.knownRequestIds.some(id => !observed.has(id))) throw new HttpError(409, 'PUBLISH_HISTORY_UNAVAILABLE', '已记录的发布历史缺失，请保留本机记录后核对；已停止发布');
    if (observed.size !== state.knownRequestIds.length) { state.knownRequestIds = [...observed]; fresh = true; }
    if (this.memoryPause) state.verification = this.memoryPause;
    if (!state.verification) {
      const unresolved = events.filter(e => ['uncertain', 'dispatching', 'rejected'].includes(e.publication.state)
        && !state.clearedRequestIds.includes(e.publication.requestId)
        && (e.publication.attentionCode === 'VERIFICATION_REQUIRED' || /^牛客要求验证/u.test(e.publication.message ?? '')))
        .sort((a, b) => b.publication.updatedAt.localeCompare(a.publication.updatedAt))[0];
      if (unresolved) {
        state.verification = { id: randomUUID(), detectedAt: unresolved.publication.updatedAt, sourceUrl: unresolved.sourceUrl,
          opportunityId: unresolved.opportunityId, key: unresolved.publication.key, requestId: unresolved.publication.requestId };
        this.memoryPause = state.verification; fresh = true;
      }
    }
    this.memoryPause = state.verification ?? undefined;
    if (fresh) await this.write(state);
    return { state, events };
  }
  private availableAt(state: State, events: PublishingHistoryEntry[], count = 1): number {
    const now = this.now(), times = events.map(e => Date.parse(e.publication.createdAt)).sort((a, b) => a - b);
    const hour = times.filter(t => t > now - HOUR), day = times.filter(t => t > now - DAY);
    return Math.max(now, times.length ? times[times.length - 1]! + state.policy.minIntervalMs : now,
      hour.length + count > state.policy.maxPerHour ? hour[hour.length + count - state.policy.maxPerHour - 1]! + HOUR : now,
      day.length + count > state.policy.maxPer24Hours ? day[day.length + count - state.policy.maxPer24Hours - 1]! + DAY : now);
  }
  private summarize(state: State, events: PublishingHistoryEntry[]): NowcoderPublishingStatus {
    const now = this.now(), times = events.map(e => Date.parse(e.publication.createdAt)), earliest = this.availableAt(state, events);
    return { schemaVersion: 1, policy: state.policy, usage: { lastHour: times.filter(t => t > now - HOUR).length, last24Hours: times.filter(t => t > now - DAY).length },
      nextAllowedAt: earliest > now ? new Date(earliest).toISOString() : null, verification: state.verification };
  }
  async status(): Promise<NowcoderPublishingStatus> {
    return this.serialize(async () => { const { state, events } = await this.read(); return this.summarize(state, events); });
  }
  async assertCapacity(count = 1, ignoreInterval = false): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('发布数量无效');
    await this.serialize(async () => {
      const { state, events } = await this.read(), status = this.summarize(state, events);
      if (status.verification) throw new HttpError(409, 'PUBLISH_VERIFICATION_PAUSED', '牛客验证尚待处理，已全局暂停发布；完成原页验证后显式核验恢复');
      if (count > status.policy.maxPerHour || count > status.policy.maxPer24Hours) throw new HttpError(429, 'PUBLISH_BUDGET_EXHAUSTED', '整批数量超过本机累计上限，请缩小清单并重新审阅；未发送');
      if (status.usage.lastHour + count > status.policy.maxPerHour || status.usage.last24Hours + count > status.policy.maxPer24Hours) {
        throw new HttpError(429, 'PUBLISH_BUDGET_EXHAUSTED', `本机累计上限内整批可用额度不足，按当前记录最早 ${new Date(this.availableAt(state, events, count)).toISOString()} 可容纳本清单；保留未执行条目，届时重新读取语境并审阅`);
      }
      if (!ignoreInterval && status.nextAllowedAt) throw new HttpError(429, 'PUBLISH_INTERVAL_REQUIRED', `发布间隔未到，请在 ${status.nextAllowedAt} 后重试原清单；未发送`);
    });
  }
  async waitForSlot(latestContextAt: string): Promise<void> {
    for (;;) {
      await this.assertCapacity(1, true);
      const status = await this.status(), delay = status.nextAllowedAt ? Date.parse(status.nextAllowedAt) - this.now() : 0;
      if (delay <= 0) return;
      if (this.now() + delay >= Date.parse(latestContextAt) + 30 * 60_000) {
        throw new HttpError(409, 'PUBLISH_CONTEXT_WOULD_EXPIRE', '发布间隔超过当前语境有效期，请稍后重新读取并审阅；未发送');
      }
      await this.sleep(Math.min(delay, 1000));
    }
  }
  async configure(raw: unknown): Promise<NowcoderPublishingStatus> {
    const policy: NowcoderPublishingPolicy = nowcoderPublishingPolicySchema.parse(raw);
    return this.serialize(async () => { const { state, events } = await this.read(); state.policy = policy; await this.write(state); return this.summarize(state, events); });
  }
  async pause(input: Omit<NowcoderVerificationPause, 'id' | 'detectedAt'>): Promise<NowcoderVerificationPause> {
    return this.serialize(async () => {
      const { state } = await this.read();
      if (state.verification?.requestId === input.requestId) return state.verification;
      const verification = nowcoderVerificationPauseSchema.parse({ ...input, id: randomUUID(), detectedAt: new Date(this.now()).toISOString() });
      this.memoryPause = verification; state.verification = verification; await this.write(state); return verification;
    });
  }
  async clearVerification(id: string): Promise<void> {
    await this.serialize(async () => {
      const { state, events } = await this.read();
      if (state.verification?.id !== id) throw new HttpError(409, 'PUBLISH_VERIFICATION_CHANGED', '待处理验证已变化，请重读发布状态；未恢复');
      const pause = state.verification;
      const linkedRequests = pause.opportunityId && pause.key ? events.filter(e => e.opportunityId === pause.opportunityId && e.publication.key === pause.key).map(e => e.publication.requestId) : [];
      state.clearedRequestIds = [...new Set([...state.clearedRequestIds, pause.requestId, ...linkedRequests])];
      state.verification = null; await this.write(state); this.memoryPause = undefined;
    });
  }
}
