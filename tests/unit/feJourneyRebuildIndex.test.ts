import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableContentId, type CollectedDocument } from '@data-collector/shared';
import { rebuildFeJourneyCandidateIndex } from '../../packages/bridge/src/feJourney/index.js';
import { MarkdownLibrary } from '../../packages/bridge/src/library/index.js';
import { organize, type OrganizedDocument } from '../../packages/bridge/src/organize/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function interview(
  id: string,
  company: '腾讯' | '字节',
  author: string,
): CollectedDocument {
  const url = `https://www.nowcoder.com/discuss/${id}`;
  const questions = [
    '1.介绍 Agent 项目架构。',
    '2.RAG 的完整流程是什么？',
    '3.如何选择 Agent 框架？',
    '4.长期记忆怎么存储？',
    '5.工具调用失败如何恢复？',
    '6.怎么做 Agent 评测？',
  ].join('');
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: `${company} Agent 开发一面面经`,
    author,
    publishedAt: '2026-08-18T09:00:00.000Z',
    collectedAt: '2026-08-19T00:00:00.000Z',
    html: `<p>我参加了${company} Agent 开发一面。${questions}</p>`,
    text: `我参加了${company} Agent 开发一面。${questions}`,
    images: [],
  };
}

async function sourcePath(root: string, id: string): Promise<string> {
  const catalog = JSON.parse(
    await readFile(join(root, '_catalog', 'index.json'), 'utf8'),
  ) as Array<{ id: string; relativePath: string }>;
  const entry = catalog.find(item => item.id === id);
  if (!entry) throw new Error(`missing catalog entry ${id}`);
  return join(root, dirname(entry.relativePath), 'source.json');
}

describe('rebuildFeJourneyCandidateIndex', () => {
  it('repairs persisted cross-company clusters and is idempotent', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-rebuild-');
    const library = new MarkdownLibrary({ root });
    const documents = [
      interview('7101', '腾讯', '候选人甲'),
      interview('7102', '字节', '候选人乙'),
    ];
    for (const document of documents) await library.save(organize(document));

    const paths = await Promise.all(documents.map(document => sourcePath(
      root,
      stableContentId(document.canonicalUrl),
    )));
    for (const path of paths) {
      const organized = JSON.parse(await readFile(path, 'utf8')) as OrganizedDocument;
      organized.document.feJourney = {
        candidateKinds: ['interview'],
        qualityScore: 80,
        qualitySignals: ['第一手面试经历'],
        exclusionReasons: [],
        contentHash: '1111111111111111',
        simHash: '2222222222222222',
        clusterId: 'cluster-wrong-shared',
      };
      await writeFile(path, `${JSON.stringify(organized, null, 2)}\n`, 'utf8');
    }
    await writeFile(
      join(root, '_catalog', 'fe-journey.json'),
      `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
      'utf8',
    );

    await expect(rebuildFeJourneyCandidateIndex(root)).resolves.toEqual({
      scanned: 2,
      rebuilt: 2,
    });
    const firstPass = await Promise.all(paths.map(async path => (
      JSON.parse(await readFile(path, 'utf8')) as OrganizedDocument
    ).document.feJourney));
    expect(firstPass[0]?.clusterId).not.toBe(firstPass[1]?.clusterId);
    expect(firstPass.every(item => item?.duplicateOf === undefined)).toBe(true);

    const catalogAfterFirstPass = await readFile(join(root, '_catalog', 'fe-journey.json'), 'utf8');
    await expect(rebuildFeJourneyCandidateIndex(root)).resolves.toEqual({
      scanned: 2,
      rebuilt: 2,
    });
    expect(await readFile(join(root, '_catalog', 'fe-journey.json'), 'utf8')).toBe(
      catalogAfterFirstPass,
    );
  });

  it('rolls back every source and catalog when a batch write fails', async () => {
    const root = await temporaryDirectories.create('fe-journey-index-rebuild-rollback-');
    const library = new MarkdownLibrary({ root });
    const documents = [
      interview('7201', '腾讯', '候选人甲'),
      interview('7202', '字节', '候选人乙'),
    ];
    for (const document of documents) await library.save(organize(document));
    const paths = await Promise.all(documents.map(document => sourcePath(
      root,
      stableContentId(document.canonicalUrl),
    )));
    const catalogPath = join(root, '_catalog', 'fe-journey.json');
    await writeFile(catalogPath, `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);
    const beforeSources = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    const beforeCatalog = await readFile(catalogPath, 'utf8');
    let writes = 0;

    await expect(rebuildFeJourneyCandidateIndex(root, {
      writeText: async (_libraryRoot, target, contents) => {
        writes += 1;
        if (writes === 2) throw new Error('injected batch write failure');
        await writeFile(target, contents, 'utf8');
      },
    })).rejects.toThrow('injected batch write failure');

    await expect(Promise.all(paths.map(path => readFile(path, 'utf8')))).resolves.toEqual(beforeSources);
    await expect(readFile(catalogPath, 'utf8')).resolves.toBe(beforeCatalog);
  });
});
