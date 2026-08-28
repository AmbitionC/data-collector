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
  text = `投资经营完整正文 ${topicId}`.repeat(10),
  html = `<p>投资经营完整正文 ${topicId}</p>`,
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
      html,
      text,
      images: [],
      truncated: completeness === true ? false : true,
      sourceMetadata: { authorRole: 'owner', topicId },
    },
    sanitizedHtml: html,
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

  it('does not trust a complete catalog flag when the retained source still contains an API preview tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-index-preview-'));
    const entry = await writeEntry(
      root,
      '188444124184822',
      true,
      '投资入门课程第六课。这里是正文预览，关键结论尚未出现...\n\n投资入门课程-第6课',
    );
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(join(root, '_catalog', 'index.json'), `${JSON.stringify([entry], null, 2)}\n`);

    const [indexed] = await loadZsxqLibraryIndex(root);

    expect(indexed?.contentComplete).toBe(false);
  });

  it('不把完整正文末尾的星球链接省略标题当成正文残片', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-index-linked-title-'));
    const linkedTitle = '#股市入门知识#银行的估值(1...';
    const entry = await writeEntry(
      root,
      '1524888815458582',
      true,
      `应某些星友要求，以今天收盘价公...\n\n`
        + `应某些星友要求，以今天收盘价公布下所有银行的业绩和月度末估值。\n\n`
        + `从安全性看，资本充足率越高越好，不良贷款越低越好。\n\n`
        + `对银行估值不了解的，可以参看银行估值系列${linkedTitle}\n\n${linkedTitle}`,
      '<p>应某些星友要求，以今天收盘价公...</p>'
        + '<p>应某些星友要求，以今天收盘价公布下所有银行的业绩和月度末估值。</p>'
        + '<p>从安全性看，资本充足率越高越好，不良贷款越低越好。</p>'
        + `<p>对银行估值不了解的，可以参看银行估值系列<a href="https://t.zsxq.com/MYrVd">${linkedTitle}</a></p>`
        + `<p><a href="https://t.zsxq.com/MYrVd">${linkedTitle}</a></p>`,
    );
    await mkdir(join(root, '_catalog'), { recursive: true });
    await writeFile(join(root, '_catalog', 'index.json'), `${JSON.stringify([entry], null, 2)}\n`);

    const [indexed] = await loadZsxqLibraryIndex(root);

    expect(indexed?.contentComplete).toBe(true);
  });
});
