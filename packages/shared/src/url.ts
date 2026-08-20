import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { descriptorForHost } from './sources.js';

export function parseSupportedUrl(raw: string): URL {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !descriptorForHost(host)) {
      throw new Error('unsupported');
    }
    url.hostname = host;
    return url;
  } catch {
    throw new Error('不支持的采集地址：仅支持微信公众号、知识星球、牛客网和 GitHub HTTPS 页面');
  }
}

export function canonicalizeUrl(input: URL): URL {
  const url = parseSupportedUrl(input.href);
  url.hash = '';
  const descriptor = descriptorForHost(url.hostname);
  const allowlist = new Set(descriptor?.identityParams ?? []);
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => allowlist.has(key))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function stableContentId(input: URL | string): string {
  const url = typeof input === 'string' ? parseSupportedUrl(input) : input;
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeUrl(url).href))).slice(
    0,
    12,
  );
}
