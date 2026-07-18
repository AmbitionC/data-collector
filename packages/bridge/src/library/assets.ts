import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { CollectedImage } from '@data-collector/shared';
import { assertInsideRoot, safeSlug } from './paths.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export interface AssetResult {
  html: string;
  downloaded: number;
  failed: number;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function replaceUrl(html: string, source: string, replacement: string): string {
  return html
    .split(source)
    .join(replacement)
    .split(source.replaceAll('&', '&amp;'))
    .join(replacement);
}

export async function downloadAssets(options: {
  html: string;
  images: CollectedImage[];
  entryDirectory: string;
  libraryRoot: string;
  fetch: typeof fetch;
}): Promise<AssetResult> {
  const assetsDirectory = assertInsideRoot(
    options.libraryRoot,
    join(options.entryDirectory, 'assets'),
  );
  await mkdir(assetsDirectory, { recursive: true });
  let html = options.html;
  let downloaded = 0;
  let failed = 0;

  for (const image of options.images.slice(0, 30)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await options.fetch(image.url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      const extension = mime ? MIME_EXTENSIONS[mime] : undefined;
      if (!extension) throw new Error('不支持的图片类型');
      const declaredSize = Number(response.headers.get('content-length') ?? 0);
      if (declaredSize > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB');
      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const hint = safeSlug(image.alt ?? 'image', 28);
      const filename = `${digest}-${hint}${extension || extname(new URL(image.url).pathname)}`;
      const target = assertInsideRoot(options.libraryRoot, join(assetsDirectory, filename));
      await atomicWrite(target, bytes);
      const relativeUrl = relative(options.entryDirectory, target).split('\\').join('/');
      html = replaceUrl(html, image.url, relativeUrl);
      downloaded += 1;
    } catch {
      failed += 1;
    }
  }

  return { html, downloaded, failed };
}
