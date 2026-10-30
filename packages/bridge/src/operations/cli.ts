import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { operationDraftImportSchema, operationIdSchema, operationPublishSchema } from '@data-collector/shared';

import { workflowKey, workflowRequestSchema } from './workflowStore.js';

interface OperationsIo { stdout(value: string): void; stderr(value: string): void }

export async function runOperationsCli(args: string[], credentials: { baseUrl: string; token: string }, io: OperationsIo): Promise<number> {
  const action = args[2];
  const values = new Map<string, string>();
  const allowed = new Set(['--source', '--id', '--file', '--port', '--config', '--library', '--query', '--limit', '--pages', '--revision', '--key', '--wait']);
  let send = false;
  for (let index = 3; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (key === '--send' && !send) { send = true; index--; continue; }
    if (!key || !allowed.has(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('牛客运营命令参数无效');
    values.set(key, value);
  }
  const actionOptions: Record<string, string[]> = { list: [], add: ['--source'], brief: ['--id'], draft: ['--file'], search: ['--query', '--limit'], context: ['--id', '--pages'], publish: ['--id', '--revision', '--key'], verify: ['--id', '--key', '--pages'], workflow: ['--file', '--id', '--wait'], stats: ['--id'] };
  if (!action || !actionOptions[action] || [...values.keys()].some(key => !['--port', '--config', '--library', ...actionOptions[action]!].includes(key)) || (send && action !== 'publish' && action !== 'workflow')) throw new Error('牛客运营命令参数无效');
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
  if (action === 'workflow') {
    if (values.has('--file') === values.has('--id')) throw new Error('workflow需要且仅需要 --file 或 --id');
    const wait = Number(values.get('--wait') ?? 0);
    if (!Number.isInteger(wait) || wait < 0 || wait > 3_600_000) throw new Error('--wait须为0–3600000毫秒');
    if (values.has('--file')) {
      const path = values.get('--file')!;
      if (!isAbsolute(path) || (await stat(path)).size > 256_000) throw new Error('批次需要256KB以内的本机绝对路径JSON文件');
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (raw?.kind === 'publish' && !send) throw new Error('发布批次必须显式 --send');
      const manifest = workflowRequestSchema.parse(raw);
      result = await request('/workflow', 'POST', { ...manifest, ...(send ? { send: true } : {}) });
    } else {
      if (send) throw new Error('查询原运行不接受 --send');
      result = await request(`/workflow/${workflowKey.parse(values.get('--id'))}`);
    }
    const deadline = Date.now() + wait;
    const running = () => ['running', 'queued'].includes((result as { status: string }).status);
    while (running() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      result = await request(`/workflow/${workflowKey.parse((result as { runId: string }).runId)}`);
    }
    if (wait > 0 && running()) {
      result = { ...(result as object), waitingTimedOut: true, query: `nowcoder ops workflow --id ${(result as { runId: string }).runId} --wait 600000`, message: '客户端等待到期；Bridge原批次仍继续，未取消，请查询原runId，勿新建补发' };
      io.stdout(`${JSON.stringify(result)}\n`); return 1;
    }
  } else if (action === 'stats' && values.has('--id')) {
    result = await request(`/workflow/${workflowKey.parse(values.get('--id'))}/stats`);
  } else if (action === 'search' && values.has('--query')) {
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
    throw new Error('用法：nowcoder ops workflow --file /absolute/request.private.json [--send] [--wait 600000] | workflow --id RUN_ID [--wait 600000] | stats --id RUN_ID | search --query 关键词 [--limit 10] | add --source ID | context --id ID [--pages 1] | brief --id ID | draft --file /absolute/draft.private.json | publish --id ID --revision N --key KEY --send | verify --id ID --key KEY [--pages 1] | list');
  }
  if ((action === 'add' || action === 'draft') && result && typeof result === 'object' && 'entry' in result) {
    const { body, conversation, ...entry } = (result as { entry: Record<string, unknown> }).entry;
    void body; void conversation; result = { entry };
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  return (action === 'workflow' && (result as { status: string }).status === 'needs_attention') ? 1 : 0;
}
