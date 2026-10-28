import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { operationDraftImportSchema } from '@data-collector/shared';

interface OperationsIo { stdout(value: string): void; stderr(value: string): void }

export async function runOperationsCli(args: string[], credentials: { baseUrl: string; token: string }, io: OperationsIo): Promise<number> {
  const action = args[2];
  const values = new Map<string, string>();
  const allowed = new Set(['--source', '--id', '--file', '--port', '--config', '--library']);
  for (let index = 3; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('牛客运营命令参数无效');
    values.set(key, value);
  }
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${credentials.baseUrl}/v1/nowcoder/operations${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? `读取牛客运营记录失败：HTTP ${response.status}`);
    return result;
  };
  let result: unknown;
  if (action === 'list' && !values.has('--source') && !values.has('--id') && !values.has('--file')) {
    result = await request('');
  } else if (action === 'add' && values.has('--source') && !values.has('--id') && !values.has('--file')) {
    result = await request('', 'POST', { sourceId: values.get('--source') });
  } else if (action === 'brief' && values.has('--id') && !values.has('--source') && !values.has('--file')) {
    result = await request(`/${encodeURIComponent(values.get('--id')!)}?brief=1`);
  } else if (action === 'draft' && values.has('--file') && !values.has('--source') && !values.has('--id')) {
    const path = values.get('--file')!;
    if (!isAbsolute(path) || (await stat(path)).size > 64_000) throw new Error('草稿必须来自64KB以内的本机绝对路径JSON文件');
    const draft = operationDraftImportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    result = await request(`/${draft.opportunityId}`, 'PUT', { revision: draft.revision, contextHash: draft.contextHash, drafts: draft.drafts });
  } else {
    throw new Error('用法：nowcoder ops list | add --source ID | brief --id ID | draft --file /absolute/draft.private.json');
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  return 0;
}
