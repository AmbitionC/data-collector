import { z } from 'zod';
import { stableContentId } from './url.js';

export const NOWCODER_HOT_MATERIAL_CAPABILITY = 'nowcoder-hot-material-v1';

export const HOT_MATERIAL_CATEGORY = '热帖素材';
export const HOT_EMOTION_TAGS = ['焦虑', '困惑', '不服', '反差', '释然'] as const;
export const HOT_SCREENSHOT_NOTICE = '截图仅用于私有运营素材；公开使用前去除昵称、头像、联系方式等个人信息，并核实消息。当前版本不采集截图。';

export function hotMaterialId(url: string): string {
  return `hot-${stableContentId(url)}`;
}

const nowcoderUrl = z.string().url().max(4096).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && (url.hostname === 'nowcoder.com' || url.hostname.endsWith('.nowcoder.com'));
}, '仅支持牛客 HTTPS 页面');
const observedValue = z.string().trim().min(1).max(80).nullable();
export const nowcoderHotMaterialSchema = z.object({
  schemaVersion: z.literal(1),
  purpose: z.literal('nowcoder-hot'),
  visibility: z.literal('private'),
  verificationStatus: z.literal('unverified'),
  observation: z.object({
    listUrl: nowcoderUrl,
    listTitle: z.string().max(500),
    publishedAtText: z.string().max(100).nullable(),
    metrics: z.object({ heat: observedValue, likes: observedValue, comments: observedValue, views: observedValue }).strict(),
    observedAt: z.iso.datetime(),
  }).strict(),
  evidence: z.object({
    excerpt: z.string().max(180),
    attribution: z.enum(['source-quote', 'author-self-report']),
  }).strict(),
  editorial: z.object({
    emotionTags: z.array(z.enum(HOT_EMOTION_TAGS)).max(5),
    inspirationNote: z.string().max(1000),
  }).strict(),
  screenshotPolicy: z.literal('redact-before-public-use'),
}).strict();
export type NowcoderHotMaterial = z.infer<typeof nowcoderHotMaterialSchema>;

export const hotSelectionsSchema = z.array(z.object({
  id: z.string().regex(/^hot-[a-f0-9]{12}$/u),
  emotionTags: z.array(z.enum(HOT_EMOTION_TAGS)).max(5),
  inspirationNote: z.string().trim().max(1000),
  attribution: z.enum(['source-quote', 'author-self-report']),
}).strict()).min(1).max(60);
export type HotSelection = z.infer<typeof hotSelectionsSchema>[number];

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Source observations, unverified quote and editor notes stay separate in Markdown too. */
export function renderHotMaterial(material: NowcoderHotMaterial): string {
  const m = material.observation;
  const metrics = Object.entries(m.metrics).map(([key, value]) => `${key}: ${value ?? '未知'}`).join(' · ');
  return `<h2>页面可见事实</h2><p>观察页面：${escapeHtml(m.listTitle)}</p><p>发布时间原样：${escapeHtml(m.publishedAtText ?? '未知')}</p><p>${escapeHtml(metrics)}</p><p>采集时间：${escapeHtml(m.observedAt)}</p>`
    + `<h2>${material.evidence.attribution === 'author-self-report' ? '发帖人自述（未核实）' : '来源短摘（未核实）'}</h2><blockquote>${escapeHtml(material.evidence.excerpt || '列表未提供短摘，请从原文链接核对。')}</blockquote>`
    + `<h2>编辑情绪标签与灵感笔记</h2><p>标签仅供选题参考：${escapeHtml(material.editorial.emotionTags.join('、') || '未标注')}</p><p>${escapeHtml(material.editorial.inspirationNote)}</p>`
    + `<h2>私有用途</h2><p>${escapeHtml(HOT_SCREENSHOT_NOTICE)} 不直接公开未核实消息；完整原文保留来源链接。</p>`;
}
