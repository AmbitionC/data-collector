#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalSkill = resolve(scriptDirectory, '..', 'SKILL.md');
await readFile(canonicalSkill, 'utf8');
const defaultRoot = process.env.CODEX_HOME
  ? join(process.env.CODEX_HOME, 'skills')
  : join(homedir(), '.codex', 'skills');
const targetRoot = resolve(option('--target-root') ?? defaultRoot);
const targetDirectory = join(targetRoot, 'data-collector-delivery');
const target = join(targetDirectory, 'SKILL.md');
const contents = `---
name: data-collector-delivery
description: Use when the user asks to collect or deliver Chen Teacher ZSXQ content, update Agent Journey from Nowcoder interview posts, or prepare Nowcoder operation-topic candidates.
---

# Data Collector Delivery

The repository copy is the only source of truth. Read and follow [the canonical skill](${canonicalSkill}) completely before taking delivery actions. Resolve all relative references and scripts from that canonical skill directory.
`;

await mkdir(targetDirectory, { recursive: true });
let changed = true;
try {
  changed = await readFile(target, 'utf8') !== contents;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (changed) await writeFile(target, contents, 'utf8');
process.stdout.write(`${JSON.stringify({ path: target, canonicalSkill, changed })}\n`);
