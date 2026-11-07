import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { runArticleAutopilot } from './autopilot.js';
import { articleIdSchema, articleImportSchema, articlePublishSchema, browserFamilySchema, nowcoderAccountIdSchema } from '@data-collector/shared';

interface Io { stdout(value: string): void; stderr(value: string): void }
const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u);
export async function runArticlesCli(args: string[], credentials: { baseUrl: string; token: string }, io: Io): Promise<number> {
  const action = args[2], values = new Map<string, string>(); let send = false;
  const options: Record<string, string[]> = { list: [], runtime: [], limits: [], draft: ['--file'], preview: ['--id'],
    account: ['--browser', '--account'], publish: ['--id', '--revision', '--key', '--browser', '--account'], verify: ['--id', '--key'], autopilot: [] };
  if (!action || !options[action]) throw new Error('用法：nowcoder articles <list|runtime|limits|draft|account|preview|publish|verify|autopilot>');
  for (let i = 3; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--send' && (action === 'publish' || action === 'autopilot') && !send) { send = true; continue; }
    if (![...options[action]!, '--port', '--config', '--library'].includes(flag) || values.has(flag) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('牛客文章命令参数无效');
    values.set(flag, args[++i]!);
  }
  // Complete syntactic admission before the first HTTP request.
  for (const flag of options[action]!) if (!values.has(flag)) throw new Error(`缺少参数：${flag}`);
  const id = values.has('--id') ? articleIdSchema.parse(values.get('--id')) : undefined;
  const key = values.has('--key') ? keySchema.parse(values.get('--key')) : undefined;
  const browser = values.has('--browser') ? browserFamilySchema.parse(values.get('--browser')) : undefined;
  const accountId = values.has('--account') ? nowcoderAccountIdSchema.parse(values.get('--account')) : undefined;
  const revision = values.has('--revision') ? z.number().int().positive().parse(Number(values.get('--revision'))) : undefined;
  if (action === 'publish' && !send) throw new Error('发布文章必须显式 --send；请先核对正文、浏览器和账号');
  const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetch(`${credentials.baseUrl}/v1/nowcoder/articles${path}`, { method,
      signal: AbortSignal.timeout(100_000), headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? `文章操作失败：HTTP ${response.status}`);
    return result;
  };
  let result: any;
  if (action === 'autopilot') {
    // Without --send this imports and previews one draft; it never reaches the publish endpoint.
    const watchdog = setTimeout(() => process.exit(3), 12 * 60_000); watchdog.unref();
    result = await runArticleAutopilot({ configDir: loadConfig(values.has('--config') ? { configDir: values.get('--config')! } : {}).configDir, live: send, api: request });
    clearTimeout(watchdog);
  } else if (action === 'draft') {
    const file = values.get('--file')!;
    if (!isAbsolute(file) || (await stat(file)).size > 128_000) throw new Error('草稿须为128KB以内的本机绝对路径JSON文件');
    result = await request('', 'POST', articleImportSchema.parse(JSON.parse(await readFile(file, 'utf8'))));
    if (result.entry) { const { body: _body, ...entry } = result.entry; result = { entry }; }
  } else if (action === 'publish') {
    const saved = await request(`/${id}`);
    result = await request(`/${id}/publish`, 'POST', articlePublishSchema.parse({ revision, contentHash: saved.entry.contentHash, key, browser, accountId, send: true }));
  } else if (action === 'preview') result = await request(`/${id}/preview`, 'POST', {});
  else if (action === 'account') result = await request('/account', 'POST', { browser, accountId });
  else if (action === 'verify') result = await request(`/${id}/verify`, 'POST', { key });
  else result = await request(action === 'list' ? '' : `/${action}`);
  io.stdout(`${JSON.stringify(result)}\n`);
  return result?.attention || result?.kind === 'attention' || (['publish', 'verify'].includes(action) && result?.publication?.state !== 'published') ? 1 : 0;
}
