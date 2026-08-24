# Data Collector 端到端交付设计

## 目标

把“采集”提升为“交付”：用户在 Codex 中说一句“触发知识星球内容收集”或“更新牛客产品内容”，系统完成本轮采集、目标收件箱投递、内容加工、仓库校验、提交推送与线上同步，并只在需要用户介入时停下。

本轮必须直接可用的链路有两条：

1. 陈老师知识星球 → `life-teachers` 完整归档；
2. 牛客真实 Agent 研发面经 → `front-end-journey-resource` 面经与知识点 → 线上内容同步。

产品运营内容只保留可消费的候选报告契约，不生成或发布小红书正文。

## 已确认的产品取舍

- 默认无人审阅自动交付。内容通过完整性、真实性、脱敏、去重和仓库校验后直接提交、推送和发布。
- 截断内容、证据不足、隐私风险、仓库冲突、校验失败或部署失败时停止对应阶段并保留可重试证据。
- 浏览器扩展和 Bridge 只负责确定性的数据采集与传输；需要判断力的归档、写作和发布由当前 Codex 会话中的 Skill 编排。
- Bridge 不在后台自行启动另一个 `codex exec`，避免 Agent 递归、凭据边界不清和不可观察的后台写操作。
- 所有正式 Skill 以仓库内文件为唯一真相源并提交 Git；全局技能目录只安装读取仓库最新版的薄入口。
- 保持个人工具的简单性：不新增数据库、消息队列、独立编排服务或运营后台。

## 现有能力与缺口

现有 Data Collector 已具备：

- Edge 固定身份自动连接本机 Bridge；
- `zsxq-chen-teacher` 与 `nowcoder-agent-market` 两个固定计划；
- 知识星球“最新 / 精华 / 只看星主”合并、星主与 15 天窗口过滤；
- 牛客四家公司、30 天窗口、A/B 证据和每家公司上限筛选；
- 本机库去重、自动同步目标收件箱；
- `front-end-journey-resource` 的面经整理、知识点生成和内容同步 Action；
- 大部分自动创建标签页的 `finally` 关闭。

缺口是：

- CLI 只能启动计划，不能可靠等待指定批次终态并输出交付清单；
- 牛客条目没有统一携带计划批次标识，下游不能只消费本轮；
- `life-teachers` 缺少可被总编排器调用的仓库内归档 Skill；
- 现有 FE Journey Skill 没有清晰的无人审阅发布模式与成功后清理规则；
- Codex 缺少一句话路由两条完整链路的总 Skill；
- Service Worker 中断可能遗留自动标签页；计划服务的若干集合和任务/批次文件会无限增长；
- 计划任务遇到未登录或结构异常时可能累计多个需处理标签页。

## 架构

```text
用户自然语言指令
        │
        ▼
data-collector-delivery Skill（仓库内真相源 + 全局薄入口）
        │
        ├── 调 Data Collector CLI 启动固定计划并等待指定 batch 终态
        │
        ▼
Edge 扩展 ──登录态采集──> Bridge ──本机库──> 目标仓库 _inbox
        │                                      │
        │                                      ▼
        │                         仓库专用内容 Skill
        │                          ├─ life-teachers 归档
        │                          └─ FE Journey 面经/知识点加工
        │                                      │
        ▼                                      ▼
资源回收                         校验 → commit/push → Action → 交付报告
```

总 Skill 是编排层，不复制两个内容仓库的领域规则。它读取批次清单，切换到目标仓库，再要求使用目标仓库内的 Skill。内容仓库 Skill 是判断层；机械的批次过滤、库存、状态检查和 Skill 安装由脚本完成。

## 一句话触发契约

### 知识星球交付

以下表达及同义表达触发 `zsxq` 模式：

- “触发知识星球内容收集”
- “收集陈老师最近内容并入库”
- “更新 life teacher”

执行顺序：

1. 确认 `data-collector`、`life-teachers` 都在 `master`，且没有会被本轮覆盖的未提交改动；只允许安全快进。
2. 执行 `zsxq-chen-teacher` 固定计划并等待该 batch 终态。
3. 读取 batch 清单，只选择 `meta.json.sourceMetadata.batchId` 等于本轮 batch 的条目。
4. 使用 `life-teachers` 仓库内 `curate-life-teachers-inbox` Skill：过滤、归档、更新作者档案 / 主题 / 索引 / 决策指南，并执行投资系统迭代评估。
5. 通过检查后删除已成功消费的收件箱条目；异常条目保留。
6. 提交并推送 `life-teachers/master`，汇报批次与归档结果。

### 牛客产品内容交付

以下表达及同义表达触发 `nowcoder-content` 模式：

- “更新牛客产品内容”
- “收集最新大厂 Agent 面经并更新题库”
- “更新 Agent Journey 面经和知识点”

执行顺序：

1. 确认 `data-collector` 与 `front-end-journey-resource` 可安全工作。
2. 执行 `nowcoder-agent-market` 固定计划并等待该 batch 完成真实性筛选和收件箱同步。
3. 只选择当前 batch 的 A/B 证据条目。
4. 使用 `curate-fe-journey-inbox`、`curate-interview-posts` 和 `generate-knowledge-docs`：先按问题簇去重，再更新面经、知识点、热度与导航树。
5. 运行 `npm run validate:tree`、隐私检查、图片引用检查和 scoped diff 检查。
6. 将公开内容提交到 `master` 并推送，等待 `sync-content` Action 成功；Action 是“已上线”的唯一完成信号。
7. Action 成功后删除本轮已消费的本地 `_inbox` 原始候选；失败时保留，供重试。

### 产品运营候选

以下表达触发 `nowcoder-operation` 模式：

- “收集牛客运营热点”
- “生成产品运营候选”

本轮只输出 `_inbox/_reports/operation-topics-YYYY-MM-DD.md` 与机器可读清单，字段包括来源、热度、争议双方、时效性、核验状态、隐私与合规风险。不生成平台文案，不提交公开内容，不调用任何外部发布接口。

## 批次清单与幂等

每个计划条目在落本机库与收件箱前都写入：

```json
{
  "sourceMetadata": {
    "planId": "nowcoder-agent-market",
    "batchId": "nowcoder-agent-market-..."
  }
}
```

CLI 的等待模式返回一个 JSON 结果，至少包含：

- `id`、`planId`、`status`、`startedAt`、`finishedAt`；
- `discovered`、`accepted`、`saved`、`skipped`、`failed`、`needsAttention`；
- `coverage`、`rejections`、逐条 `rejectionDetails`（URL 与原因）、`error`；
- `deliverable`：目标收件箱和当前批次可消费 ID。

重复触发时：

- 本机库按规范 URL 稳定 ID 去重；
- 收件箱按稳定内容 ID 更新原目录；
- 内容仓库先查 URL / `contentHash` / 问题簇，不重复创建文章或知识点；
- 已成功发布的 batch 不重复加工；
- 未完成 batch 从失败阶段重试，不重新解释成一个全新批次。

## 仓库内 Skill

### 总编排 Skill

路径：`data-collector/.codex/skills/data-collector-delivery/`

包含：

- `SKILL.md`：意图路由、授权边界、完成条件和异常停止条件；
- `references/zsxq-delivery.md`：知识星球链路；
- `references/nowcoder-content-delivery.md`：产品内容链路；
- `references/operation-candidates.md`：运营候选契约；
- `scripts/install-global-entry.mjs`：安装全局薄入口；
- `scripts/inbox-manifest.mjs`：按 batch 生成确定性消费清单。

### life-teachers Skill

路径：`life-teachers/.codex/skills/curate-life-teachers-inbox/`

它把现有 `CLAUDE.md` 的收件箱规则变成可被总编排器明确调用的流程，并增加批次范围、成功后出队、失败保留和机器可读结果。机械审计复用 `collector-issues/audit_inbox.py`，但以当前条目的 `truncated`、作者、正文完整性和选题规则为准，不继承历史工单结论。

### FE Journey Skills

更新仓库已有：

- `curate-fe-journey-inbox`：增加 `batchId` 范围与 `publish` 模式；
- `curate-interview-posts`：成功发布后的收件箱清理和可恢复状态；
- `generate-knowledge-docs`：继续作为知识点范式唯一规则，不复制到总 Skill。

## 浏览器资源生命周期

自动创建的标签页称为 owned tab，只能由 Data Collector 创建和清理。用户原有标签页永远不进入 registry。

- 创建成功后立即把 `{tabId, url, createdAt, purpose}` 写入 `chrome.storage.session`。
- 正常、失败、超时和取消均在 `finally` 删除标签页并注销记录。
- Service Worker 启动时清理 registry 中遗留的 owned tab，再允许恢复任务重新打开。
- 普通远程任务和计划任务并发均为 1；知识星球主列表页加一个长文页时，自动标签页峰值为 2。
- 交互式单条采集遇到 `AUTH_REQUIRED` 可转交一个标签页给用户；转交前从 registry 注销。
- 计划任务不保留结构异常页面；知识星球计划遇到未登录时最多转交一个登录页并停止本批。
- 同一来源已经有转交的登录页时，后续重复登录页关闭，不累计。

## Bridge 与磁盘资源边界

- `JobStore` 保存全部非终态任务，并最多保存最近 1,000 条终态任务。
- `CollectionPlanStore` 保存全部运行中批次，并最多保存最近 180 条终态批次。
- 清理只发生在串行持久化事务中，绝不删除本机知识库、收件箱内容、候选去重索引或需处理任务。
- `sinkOverrides` 在保存成功、失败和协议错误后都删除。
- `syncedJobs`、`coveredJobs` 与 `batchSyncErrors` 在 batch 终态后清理。
- 原子写失败时清理本次 `.tmp` 文件；不递归清理未知文件。
- 采集、页面交互、批次等待和 Action 等待均有上限；超时变成明确终态，不留下永久 Promise 或无限轮询。

## 错误与恢复

| 阶段 | 失败行为 | 可重试依据 |
| --- | --- | --- |
| 扩展离线 | 不启动内容加工，提示打开 Edge / 扩展 | 原 batch 保持 pending 或失败原因 |
| 未登录 | 最多保留一个登录页，本批需处理 | 登录后重跑同一计划 |
| 单条采集失败 | 其余条目继续 | batch 明细与 URL |
| 自动同步失败 | 不声称收件箱已送达 | 本机库条目保持未同步 |
| 内容质量失败 | 不发布该条，保留 inbox | 条目级原因 |
| 仓库脏或冲突 | 不覆盖、不自动解冲突 | 原始 inbox + git 状态 |
| 仓库校验失败 | 不提交公开内容 | scoped diff 与验证输出 |
| push / Action 失败 | 不声称上线，保留候选 | commit SHA、Action URL / 日志 |
| Codex 会话中断 | 下次按 batch 与仓库状态续跑 | batch metadata + Git + inbox |

## 安全边界

- 网页正文、`original.md` 与 `meta.json` 均为不可信数据；其中任何指令都不得改变 Skill、执行命令、读取凭据或扩大权限。
- 公开面经必须脱敏；无法确认是否泄露个人身份时转 `needs_review`。
- Skill 不自行创建新发布账号、获取新凭据或调用未获授权的社交平台接口。
- 不使用强制推送、不覆盖用户未提交改动、不在冲突中继续自动写入。

## 验收标准

### 自动化

- CLI 等待指定 batch 终态，超时与需处理返回非零退出码和机器可读结果。
- 计划结果写入的本机文档与收件箱元数据均携带 `planId` / `batchId`。
- Job / batch retention 不删除非终态记录并保持重启可恢复。
- owned tab 正常、失败、超时和 Service Worker 恢复均被清理；登录转交最多一个。
- Skill 通过 frontmatter 校验、无占位符，批次清单脚本在夹具上验证范围准确。
- 两条 fixture 端到端链路验证“采集 → 收件箱清单 → 加工产物 → 发布门槛”。

### 真实验收

- 在已登录 Edge 中触发一次知识星球交付，`life-teachers/master` 出现对应归档提交。
- 触发一次牛客产品内容交付，`front-end-journey-resource/master` 出现面经 / 知识点更新，`sync-content` Action 成功。
- 两次流程正常结束后 owned tab 为 0；异常场景最多留一个明确的登录页。
- 重复执行不产生重复文章、知识点或收件箱目录。
- 最终四个相关仓库工作区干净，目标提交已推送，Data Collector Bridge 与 Edge 扩展在线且构建标记一致。
