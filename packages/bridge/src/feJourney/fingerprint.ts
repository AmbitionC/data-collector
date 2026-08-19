import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();

function normalizeExactContent(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function simHashTokens(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const tokens: string[] = [];
  for (const segment of normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      const characters = [...segment];
      tokens.push(...characters);
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.push(`${characters[index]}${characters[index + 1]}`);
      }
    } else {
      tokens.push(segment);
    }
  }
  return tokens.length > 0 ? tokens : [''];
}

export function contentFingerprint(text: string): string {
  return bytesToHex(sha256(encoder.encode(normalizeExactContent(text)))).slice(0, 16);
}

export function simHash64(text: string): string {
  const vector = new Array<number>(64).fill(0);
  for (const token of simHashTokens(text)) {
    const digest = sha256(encoder.encode(token));
    for (let bit = 0; bit < 64; bit += 1) {
      const byte = digest[Math.floor(bit / 8)] ?? 0;
      vector[bit] = (vector[bit] ?? 0) + ((byte & (1 << (7 - (bit % 8)))) === 0 ? -1 : 1);
    }
  }
  let value = 0n;
  for (const weight of vector) value = (value << 1n) | (weight >= 0 ? 1n : 0n);
  return value.toString(16).padStart(16, '0');
}

export function hammingDistance64(left: string, right: string): number {
  if (!/^[a-f0-9]{16}$/i.test(left) || !/^[a-f0-9]{16}$/i.test(right)) {
    throw new Error('SimHash 必须是 16 位十六进制字符串');
  }
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (difference > 0n) {
    distance += Number(difference & 1n);
    difference >>= 1n;
  }
  return distance;
}
