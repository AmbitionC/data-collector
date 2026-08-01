import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLibrary,
  deleteEntries,
  listLibrary,
  readEntry,
} from '../../packages/bridge/src/library/manage.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

interface Seed {
  id: string;
  source: string;
  title: string;
  relativePath: string;
  updatedAt: string;
}

async function seedLibrary(entries: Seed[]): Promise<string> {
  const root = await temporaryDirectories.create('library-manage-');
  await mkdir(join(root, '_catalog'), { recursive: true });
  for (const entry of entries) {
    const directory = join(root, entry.relativePath, '..');
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(root, entry.relativePath), `# ${entry.title}\n`, 'utf8');
    await writeFile(join(directory, 'assets', 'a.png'), 'x', 'utf8');
  }
  await writeFile(
    join(root, '_catalog', 'index.json'),
    JSON.stringify(entries.map(entry => ({ ...entry, url: `https://x/${entry.id}`, category: '投资' }))),
    'utf8',
  );
  return root;
}

const SEEDS: Seed[] = [
  {
    id: 'aaa',
    source: '知识星球',
    title: '第一条',
    relativePath: join('知识星球', '投资', '2026', 'aaa-first', 'index.md'),
    updatedAt: '2026-07-20T00:00:00.000Z',
  },
  {
    id: 'bbb',
    source: '微信公众号',
    title: '第二条',
    relativePath: join('微信公众号', '投资', '2026', 'bbb-second', 'index.md'),
    updatedAt: '2026-07-25T00:00:00.000Z',
  },
];

describe('已入库内容管理', () => {
  it('按时间倒序列出条目', async () => {
    const root = await seedLibrary(SEEDS);

    const entries = await listLibrary(root);

    expect(entries.map(entry => entry.id)).toEqual(['bbb', 'aaa']);
    expect(entries[0]).toMatchObject({ source: '微信公众号', title: '第二条' });
  });

  it('删除一条时连同它的目录（正文 + assets）一起删，并更新索引', async () => {
    const root = await seedLibrary(SEEDS);

    const outcome = await deleteEntries(root, ['aaa']);

    expect(outcome).toEqual({ deleted: 1, missing: 0 });
    expect(existsSync(join(root, '知识星球', '投资', '2026', 'aaa-first'))).toBe(false);
    // 另一条必须完好无损。
    expect(existsSync(join(root, '微信公众号', '投资', '2026', 'bbb-second', 'index.md'))).toBe(true);
    expect((await listLibrary(root)).map(entry => entry.id)).toEqual(['bbb']);
  });

  it('清空会删掉每一条，并留下一个空索引', async () => {
    const root = await seedLibrary(SEEDS);

    const outcome = await clearLibrary(root);

    expect(outcome.deleted).toBe(2);
    expect(await listLibrary(root)).toEqual([]);
    expect(JSON.parse(await readFile(join(root, '_catalog', 'index.json'), 'utf8'))).toEqual([]);
  });

  it('空 id 列表是安全的空操作，绝不理解成「删全部」', async () => {
    const root = await seedLibrary(SEEDS);

    expect(await deleteEntries(root, [])).toEqual({ deleted: 0, missing: 0 });
    expect(await listLibrary(root)).toHaveLength(2);
  });

  it('索引里指向库外的路径一律不删（relativePath 是外部数据）', async () => {
    const root = await seedLibrary(SEEDS);
    const outside = await temporaryDirectories.create('outside-');
    await writeFile(join(outside, 'victim.md'), '别删我', 'utf8');
    await writeFile(
      join(root, '_catalog', 'index.json'),
      JSON.stringify([
        {
          id: 'evil',
          source: 'x',
          title: '越界条目',
          url: 'https://x/evil',
          category: '其他',
          relativePath: join('..', '..', '..', outside, 'victim.md'),
          updatedAt: '2026-07-25T00:00:00.000Z',
        },
      ]),
      'utf8',
    );

    const outcome = await deleteEntries(root, ['evil']);

    // 越界的条目从索引里清掉，但**绝不碰库外的文件**。
    expect(outcome.deleted).toBe(0);
    expect(existsSync(join(outside, 'victim.md'))).toBe(true);
    expect(await listLibrary(root)).toEqual([]);
  });

  it('文件已经不在了也能把索引清干净', async () => {
    const root = await seedLibrary(SEEDS);
    await deleteEntries(root, ['aaa']);

    // 再删一次同一条：文件没了，索引里也没了，不该报错。
    expect(await deleteEntries(root, ['aaa'])).toEqual({ deleted: 0, missing: 0 });
  });

  it('读得出一条的正文，并给出可用于打开文件夹的绝对路径', async () => {
    // 「点开看不了内容」等于这个页面白做——用户没法核对自己到底采到了什么。
    const root = await seedLibrary(SEEDS);

    const entry = await readEntry(root, 'aaa');

    expect(entry).toMatchObject({ id: 'aaa', title: '第一条', markdown: '# 第一条\n', truncated: false });
    expect(entry?.absolutePath).toBe(join(root, SEEDS[0]!.relativePath));
  });

  it('索引里有、文件已经不在了：如实说找不到，而不是给一片空白', async () => {
    const root = await seedLibrary(SEEDS);
    await deleteEntries(root, ['aaa']);

    expect(await readEntry(root, 'aaa')).toBeUndefined();
    expect(await readEntry(root, '根本不存在的 id')).toBeUndefined();
  });

  it('索引里指向库外的路径一律读不出来（relativePath 是外部数据）', async () => {
    const root = await seedLibrary(SEEDS);
    const outside = await temporaryDirectories.create('outside-read-');
    await writeFile(join(outside, 'secret.md'), '不该被读到', 'utf8');
    await writeFile(
      join(root, '_catalog', 'index.json'),
      JSON.stringify([
        {
          id: 'evil',
          source: 'x',
          title: '越界条目',
          url: 'https://x/evil',
          category: '其他',
          relativePath: join('..', '..', '..', outside, 'secret.md'),
          updatedAt: '2026-07-25T00:00:00.000Z',
        },
      ]),
      'utf8',
    );

    expect(await readEntry(root, 'evil')).toBeUndefined();
  });

  it('清空之后不留空目录壳子', async () => {
    // 库的结构是 <来源>/<分类>/<年份>/<条目>/，只删条目目录会留下一串空壳，
    // 清空完目录树看着还是满的——用户说的「脏数据」正是这些。
    const root = await seedLibrary(SEEDS);

    await clearLibrary(root);

    expect(existsSync(join(root, '知识星球'))).toBe(false);
    expect(existsSync(join(root, '微信公众号'))).toBe(false);
    // 索引目录本身要留着（里面还有 index.json）。
    expect(existsSync(join(root, '_catalog', 'index.json'))).toBe(true);
  });

  it('删单条只收走因此变空的目录，不碰还有内容的同级目录', async () => {
    const root = await seedLibrary([
      ...SEEDS,
      {
        id: 'ccc',
        source: '知识星球',
        title: '同年同分类的另一条',
        relativePath: join('知识星球', '投资', '2026', 'ccc-third', 'index.md'),
        updatedAt: '2026-07-26T00:00:00.000Z',
      },
    ]);

    await deleteEntries(root, ['aaa']);

    // 同一个 2026/ 下还有别的条目，这层目录必须留着。
    expect(existsSync(join(root, '知识星球', '投资', '2026', 'ccc-third'))).toBe(true);
    expect(existsSync(join(root, '知识星球', '投资', '2026', 'aaa-first'))).toBe(false);

    await deleteEntries(root, ['ccc']);
    // 最后一条也删掉之后，整条空掉的路径才收走。
    expect(existsSync(join(root, '知识星球'))).toBe(false);
    expect(existsSync(join(root, '微信公众号', '投资', '2026', 'bbb-second'))).toBe(true);
  });

  it('没有索引文件时列表为空、清空是空操作', async () => {
    const root = await temporaryDirectories.create('empty-library-');

    expect(await listLibrary(root)).toEqual([]);
    expect(await clearLibrary(root)).toEqual({ deleted: 0, missing: 0 });
  });
});
