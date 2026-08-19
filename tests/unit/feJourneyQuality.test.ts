import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import {
  contentFingerprint,
  hammingDistance64,
  scoreFeJourneyCandidate,
  simHash64,
} from '../../packages/bridge/src/feJourney/index.js';

function nowcoderDocument(title: string, text: string): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url: 'https://www.nowcoder.com/discuss/123456',
    canonicalUrl: 'https://www.nowcoder.com/discuss/123456',
    title,
    author: '牛客用户',
    publishedAt: '2026-08-18T03:00:00.000Z',
    collectedAt: '2026-08-19T00:00:00.000Z',
    html: `<p>${text}</p>`,
    text,
    images: [],
  };
}

describe('fe-journey deterministic candidate scoring', () => {
  it('recognizes a first-person Agent interview as interview and knowledge material', () => {
    const text = [
      '昨天参加了某大厂 Agent 全栈研发岗位的一面，下面记录我的真实面试过程。',
      '面试官先让我介绍做过的 RAG 项目，然后追问向量检索召回率如何评测。',
      '第二题是 MCP 工具调用失败怎样重试，要求说明幂等、超时与状态恢复。',
      '第三题让我手写一个并发任务调度器，并继续追问事件循环和 Promise 错误传播。',
      '最后讨论了 LangGraph 的状态持久化、人工确认节点以及生产环境部署。',
    ].join('');

    const result = scoreFeJourneyCandidate(nowcoderDocument('Agent 全栈研发一面面经', text));

    expect(result.candidateKinds).toEqual(['interview', 'knowledge']);
    expect(result.qualityScore).toBeGreaterThanOrEqual(65);
    expect(result.exclusionReasons).toBeUndefined();
    expect(result.qualitySignals).toEqual(expect.arrayContaining(['第一手面试经历', '包含工程知识证据']));
  });

  it('separates engineering knowledge and operation topic candidates', () => {
    const knowledge = scoreFeJourneyCandidate(nowcoderDocument(
      '从零实现 ReAct Agent 的工具调用与记忆系统',
      '本文拆解 ReAct Agent 的架构和实现原理，包括工具注册、参数校验、调用超时、失败重试、短期记忆、长期记忆、可观测性、评测集和 Docker 部署。每个模块都给出接口选择、故障场景和性能对比。',
    ));
    const operation = scoreFeJourneyCandidate(nowcoderDocument(
      'Agent 产品最近爆火背后的三个用户痛点',
      '最近行业里关于 Agent 产品是否真的有用出现了明显争议。本文记录团队踩坑、用户反馈和行业变化，可以形成一组有事实依据的内容选题，而不是单纯追热点。',
    ));

    expect(knowledge.candidateKinds).toEqual(['knowledge']);
    expect(knowledge.qualityScore).toBeGreaterThanOrEqual(45);
    expect(operation.candidateKinds).toEqual(['operation']);
    expect(operation.qualityScore).toBeGreaterThanOrEqual(35);
  });

  it('scores a GitHub repository only as a candidate project, without membership semantics', () => {
    const document: CollectedDocument = {
      schemaVersion: 1,
      source: 'github',
      kind: 'article',
      url: 'https://github.com/acme/agent-lab',
      canonicalUrl: 'https://github.com/acme/agent-lab',
      title: 'acme/agent-lab',
      author: 'acme',
      publishedAt: '2026-08-10T00:00:00.000Z',
      collectedAt: '2026-08-19T00:00:00.000Z',
      html: '',
      text: 'Open source AI agent example. Quick start with npm install and npm test. Includes Docker deployment, architecture documentation, evaluation cases, CI and an MIT license.',
      images: [],
      sourceMetadata: {
        stars: 420,
        forks: 38,
        openIssues: 12,
        license: 'MIT',
        updatedAt: '2026-08-10T00:00:00.000Z',
      },
    };

    const result = scoreFeJourneyCandidate(document);

    expect(result.candidateKinds).toEqual(['project']);
    expect(result.projectScore).toBeGreaterThanOrEqual(70);
    expect(result.projectSignals).toEqual(expect.arrayContaining(['有运行说明', '许可证明确']));
    expect(JSON.stringify(result)).not.toMatch(/会员|权益/);
  });

  it('requires repository evidence before treating a Nowcoder post as a project candidate', () => {
    const vocabularyOnly = scoreFeJourneyCandidate(nowcoderDocument(
      'Agent 面经里的项目架构追问',
      '面试官围绕项目架构、GitHub 开源生态和 Demo 快速开始连续追问，正文只是复盘题目与回答，并没有提供任何可复核的代码仓库。',
    ));
    const linkedRepository = scoreFeJourneyCandidate(nowcoderDocument(
      'Agent 开源项目复盘',
      '这是一个开源 Agent Demo，包含项目架构与快速开始。代码仓库：https://github.com/acme/agent-lab 。',
    ));

    expect(vocabularyOnly.candidateKinds).not.toContain('project');
    expect(vocabularyOnly.projectScore).toBeUndefined();
    expect(linkedRepository.candidateKinds).toContain('project');
    expect(linkedRepository.projectScore).toBeTypeOf('number');
  });

  it('penalizes short job-wish chatter and promotional copy', () => {
    const result = scoreFeJourneyCandidate(nowcoderDocument(
      '许愿 offer，求捞',
      '求 offer，求内推，加微信进求职群，扫码领取付费训练营资料。',
    ));

    expect(result.candidateKinds).toEqual([]);
    expect(result.qualityScore).toBeLessThanOrEqual(10);
    expect(result.exclusionReasons).toEqual(expect.arrayContaining([
      '正文过短',
      '求职闲聊',
      '推广导流',
      '缺少可消费内容类型',
    ]));
  });
});

describe('fe-journey deterministic fingerprints', () => {
  it('normalizes punctuation, whitespace and Latin case for exact content hashes', () => {
    expect(contentFingerprint('Agent 架构：MCP 工具调用。')).toBe(
      contentFingerprint('  agent\n架构 mcp 工具调用!  '),
    );
  });

  it('keeps a light rewrite closer than unrelated content', () => {
    const original = simHash64('RAG 检索包括文档切分、向量召回、重排和答案评测。');
    const rewrite = simHash64('RAG 检索流程包括文档切分、向量召回、结果重排以及答案评测。');
    const unrelated = simHash64('CSS 容器查询根据父元素宽度切换卡片的网格布局。');
    const closeDistance = hammingDistance64(original, rewrite);

    expect(original).toMatch(/^[a-f0-9]{16}$/);
    expect(closeDistance).toBeLessThanOrEqual(18);
    expect(hammingDistance64(original, unrelated)).toBeGreaterThan(closeDistance);
  });
});
