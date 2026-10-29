import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { operationDraftImportSchema, operationIdSchema, operationPublishSchema } from '@data-collector/shared';

interface OperationsIo { stdout(value: string): void; stderr(value: string): void }

export async function runOperationsCli(args: string[], credentials: { baseUrl: string; token: string }, io: OperationsIo): Promise<number> {
  const action = args[2];
  const values = new Map<string, string>();
  const allowed = new Set(['--source', '--id', '--file', '--port', '--config', '--library', '--query', '--limit', '--pages', '--revision', '--key']);
  let send = false;
  for (let index = 3; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (key === '--send' && !send) { send = true; index--; continue; }
    if (!key || !allowed.has(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('牛客运营命令参数无效');
    values.set(key, value);
  }
  const actionOptions: Record<string, string[]> = { list: [], add: ['--source'], brief: ['--id'], draft: ['--file'], search: ['--query', '--limit'], context: ['--id', '--pages'], publish: ['--id', '--revision', '--key'], verify: ['--id', '--key', '--pages'] };
  if (!action || !actionOptions[action] || [...values.keys()].some(key => !['--port', '--config', '--library', ...actionOptions[action]!].includes(key)) || (send && action !== 'publish')) throw new Error('牛客运营命令参数无效');
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${credentials.baseUrl}/v1/nowcoder/operations${path}`, {
      method, signal: AbortSignal.timeout(100_000),
      headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? `读取牛客运营记录失败：HTTP ${response.status}`);
    return result;
  };
  let result: unknown;
  if (action === 'search' && values.has('--query')) {
    const limit = Number(values.get('--limit') ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('搜索条数须为1–20');
    result = await request('/search', 'POST', { query: values.get('--query'), limit });
  } else if (action === 'context' && values.has('--id')) {
    const id = operationIdSchema.parse(values.get('--id')), maxPages = Number(values.get('--pages') ?? 1);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3) throw new Error('读取页数须为1–3');
    result = await request(`/${id}/context`, 'POST', { maxPages });
  } else if (action === 'verify' && values.has('--id') && values.has('--key')) {
    const id = operationIdSchema.parse(values.get('--id')), maxPages = Number(values.get('--pages') ?? 1);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3) throw new Error('读取页数须为1–3');
    result = await request(`/${id}/verify`, 'POST', { key: values.get('--key'), maxPages });
  } else if (action === 'publish' && values.has('--id')) {
    if (!send) throw new Error('发送评论必须显式提供 --send；请先审阅已保存的草稿');
    const id = operationIdSchema.parse(values.get('--id'));
    const stored = await request(`/${id}`) as { entry: { contextHash: string } };
    const input = operationPublishSchema.parse({ revision: Number(values.get('--revision')), contextHash: stored.entry.contextHash, key: values.get('--key'), send: true });
    result = await request(`/${id}/publish`, 'POST', input);
  } else if (action === 'list' && !values.has('--source') && !values.has('--id') && !values.has('--file')) {
    result = await request('');
  } else if (action === 'add' && values.has('--source') && !values.has('--id') && !values.has('--file')) {
    result = await request('', 'POST', { sourceId: values.get('--source') });
  } else if (action === 'brief' && values.has('--id') && !values.has('--source') && !values.has('--file')) {
    result = await request(`/${encodeURIComponent(values.get('--id')!)}?brief=1`);
  } else if (action === 'draft' && values.has('--file') && !values.has('--source') && !values.has('--id')) {
    const path = values.get('--file')!;
    if (!isAbsolute(path) || (await stat(path)).size > 64_000) throw new Error('草稿必须来自64KB以内的本机绝对路径JSON文件');
    const draft = operationDraftImportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    result = await request(`/${draft.opportunityId}`, 'PUT', { revision: draft.revision, contextHash: draft.contextHash, drafts: draft.drafts,
      ...(draft.conversationHash ? { conversationHash: draft.conversationHash } : {}) });
  } else {
    throw new Error('用法：nowcoder ops search --query 关键词 [--limit 10] | add --source ID | context --id ID [--pages 1] | brief --id ID | draft --file /absolute/draft.private.json | publish --id ID --revision N --key KEY --send | verify --id ID --key KEY [--pages 1] | list');
  }
  if ((action === 'add' || action === 'draft') && result && typeof result === 'object' && 'entry' in result) {
    const { body, conversation, ...entry } = (result as { entry: Record<string, unknown> }).entry;
    void body; void conversation; result = { entry };
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  return 0;
}
