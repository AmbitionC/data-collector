export interface ZsxqSemanticSignature {
  publishedAt: string;
  authorRole: 'owner' | 'member';
  normalizedLength: number;
  exactHash: string;
  minHashes: number[];
}

export interface ZsxqLibraryIndexEntry {
  id: string;
  url: string;
  topicId?: string;
  publishedAt?: string;
  authorRole?: 'owner' | 'member';
  /** `undefined` means a legacy entry whose completeness has not been proven. */
  contentComplete?: boolean;
  semanticSignature?: ZsxqSemanticSignature;
}

function normalizedBody(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function exactHash(value: string): string {
  return [fnv1a(value, 0x811c9dc5), fnv1a(value, 0x9e3779b9)]
    .map(part => part.toString(16).padStart(8, '0'))
    .join('');
}

function minimumShingleHashes(value: string): number[] {
  if (value.length < 5) return [fnv1a(value, 0x811c9dc5)];
  const hashes = new Set<number>();
  for (let index = 0; index <= value.length - 5; index += 1) {
    hashes.add(fnv1a(value.slice(index, index + 5), 0x811c9dc5));
  }
  return [...hashes].sort((left, right) => left - right).slice(0, 64);
}

export function zsxqSemanticSignature(input: {
  publishedAt: string;
  text: string;
  authorRole: 'owner' | 'member';
}): ZsxqSemanticSignature {
  const normalized = normalizedBody(input.text);
  return {
    publishedAt: input.publishedAt,
    authorRole: input.authorRole,
    normalizedLength: normalized.length,
    exactHash: exactHash(normalized),
    minHashes: minimumShingleHashes(normalized),
  };
}

function signatureOverlap(left: readonly number[], right: readonly number[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  const smaller = Math.min(leftSet.size, rightSet.size);
  return smaller === 0 ? 1 : intersection / smaller;
}

export function isHighConfidenceZsxqDuplicate(
  left: ZsxqSemanticSignature,
  right: ZsxqSemanticSignature,
): boolean {
  if (
    left.authorRole !== 'owner'
    || right.authorRole !== 'owner'
    || left.publishedAt !== right.publishedAt
  ) return false;
  const longer = Math.max(left.normalizedLength, right.normalizedLength);
  const shorter = Math.min(left.normalizedLength, right.normalizedLength);
  if (longer === 0 || shorter / longer < 0.85) return false;
  if (longer < 80) {
    return left.normalizedLength === right.normalizedLength
      && left.exactHash === right.exactHash;
  }
  return signatureOverlap(left.minHashes, right.minHashes) >= 0.82;
}
