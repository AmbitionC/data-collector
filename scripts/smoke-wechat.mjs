import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { MarkdownLibrary } from '../packages/bridge/dist/library/index.js';
import { organize } from '../packages/bridge/dist/organize/index.js';

const DEFAULT_URL = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g';
const WORKSPACE = resolve(import.meta.dirname, '..');

function log(stage) {
  process.stderr.write(`[smoke] ${stage}\n`);
}

async function productionExtractor(temporaryDirectory) {
  const bundlePath = join(temporaryDirectory, 'extractor.mjs');
  await build({
    entryPoints: [join(WORKSPACE, 'packages', 'extension', 'src', 'extractors', 'index.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    legalComments: 'none',
    alias: {
      '@data-collector/shared': join(WORKSPACE, 'packages', 'shared', 'src', 'index.ts'),
    },
  });
  return import(`${pathToFileURL(bundlePath).href}?smoke=${Date.now()}`);
}

async function main() {
  const targetUrl = process.argv[2] ?? DEFAULT_URL;
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'mp.weixin.qq.com') {
    throw new Error('真实冒烟脚本只接受 mp.weixin.qq.com 的 HTTPS 文章地址');
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'data-collector-smoke-'));
  try {
    log(`请求真实文章：${targetUrl}`);
    const response = await fetch(targetUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`请求真实文章失败：HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < 100_000) throw new Error(`真实页面体积异常：${html.length} 字符`);

    log('使用扩展生产提取器解析真实 DOM');
    const { extractDocument } = await productionExtractor(temporaryDirectory);
    const dom = new JSDOM(html, { url: targetUrl });
    const document = extractDocument(dom.window.document, targetUrl);
    if (document.text.length < 1_000) {
      throw new Error(`提取正文过短：${document.text.length} 字符`);
    }
    if (
      document.title !== '一夜之间，通胀的玩笑这次开大了' ||
      document.author !== '重远投资观'
    ) {
      throw new Error(`标题或作者不符：${document.title} / ${document.author ?? '-'}`);
    }
    if (!document.publishedAt) throw new Error('真实页面没有提取到发布时间');

    const libraryRoot = process.env.DATA_COLLECTOR_LIBRARY
      ? resolve(process.env.DATA_COLLECTOR_LIBRARY)
      : join(WORKSPACE, 'artifacts', 'smoke-library');
    const library = new MarkdownLibrary({ root: libraryRoot });
    log('第 1 次整理并写入本机知识库');
    const first = await library.save(organize(document));
    log('第 2 次写入同一 URL，验证幂等更新');
    const second = await library.save(
      organize({ ...document, collectedAt: new Date().toISOString() }),
    );
    if (first.markdownPath !== second.markdownPath) {
      throw new Error('重复采集没有命中同一个知识库条目');
    }

    const markdown = await readFile(first.markdownPath, 'utf8');
    if (markdown.length < 1_000 || !markdown.includes(targetUrl)) {
      throw new Error(`落盘正文不完整：${first.markdownPath}`);
    }
    if (!markdown.includes(document.title) || !markdown.includes(document.author)) {
      throw new Error('落盘内容缺少标题或作者');
    }
    const catalog = JSON.parse(
      await readFile(join(libraryRoot, '_catalog', 'index.json'), 'utf8'),
    );
    const matchingEntries = catalog.filter(entry => entry.url === targetUrl);
    if (matchingEntries.length !== 1) {
      throw new Error(`目录幂等校验失败：同一 URL 有 ${matchingEntries.length} 个条目`);
    }

    const report = {
      ok: true,
      workflow: 'real-html + production-extractor + production-library',
      url: targetUrl,
      title: document.title,
      author: document.author,
      publishedAt: document.publishedAt,
      extractedTextCharacters: document.text.length,
      extractedImages: document.images.length,
      outputPath: first.markdownPath,
      markdownBytes: Buffer.byteLength(markdown),
      downloadedImages: second.downloadedImages,
      failedImages: second.failedImages,
      catalogEntriesForUrl: matchingEntries.length,
      stableContentId: first.id,
      testedAt: new Date().toISOString(),
    };
    const reportPath = join(WORKSPACE, 'artifacts', 'smoke-wechat.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
