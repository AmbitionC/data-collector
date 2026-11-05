import { z } from 'zod';

/**
 * Invest Journey 对外引流（雪球引流 + 公众号深度）。
 *
 * 稿件由 invest-model 云端出稿并过机器审核闸，写在 `<invest-model>/outreach/outbox/<id>/`；
 * 本机 Bridge 拉取后在这里再核一遍，交给已登录浏览器里的插件发布，回执写回
 * `outreach/receipts/<id>.json`。契约见 invest-model `outreach/README.md`。
 *
 * 发布只认观察到的成功：页面上看到这条内容才算 published；点了但没看到一律 uncertain，
 * 不自动重发。
 */
export const INVEST_OUTREACH_CAPABILITY = 'invest-outreach-publishing-v1';
export const OUTREACH_CHANNELS = ['xueqiu', 'wechat'] as const;
export const outreachChannelSchema = z.enum(OUTREACH_CHANNELS);
export type OutreachChannel = z.infer<typeof outreachChannelSchema>;
export const OUTREACH_GATE_VERSION = 1;
/**
 * 已经在真实后台核对过页面结构、能自动发布的渠道。未列入的渠道稿件一律不碰（不发、不写回执），
 * 页面操作验证通过后随版本更新加入，靠自更新送到用户机器上。
 */
export const OUTREACH_READY_CHANNELS: readonly OutreachChannel[] = [];

export const outreachIdSchema = z.string().regex(/^[0-9a-z-]{8,80}$/u);
const imageName = z.string().regex(/^[a-z0-9-]{1,40}\.png$/u);
const isoTime = z.string().refine(value => !Number.isNaN(Date.parse(value)), '时间格式无效');

export const outreachPostSchema = z.object({
  schemaVersion: z.literal(1),
  id: outreachIdSchema,
  channel: outreachChannelSchema,
  kind: z.enum(['weekly', 'event']),
  title: z.string().max(200).nullable().optional(),
  digest: z.string().max(400).nullable().optional(),
  body: z.string().min(1).max(20_000),
  bodyHtml: z.string().max(60_000).nullable().optional(),
  images: z.array(imageName).max(6),
  cover: imageName.nullable().optional(),
  link: z.string().url().max(500).nullable().optional(),
  notBefore: isoTime,
  notAfter: isoTime,
  dataDate: z.string().regex(/^\d{8}$/u),
  gate: z.object({
    version: z.number().int(),
    passed: z.boolean(),
    problems: z.array(z.string()),
    checkedAt: isoTime,
  }),
});
export type OutreachPost = z.infer<typeof outreachPostSchema>;

export const OUTREACH_RECEIPT_STATUSES = ['published', 'refused', 'expired', 'paused', 'failed', 'uncertain'] as const;
export const outreachReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  id: outreachIdSchema,
  channel: outreachChannelSchema,
  status: z.enum(OUTREACH_RECEIPT_STATUSES),
  publishedAt: isoTime.nullable(),
  url: z.string().url().max(2000).nullable(),
  reason: z.string().max(1000).nullable(),
  collector: z.string().max(100),
  stats: z.array(z.object({
    at: isoTime, views: z.number().int().nonnegative().nullable(), likes: z.number().int().nonnegative().nullable(),
    comments: z.number().int().nonnegative().nullable(), reposts: z.number().int().nonnegative().nullable(),
  })).max(400),
});
export type OutreachReceipt = z.infer<typeof outreachReceiptSchema>;

/**
 * 人工批准（2026-11-05 用户要求：每篇发布前必须先给他审稿、他确认后才发）。
 * `<invest-model>/outreach/approvals/<id>.json`，只在用户在对话里明确确认这篇之后写入。
 * contentSha256 把批准绑死在审过的那一版：post.json 字节 + 按 images 顺序的「\n名字\n图片字节」。
 * 没有批准、或稿件/配图在批准后被改过 → 不发（也不写回执，等批准或过期）。
 */
export const outreachApprovalSchema = z.object({
  schemaVersion: z.literal(1),
  id: outreachIdSchema,
  approvedBy: z.string().min(1).max(100),
  approvedAt: isoTime,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  note: z.string().max(1000).nullable().optional(),
});
export type OutreachApproval = z.infer<typeof outreachApprovalSchema>;

const pngDataUrl = z.string().max(4_000_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u);
export const outreachImagePayloadSchema = z.object({ name: imageName, dataUrl: pngDataUrl }).strict();

export const outreachActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('outreach-account'), channel: outreachChannelSchema }).strict(),
  z.object({
    kind: z.literal('outreach-publish'),
    channel: outreachChannelSchema,
    id: outreachIdSchema,
    title: z.string().max(200),
    digest: z.string().max(400),
    body: z.string().min(1).max(20_000),
    bodyHtml: z.string().max(60_000),
    images: z.array(outreachImagePayloadSchema).max(6),
    cover: imageName.nullable(),
    link: z.string().url().max(500).nullable(),
  }).strict(),
]);
export type OutreachAction = z.infer<typeof outreachActionSchema>;

export const outreachResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('outreach-account'), channel: outreachChannelSchema, loggedIn: z.boolean(),
    accountName: z.string().max(200).optional() }).strict(),
  z.object({ kind: z.literal('outreach-published'), channel: outreachChannelSchema, id: outreachIdSchema,
    url: z.string().url().max(2000).nullable(), observedAt: isoTime }).strict(),
  z.object({ kind: z.literal('attention'), code: z.string().min(1).max(100), message: z.string().min(1).max(1000),
    submission: z.enum(['not_attempted', 'uncertain']), tabUrl: z.string().url().max(4096).optional() }).strict(),
]);
export type OutreachResult = z.infer<typeof outreachResultSchema>;

/** 页面出现这些就全渠道暂停，等用户处理；绝不自动重试。 */
export const OUTREACH_BARRIER_CODES = ['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'ACCESS_RESTRICTED'] as const;

const XUEQIU_FORBIDDEN = ['http', 'www.', '.cn', '.com', '公众号', '微信', '阅读原文'];
const REQUIRED = ['不构成投资建议', 'AI 辅助生成'];
const ALLOWED_LINK_HOSTS = new Set(['invest-journey.cn', 'www.invest-journey.cn']);

/**
 * 发布端的轻量复核。云端审核闸是主闸，这里只防「目录被手改 / 传输出错 / 规则版本落后」。
 * 返回问题列表，空数组才可发。
 */
export function recheckOutreachPost(post: OutreachPost, location: 'outbox' | 'blocked'): string[] {
  const problems: string[] = [];
  if (location !== 'outbox') problems.push('稿件不在待发目录');
  if (!post.gate.passed || post.gate.problems.length) problems.push('云端审核闸未通过');
  if (post.gate.version < OUTREACH_GATE_VERSION) problems.push(`审核闸版本过旧：${post.gate.version}`);
  const text = [post.title ?? '', post.digest ?? '', post.body].join('\n');
  for (const word of REQUIRED) if (!post.body.includes(word)) problems.push(`缺少声明：${word}`);
  if (/(?<!\d)[0-9]{6}(?!\d)/u.test(text.replace(/\d{8}/gu, ''))) problems.push('出现 6 位代码');
  if (post.channel === 'xueqiu') {
    const lower = text.toLowerCase();
    for (const word of XUEQIU_FORBIDDEN) if (lower.includes(word.toLowerCase())) problems.push(`雪球稿件含禁用内容：${word}`);
    if (post.link) problems.push('雪球稿件不能带链接');
    if ([...post.body].length > 900) problems.push('雪球稿件超长');
  } else {
    if (!post.title?.trim()) problems.push('公众号缺标题');
    if (!post.bodyHtml?.trim()) problems.push('公众号缺正文 HTML');
    if (post.link) {
      try {
        const url = new URL(post.link);
        if (!ALLOWED_LINK_HOSTS.has(url.hostname) || !url.searchParams.get('ch')) problems.push('公众号链接不合规');
      } catch { problems.push('公众号链接无效'); }
    }
    for (const match of (post.bodyHtml ?? '').matchAll(/href="([^"]+)"/gu)) {
      try {
        const url = new URL(match[1]!);
        if (!ALLOWED_LINK_HOSTS.has(url.hostname) || !url.searchParams.get('ch')) problems.push(`正文链接不合规：${match[1]}`);
      } catch { problems.push(`正文链接无效：${match[1]}`); }
    }
  }
  for (const img of post.images) if (!/^[a-z0-9-]+\.png$/u.test(img)) problems.push(`配图名非法：${img}`);
  return [...new Set(problems)];
}

export type OutreachTiming = 'early' | 'due' | 'expired';
export function outreachTiming(post: Pick<OutreachPost, 'notBefore' | 'notAfter'>, now: number): OutreachTiming {
  if (now < Date.parse(post.notBefore)) return 'early';
  if (now > Date.parse(post.notAfter)) return 'expired';
  return 'due';
}

export const outreachPolicySchema = z.object({
  /** 两次发布（任意渠道）最小间隔。 */
  minIntervalMs: z.number().int().min(60_000).max(86_400_000),
  /** 每个渠道滚动 24 小时最多几篇。 */
  maxPerChannel24h: z.number().int().min(1).max(10),
}).strict();
export type OutreachPolicy = z.infer<typeof outreachPolicySchema>;
export const DEFAULT_OUTREACH_POLICY: OutreachPolicy = { minIntervalMs: 120_000, maxPerChannel24h: 3 };
