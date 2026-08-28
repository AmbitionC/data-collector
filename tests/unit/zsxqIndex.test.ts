import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  stableContentId,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
} from '@data-collector/shared';
import { loadZsxqLibraryIndex } from '../../packages/bridge/src/library/zsxqIndex.js';

async function writeEntry(
  root: string,
  topicId: string,
  completeness: true | false | undefined,
): Promise<Record<string, unknown>> {
  const url = `https://wx.zsxq.com/group/48844584441158/topic/${topicId}`;
  const id = stableContentId(url);
  const relativePath = `zsxq/2026-08-28-owner-${topicId}-${id}/content.md`;
  const sourcePath = join(root, dirname(relativePath), 'source.json');
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, `${JSON.stringify({
    document: {
      schemaVersion: 1,
      source: 'zsxq',
      kind: 'post',
      url,
      canonicalUrl: url,
      title: `投资复盘 ${topicId}`,
      author: '陈老师',
      publishedAt: '2026-08-28T01:00:00.000Z',
      collectedAt: '2026-08-29T00:00:00.000Z',
      html: `<p>投资经营完整正文 ${topicId}</p>`,
      text: `投资经营完整正文 ${topicId}`.repeat(10),
      images: [],
      truncated: completeness === true ? false : true,
      sourceMetadata: { authorRole: 'owner', topicId },
    },
    sanitizedHtml: `<p>投资经营完整正文 ${topicId}</p>`,
    category: '投资',
    tags: [],
    summary: `投资经营完整正文 ${topicId}`,
  }, null, 2)}\n`);
  return {
    id,
    source: 'zsxq',
    title: `投资复盘 ${topicId}`,
    url,
    relativePath,
    ...(completeness === undefined
      ? {}
      : {
          contentComplete: completeness,
          ...(completeness
            ? { contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY }
            : {}),
        }),
  };
}

describe('ZSXQ local library index', () => {
  it('returns compact exact, completeness, and semantic facts without article bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-index-'));
    const entries = await Promise.all([
      writeEntry(root, '1001', true),
      writeEntry(root, '1002', false),
      writeEntry(root, '1003', undefined),
    ]);
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(
      join(root, '_catalog', 'index.json'),
      `${JSON.stringify(entries, null, 2)}\n`,
    );

    const index = await loadZsxqLibraryIndex(root);

    expect(index).toHaveLength(3);
    expect(index.map(entry => entry.contentComplete)).toEqual([true, false, undefined]);
    expect(index[0]).toMatchObject({
      topicId: '1001',
      publishedAt: '2026-08-28T01:00:00.000Z',
      authorRole: 'owner',
      semanticSignature: {
        publishedAt: '2026-08-28T01:00:00.000Z',
        authorRole: 'owner',
      },
    });
    for (const entry of index) {
      expect(entry).not.toHaveProperty('text');
      expect(entry).not.toHaveProperty('html');
      expect(JSON.stringify(entry)).not.toContain('投资经营完整正文');
    }
  });

  it('fails closed when the catalog references a missing retained snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-index-missing-source-'));
    const url = 'https://wx.zsxq.com/group/48844584441158/topic/1999';
    const id = stableContentId(url);
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(join(root, '_catalog', 'index.json'), `${JSON.stringify([{
      id,
      source: 'zsxq',
      url,
      relativePath: `zsxq/2026-08-28-owner-1999-${id}/content.md`,
    }])}\n`);

    await expect(loadZsxqLibraryIndex(root)).rejects.toThrow(
      /知识星球本机索引无法安全读取.*ENOENT/u,
    );
  });
});
