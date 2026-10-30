#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

// Offline only. Never render JSONL content or host-model metadata to stdout/stderr.
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--file' || !isAbsolute(args[1])) throw new Error('需要 --file /absolute/measurement.private.json');
  if ((await stat(args[1])).size > 64_000) throw new Error('measurement文件超过64KB');
  let input;
  try { input = JSON.parse(await readFile(args[1], 'utf8')); } catch { throw new Error('measurement JSON无效'); }
  if (!input || Object.keys(input).some(k => !['sessionPaths', 'from', 'to'].includes(k)) || !Array.isArray(input.sessionPaths) || !input.sessionPaths.length || input.sessionPaths.length > 100 || !input.sessionPaths.every(p => typeof p === 'string' && isAbsolute(p)) || !iso(input.from) || !iso(input.to) || Date.parse(input.from) > Date.parse(input.to)) throw new Error('measurement需要绝对sessionPaths及有效from/to ISO范围');
  const seen = new Map();
  const result = { from: input.from, to: input.to, rangeInclusive: true, responses: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  for (let fileIndex = 0; fileIndex < input.sessionPaths.length; fileIndex++) {
    const lines = createInterface({ input: createReadStream(input.sessionPaths[fileIndex]), crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        let record; try { record = JSON.parse(line); } catch { throw new Error(`session ${fileIndex + 1} line ${lineNumber}: JSON无效`); }
        if (record.type !== 'token_usage_record') continue;
        if (!iso(record.timestamp)) throw new Error(`session ${fileIndex + 1} line ${lineNumber}: usage时间缺失或无效`);
        const timestamp = Date.parse(record.timestamp);
        if (timestamp < Date.parse(input.from) || timestamp > Date.parse(input.to)) continue;
        const id = record.payload?.response_id, usage = record.payload?.usage;
        const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
        if (typeof id !== 'string' || !id.trim() || !usage || fields.some(k => !Number.isSafeInteger(usage[k]) || usage[k] < 0) || usage.cached_input_tokens > usage.input_tokens || usage.reasoning_output_tokens > usage.output_tokens || usage.total_tokens !== usage.input_tokens + usage.output_tokens) throw new Error(`session ${fileIndex + 1} line ${lineNumber}: usage token字段缺失或不一致`);
        const signature = JSON.stringify(fields.map(k => usage[k]));
        if (seen.has(id)) { if (seen.get(id) !== signature) throw new Error('duplicate response_id的usage不一致'); continue; }
        seen.set(id, signature);
        result.responses++; result.inputTokens += usage.input_tokens; result.cachedInputTokens += usage.cached_input_tokens;
        result.uncachedInputTokens += usage.input_tokens - usage.cached_input_tokens; result.outputTokens += usage.output_tokens;
        result.reasoningOutputTokens += usage.reasoning_output_tokens; result.totalTokens += usage.total_tokens;
        if (Object.values(result).some(v => typeof v === 'number' && !Number.isSafeInteger(v))) throw new Error('token汇总超过安全整数范围');
      }
    } catch (error) {
      if (error?.code) throw new Error(`session ${fileIndex + 1}: 读取失败`);
      throw error;
    } finally { lines.close(); }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
