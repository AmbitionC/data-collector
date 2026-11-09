import { describe, expect, it } from 'vitest';
import { countTerms, pickPage, statLines, type SitePage } from '../../packages/bridge/src/operations/siteContext.js';

const pages: SitePage[] = [
  { module: 'knowledge', key: 'agent-learning-roadmap', label: '从零到 Agent 工程师的学习路线', filePath: 'agent' },
  { module: 'knowledge', key: 'rag-evaluation', label: 'RAG 评测：检索与生成分开度量', filePath: 'llm/rag' },
  { module: 'knowledge', key: 'llm-token-context', label: 'Token、Context Window 与 KV Cache', filePath: 'llm/basics' },
];
describe('lead grounding', () => {
  it('picks the page whose title phrases appear in the post', () => {
    expect(pickPage(pages, '面试被问 RAG 评测怎么做，检索和生成怎么分开看')?.key).toBe('rag-evaluation');
    expect(pickPage(pages, 'Context Window 不够用怎么办')?.key).toBe('llm-token-context');
  });
  it('falls back to the roadmap only for route questions', () => {
    expect(pickPage(pages, 'Java 后端想转大模型，求一个学习路线')?.key).toBe('agent-learning-roadmap');
    expect(pickPage(pages, '今天面试好紧张')).toBeUndefined();
  });
  it('states only counted numbers for terms the post mentions', () => {
    const stats = countTerms(['RAG 和 Redis', 'RAG 幂等', 'Kafka']);
    expect(statLines(stats, '想补 RAG 和 Kafka')).toEqual(['站内 3 篇面经里，2 篇问到了 RAG', '站内 3 篇面经里，1 篇问到了 Kafka']);
    expect(statLines(stats, '今天好累')).toEqual([]);
    expect(countTerms(['Google algorithm', 'Go 并发']).counts.Go).toBe(1);
  });
});
