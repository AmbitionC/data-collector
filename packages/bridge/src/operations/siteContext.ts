import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Grounding for lead comments (2026-11-09 user choice: quote one real page plus a real statistic).
 * Everything handed to the model comes from the published site, so a lead can only cite what exists.
 */
const API = 'https://fe-journey-main-ktantdfjcs.cn-hangzhou.fcapp.run/article/navList';
const CONTENT = 'https://font-end-journey-resources.oss-cn-hangzhou.aliyuncs.com';
const ROADMAP_KEY = 'agent-learning-roadmap', INTERVIEW_KEY = 'agent-resume-interview';
const INTERVIEW_INTENT = /面试|简历|秋招|春招|实习|复习|八股|面经/iu;
const ROUTE_INTENT = /路线|怎么学|入门|转行|转方向|转\s*(ai|agent|大模型)|学什么|从零/iu;
// Terms nearly every interview mentions (Agent, 项目) say nothing and are left out.
export const STAT_TERMS = ['RAG', 'MCP', 'Function Calling', '工具调用', 'LangGraph', 'Memory', '记忆', '幂等', '超时', '重试', '评测', 'Prompt', '微调',
  '向量', 'Embedding', 'Redis', 'MySQL', 'Kafka', '消息队列', '分布式', '系统设计', '手撕', 'Go', 'Java', 'Python', 'React', '多 Agent', '上下文'] as const;

export interface SitePage { module: 'knowledge' | 'interview'; key: string; label: string; filePath: string }
export interface SiteContext { title: string; excerpt: string; stats: string[] }
export interface SiteStats { version?: number; generatedAt: string; total: number; counts: Record<string, number> }
const STATS_VERSION = 2;

const get = async (url: string) => { const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }); if (!response.ok) throw new Error(`${response.status} ${url}`); return response.text(); };
function leaves(nodes: any[], module: SitePage['module'], out: SitePage[] = []): SitePage[] {
  for (const node of nodes) node.isLeaf ? out.push({ module, key: node.key, label: node.label, filePath: node.filePath }) : leaves(node.children ?? [], module, out);
  return out;
}
export const catalog = async (module: SitePage['module']) => leaves((JSON.parse(await get(`${API}?module=${module}`)) as { data: { navData: any[] } }).data.navData, module);
const plain = (markdown: string) => markdown.replace(/<[^>]+>/gu, ' ').replace(/[#>*`|]/gu, ' ').replace(/[ \t]+/gu, ' ').replace(/\n{2,}/gu, '\n').trim();

/** Best knowledge page for the post: label phrases that literally appear in it; the roadmap answers route questions. */
export function pickPage(pages: SitePage[], text: string): SitePage | undefined {
  const lower = text.toLowerCase();
  let best: { page: SitePage; score: number } | undefined;
  for (const page of pages) {
    const score = page.label.split(/[、，,：:（）()\s与和及的]+/u).filter(part => part.length >= 2 && lower.includes(part.toLowerCase())).reduce((sum, part) => sum + part.length, 0);
    if (score > (best?.score ?? 0)) best = { page, score };
  }
  if (best && best.score >= 3) return best.page;
  if (ROUTE_INTENT.test(text)) return pages.find(page => page.key === ROADMAP_KEY);
  // Interview prep and resume questions are answered by the site's interview guide.
  return INTERVIEW_INTENT.test(text) ? pages.find(page => page.key === INTERVIEW_KEY) : undefined;
}

/** ASCII terms match whole words only, so "Go" is not counted inside "Google" or "algorithm". */
const termPattern = (term: string) => /^[\x20-\x7e]+$/u.test(term) ? new RegExp(`(?<![A-Za-z])${term.replace(/\s+/gu, '\\s*')}(?![A-Za-z])`, 'iu') : new RegExp(term, 'u');
export function countTerms(texts: string[]): SiteStats {
  const counts: Record<string, number> = {};
  for (const term of STAT_TERMS) { const pattern = termPattern(term); counts[term] = texts.filter(text => pattern.test(text)).length; }
  return { version: STATS_VERSION, generatedAt: new Date().toISOString(), total: texts.length, counts };
}
export function statLines(stats: SiteStats, text: string): string[] {
  return STAT_TERMS.filter(term => termPattern(term).test(text) && (stats.counts[term] ?? 0) > 0)
    .sort((a, b) => stats.counts[b]! - stats.counts[a]!).slice(0, 3)
    .map(term => `站内 ${stats.total} 篇面经里，${stats.counts[term]} 篇问到了 ${term}`);
}

/** Recomputed at most daily from every published interview page. */
async function siteStats(cacheDir: string): Promise<SiteStats> {
  const path = join(cacheDir, 'site-stats.json');
  const cached = await readFile(path, 'utf8').then(raw => JSON.parse(raw) as SiteStats, () => undefined);
  if (cached && cached.version === STATS_VERSION && Date.now() - Date.parse(cached.generatedAt) < 86_400_000) return cached;
  const pages = await catalog('interview'), texts: string[] = [];
  for (let i = 0; i < pages.length; i += 8) texts.push(...await Promise.all(pages.slice(i, i + 8).map(p => get(`${CONTENT}/interview/${p.filePath}/${p.key}.md`).catch(() => ''))));
  const stats = countTerms(texts.filter(Boolean));
  await mkdir(cacheDir, { recursive: true }); await writeFile(path, JSON.stringify(stats), { mode: 0o600 });
  return stats;
}

export async function siteContext(cacheDir: string, postText: string): Promise<SiteContext | undefined> {
  const page = pickPage(await catalog('knowledge'), postText);
  if (!page) return undefined;
  const excerpt = plain(await get(`${CONTENT}/knowledge/${page.filePath}/${page.key}.md`)).slice(0, 2500);
  const stats = await siteStats(cacheDir).then(s => statLines(s, `${postText}\n${page.label}`)).catch(() => []);
  return { title: page.label, excerpt, stats };
}
