import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { collectedDocumentSchema, hotMaterialId, type NowcoderSearchCandidate } from '@data-collector/shared';
import { canonicalNowcoderDetailUrl } from './feJourney/nowcoderSearchRecord.js';
import { discoverNowcoderDirectedCandidates } from './nowcoderDirected/discovery.js';
import { NowcoderRequestPacer } from './plans/nowcoderPacing.js';

const specSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(80)).max(6),
  complaintQueries: z.array(z.string().trim().min(1).max(80)).max(6),
  latestTarget: z.number().int().min(0).max(40),
  complaintTarget: z.number().int().min(0).max(40),
  days: z.number().int().min(1).max(30),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/u),
  waitMs: z.number().int().min(100).max(1_800_000),
  hotExportPath: z.string().refine(isAbsolute).optional(),
  hotObservationPath: z.string().refine(isAbsolute).optional(),
}).strict().refine(s => (s.latestTarget === 0 || s.queries.length > 0)
  && (s.complaintTarget === 0 || s.complaintQueries.length > 0)
  && !(s.hotExportPath && s.hotObservationPath)
  && (s.latestTarget + s.complaintTarget > 0 || !!s.hotExportPath || !!s.hotObservationPath), '请提供采样关键词与目标');
export type ResearchSpec = z.infer<typeof specSchema>;
type Stratum = 'latest' | 'complaint' | 'hot';
export interface ResearchItem {
  canonicalUrl: string;
  stratum: Stratum;
  strata: Stratum[];
  title?: string;
  searchPublishedAt?: string;
  candidate?: NowcoderSearchCandidate;
  jobId: string;
  status: 'pending' | 'collecting' | 'saved' | 'excluded' | 'failed';
  snapshotPath?: string;
  sha256?: string;
  errorCode?: string;
  exclusionReason?: string;
}
export interface ResearchRun {
  schemaVersion: 1;
  purpose: 'nowcoder-private-user-research';
  visibility: 'private';
  id: string;
  spec: ResearchSpec;
  specHash: string;
  status: 'preparing' | 'running' | 'completed' | 'completed_with_attention' | 'failed';
  startedAt: string;
  finishedAt?: string;
  manifestPath: string;
  items: ResearchItem[];
  counts: { discovered: number; selected: number; saved: number; excluded: number; failed: number; delivered: 0 };
  discoveryFiles: string[];
  frozenCandidatesSha256?: string;
  hotExportSha256?: string;
  hotObservationSha256?: string;
  hotInputSha256?: string;
  ignoredOlderHotMaterials?: number;
  error?: { code: string; message: string };
}
export interface ResearchDependencies {
  fetch: typeof fetch;
  baseUrl: string;
  token: string;
  libraryRoot: string;
  runsRoot: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  progress?: (message: string) => void;
}
class ResearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const COMPILATION_TITLE = /(?:面经|真题).{0,30}(?:面经|真题)|面经\s*[-－]\s*0\d|面试经验地图|题库汇编/iu;
const COMPLAINT_SIGNAL = /吐槽|焦虑|迷茫|求助|求(?:大佬|佬|建议|指点)|(?:给我?点|请.{0,6}给.{0,6})建议|简历.{0,8}(?:挂|不过|没)|(?:没有|没拿到|零|0)\s*(?:offer|面试|面邀|工作)|offer.{0,6}(?:挂零|没有)|(?:心态|情绪).{0,5}(?:崩|炸)|\bemo\b|烧心|还(?:没|没有)/iu;
const MAX_RESEARCH_DETAILS = 160;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

async function privateJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
async function inside(root: string, path: string): Promise<string> {
  const resolved = await realpath(path);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ResearchError('RESEARCH_PATH_OUTSIDE_LIBRARY', '采集输出不在本机库内');
  }
  return resolved;
}

/** A separate, explicitly private purpose. It never reads or changes interview publication history. */
export async function runPrivateNowcoderResearch(rawSpec: ResearchSpec, d: ResearchDependencies): Promise<ResearchRun> {
  const spec = specSchema.parse(rawSpec);
  const base = new URL(d.baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('调研仅连接本机 Bridge');
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const pacer = new NowcoderRequestPacer({delay:sleep});
  const specHash = digest(JSON.stringify(spec));
  const id = `nowcoder-research-${digest(spec.idempotencyKey).slice(0, 20)}`;
  await mkdir(d.runsRoot, { recursive: true, mode: 0o700 });
  const runRoot = join(await realpath(d.runsRoot), id);
  const manifestPath = join(runRoot, 'manifest.json');
  try {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8')) as ResearchRun;
    if (previous.specHash !== specHash) throw new ResearchError('RESEARCH_IDEMPOTENCY_CONFLICT', '幂等键已用于其他调研范围');
    // An interrupted run is evidence too: never silently replay or pool its jobs.
    return previous;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Exclusive directory creation also prevents concurrent processes from sharing a run.
  await mkdir(runRoot, { mode: 0o700 });
  const run: ResearchRun = { schemaVersion: 1, purpose: 'nowcoder-private-user-research', visibility: 'private',
    id, spec, specHash, status: 'preparing', startedAt: now().toISOString(), manifestPath,
    items: [], counts: { discovered: 0, selected: 0, saved: 0, excluded: 0, failed: 0, delivered: 0 }, discoveryFiles: [] };
  const save = async (): Promise<void> => {
    run.counts.selected = run.items.length;
    run.counts.saved = run.items.filter(i => i.status === 'saved').length;
    run.counts.excluded = run.items.filter(i => i.status === 'excluded').length;
    run.counts.failed = run.items.filter(i => i.status === 'failed').length;
    await privateJson(manifestPath, run);
  };
  await save();
  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await d.fetch(`${d.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = record(await response.json());
    if (!response.ok) throw new ResearchError('RESEARCH_BRIDGE_HTTP_ERROR', `本机采集接口返回 HTTP ${response.status}`);
    return result;
  };
  try {
    const health = await request('/health');
    if (health.extensionConnected !== true) throw new ResearchError('EXTENSION_OFFLINE', 'Data Collector 扩展未连接');
    if (health.directedRunActive === true) throw new ResearchError('RESEARCH_ACTIVE_RUN_CONFLICT', '已有定向采集运行，请勿同时启动调研');
    if (!Array.isArray(health.extensionCapabilities) || !health.extensionCapabilities.includes('nowcoder-detail-v1')
      || !health.buildId || health.buildId !== health.extensionBuildId || health.version !== health.extensionVersion) {
      throw new ResearchError('RESEARCH_CAPABILITY_MISMATCH', 'Bridge 与扩展构建或详情采集能力不一致');
    }
    await privateJson(join(runRoot, 'health.json'), { version: health.version, extensionVersion: health.extensionVersion,
      buildId: health.buildId, extensionBuildId: health.extensionBuildId, extensionCapabilities: health.extensionCapabilities });
    const started = Date.parse(run.startedAt), cutoff = started - spec.days * 86_400_000;
    const selected = new Map<string, ResearchItem>();
    const discoveredUrls = new Set<string>();
    const pools: Record<'latest' | 'complaint', NowcoderSearchCandidate[]> = { latest: [], complaint: [] };
    const eligibilityExclusions: { canonicalUrl: string; stratum: Stratum; reason: string }[] = [];
    const candidateItem = (candidate: NowcoderSearchCandidate, stratum: 'latest' | 'complaint'): ResearchItem => ({
      canonicalUrl: candidate.canonicalUrl, stratum, strata: [stratum], ...(candidate.title ? { title: candidate.title } : {}),
      searchPublishedAt: candidate.publishedAt, candidate,
      jobId: `${id}-${digest(candidate.canonicalUrl).slice(0, 12)}`, status: 'pending',
    });
    const discover = async (queries: string[], stratum: 'latest' | 'complaint', target: number): Promise<void> => {
      if (target === 0) return;
      d.progress?.(`正在发现 ${stratum} 候选`);
      const discovery = await discoverNowcoderDirectedCandidates(d.fetch, {
        queries, target: 1, sort: 'latest', maxPagesPerQuery: 2, maxRequests: 12,
      }, new Set(), new Date(started));
      const filename = `${stratum}-discovery.json`;
      await privateJson(join(runRoot, filename), discovery);
      run.discoveryFiles.push(filename);
      for (const candidate of [...discovery.candidates, ...discovery.previewOnly]) discoveredUrls.add(candidate.canonicalUrl);
      run.counts.discovered = discoveredUrls.size;
      let added = 0;
      for (const candidate of discovery.candidates) {
        const published = Date.parse(candidate.publishedAt);
        if (!Number.isFinite(published) || published < cutoff || published > started) continue;
        const url = canonicalNowcoderDetailUrl(candidate.canonicalUrl);
        if (!url || url !== candidate.canonicalUrl) throw new ResearchError('RESEARCH_INVALID_SOURCE', '搜索返回的帖子来源无效');
        const reason = COMPILATION_TITLE.test(candidate.title ?? '') ? 'compiled_interview'
          : stratum === 'complaint' && !COMPLAINT_SIGNAL.test(`${candidate.title ?? ''}\n${candidate.snippet ?? ''}`) ? 'complaint_signal_missing' : undefined;
        if (reason) { eligibilityExclusions.push({canonicalUrl:url,stratum,reason}); continue; }
        pools[stratum].push(candidate);
        if (added >= target || selected.has(url)) continue;
        selected.set(url, candidateItem(candidate,stratum));
        added++;
      }
      await privateJson(join(runRoot,'selection-exclusions.json'),eligibilityExclusions);
      if (added !== target) throw new ResearchError('RESEARCH_TARGET_UNAVAILABLE', `${stratum} 在时间窗口内只有 ${added} 篇可用候选，目标 ${target}`);
    };
    // Reserve the explicit complaint stratum before broad latest queries to avoid stealing its quota.
    await discover(spec.complaintQueries, 'complaint', spec.complaintTarget);
    await discover(spec.queries, 'latest', spec.latestTarget);
    await privateJson(join(runRoot,'frozen-candidates.json'),pools);
    run.frozenCandidatesSha256 = digest(await readFile(join(runRoot,'frozen-candidates.json')));
    const hotInput = spec.hotExportPath ?? spec.hotObservationPath;
    if (hotInput) {
      const raw = await readFile(hotInput);
      if (raw.length > 16 * 1024 * 1024) throw new ResearchError('RESEARCH_HOT_EXPORT_INVALID', '热帖导出超过大小上限');
      const exported = record(JSON.parse(raw.toString('utf8')));
      await writeFile(join(runRoot, 'hot-input.original.json'), raw, { mode: 0o600 });
      run.hotInputSha256 = digest(raw);
      const addHot = (url: string, title: string): void => {
        discoveredUrls.add(url); run.counts.discovered = discoveredUrls.size;
        const existing = selected.get(url);
        if (existing) { if (!existing.strata.includes('hot')) existing.strata.push('hot'); }
        else selected.set(url, { canonicalUrl: url, stratum: 'hot', strata: ['hot'], title,
          jobId: `${id}-${digest(url).slice(0, 12)}`, status: 'pending' });
      };
      if (spec.hotObservationPath) {
        const observation = z.object({
          schemaVersion: z.literal(1), type: z.literal('nowcoder-public-hot-observation'), visibility: z.literal('private'),
          observer: z.literal('browser-visible-dom'), listUrl: z.string().url().refine(value => {
            const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'nowcoder.com' || u.hostname.endsWith('.nowcoder.com'));
          }), listTitle: z.string().min(1).max(500), observedAt: z.iso.datetime(), scope: z.string().min(1).max(1000),
          items: z.array(z.object({ canonicalUrl: z.string().refine(value => canonicalNowcoderDetailUrl(value) === value),
            title: z.string().min(1).max(500), metrics: z.object({heat:z.string().max(80).nullable(),likes:z.string().max(80).nullable(),comments:z.string().max(80).nullable(),views:z.string().max(80).nullable()}).strict(),
          }).strict()).min(1).max(60),
        }).strict().parse(exported);
        const observed = Date.parse(observation.observedAt);
        if (observed < started - 3_600_000 || observed > started + 60_000
          || new Set(observation.items.map(i => i.canonicalUrl)).size !== observation.items.length) {
          throw new ResearchError('RESEARCH_HOT_OBSERVATION_INVALID', '公开榜单观察已过期或包含重复来源');
        }
        observation.items.forEach(i => addHot(i.canonicalUrl, i.title));
        await privateJson(join(runRoot,'hot-observations.json'),observation);
        run.hotObservationSha256 = digest(await readFile(join(runRoot,'hot-observations.json')));
      } else {
      if (exported.schemaVersion !== 1 || exported.type !== 'nowcoder-hot-materials' || exported.visibility !== 'private'
        || !Array.isArray(exported.materials)) throw new ResearchError('RESEARCH_HOT_EXPORT_INVALID', '需要 Data Collector 原始私有热帖导出');
      const observations: unknown[] = [];
      let ignored = 0;
      for (const input of exported.materials) {
        const material = record(input);
        const doc = collectedDocumentSchema.parse(material.document);
        const observed = Date.parse(doc.operationMaterial?.observation.observedAt ?? '');
        if (doc.source !== 'nowcoder' || !doc.operationMaterial || !canonicalNowcoderDetailUrl(doc.canonicalUrl)
          || material.id !== hotMaterialId(doc.canonicalUrl)) {
          throw new ResearchError('RESEARCH_HOT_EXPORT_INVALID', '热帖缺少真实来源或私有观察信息');
        }
        if (!Number.isFinite(observed) || observed < started - 3_600_000 || observed > started + 60_000) { ignored++; continue; }
        observations.push(input);
        addHot(doc.canonicalUrl,doc.title);
      }
      if (observations.length === 0 || observations.length > 60) throw new ResearchError('RESEARCH_HOT_EXPORT_STALE', '本次导出需包含一小时内观察的 1–60 条热帖素材');
      run.hotExportSha256 = digest(raw);
      run.ignoredOlderHotMaterials = ignored;
      await privateJson(join(runRoot, 'hot-observations.json'), { ...exported, materials: observations });
      run.hotObservationSha256 = digest(await readFile(join(runRoot,'hot-observations.json')));
      }
    }
    run.items = [...selected.values()];
    run.status = 'running';
    await save();
    const library = await realpath(d.libraryRoot);
    const deadline = Date.now() + spec.waitMs;
    await mkdir(join(runRoot, 'sources'), { mode: 0o700 });
    const guardDeadline = (): void => {
      if (Date.now() >= deadline) throw new ResearchError('RESEARCH_JOB_TIMEOUT', '本轮等待期限已到，已停止派发详情任务');
    };
    for (let index = 0; index < run.items.length; index++) {
      guardDeadline();
      const item = run.items[index]!;
      item.status = 'collecting';
      await save(); // Intent is durable before a potentially uncertain POST.
      const created = await pacer.run(() => {
        guardDeadline();
        return request('/v1/jobs', { id: item.jobId, url: item.canonicalUrl, requestedBy: 'cli', sinks: ['markdown'] });
      });
      if (created.id !== item.jobId) throw new ResearchError('RESEARCH_JOB_MISMATCH', '本机服务返回了其他任务身份');
      const jobDeadline = Math.min(deadline, Date.now() + 90_000);
      let terminal = false;
      while (Date.now() < jobDeadline) {
        const job = await request(`/v1/jobs/${encodeURIComponent(item.jobId)}`);
        if (job.id !== undefined && job.id !== item.jobId) throw new ResearchError('RESEARCH_JOB_MISMATCH', '采集任务身份不一致');
        if (job.url !== item.canonicalUrl) throw new ResearchError('RESEARCH_SOURCE_MISMATCH', '采集任务来源与冻结候选不一致');
        if (job.status === 'failed' || job.status === 'needs_attention') {
          item.status = 'failed';
          item.errorCode = typeof job.errorCode === 'string' ? job.errorCode : 'RESEARCH_DETAIL_FAILED';
          throw new ResearchError(item.errorCode, typeof job.errorMessage === 'string' ? job.errorMessage : '帖子采集需要处理');
        }
        if (job.status === 'saved') {
          if (typeof job.outputPath !== 'string') throw new ResearchError('RESEARCH_DOCUMENT_MISSING', '采集完成但没有正文路径');
          const output = await inside(library, job.outputPath);
          const source = await inside(library, join(dirname(output), 'source.json'));
          const stored = record(JSON.parse(await readFile(source, 'utf8')));
          const identity = record(stored.document);
          if (identity.source !== 'nowcoder' || identity.canonicalUrl !== item.canonicalUrl || identity.url !== item.canonicalUrl) {
            throw new ResearchError('RESEARCH_SOURCE_MISMATCH', '正文来源与本次冻结候选不一致');
          }
          const document = collectedDocumentSchema.parse(stored.document);
          if (document.source !== 'nowcoder' || document.canonicalUrl !== item.canonicalUrl || document.url !== item.canonicalUrl) {
            throw new ResearchError('RESEARCH_SOURCE_MISMATCH', '正文来源与本次冻结候选不一致');
          }
          if (!document.text.trim()) throw new ResearchError('RESEARCH_DOCUMENT_EMPTY', '采集正文为空');
          const captured = Date.parse(document.collectedAt);
          if (!Number.isFinite(captured) || captured < started || captured > now().getTime() + 60_000) {
            throw new ResearchError('RESEARCH_STALE_DOCUMENT', '正文不是本次运行期间采集的证据');
          }
          if (document.sourceMetadata?.collectionJobId !== item.jobId) {
            throw new ResearchError('RESEARCH_LINEAGE_MISMATCH', '正文未绑定到本次采集任务');
          }
          if (item.stratum !== 'hot' && document.publishedAt) {
            const published = Date.parse(document.publishedAt);
            if (!Number.isFinite(published) || published < cutoff || published > started) {
              throw new ResearchError('RESEARCH_DATE_OUTSIDE_WINDOW', '详情发布时间不在冻结的最新样本窗口内');
            }
          }
          const snapshotPath = join(runRoot, 'sources', `${digest(item.canonicalUrl).slice(0, 16)}.json`);
          await privateJson(snapshotPath, stored);
          item.snapshotPath = snapshotPath;
          item.sha256 = digest(await readFile(snapshotPath));
          terminal = true;
          if (document.truncated === true) {
            // Keep the accessible preview as exclusion evidence, never as a complete sample.
            item.status = 'excluded';
            item.exclusionReason = /剩余\s*\d{1,3}\s*%\s*内容|订阅专栏|付费后|购买后/u.test(document.text) ? 'paywalled' : 'truncated';
            if (item.stratum !== 'hot') {
              const replacement = pools[item.stratum].find(c => !selected.has(c.canonicalUrl));
              if (!replacement || run.items.length >= MAX_RESEARCH_DETAILS) {
                throw new ResearchError('RESEARCH_TARGET_UNAVAILABLE','本轮冻结候选中可完整读取的讨论不足目标，已保留排除证据');
              }
              const appended = candidateItem(replacement,item.stratum);
              selected.set(appended.canonicalUrl,appended);
              run.items.push(appended);
            }
          } else item.status = 'saved';
          break;
        }
        await sleep(300);
      }
      if (!terminal) throw new ResearchError('RESEARCH_JOB_TIMEOUT', '帖子任务未在等待期限内完成，已停止本轮');
      await save();
      d.progress?.(`本轮完整正文 ${run.counts.saved} 篇，排除 ${run.counts.excluded} 篇，已检查 ${index + 1}/${run.items.length}`);
    }
    const savedIn = (s: Stratum): number => run.items.filter(i => i.status === 'saved' && i.stratum === s).length;
    run.status = savedIn('latest') === spec.latestTarget && savedIn('complaint') === spec.complaintTarget
      && run.counts.saved > 0 && run.items.every(i => i.status === 'saved' || i.status === 'excluded') ? 'completed' : 'completed_with_attention';
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof ResearchError ? { code: error.code, message: error.message }
      : { code: 'RESEARCH_COLLECTION_UNAVAILABLE', message: '调研采集未完成，请保留本轮证据并核查发现与详情阶段' };
    const active = run.items.find(item => item.status === 'collecting');
    if (active) { active.status = 'failed'; active.errorCode = run.error.code; }
  }
  run.finishedAt = now().toISOString();
  await save();
  return run;
}

export function parseResearchArgs(args: string[]): ResearchSpec {
  const queries: string[] = [], complaintQueries: string[] = [];
  const values = new Map<string, string>();
  const allowed = new Set(['--query', '--complaint-query', '--latest-target', '--complaint-target', '--days', '--idempotency-key', '--wait', '--hot-export', '--hot-observation']);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!flag || !allowed.has(flag) || !value || value.startsWith('--')) throw new Error('牛客私密调研参数无效');
    if (flag === '--query') queries.push(value);
    else if (flag === '--complaint-query') complaintQueries.push(value);
    else { if (values.has(flag)) throw new Error('调研参数重复'); values.set(flag, value); }
  }
  return specSchema.parse({ queries, complaintQueries, latestTarget: Number(values.get('--latest-target') ?? 30),
    complaintTarget: Number(values.get('--complaint-target') ?? 20), days: Number(values.get('--days') ?? 7),
    idempotencyKey: values.get('--idempotency-key'), waitMs: Number(values.get('--wait') ?? 1_800_000),
    ...(values.has('--hot-export') ? { hotExportPath: values.get('--hot-export') } : {}),
    ...(values.has('--hot-observation') ? { hotObservationPath: values.get('--hot-observation') } : {}) });
}
