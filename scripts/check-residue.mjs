#!/usr/bin/env node
/**
 * 查一遍「清空」之后本机还剩什么。**只读，不删任何东西**。
 *
 * 侧栏那颗「清空」只删得掉**目录索引里有的**条目（`clearLibrary` 是照着
 * `_catalog/index.json` 一条条删的）。因此至少三类东西它碰不到，得单独看：
 *
 * - **孤儿目录**：写进磁盘了但没进索引（写到一半崩过、或旧版本留下的布局）。
 *   索引里没有 → 清空时压根不知道它存在 → 静默留在库里。
 * - **`.tmp` 残片**：`atomicWriteText` 是「写临时文件再 rename」，中途挂掉就留一个
 *   `<文件>.<pid>.<随机>.tmp`，同样不在索引里。
 * - **已经同步出去的收件箱条目**：清空只管本机库，`<仓库>/_inbox/` 里的东西已经
 *   commit 进 git 了，本机库清空**不会**、也不该把它们带走——但你重采之前得知道它们还在，
 *   否则 Agent 会把上一轮的东西再归档一遍。
 *
 * 用法：node scripts/check-residue.mjs
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 这个脚本是你在终端里手跑的，PATH 是你自己的那份，裸 git 解析得对。
// （本机服务不一样——它是登录项，PATH 很窄，所以那边要探绝对路径，见 packages/bridge/src/git.ts。）
async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000 });
    return stdout;
  } catch {
    return undefined;
  }
}

function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

const LIBRARY_ROOT = expandHome(process.env.DATA_COLLECTOR_LIBRARY ?? '~/Documents/data-collector');
// 与 packages/bridge/src/sinks/config.ts 的 BUILT_IN_TARGETS 保持一致。
const REPOS = [
  { id: 'life-teachers', path: expandHome('~/code/life-teachers') },
  { id: 'fe-journey', path: expandHome('~/code/front-end-journey-resource') },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 递归列出所有文件（返回绝对路径）。读不动的目录跳过，不让整个检查挂掉。 */
async function walk(directory, out = []) {
  let names;
  try {
    names = await readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of names) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await walk(path, out);
    else out.push(path);
  }
  return out;
}

function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function sizeOf(paths) {
  let total = 0;
  for (const path of paths) {
    try {
      total += (await stat(path)).size;
    } catch {
      /* 文件刚好没了，忽略 */
    }
  }
  return total;
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

async function checkLibrary() {
  section(`本机库  ${LIBRARY_ROOT}`);
  if (!(await exists(LIBRARY_ROOT))) {
    console.log('目录不存在 —— 干净（一条都没有）。');
    return;
  }

  let catalog = [];
  let catalogReadable = true;
  try {
    const raw = await readFile(join(LIBRARY_ROOT, '_catalog', 'index.json'), 'utf8');
    const parsed = JSON.parse(raw);
    catalog = Array.isArray(parsed) ? parsed : [];
  } catch {
    catalogReadable = await exists(join(LIBRARY_ROOT, '_catalog', 'index.json'));
  }
  if (!catalogReadable) {
    console.log('⚠️  索引 _catalog/index.json 读不出来（损坏或格式不对）。');
    console.log('    这很要紧：清空是照着索引删的，索引读不出来就等于「一条都删不掉」。');
  }
  console.log(`索引里还有 ${catalog.length} 条。`);

  const files = await walk(LIBRARY_ROOT);
  const catalogDirs = catalog
    .filter(entry => typeof entry?.relativePath === 'string')
    .map(entry => `${dirname(join(LIBRARY_ROOT, entry.relativePath))}/`);

  const inCatalog = path => catalogDirs.some(directory => path.startsWith(directory));
  const metaPrefix = `${join(LIBRARY_ROOT, '_catalog')}/`;

  const orphans = files.filter(
    path => !path.startsWith(metaPrefix) && !inCatalog(path) && !path.endsWith('.tmp'),
  );
  const temporaries = files.filter(path => path.endsWith('.tmp'));

  // 索引里有、文件却没了：清空时会照样从索引清掉，但现在能看出来对不上。
  const zombies = [];
  for (const entry of catalog) {
    if (typeof entry?.relativePath !== 'string') continue;
    if (!(await exists(join(LIBRARY_ROOT, entry.relativePath)))) zombies.push(entry);
  }

  if (orphans.length === 0) {
    console.log('✅ 没有孤儿文件（索引之外没有残留正文/图片）。');
  } else {
    console.log(`❌ 孤儿文件 ${orphans.length} 个，共 ${bytes(await sizeOf(orphans))} ——`);
    console.log('   它们不在索引里，所以「清空」删不到，会一直留着。');
    const directories = [...new Set(orphans.map(path => dirname(path)))].sort();
    for (const directory of directories.slice(0, 20)) {
      console.log(`   · ${relative(LIBRARY_ROOT, directory)}`);
    }
    if (directories.length > 20) console.log(`   · …还有 ${directories.length - 20} 个目录`);
  }

  if (temporaries.length > 0) {
    console.log(`❌ 写到一半的 .tmp 残片 ${temporaries.length} 个：`);
    for (const path of temporaries.slice(0, 10)) {
      console.log(`   · ${relative(LIBRARY_ROOT, path)}`);
    }
  } else {
    console.log('✅ 没有 .tmp 残片。');
  }

  if (zombies.length > 0) {
    console.log(`⚠️  索引里有 ${zombies.length} 条指向已经不存在的文件（点开会说「不在本机库里」）。`);
  }

  try {
    const jobs = JSON.parse(await readFile(join(LIBRARY_ROOT, '_catalog', 'jobs.json'), 'utf8'));
    const count = Array.isArray(jobs) ? jobs.length : Object.keys(jobs ?? {}).length;
    if (count > 0) {
      console.log(`ℹ️  _catalog/jobs.json 里还留着 ${count} 条历史任务记录（只是流水，不影响去重）。`);
    }
  } catch {
    /* 没有就没有 */
  }
}

async function checkInbox(repo) {
  const inbox = join(repo.path, '_inbox');
  section(`收件箱  ${inbox}`);
  if (!(await exists(repo.path))) {
    console.log('仓库不在本机，跳过。');
    return;
  }
  if (!(await exists(inbox))) {
    console.log('✅ 没有 _inbox 目录 —— 干净。');
    return;
  }

  const sources = await readdir(inbox, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const source of sources) {
    if (!source.isDirectory()) continue;
    const entries = (await readdir(join(inbox, source.name), { withFileTypes: true }).catch(() => []))
      .filter(item => item.isDirectory());
    if (entries.length === 0) continue;
    total += entries.length;
    console.log(`${source.name}：${entries.length} 条`);
    for (const entry of entries.slice(0, 10)) console.log(`   · ${entry.name}`);
    if (entries.length > 10) console.log(`   · …还有 ${entries.length - 10} 条`);
  }

  if (total === 0) {
    console.log('✅ 收件箱是空的。');
    return;
  }

  console.log(`\n⚠️  收件箱里有 ${total} 条**没被本机库清空带走**（清空只管本机库，这是对的）。`);
  console.log('   Agent 下次 drain 会把它们归档。要是这批是你打算重采的，先删掉再重采：');
  console.log(`     cd ${repo.path} && git rm -r _inbox/*/ && git commit -m "清空收件箱"`);

  const status = await git(repo.path, ['status', '--porcelain', '--', '_inbox']);
  if (status === undefined) console.log('   （这个目录不是 git 仓库，或者 git 跑不起来）');
  else if (status.trim() === '') console.log('   这些条目已经全部提交进 git 了。');
  else console.log(`   其中还有未提交的改动：\n${status.trimEnd().split('\n').map(line => `     ${line}`).join('\n')}`);
}

console.log('检查「清空」之后还剩什么（只读，不会删东西）');
await checkLibrary();
for (const repo of REPOS) await checkInbox(repo);
section('清空管不到的另外两处');
console.log('· 页面上的已处理标记：留在那个没刷新过的标签页里，重采会把它们当「已采过」跳过。');
console.log('· 侧栏里上一轮的采集明细：存在扩展的 storage 里，和本机库无关。');
console.log('  0.3.7 起「清空」会一并清掉这两处；旧版本手动关掉那个标签页重开即可。');
console.log('');
