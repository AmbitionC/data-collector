#!/usr/bin/env node
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function stop(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const rawRepo = option('--repo');
const batch = option('--batch');
const source = option('--source');
if (!rawRepo || !batch || !source) {
  stop('用法：inbox-manifest.mjs --repo <path> --batch <id> --source <zsxq|nowcoder>');
} else if (source !== 'zsxq' && source !== 'nowcoder') {
  stop('--source 必须是 zsxq 或 nowcoder');
} else {
  const repo = resolve(rawRepo);
  const repoReal = await realpath(repo);
  const inbox = join(repoReal, '_inbox', source);
  const matched = [];
  const blocked = [];
  const malformed = [];
  let names = [];
  try {
    names = (await readdir(inbox, { withFileTypes: true }))
      .filter(item => item.isDirectory() || item.isSymbolicLink())
      .map(item => item.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  for (const name of names) {
    const requestedPath = join(inbox, name, 'meta.json');
    const displayPath = relative(repoReal, requestedPath);
    let metaPath;
    try {
      metaPath = await realpath(requestedPath);
      const inside = relative(repoReal, metaPath);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        malformed.push({ path: displayPath, reason: 'meta.json 指向仓库外部' });
        continue;
      }
    } catch (error) {
      malformed.push({ path: displayPath, reason: `meta.json 不可读：${error?.code ?? 'UNKNOWN'}` });
      continue;
    }

    let meta;
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {
      malformed.push({ path: displayPath, reason: 'meta.json 不是有效 JSON' });
      continue;
    }
    const manifestBatch = source === 'nowcoder'
      ? (meta?.sourceMetadata?.deliveryBatchId ?? meta?.sourceMetadata?.batchId)
      : meta?.sourceMetadata?.batchId;
    if (manifestBatch !== batch) continue;
    if (meta?.source !== source || typeof meta?.id !== 'string' || !/^[a-f0-9]{12}$/.test(meta.id)) {
      malformed.push({ path: displayPath, reason: '当前批次条目的 source 或 id 无效' });
      continue;
    }
    const item = {
      id: meta.id,
      title: typeof meta.title === 'string' ? meta.title : '',
      path: relative(repoReal, join(inbox, name)),
    };
    let reason;
    if (meta.truncated === true) reason = '正文被截断';
    else if (source === 'zsxq' && meta.sourceMetadata?.authorRole !== 'owner') reason = '非星主内容';
    else if (source === 'nowcoder' && meta.sourceMetadata?.evidenceGrade !== 'A' &&
      meta.sourceMetadata?.evidenceGrade !== 'B') reason = '牛客证据等级不是 A/B';
    if (reason) blocked.push({ ...item, reason });
    else matched.push(item);
  }

  const byPath = (left, right) => left.path.localeCompare(right.path);
  matched.sort(byPath);
  blocked.sort(byPath);
  malformed.sort(byPath);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    repo: repoReal,
    batch,
    source,
    matched,
    blocked,
    malformed,
  })}\n`);
}
