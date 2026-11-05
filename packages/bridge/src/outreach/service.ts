import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  APP_VERSION, DEFAULT_OUTREACH_POLICY, OUTREACH_READY_CHANNELS, OUTREACH_BARRIER_CODES, outreachChannelSchema, outreachIdSchema, outreachPolicySchema,
  outreachPostSchema, outreachReceiptSchema, outreachTiming, recheckOutreachPost,
  type OutreachAction, type OutreachChannel, type OutreachPolicy, type OutreachPost, type OutreachReceipt, type OutreachResult,
} from '@data-collector/shared';
import type { GitRunResult } from '../git.js';
import { atomicWriteText } from '../library/writer.js';

/**
 * Invest Journey 引流发布（invest-model outreach/outbox → 浏览器 → outreach/receipts）。
 *
 * 规则（和牛客发布保护同一个思路）：
 * - 先把 dispatching 落盘再发；发完只认观察到的回执。超时、断线、看不到内容 → uncertain，
 *   **整体暂停**、等用户核验，绝不自动重发；
 * - 登录失效 / 验证码 / 限制 → 整体暂停，原稿保留，等用户处理后 resume；
 * - 过期稿件（晚于 notAfter）写 expired 回执、不发；复核不过写 refused 回执、不发；
 * - 每次 tick 最多发一篇；两次发布间隔与每渠道 24 小时篇数有上限。
 */

const attemptSchema = z.object({
  id: outreachIdSchema,
  channel: outreachChannelSchema,
  requestId: z.string().regex(/^outreach-[a-f0-9]{16}$/u),
  state: z.enum(['dispatching', 'published', 'uncertain', 'rejected']),
  at: z.iso.datetime(),
  url: z.string().url().max(2000).nullable().optional(),
  code: z.string().max(100).optional(),
  message: z.string().max(1000).optional(),
}).strict();
type Attempt = z.infer<typeof attemptSchema>;
const pauseSchema = z.object({
  code: z.string().max(100), message: z.string().max(1000), at: z.iso.datetime(),
  postId: outreachIdSchema.optional(), tabUrl: z.string().url().max(4096).optional(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  policy: outreachPolicySchema,
  pause: pauseSchema.nullable(),
  attempts: z.array(attemptSchema).max(5000),
  lastTick: z.object({ at: z.iso.datetime(), outcome: z.string().max(100), detail: z.string().max(1000) }).nullable(),
}).strict();
export type OutreachState = z.infer<typeof stateSchema>;

export interface OutreachDeps {
  configDir: string;
  /** invest-model 本机工作区；不存在则整个功能不启用。 */
  repoPath: string;
  git: (repoPath: string, args: string[]) => Promise<GitRunResult>;
  execute: (action: OutreachAction, requestId: string) => Promise<OutreachResult>;
  available: () => boolean;
  now?: () => number;
  /** 测试注入；缺省用随版本发布的 OUTREACH_READY_CHANNELS。 */
  readyChannels?: readonly OutreachChannel[];
}

export interface OutreachTick {
  outcome: 'disabled' | 'paused' | 'waiting' | 'idle' | 'published' | 'attention';
  detail: string;
  postId?: string;
}

interface Candidate { post: OutreachPost; location: 'outbox' | 'blocked'; dir: string }

const MAX_REJECTED = 3;
const DAY = 86_400_000;

export class InvestOutreachService {
  private running = false;
  private readonly now: () => number;
  private readonly statePath: string;
  constructor(private readonly deps: OutreachDeps) {
    this.now = deps.now ?? Date.now;
    this.statePath = join(deps.configDir, 'invest-outreach.json');
  }
  get busy(): boolean { return this.running; }

  private iso(): string { return new Date(this.now()).toISOString(); }

  async state(): Promise<OutreachState> {
    try {
      const info = await lstat(this.statePath);
      if (!info.isFile() || info.size > 5_000_000) throw new Error('invalid');
      return stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, policy: DEFAULT_OUTREACH_POLICY, pause: null, attempts: [], lastTick: null };
      }
      // 台账损坏时不猜：当作暂停，等人核对，绝不在丢了历史的情况下继续发。
      throw new Error('引流发布台账损坏，已停止发布，请保留 invest-outreach.json 后核对');
    }
  }

  private async save(state: OutreachState): Promise<void> {
    await atomicWriteText(this.deps.configDir, this.statePath, `${JSON.stringify(stateSchema.parse(state), null, 1)}\n`);
  }

  async enabled(): Promise<boolean> {
    try { return (await lstat(join(this.deps.repoPath, 'outreach'))).isDirectory(); } catch { return false; }
  }

  async configure(raw: unknown): Promise<OutreachPolicy> {
    const policy = outreachPolicySchema.parse(raw), state = await this.state();
    await this.save({ ...state, policy });
    return policy;
  }

  /** 用户处理完登录 / 验证 / 核验后解除暂停。uncertain 的那条保持 uncertain，不重发。 */
  async resume(): Promise<OutreachState> {
    const state = await this.state();
    const next = { ...state, pause: null };
    await this.save(next);
    return next;
  }

  async status(): Promise<{ enabled: boolean; connected: boolean; state: OutreachState }> {
    return { enabled: await this.enabled(), connected: this.deps.available(), state: await this.state() };
  }

  async tick(): Promise<OutreachTick> {
    if (this.running) return { outcome: 'waiting', detail: '上一轮还在执行' };
    this.running = true;
    try {
      const result = await this.tickInner();
      const state = await this.state().catch(() => undefined);
      if (state) await this.save({ ...state, lastTick: { at: this.iso(), outcome: result.outcome, detail: result.detail.slice(0, 1000) } });
      return result;
    } finally { this.running = false; }
  }

  private async tickInner(): Promise<OutreachTick> {
    if (!(this.deps.readyChannels ?? OUTREACH_READY_CHANNELS).length) return { outcome: 'disabled', detail: '还没有可自动发布的渠道' };
    if (!(await this.enabled())) return { outcome: 'disabled', detail: '本机没有 invest-model 工作区或其中没有 outreach 目录' };
    const state = await this.state();
    if (state.pause) return { outcome: 'paused', detail: `${state.pause.code}：${state.pause.message}` };
    const open = state.attempts.find(attempt => attempt.state === 'dispatching' || attempt.state === 'uncertain');
    if (open) {
      await this.pause(state, { code: 'UNCERTAIN_PUBLICATION', message: `稿件 ${open.id} 的发布结果不确定，请到平台核对后再恢复`, postId: open.id });
      return { outcome: 'paused', detail: `稿件 ${open.id} 结果待核验` };
    }

    const pull = await this.deps.git(this.deps.repoPath, ['pull', '--rebase', '--autostash', '--quiet']);
    if (pull.code !== 0) return { outcome: 'waiting', detail: `拉取 invest-model 失败：${pull.stderr.trim().slice(0, 300)}` };

    const receipts = await this.receiptIds();
    const handled = new Set(state.attempts.filter(attempt => attempt.state !== 'rejected').map(attempt => attempt.id));
    const ready = new Set(this.deps.readyChannels ?? OUTREACH_READY_CHANNELS);
    const candidates = (await this.candidates()).filter(c => ready.has(c.post.channel) && !receipts.has(c.post.id) && !handled.has(c.post.id))
      .sort((a, b) => a.post.notBefore.localeCompare(b.post.notBefore) || a.post.id.localeCompare(b.post.id));

    const now = this.now();
    let wroteReceipt = false, published: OutreachTick | undefined;
    for (const candidate of candidates) {
      const { post } = candidate;
      const timing = outreachTiming(post, now);
      if (timing === 'early') continue;
      if (timing === 'expired') {
        await this.writeReceipt(post, 'expired', null, `已过发布时限 ${post.notAfter}`);
        wroteReceipt = true; continue;
      }
      const problems = recheckOutreachPost(post, candidate.location);
      if (problems.length) {
        await this.writeReceipt(post, 'refused', null, problems.join('；'));
        wroteReceipt = true; continue;
      }
      if (published) continue;
      const wait = this.pacing(await this.state(), post.channel, now);
      if (wait) { published = { outcome: 'waiting', detail: wait, postId: post.id }; continue; }
      if (!this.deps.available()) { published = { outcome: 'waiting', detail: '发文插件未连接', postId: post.id }; continue; }
      published = await this.publish(candidate);
      if (published.outcome === 'published' || published.outcome === 'attention') wroteReceipt = true;
    }
    if (wroteReceipt) {
      const pushed = await this.pushReceipts();
      if (!pushed.ok) return { outcome: 'attention', detail: `回执已写本机但推送失败：${pushed.reason}` };
    }
    return published ?? { outcome: 'idle', detail: candidates.length ? '没有到发布时间的稿件' : '没有待发稿件' };
  }

  private pacing(state: OutreachState, channel: OutreachChannel, now: number): string | undefined {
    const sent = state.attempts.filter(attempt => attempt.state !== 'rejected');
    const last = sent.map(attempt => Date.parse(attempt.at)).sort((a, b) => b - a)[0];
    if (last !== undefined && now - last < state.policy.minIntervalMs) {
      return `距上次发布不足 ${Math.round(state.policy.minIntervalMs / 1000)} 秒`;
    }
    const recent = sent.filter(attempt => attempt.channel === channel && now - Date.parse(attempt.at) < DAY).length;
    if (recent >= state.policy.maxPerChannel24h) return `${channel} 24 小时内已发 ${recent} 篇，达到上限`;
    return undefined;
  }

  private async pause(state: OutreachState, pause: Omit<NonNullable<OutreachState['pause']>, 'at'>): Promise<void> {
    await this.save({ ...state, pause: { ...pause, at: this.iso() } });
  }

  private async publish(candidate: Candidate): Promise<OutreachTick> {
    const { post } = candidate;
    const images = [];
    for (const name of post.images) {
      const bytes = await readFile(join(candidate.dir, name));
      images.push({ name, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
    }
    const action: OutreachAction = {
      kind: 'outreach-publish', channel: post.channel, id: post.id,
      title: post.title ?? '', digest: post.digest ?? '', body: post.body, bodyHtml: post.bodyHtml ?? '',
      images, cover: post.cover ?? null, link: post.link ?? null,
    };
    const requestId = `outreach-${randomBytes(8).toString('hex')}`;
    let state = await this.state();
    const attempt: Attempt = { id: post.id, channel: post.channel, requestId, state: 'dispatching', at: this.iso() };
    state = { ...state, attempts: [...state.attempts, attempt] };
    await this.save(state);

    let result: OutreachResult;
    try {
      result = await this.deps.execute(action, requestId);
    } catch (error) {
      result = { kind: 'attention', code: 'TRANSPORT_FAILED', message: (error as Error).message.slice(0, 900) || '发送中断', submission: 'uncertain' };
    }
    state = await this.state();
    const replace = (next: Attempt) => ({ ...state, attempts: state.attempts.map(item => item.requestId === requestId ? next : item) });

    if (result.kind === 'outreach-published' && result.id === post.id && result.channel === post.channel) {
      await this.save(replace({ ...attempt, state: 'published', url: result.url, at: result.observedAt }));
      await this.writeReceipt(post, 'published', result.url, null, result.observedAt);
      return { outcome: 'published', detail: `${post.channel} 已发布 ${post.id}`, postId: post.id };
    }
    if (result.kind !== 'attention' || result.submission === 'uncertain') {
      const message = result.kind === 'attention' ? result.message : '回执与稿件不符';
      const code = result.kind === 'attention' ? result.code : 'RECEIPT_MISMATCH';
      const next = replace({ ...attempt, state: 'uncertain', code, message });
      await this.save({ ...next, pause: { code: 'UNCERTAIN_PUBLICATION', message: `${post.id}：${message}`, postId: post.id, at: this.iso(),
        ...(result.kind === 'attention' && result.tabUrl ? { tabUrl: result.tabUrl } : {}) } });
      await this.writeReceipt(post, 'uncertain', null, message);
      return { outcome: 'attention', detail: `${post.id} 结果不确定，已暂停：${message}`, postId: post.id };
    }
    // 明确没点发布。
    const rejected = replace({ ...attempt, state: 'rejected', code: result.code, message: result.message });
    if ((OUTREACH_BARRIER_CODES as readonly string[]).includes(result.code)) {
      await this.save({ ...rejected, pause: { code: result.code, message: result.message, postId: post.id, at: this.iso(),
        ...(result.tabUrl ? { tabUrl: result.tabUrl } : {}) } });
      return { outcome: 'paused', detail: `${post.channel} 需要处理：${result.message}`, postId: post.id };
    }
    await this.save(rejected);
    const tries = rejected.attempts.filter(item => item.id === post.id && item.state === 'rejected').length;
    if (tries >= MAX_REJECTED) {
      await this.writeReceipt(post, 'failed', null, `${tries} 次均未能发布：${result.message}`);
      return { outcome: 'attention', detail: `${post.id} 多次未能发布，已放弃：${result.message}`, postId: post.id };
    }
    return { outcome: 'waiting', detail: `${post.id} 本轮未发布（${result.code}），下轮再试`, postId: post.id };
  }

  /** 只看待发目录；blocked 里的稿件云端已标红，永不发布。 */
  private async candidates(): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const root = join(this.deps.repoPath, 'outreach', 'outbox');
    let names: string[];
    try { names = await readdir(root); } catch { return out; }
    for (const name of names) {
      if (!outreachIdSchema.safeParse(name).success) continue;
      const dir = join(root, name);
      try {
        const post = outreachPostSchema.parse(JSON.parse(await readFile(join(dir, 'post.json'), 'utf8')));
        if (post.id === name) out.push({ post, location: 'outbox', dir });
      } catch { /* 格式不对的稿件不碰 */ }
    }
    return out;
  }

  private async receiptIds(): Promise<Set<string>> {
    try {
      return new Set((await readdir(join(this.deps.repoPath, 'outreach', 'receipts')))
        .filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)));
    } catch { return new Set(); }
  }

  private async writeReceipt(post: OutreachPost, status: OutreachReceipt['status'], url: string | null, reason: string | null,
    publishedAt?: string): Promise<void> {
    const receipt: OutreachReceipt = outreachReceiptSchema.parse({
      schemaVersion: 1, id: post.id, channel: post.channel, status,
      publishedAt: status === 'published' ? (publishedAt ?? this.iso()) : null,
      url, reason: reason?.slice(0, 1000) ?? null, collector: `data-collector ${APP_VERSION}`, stats: [],
    });
    const root = join(this.deps.repoPath, 'outreach');
    await atomicWriteText(root, join(root, 'receipts', `${post.id}.json`), `${JSON.stringify(receipt, null, 1)}\n`);
  }

  private async pushReceipts(): Promise<{ ok: boolean; reason?: string }> {
    const repo = this.deps.repoPath, git = this.deps.git;
    const add = await git(repo, ['add', '--', 'outreach/receipts']);
    if (add.code !== 0) return { ok: false, reason: add.stderr.trim().slice(0, 300) };
    // 只提交回执目录，不连带用户自己暂存的其他改动。
    const commit = await git(repo, ['commit', '-m', 'outreach: 发布回执 [skip ci]', '--', 'outreach/receipts']);
    if (commit.code !== 0 && !/nothing (to commit|added)/u.test(`${commit.stdout ?? ''}${commit.stderr}`)) {
      return { ok: false, reason: commit.stderr.trim().slice(0, 300) };
    }
    let last = '';
    for (let i = 0; i < 4; i += 1) {
      const rebase = await git(repo, ['pull', '--rebase', '--autostash', '--quiet']);
      if (rebase.code === 0) {
        const push = await git(repo, ['push', '--quiet']);
        if (push.code === 0) return { ok: true };
        last = push.stderr;
      } else last = rebase.stderr;
    }
    return { ok: false, reason: last.trim().slice(0, 300) };
  }
}
