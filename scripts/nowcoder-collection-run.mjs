#!/usr/bin/env node
// One interview-collection run in a fresh Codex session. It shares no context with
// comments or articles: the only memory between runs is a small private handoff file.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { notifyUser } from '../packages/bridge/dist/autopilot/core.js';

const root = process.env.NOWCODER_AUTOPILOT_DIR ?? join(homedir(), '.data-collector/nowcoder-autopilot');
const binary = process.env.NOWCODER_AUTOPILOT_CODEX ?? join(homedir(), '.local/bin/codex');
const maxMs = Number(process.env.NOWCODER_COLLECTION_MAX_MS ?? 120 * 60_000);
const maxTokens = Number(process.env.NOWCODER_COLLECTION_MAX_TOKENS ?? 80_000_000);
const lock = join(root, 'collection.lock'), handoff = join(root, 'collection.handoff.md'), log = join(root, 'collection.log.jsonl');
const record = entry => appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });

if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < maxMs + 10 * 60_000) { record({ outcome: 'already_running' }); process.exit(0); }
rmSync(lock, { force: true });
const fd = openSync(lock, 'wx', 0o600); writeSync(fd, String(process.pid)); closeSync(fd);

const previous = existsSync(handoff) ? readFileSync(handoff, 'utf8').slice(0, 4000) : '（首次运行，没有交接）';
const prompt = `${readFileSync(join(root, 'collection.prompt.md'), 'utf8')}\n\n<previous_handoff>\n${previous}\n</previous_handoff>`;
// 2026-11-24 user: a dropped connection must not cost the whole slot. A session that dies within minutes is
// started again after a pause; one that worked for a while is left for the next schedule, with its handoff.
const quickFailureMs = 10 * 60_000;
const retryDelays = (process.env.NOWCODER_COLLECTION_RETRY_MS ?? '300000,600000,1200000,1800000').split(',').map(Number);
const attemptRun = () => new Promise(resolve => {
const started = Date.now();
let tokens = 0, stopped;
const child = spawn(binary, ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--cd', join(homedir(), 'code/data-collector'), '-c', 'model_reasoning_effort="high"', '--json', '-'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
// Signal the whole group: a surviving grandchild would otherwise keep stdout open and wedge this run.
const killGroup = signal => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
const stop = reason => { stopped ??= reason; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 10_000).unref(); };
const timer = setTimeout(() => stop('time_limit'), maxMs);
let pending = '';
child.stdout.on('data', chunk => {
  const lines = (pending + chunk).split('\n'); pending = lines.pop();
  for (const line of lines) {
    try { const event = JSON.parse(line); if (event.type === 'turn.completed') tokens += (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0); } catch { continue; }
    if (tokens > maxTokens) stop('token_limit');
  }
});
child.stdin.end(prompt);
child.on('error', error => { clearTimeout(timer); resolve({ outcome: 'failed', code: null, tokens, elapsedMs: Date.now() - started, detail: error.message }); });
child.on('exit', code => {
  clearTimeout(timer); killGroup('SIGKILL');
  resolve({ outcome: stopped ?? (code === 0 ? 'finished' : 'failed'), code, tokens, elapsedMs: Date.now() - started });
});
});

let result;
for (let attempt = 0; ; attempt++) {
  utimesSync(lock, new Date(), new Date());
  result = await attemptRun();
  record({ ...result, attempt });
  if (result.outcome !== 'failed' || result.elapsedMs >= quickFailureMs || attempt >= retryDelays.length) break;
  await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
}
rmSync(lock, { force: true });
// The session marks anything only the user can unblock with a 需要用户： line; alert once per distinct line.
const need = (existsSync(handoff) ? readFileSync(handoff, 'utf8') : '').split('\n').find(line => line.startsWith('需要用户：'));
const lastPath = join(root, 'collection.alerted.txt'), last = existsSync(lastPath) ? readFileSync(lastPath, 'utf8') : '';
const alert = need && need !== last ? need : result.outcome !== 'finished' ? `面经采集本轮异常结束：${result.outcome}` : undefined;
if (alert) { await notifyUser(join(homedir(), '.data-collector'))(alert).catch(() => undefined); if (need) writeFileSync(lastPath, need, { mode: 0o600 }); }
process.exit(result.outcome === 'finished' ? 0 : 1);
