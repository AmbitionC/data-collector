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

const INTERVIEW_TOPIC_RULES: readonly [string, RegExp][] = [
  ['introduction', /自我介绍|介绍一下自己/iu],
  ['ai-direction', /为什么.{0,12}(?:选择|做).{0,12}(?:AI|人工智能|大模型).{0,12}方向|选择.{0,12}(?:AI|人工智能|大模型).{0,12}方向/iu],
  ['project-deep-dive', /AI\s*Coding|智能编码|代码生成.{0,12}项目|项目.{0,12}(?:介绍|深挖)|介绍.{0,12}项目/iu],
  ['learning-tools', /(?:学习|跟进).{0,12}(?:前沿|新).{0,12}技术|编程工具/iu],
  ['agent-architecture', /(?:理解|设计).{0,8}Agent|Agent.{0,12}(?:系统|架构|核心模块)/iu],
  ['tool-design', /(?:Tool|工具调用).{0,12}(?:设计|原则|实现)/iu],
  ['memory', /Memory|记忆.{0,8}(?:类型|实现|设计)/iu],
  ['react-plan', /ReAct|Plan[-\s]?Execute/iu],
  ['multi-agent', /多\s*Agent|Multi[-\s]?Agent/iu],
  ['rag-pipeline', /RAG.{0,16}(?:(?:整体|完整).{0,4})?(?:流程|链路)/iu],
  ['chunking', /Chunk|分块.{0,12}(?:大小|重叠|策略)/iu],
  ['retrieval', /向量.{0,8}(?:召回|检索)|混合检索|召回结果/iu],
  ['rerank', /Rerank|重排/iu],
  ['rag-finetune', /RAG.{0,10}(?:微调|fine[-\s]?tun)|(?:微调|fine[-\s]?tun).{0,10}RAG/iu],
  ['rag-cost', /RAG.{0,16}(?:延迟|成本|性能)/iu],
  ['hallucination', /Bad\s*Case|幻觉/iu],
  ['reliability-observability', /(?:大模型|LLM).{0,20}(?:超时|异常|重试|降级|可观测)|可观测性/iu],
];

function numberedSegments(text: string): string[] {
  const markers = [...text.matchAll(/(?<!\d)([1-9]\d?)[.、．]\s*/gu)];
  if (markers.length < 3) return [];
  return markers.map((marker, index) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const next = markers[index + 1];
    const end = next?.index ?? text.length;
    return text.slice(start, end).trim();
  });
}

function normalizedQuestionHeader(segment: string): string {
  const questionEnd = segment.search(/[？?]/u);
  const lineEnd = segment.search(/[\r\n]/u);
  const ends = [questionEnd >= 0 ? questionEnd + 1 : -1, lineEnd]
    .filter(value => value >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : Math.min(segment.length, 100);
  return normalizeExactContent(segment.slice(0, end));
}

/**
 * 提取编号面经的稳定问题序列。已知高频问题归一到主题键，避免答案扩写或
 * 少量措辞变化把同一次面试的长短版本误判为两篇独立样本。
 */
export function normalizedInterviewQuestions(text: string): string[] {
  return numberedSegments(text)
    .map(segment => {
      const topic = INTERVIEW_TOPIC_RULES
        .map(([name, pattern], ruleIndex) => ({ name, ruleIndex, index: pattern.exec(segment)?.index }))
        .filter((match): match is { name: string; ruleIndex: number; index: number } =>
          match.index !== undefined)
        .sort((left, right) => left.index - right.index || left.ruleIndex - right.ruleIndex)[0]?.name;
      return topic ?? normalizedQuestionHeader(segment);
    })
    .filter(question => question.length > 0);
}

export function questionFingerprint(text: string): string | undefined {
  const questions = normalizedInterviewQuestions(text);
  if (questions.length < 3) return undefined;
  return bytesToHex(sha256(encoder.encode(questions.join('\n')))).slice(0, 16);
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
