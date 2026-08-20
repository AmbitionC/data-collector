# fe-journey 定时采集与内容消费设计

**日期：** 2026-08-19
**状态：** 已确认，进入实现
**产品定位：** Agent Journey 是专注 Agent 全栈研发的学习与成长平台。

## 1. 目标与边界

本设计只解决两件事：

1. Data Collector 如何以个人固定规则定时收集高质量的面经、知识、运营选题素材和优秀项目候选；
2. 收集结果如何经过确定性筛选、跨 URL 去重、相似内容聚合和 Codex 批处理，转化为可更新到 fe-journey 的内容。

明确不做：

- 面向多用户的订阅、关键词、频率配置界面；
- 情报中台、管理后台、数据库工作流；
- 求职平台、能力诊断、会员权益、定价或购买链路；
- 自动发布未经人工复核的内容；
- 绕过登录、验证码、反自动化或大规模历史爬取。

## 2. 兼容性硬约束

- 微信公众号与知识星球现有提取器、列表批采、广告过滤、选题过滤、长文补全和收件箱路由行为不得改变。
- 新逻辑放在独立的 `packages/bridge/src/feJourney/` 模块中；共享模型只增加向后兼容的可选字段和 `github` 来源。
- fe-journey 定时器只在本机检测到内置 `fe-journey` sink 时启用；其他安装环境没有网络请求和行为变化。
- 知识星球继续路由到 `life-teachers`，GitHub 与牛客只路由到 `fe-journey`。
- 所有新行为必须有单元测试、集成测试，并在全量测试、类型检查、构建和知识星球 E2E 冒烟通过后才可交付。

## 3. 最小架构

```text
固定个人预设
  ├─ 牛客公开搜索页（每日）──> 详情 URL 任务 ──> Edge 已登录页面提取
  └─ GitHub Search API（每周）──> 仓库元数据 + README
                                   │
                                   v
Data Collector 本机 Markdown 库
  ├─ fe-journey 候选类型与初筛分
  ├─ 规范 URL / 正文哈希 / SimHash 聚类
  └─ 显式同步到 resource 仓库本地 `_inbox/`
                                   │
                                   v
Codex `curate-fe-journey-inbox` skill
  ├─ 面经：聚合标准问题并更新 interview
  ├─ 知识：检索现有文章后增量更新 knowledge
  ├─ 运营：生成本地私有选题报告
  └─ 项目：生成本地候选评分报告
```

不新增业务服务。原始采集与私有报告都留在本机；resource 仓库的 `_inbox/` 被 git 忽略，只有人工复核后的 `interview/`、`knowledge/` 和清单修改进入 Git。

## 4. 固定个人预设

预设以代码常量交付，不提供设置 UI：

- 时区：`Asia/Shanghai`；
- 牛客：每 24 小时运行一次，每次最多创建 24 个未见过的详情任务；
- GitHub：每 7 天运行一次，每次最多保存 12 个项目候选；
- Bridge 启动时检查上次运行时间，到期才运行；失败保留状态与错误，下次周期重试；
- 提供一个受本机令牌保护的“立即执行”接口和 CLI 命令，供冒烟与人工补跑，不提供关键词编辑能力。

牛客固定查询：

- `Agent 面经`
- `AI 应用开发 面经`
- `Agent 平台开发`
- `RAG 面试`
- `大模型应用开发`
- `MCP 面试`
- `LangGraph 面试`

GitHub 固定查询围绕 `ai-agent`、`rag`、`mcp-server`、`agent-framework`、`llm-app`，并限制非 fork、最近仍维护和最低基础热度。Star 只用于发现，不作为最终质量结论。

## 5. 候选内容契约

`CollectedDocument` 增加可选的 `feJourney` 元数据；微信和知识星球文档不写该字段：

```ts
type FeJourneyCandidateKind = 'interview' | 'knowledge' | 'operation' | 'project';

interface FeJourneyCandidateMetadata {
  candidateKinds: FeJourneyCandidateKind[];
  qualityScore: number;          // 0..100，确定性初筛
  qualitySignals: string[];
  exclusionReasons?: string[];
  contentHash: string;           // 归一化正文 SHA-256 截断值
  simHash: string;               // 64 位十六进制
  clusterId: string;             // 相似内容簇稳定标识
  duplicateOf?: string;          // 同正文或近似内容的代表条目 id
  projectScore?: number;         // GitHub/项目线索初筛分
  projectSignals?: string[];
}
```

该字段写入本机 `_source.json` 和同步收件箱 `meta.json`，成为 Codex 的输入证据。

## 6. 初筛与去重

### 6.1 候选类型

- `interview`：标题/正文包含面经、面试轮次、公司岗位、问题与追问等强信号；
- `knowledge`：包含原理、实现、架构、评测、部署、故障、对比等工程知识；
- `operation`：包含趋势、争议、踩坑、用户痛点、行业变化等可形成选题的信号；
- `project`：GitHub 仓库，或正文包含仓库、Demo、项目架构、开源等项目证据。

一条内容可以同时属于多类。

### 6.2 质量初筛

面经/知识初筛由相关度、信息密度、第一手信号、增量线索和时效组成，并扣除推广、求职闲聊、纯题单、正文过短等噪声。初筛只决定优先级和排除原因，不自动生成公开内容。

### 6.3 三层确定性去重

1. 规范 URL：同 URL 始终覆盖同一条；
2. 正文哈希：跨 URL 原文相同，进入同一簇并标记代表条目；
3. 64 位 SimHash：归一化中文/英文 token 后计算，汉明距离不超过阈值时进入同一近似簇。

原始证据仍保留，但 Codex 必须按 `clusterId` 聚合，公开内容不能按原始条目一比一生成。

语义同义但文本差异较大的内容由 Codex 在加工阶段聚合；采集器不调用大模型。

## 7. 项目候选初筛

项目初筛总分 100：

- 学习价值 25；
- 工程完整性 20；
- 可运行性证据 15；
- 代码质量证据 15；
- Agent 技术深度 10；
- 维护状态与许可证 10；
- 文档与演示 5。

采集器只能根据仓库元数据、README、目录与固定信号给出“初筛分”；Codex 再读取候选仓库证据完成复核。Fork、README 模板和同源衍生项目聚合到上游代表项目。输出仅为项目候选报告，不涉及项目发布、会员或产品改造。

## 8. Codex 消费规则

resource 仓库增加一个 `curate-fe-journey-inbox` skill，批次处理规则：

1. 读取 `_inbox/nowcoder` 与 `_inbox/github`；
2. 校验 `meta.json`，按 `clusterId` 合并重复和近似内容；
3. 先检索现有 `_tree.json` 和 Markdown，命中已有主题时更新而非新建；
4. 面经只从第一手/高置信内容抽取标准问题、追问和来源时间，不复制原文叙述；
5. 知识内容只做有证据的增量更新；
6. 运营选题写到 `_inbox/_reports/operation-topics.md`；
7. 项目候选写到 `_inbox/_reports/project-candidates.md`；
8. 低质量与排除内容写到 `_inbox/_reports/skipped-items.md`；
9. 公开内容修改运行资源仓库校验后走分支与 PR；
10. 不自动删除原始收件箱，待人工确认 PR 后再清理。

## 9. 冒烟与真实验证

自动化门禁：

- 全量 `npm test`；
- `npm run typecheck`；
- `npm run build`；
- `npm run test:e2e`，重点确认知识星球列表批采与长文补全；
- 新增固定 HTML/API fixture 的 fe-journey 集成冒烟；
- package manifest 权限不扩大到不需要的域名。

真实验证：

1. 用公开牛客搜索页发现真实详情 URL；
2. 通过运行中的 Bridge + Edge 扩展采集至少一篇真实牛客详情；
3. 通过 GitHub API采集至少一个真实项目候选；
4. 显式同步到本地 `_inbox/`；
5. 运行 Codex skill，证明相似项被聚合，产出运营/项目报告，并对至少一个真实面经或知识主题完成资源内容更新；
6. 校验资源仓库、构建前端或调用现有内容读取链验证最终可消费效果；
7. 最终报告逐项列出设计、代码、测试、审查发现、真实样本、内容变更和线上验证证据。
