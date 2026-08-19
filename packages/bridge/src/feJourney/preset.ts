export const FE_JOURNEY_PRESET = Object.freeze({
  timezone: 'Asia/Shanghai',
  nowcoder: Object.freeze({
    intervalMs: 24 * 60 * 60 * 1_000,
    maxPerRun: 24,
    queries: Object.freeze([
      'Agent 面经',
      'AI 应用开发 面经',
      'Agent 平台开发',
      'RAG 面试',
      '大模型应用开发',
      'MCP 面试',
      'LangGraph 面试',
    ]),
  }),
  github: Object.freeze({
    intervalMs: 7 * 24 * 60 * 60 * 1_000,
    maxPerRun: 12,
    queries: Object.freeze([
      'topic:ai-agent stars:>=50 fork:false',
      'topic:rag stars:>=100 fork:false',
      'topic:mcp-server stars:>=20 fork:false',
      'topic:agent-framework stars:>=50 fork:false',
      'topic:llm-app stars:>=50 fork:false',
    ]),
  }),
});
