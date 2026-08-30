import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { isIP } from 'node:net';
import type { CollectedImage } from '@data-collector/shared';
import { assertInsideRoot, assertSafeWritePath, safeSlug } from './paths.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

export interface AssetResult {
  html: string;
  downloaded: number;
  failed: number;
}

export type AssetWriter = (asset: {
  filename: string;
  bytes: Uint8Array;
}) => Promise<string>;

export interface AssetCollisionFingerprint {
  sha256: string;
  byteLength: number;
}

export interface AssetCollisionMetadata extends AssetCollisionFingerprint {
  filename: string;
  mime: string;
  relativeUrl: string;
}

export type AssetFingerprint = (bytes: Uint8Array) => AssetCollisionFingerprint;

function defaultAssetFingerprint(bytes: Uint8Array): AssetCollisionFingerprint {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

/**
 * Directed collision authority. Only fixed-size digest metadata survives each sequential write;
 * fetched response buffers become unreachable as soon as the current loop iteration finishes.
 */
export class AssetCollisionTracker {
  private readonly assets = new Map<string, AssetCollisionMetadata>();

  constructor(private readonly fingerprint: AssetFingerprint = defaultAssetFingerprint) {}

  async resolve(
    input: {
      filename: string;
      bytes: Uint8Array;
      mime: string;
      fingerprint?: AssetCollisionFingerprint;
    },
    write: () => Promise<string>,
  ): Promise<string> {
    const fingerprint = input.fingerprint ?? this.fingerprint(input.bytes);
    const existing = this.assets.get(input.filename);
    if (existing) {
      if (existing.sha256 !== fingerprint.sha256
        || existing.byteLength !== fingerprint.byteLength
        || existing.mime !== input.mime) {
        throw new Error('asset filename collision');
      }
      return existing.relativeUrl;
    }
    const relativeUrl = await write();
    this.assets.set(input.filename, {
      filename: input.filename,
      sha256: fingerprint.sha256,
      byteLength: fingerprint.byteLength,
      mime: input.mime,
      relativeUrl,
    });
    return relativeUrl;
  }

  /** @internal Instrumentation surface for bounded-memory regression tests. */
  metadataSnapshot(): readonly AssetCollisionMetadata[] {
    return [...this.assets.values()].map(item => ({ ...item }));
  }
}

class AssetWriterError extends Error {
  constructor(readonly writerCause: unknown) {
    super('asset writer failed', { cause: writerCause });
  }
}

async function atomicWrite(root: string, path: string, bytes: Uint8Array): Promise<void> {
  await assertSafeWritePath(root, path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function replaceUrl(html: string, source: string, replacement: string): string {
  return html
    .split(source)
    .join(replacement)
    .split(source.replaceAll('&', '&amp;'))
    .join(replacement);
}

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.').map(value => Number(value));
  return parts.length === 4 && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    ? parts
    : undefined;
}

function isPublicIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a = 0, b = 0, c = 0] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Parts(rawAddress: string): number[] | undefined {
  let address = rawAddress.toLowerCase().split('%')[0] ?? '';
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const embeddedIpv4 = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) {
    const parts = ipv4Parts(embeddedIpv4);
    if (!parts) return undefined;
    const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    address = address.slice(0, -embeddedIpv4.length) + `${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const values = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    .map(value => Number.parseInt(value, 16));
  return values.length === 8 && values.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? values
    : undefined;
}

function isPublicIpv6(address: string): boolean {
  const parts = ipv6Parts(address);
  if (!parts) return false;
  const [first = 0, second = 0, third = 0, fourth = 0, fifth = 0, sixth = 0, seventh = 0, eighth = 0] = parts;
  const isUnspecifiedOrLoopback =
    first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0 && seventh === 0 && eighth <= 1;
  const isMappedIpv4 = first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && (sixth === 0 || sixth === 0xffff);
  if (isMappedIpv4) {
    return isPublicIpv4(`${seventh >> 8}.${seventh & 255}.${eighth >> 8}.${eighth & 255}`);
  }
  return !(
    isUnspecifiedOrLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8)
  );
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address.replace(/^\[|\]$/g, ''));
  return version === 4
    ? isPublicIpv4(address)
    : version === 6
      ? isPublicIpv6(address)
      : false;
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(result => result.address);
}

async function assertPublicHttps(url: URL, resolveAddresses: ResolveAddresses): Promise<void> {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('图片只允许公开 HTTPS 地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [hostname] : await resolveAddresses(hostname);
  if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address))) {
    throw new Error('拒绝访问本机或私有网络图片');
  }
}

async function fetchPublicImage(options: {
  url: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  resolveAddresses: ResolveAddresses;
}): Promise<Response> {
  let current = new URL(options.url);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicHttps(current, options.resolveAddresses);
    const response = await options.fetch(current.href, {
      signal: options.signal,
      redirect: 'manual',
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirectCount === 5) throw new Error('图片重定向无效或过多');
      current = new URL(location, current);
      continue;
    }
    if (response.url) await assertPublicHttps(new URL(response.url), options.resolveAddresses);
    return response;
  }
  throw new Error('图片重定向过多');
}

export async function readResponseBytes(
  response: Response,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<Uint8Array> {
  if (!response.body) throw new Error('图片响应没有正文');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('图片超过 10 MB');
        throw new Error('图片超过 10 MB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadAssets(options: {
  html: string;
  images: CollectedImage[];
  entryDirectory: string;
  libraryRoot: string;
  fetch: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  /** Directed transactions can persist the exact fetched manifest without rescanning paths. */
  writeAsset?: AssetWriter;
}): Promise<AssetResult> {
  const assetsDirectory = assertInsideRoot(
    options.libraryRoot,
    join(options.entryDirectory, 'assets'),
  );
  await assertSafeWritePath(options.libraryRoot, assetsDirectory);
  let html = options.html;
  let downloaded = 0;
  let failed = 0;
  const writtenAssets = new AssetCollisionTracker();

  for (const image of options.images.slice(0, 30)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetchPublicImage({
          url: image.url,
          fetch: options.fetch,
          signal: controller.signal,
          resolveAddresses: options.resolveAddresses ?? defaultResolveAddresses,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
        const extension = mime ? MIME_EXTENSIONS[mime] : undefined;
        if (!extension) throw new Error('不支持的图片类型');
        const declaredSize = Number(response.headers.get('content-length') ?? 0);
        if (declaredSize > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB');
        const bytes = await readResponseBytes(response);
        const fullDigest = createHash('sha256').update(bytes).digest('hex');
        const digest = fullDigest.slice(0, 16);
        const hint = safeSlug(image.alt ?? 'image', 28);
        const filename = `${digest}-${hint}${extension || extname(new URL(image.url).pathname)}`;
        let relativeUrl: string;
        if (options.writeAsset) {
          try {
            relativeUrl = await writtenAssets.resolve({
              filename,
              bytes,
              mime: mime!,
              fingerprint: { sha256: fullDigest, byteLength: bytes.byteLength },
            }, async () => await options.writeAsset!({ filename, bytes }));
          } catch (error) {
            throw new AssetWriterError(error);
          }
        } else {
          const target = assertInsideRoot(options.libraryRoot, join(assetsDirectory, filename));
          await mkdir(assetsDirectory, { recursive: true });
          await assertSafeWritePath(options.libraryRoot, assetsDirectory);
          await atomicWrite(options.libraryRoot, target, bytes);
          relativeUrl = relative(options.entryDirectory, target).split('\\').join('/');
        }
        html = replaceUrl(html, image.url, relativeUrl);
        downloaded += 1;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof AssetWriterError) throw error.writerCause;
      failed += 1;
    }
  }

  if (downloaded === 0 && !options.writeAsset) {
    await rmdir(assetsDirectory).catch(() => undefined);
  }

  return { html, downloaded, failed };
}
