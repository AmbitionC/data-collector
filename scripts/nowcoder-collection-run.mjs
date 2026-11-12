#!/usr/bin/env node
// One interview-collection run in a fresh Codex session. It shares no context with
// comments or articles: the only memory between runs is a small private handoff file.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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
const started = Date.now();
let tokens = 0, stopped;
const child = spawn(binary, ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--cd', join(homedir(), 'code/data-collector'), '-c', 'model_reasoning_effort="high"', '--json', '-'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
// Signal the whole group: a surviving grandchild would otherwise keep stdout open and wedge this run.
const killGroup = signal => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
const stop = reason => { stopped ??= reason; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 10_000); };
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
child.on('exit', code => {
  clearTimeout(timer); killGroup('SIGKILL'); rmSync(lock, { force: true });
  const outcome = stopped ?? (code === 0 ? 'finished' : 'failed');
  record({ outcome, code, tokens, elapsedMs: Date.now() - started });
  // The session marks anything only the user can unblock with a 需要用户： line; alert once per distinct line.
  const need = (existsSync(handoff) ? readFileSync(handoff, 'utf8') : '').split('\n').find(line => line.startsWith('需要用户：'));
  const lastPath = join(root, 'collection.alerted.txt'), last = existsSync(lastPath) ? readFileSync(lastPath, 'utf8') : '';
  const alert = need && need !== last ? need : outcome !== 'finished' ? `面经采集本轮异常结束：${outcome}` : undefined;
  const done = () => process.exit(code === 0 && !stopped ? 0 : 1);
  if (!alert) done();
  else notifyUser(join(homedir(), '.data-collector'))(alert).finally(() => { if (need) appendFileSync(lastPath, '', { mode: 0o600 }), writeFileSync(lastPath, need); done(); });
});
