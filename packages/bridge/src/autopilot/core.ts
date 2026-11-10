import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteText } from '../library/writer.js';

/**
 * Shared base for unattended publishing jobs (comments, articles, later other products).
 * A job is one short process: lock, load small private state, run one tick, log.
 * Scheduling and retries are code. The model is only called through codexJson, with a
 * fresh tool-free context. See docs/autopilot.md for how to add a channel.
 */
const STALE_LOCK_MS = 15 * 60_000, IDLE = new Set(['not_due', 'already_running', 'waiting']), HOUR = 3_600_000;
export interface JobResult { outcome: string; [key: string]: unknown }

/** One tick at most per machine. A dead or overdue holder cannot wedge the schedule. */
export async function withLock<T>(path: string, now: number, work: () => Promise<T>): Promise<T | undefined> {
  const acquire = async () => { const handle = await open(path, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); };
  try { await acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const [holder, info] = await Promise.all([readFile(path, 'utf8').catch(() => ''), stat(path).catch(() => undefined)]);
    let alive = false;
    try { process.kill(Number(holder), 0); alive = Number(holder) > 0; } catch { alive = false; }
    if (alive && info && now - info.mtimeMs < STALE_LOCK_MS) return undefined;
    await rm(path, { force: true }); await acquire();
  }
  try { return await work(); } finally { await rm(path, { force: true }); }
}

/** Fresh ephemeral Codex process: no user config, no MCP, no history, read-only sandbox, hard timeout. */
export async function codexJson<T>(prompt: string, jsonSchema: object, options: { binary?: string; model?: string; effort?: string; timeoutMs?: number } = {}): Promise<{ value: T; usage?: unknown }> {
  const dir = await mkdtemp(join(tmpdir(), 'nowcoder-draft-'));
  try {
    const schema = join(dir, 'schema.json'), output = join(dir, 'out.json');
    await writeFile(schema, JSON.stringify(jsonSchema));
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', dir,
      '-m', options.model ?? process.env.NOWCODER_AUTOPILOT_MODEL ?? 'gpt-6.1-sol', '-c', `model_reasoning_effort="${options.effort ?? 'medium'}"`, '--output-schema', schema, '-o', output, '--json', '-'];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(options.binary ?? process.env.NOWCODER_AUTOPILOT_CODEX ?? `${process.env.HOME}/.local/bin/codex`, args, { stdio: ['pipe', 'pipe', 'ignore'] });
      let text = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('起草超时')); }, options.timeoutMs ?? 180_000);
      child.stdout.on('data', chunk => { text += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(text); else reject(new Error(`起草进程退出 ${code}`)); });
      child.stdin.end(prompt);
    });
    const usage = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as { type?: string; usage?: unknown }; } catch { return {}; } }).find(event => event.type === 'turn.completed')?.usage;
    return { value: JSON.parse(await readFile(output, 'utf8')) as T, ...(usage ? { usage } : {}) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export const macNotify = (message: string) => new Promise<void>(resolve => {
  const child = spawn('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title "牛客评论运行器"`], { stdio: 'ignore' });
  child.on('close', () => resolve()); child.on('error', () => resolve());
});

/**
 * Email settings the user fills in themselves (`<config>/notify-email.json`, mode 0600):
 * {"smtpUrl":"smtps://smtp.gmail.com:465","user":"...","password":"<app password>","from":"...","to":"..."}.
 * The password goes to curl through stdin, never through process arguments.
 */
export interface EmailSettings { smtpUrl: string; user: string; password: string; from: string; to: string }
export function curlEmailConfig(settings: EmailSettings, bodyPath: string): string {
  const quote = (value: string) => `"${value.replace(/[\\"]/gu, ch => `\\${ch}`)}"`;
  return [`url = ${quote(settings.smtpUrl)}`, `user = ${quote(`${settings.user}:${settings.password}`)}`, `mail-from = ${quote(settings.from)}`,
    `mail-rcpt = ${quote(settings.to)}`, `upload-file = ${quote(bodyPath)}`, 'ssl-reqd', 'silent', 'show-error', 'max-time = 30'].join('\n');
}
export function emailMessage(settings: EmailSettings, subject: string, text: string, now: Date): string {
  const encoded = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  return [`From: ${settings.from}`, `To: ${settings.to}`, `Subject: ${encoded}`, `Date: ${now.toUTCString()}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(text).toString('base64').replace(/.{76}/gu, '$&\r\n')].join('\r\n');
}
export async function sendEmail(configDir: string, subject: string, text: string): Promise<'sent' | 'not_configured' | 'failed'> {
  const settings = await readFile(join(configDir, 'notify-email.json'), 'utf8').then(raw => JSON.parse(raw) as EmailSettings, () => undefined);
  if (!settings?.smtpUrl || !settings.to) return 'not_configured';
  const dir = await mkdtemp(join(tmpdir(), 'notify-')), body = join(dir, 'mail.eml');
  try {
    await writeFile(body, emailMessage(settings, subject, text, new Date()), { mode: 0o600 });
    return await new Promise(resolve => {
      const child = spawn('/usr/bin/curl', ['-K', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', code => resolve(code === 0 ? 'sent' : 'failed')); child.on('error', () => resolve('failed'));
      child.stdin.end(curlEmailConfig(settings, body));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
/**
 * Preferred route: the fe-journey-faas alert mailer (`POST /pos/notify/alert`), so no SMTP secret lives on this Mac.
 * `<config>/notify-faas.json` = {"token":"<HEALTH_API_TOKEN>"}; the token goes to curl through stdin.
 */
export const FAAS_ALERT_URL = 'https://fe-journey-main-ktantdfjcs.cn-hangzhou.fcapp.run/pos/notify/alert';
export async function sendFaasAlert(configDir: string, subject: string, text: string): Promise<'sent' | 'not_configured' | 'failed'> {
  const settings = await readFile(join(configDir, 'notify-faas.json'), 'utf8').then(raw => JSON.parse(raw) as { token?: string; url?: string }, () => undefined);
  if (!settings?.token) return 'not_configured';
  const quote = (value: string) => `"${value.replace(/[\\"]/gu, ch => `\\${ch}`)}"`;
  const config = [`url = ${quote(settings.url ?? FAAS_ALERT_URL)}`, `header = ${quote(`X-Health-Token: ${settings.token}`)}`, 'header = "Content-Type: application/json"',
    `data = ${quote(JSON.stringify({ subject, text }))}`, 'silent', 'max-time = 30'].join('\n');
  return new Promise(resolve => {
    let out = '';
    const child = spawn('/usr/bin/curl', ['-K', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', () => { try { resolve((JSON.parse(out) as { data?: { status?: string } }).data?.status === 'sent' ? 'sent' : 'failed'); } catch { resolve('failed'); } });
    child.on('error', () => resolve('failed'));
    child.stdin.end(config);
  });
}
/** Blockers that need the user: desktop notification plus email when configured. Every caller already dedupes per event. */
export const notifyUser = (configDir: string) => async (message: string): Promise<void> => {
  await macNotify(message);
  const subject = `牛客运营需要你处理：${message.slice(0, 40)}`, body = `${message}\n\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n状态：node packages/bridge/dist/cli.js nowcoder ops autopilot-status`;
  const viaFaas = await sendFaasAlert(configDir, subject, body);
  const outcome = viaFaas === 'not_configured' ? await sendEmail(configDir, subject, body) : `faas:${viaFaas}`;
  await appendFile(join(configDir, 'nowcoder-autopilot', 'notify.log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), message, email: outcome })}\n`, { mode: 0o600 }).catch(() => undefined);
};


export async function runJob<S, R extends JobResult>(input: { configDir: string; name: string; now: () => number; initial(): Promise<S>; tick(state: S, save: (state: S) => Promise<void>): Promise<R>; watch?: (message: string) => Promise<void> }): Promise<R | JobResult> {
  const root = join(input.configDir, 'nowcoder-autopilot'), path = join(root, `${input.name}.json`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const result: R | JobResult = await withLock(join(root, `${input.name}.lock`), input.now(), async () => {
    const state: S = await readFile(path, 'utf8').then(async raw => ({ ...await input.initial(), ...JSON.parse(raw) as S }), async (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return input.initial(); throw error; });
    return input.tick(state, next => atomicWriteText(root, path, `${JSON.stringify(next)}\n`)).catch((error: unknown): JobResult => ({ outcome: 'technical_failure', detail: error instanceof Error ? error.message : 'unknown' }));
  }) ?? { outcome: 'already_running' };
  if (!IDLE.has(result.outcome)) await appendFile(join(root, `${input.name}.log.jsonl`), `${JSON.stringify({ at: new Date(input.now()).toISOString(), ...result })}\n`, { mode: 0o600 });
  if (input.watch) await watchJobs(root, input.now(), input.watch).catch(() => undefined);
  return result;
}

export interface JobStatus { job: string; outcomes: Record<string, number>; tokens: number; lastSuccessAt: string | null; lastFailure: string | null }
const LIMITS: Record<string, { tokensPerDay: number; quietMs?: number }> = { comments: { tokensPerDay: 3_000_000, quietMs: 3 * HOUR }, articles: { tokensPerDay: 1_000_000 }, collection: { tokensPerDay: 60_000_000 } };

/** Last 24 hours per job, read from the logs. */
export async function jobStatus(root: string, now: number): Promise<JobStatus[]> {
  const out: JobStatus[] = [];
  for (const file of (await readdir(root).catch(() => [] as string[])).filter(name => name.endsWith('.log.jsonl') && !name.includes('dry-run')).sort()) {
    const status: JobStatus = { job: file.replace('.log.jsonl', ''), outcomes: {}, tokens: 0, lastSuccessAt: null, lastFailure: null };
    for (const line of (await readFile(join(root, file), 'utf8')).split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as { at: string; outcome: string; detail?: string; tokens?: number; usage?: { input_tokens?: number; output_tokens?: number } };
      if (now - Date.parse(entry.at) > 24 * HOUR) continue;
      status.outcomes[entry.outcome] = (status.outcomes[entry.outcome] ?? 0) + 1;
      status.tokens += entry.tokens ?? (entry.usage?.input_tokens ?? 0) + (entry.usage?.output_tokens ?? 0);
      if (entry.outcome === 'published' || entry.outcome === 'finished') status.lastSuccessAt = entry.at;
      if (['technical_failure', 'failed', 'time_limit', 'token_limit', 'isolated_uncertain', 'gave_up'].includes(entry.outcome)) status.lastFailure = `${entry.outcome}${entry.detail ? `: ${entry.detail}` : ''}`;
    }
    out.push(status);
  }
  return out;
}

export function jobIssues(statuses: JobStatus[], now: number): string[] {
  const issues: string[] = [], shanghaiHour = new Date(now + 8 * HOUR).getUTCHours();
  for (const status of statuses) {
    const limit = LIMITS[status.job]; if (!limit) continue;
    if (status.tokens > limit.tokensPerDay) issues.push(`${status.job} 24 小时用了 ${Math.round(status.tokens / 1e4) / 100}M token，超过预期`);
    const failures = (status.outcomes.technical_failure ?? 0) + (status.outcomes.failed ?? 0) + (status.outcomes.time_limit ?? 0);
    if (failures >= 5) issues.push(`${status.job} 24 小时失败 ${failures} 次，最近：${status.lastFailure ?? '未知'}`);
    // Quota waits are normal silence; quiet counts when something failed or the runner kept finding nothing (2026-11-10 stall).
    if (limit.quietMs && shanghaiHour >= 11 && shanghaiHour < 23 && (status.lastFailure || (status.outcomes.no_opportunity ?? 0) + (status.outcomes.no_lead_post ?? 0) >= 20) && (!status.lastSuccessAt || now - Date.parse(status.lastSuccessAt) > limit.quietMs)) issues.push(`${status.job} 超过 ${limit.quietMs / HOUR} 小时没有成功`);
  }
  return issues;
}

/** Runs at most hourly from a live job, so stalls and token waste surface without anyone watching. */
async function watchJobs(root: string, now: number, notify: (message: string) => Promise<void>): Promise<void> {
  const path = join(root, 'watch.json');
  const last = await readFile(path, 'utf8').then(raw => JSON.parse(raw) as { at: number; seen: string[] }, () => ({ at: 0, seen: [] as string[] }));
  if (now - last.at < HOUR) return;
  const issues = jobIssues(await jobStatus(root, now), now), fresh = issues.filter(issue => !last.seen.includes(issue.split(' ').slice(0, 2).join(' ')));
  await atomicWriteText(root, path, JSON.stringify({ at: now, seen: issues.map(issue => issue.split(' ').slice(0, 2).join(' ')) }));
  if (fresh.length) await notify(fresh.join('；'));
}
