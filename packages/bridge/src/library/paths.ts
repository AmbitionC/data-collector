import { sep, resolve } from 'node:path';

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeSlug(value: string, maxLength = 60): string {
  const slug = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/?%*:|"<>]/g, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[.]+$/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  if (!slug) return 'untitled';
  return WINDOWS_RESERVED.test(slug) ? `_${slug.toLowerCase()}` : slug;
}

export function assertInsideRoot(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (
    absoluteCandidate !== absoluteRoot &&
    !absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new Error('拒绝写入知识库目录之外的路径');
  }
  return absoluteCandidate;
}
