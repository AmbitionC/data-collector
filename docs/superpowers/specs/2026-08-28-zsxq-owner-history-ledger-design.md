# 知识星球「只看星主」历史审计与逐日账本设计

**日期：** 2026-08-28

**状态：** 设计已确认，待实现计划复核

**适用计划：** `zsxq-chen-teacher`

## 1. 背景与问题

当前知识星球定时计划使用固定回看窗口，并对每个视图设置条数上限。这个策略适合低成本增量扫描，但无法证明「只看星主」历史内容已经完整采集：

- 固定 15 天回看会重复读取已经确认过的日期，浪费时间和请求。
- 每视图 20 条上限只能证明“读过一小段”，不能证明已读到时间边界或历史末尾。
- 现有批次只记录视图级计数，不能回答某个上海自然日是“有内容且已处理”“确实无内容”还是“尚未检查”。
- 仅按 canonical URL 去重无法识别少量跨 URL 的语义重复；反过来，已知 URL 但正文完整性未知的旧数据又不能安全跳过。
- 若在去重和确定性过滤之前补全外链正文，会对最终必然跳过的项目产生额外浏览、处理和下游 token 消耗。

本设计是对既有定时来源计划设计中“固定回看窗口”和“不做历史全量爬取”限制的定向修订，仅适用于经过既有过滤规则后的「只看星主」内容。`最新`、`精华`以及其他来源仍沿用各自现有策略，除非另有设计。

## 2. 目标

1. 对「只看星主」建立可审计的上海自然日账本；每个已经结束的日期必须明确记录为有有效内容、有效内容为零或失败。
2. 日常定时任务不再固定回刷 15 天，而是检查最近一个已结束日期，并向后补齐所有未检查或失败的日期，直到接上连续完成边界。
3. 提供一次性、可恢复的「只看星主」历史审计/补采模式，从当前已登录会话向历史翻页，直到 API 明确耗尽。
4. 保留现有关注范围过滤，只采集符合投资、创业、商业、财富、职业与认知主题的内容，并过滤打新、楼市、相亲和明确广告。
5. 将去重尽量前置；只对真正缺失、需要修复且可能被接受的条目执行正文补全和下游交付。
6. 任何“不完整”“未证明”“达到安全上限”的状态均失败关闭，不能伪装成空日或完成。

## 3. 非目标

- 不取消既有主题、广告、作者身份或相关性过滤。
- 不采集非星主作者内容。
- 不自动删除或合并历史库中已经存在的可疑重复项；本次只报告并阻止新增重复。
- 不把本需求扩展成通用采集 DSL 或新建第二套计划系统。
- 不在账本、批次日志或桥接协议中持久化 Cookie、localStorage、完整正文等敏感或大体积数据。

## 4. 选定方案

继续使用固定计划 `zsxq-chen-teacher`，在同一执行器下增加两种明确模式：

### 4.1 日常逐日模式

定时调度默认运行该模式。它读取逐日账本，处理最近一个已经结束的上海自然日，并继续向历史方向补齐相邻的缺口或失败日，直到接上最近的连续完成边界。列表分页不受 20 条限制，必须至少翻到目标最老日期之前，取得越过日期边界的证据。

该模式不使用固定 15 天窗口。需要访问多少天由账本缺口决定：正常情况下只封账昨天；如果电脑离线、登录失效或某次采集失败，则下一次运行只补缺失日期，不重扫已完成日期。

### 4.2 「只看星主」历史模式

通过显式手工入口启用，例如 CLI 参数 `--owner-history`。它只遍历 `by_owner` 视图，不受 20 条限制和日期回看窗口限制，从最新内容持续向历史翻页，直到 API 返回短页或空页并提供真实耗尽证据。

历史模式用于首次建立账本、审计已有数据并补采过滤后缺失的内容。中断后从检查点恢复，而不是从头开始。该模式不创建新的计划定义，也不改变定时调度频率。

## 5. 上海自然日账本

### 5.1 存储

使用独立的原子 JSON 存储，例如：

```text
~/.data-collector/zsxq-day-ledger.json
```

独立存储避免把长期逐日覆盖信息塞入短生命周期批次文件。写入必须采用临时文件加原子替换；旧执行尝试的 token 不能覆盖新尝试的结果。

账本以计划 ID、视图和 `Asia/Shanghai` 日期为键。首版只为 `zsxq-chen-teacher/by_owner` 建账，不为早于“API 实际观察到的最老星主主题日期”的日期虚构零记录。

### 5.2 日期状态

已结束日期只有三种持久化终态：

- `completed_content`：该日存在至少一条经过过滤后应保留的星主内容，且所有接受或修复任务均已到达终态；内容此前已经完整存在于本地库也仍然属于“有内容”。
- `completed_empty`：采集已越过该日边界，能够证明该日过滤后的有效内容为零。原始星主内容可能为零，也可能全部被过滤，但不能因为内容已经在本地库而把该日记成空日。
- `failed`：鉴权、分页、正文完整性、保存或对账任一环节失败，无法安全完成该日。

日期键缺失即表示 `unchecked`，不额外写入这一状态。失败不能被转换为“零内容”。

建议的日期记录结构如下：

```ts
type ZsxqDayLedgerEntry = {
  status: 'completed_content' | 'completed_empty' | 'failed'
  rawOwnerCount: number
  qualifyingCount: number
  filteredCount: number
  exactDuplicateCount: number
  semanticDuplicateCount: number
  knownCompleteCount: number
  repairCount: number
  candidateCount: number
  savedCount: number
  failedCount: number
  crossedDayBoundary: boolean
  checkedAt: string
  batchId: string
  attemptToken: string
  errorCode?: string
}
```

`completed_empty` 描述的是“过滤后不存在有效内容”，而不是“没有需要新增的内容”。它不能仅凭列表第一页没有目标内容得出，并且至少要求 `crossedDayBoundary=true`。`qualifyingCount > 0` 的日期必须是 `completed_content`，即使这些内容全部因已完整存在而被前置去重。

### 5.3 当天与封账语义

08:00 的定时任务可以观察当天已发布内容，但上海当天尚未结束，不能把当天持久化为最终 `completed_empty` 或 `completed_content`。当天观察结果属于批次暂态；次日任务重新读取并封账前一日。

因此正常调度的最低行为是：

1. 封账昨天。
2. 从昨天向历史方向寻找相邻的缺失或失败日期并补齐。
3. 遇到最近的连续完成边界后停止。
4. 可增量观察今天的新内容并保存符合条件的项目，但不以此证明今天已经完整。

手工补采同样不能提前封账尚未结束的当天。这样既保持及时收集，也不会把上午无内容误记成全天无内容。

## 6. 历史审计与补采

### 6.1 分页与耗尽证明

历史模式使用当前已登录浏览器会话调用已有签名 API，并固定为「只看星主」查询：

1. 从最新页开始，按 API cursor/end time 向历史翻页。
2. 每页处理完后保存 cursor、页数、最老已观察时间和聚合计数。
3. 只有 API 返回短页或空页时，才设置 `exhausted=true`。
4. 可以保留较高的安全页数上限防止死循环；命中上限必须将审计标记为失败/需关注，绝不能当作成功耗尽。
5. cursor 不前进、时间倒退异常、重复页或鉴权失败都必须失败关闭并保留可恢复检查点。

历史审计从最老的实际星主主题日期到最近一个已结束日期生成逐日记录。中间没有任何原始星主主题的日期也要写入 `completed_empty`，从而形成连续、可检查的日期覆盖。

### 6.2 可恢复检查点

检查点至少包含：

```ts
type ZsxqOwnerHistoryCheckpoint = {
  planId: 'zsxq-chen-teacher'
  mode: 'owner-history'
  batchId: string
  attemptToken: string
  cursor?: string
  pagesFetched: number
  newestObservedAt?: string
  oldestObservedAt?: string
  exhausted: boolean
  seenTopicIds: string[]
  seenFingerprints: string[]
  updatedAt: string
}
```

实现可对 `seenTopicIds` 和 fingerprint 做紧凑编码，但不得保存完整正文。每处理完一页就原子持久化一次。恢复时必须校验计划、模式和 attempt token，防止过期运行覆盖当前进度。

## 7. 前置去重与过滤流水线

执行开始时一次性加载本地知识库索引：

- canonical URL → 内容 ID 与 `contentComplete` 状态；
- topic ID → 内容 ID；
- 规范化语义 fingerprint → 完整内容 ID。

每条 API 记录严格按以下顺序处理：

1. **来源校验：** 验证 topic ID、星主身份、发布时间和 canonical URL。无法证明作者是星主的记录不进入候选。
2. **精确去重：** canonical URL 或 topic ID 已存在且 `contentComplete=true` 时，立即计数并跳过，不打开外链、不补正文、不进入下游。
3. **语义去重：** 使用 API 已有标题/正文、发布时间和规范化文本生成 fingerprint。若与本地完整内容形成高置信重复，则跳过并写入审计报告。不同 URL 的历史重复项只报告，不自动删除。
4. **廉价确定性过滤：** 使用已有文本执行打新、楼市、相亲和明确广告过滤。命中后立即跳过。
5. **正文修复/补全：** 仅对仍可能被接受的新条目，以及本地已知但 `contentComplete=false/undefined` 的条目运行 `withLinkedArticle` 等完整性流程。
6. **完整正文相关性过滤：** 在补全后正文上判断投资、创业、商业、财富、职业与认知相关性，避免因为列表摘要过短造成误杀。
7. **接受与保存：** 只有正文完整并通过过滤的条目才能保存或修复；不完整状态不能标记为已完成。

去重和确定性过滤过程不调用 LLM。只有本批次真实新增或修复的 delivery ID 才能进入后续整理，避免重复项目消耗 token。

## 8. 批次事实与审计指标

现有 `coverage: Record<string, number>` 不足以表达耗尽证明和失败原因。批次应增加有类型的审计结果，至少包括：

```ts
type ZsxqOwnerAudit = {
  mode: 'daily-ledger' | 'owner-history'
  pagesFetched: number
  observed: number
  qualifying: number
  exactDuplicates: number
  semanticDuplicates: number
  filtered: number
  knownComplete: number
  repaired: number
  saved: number
  failed: number
  newestObservedAt?: string
  oldestObservedAt?: string
  exhausted: boolean
  safetyCapReached: boolean
  completedDays: number
  emptyDays: number
  failedDays: number
}
```

某日只有在以下条件同时满足时才能写入完成终态：

- 分页已经越过该日边界；
- 该日所有被接受的采集 job 均为终态；
- 所有需要修复的已知条目均成功或被明确记为失败；
- 保存结果已重新读回或通过批次 manifest 对账；
- 不存在未归类错误。

历史审计整体只有在 `exhausted=true`、`safetyCapReached=false`、`failed=0` 且日期账本连续时才算通过。

## 9. 交付语义

沿用固定计划现有自动交付合同：符合条件且成功保存的新增/修复内容同步到 life-teachers inbox，下游仅消费当前批次 manifest 中的精确 delivery ID。

已完整存在、被过滤、精确重复或语义重复的项目不产生 delivery ID。若本次补采没有新增或修复，则可以成功完成为空批次，但必须保留审计和逐日账本证据。

## 10. 错误与安全边界

- 登录失效、API 拒绝或浏览器桥接失败：批次失败，相应日期为 `failed` 或保持未检查。
- 正文无法补全：不得写入完整内容，也不得完成相关日期。
- 分页达到安全上限：整体失败并保留 cursor，禁止写 `exhausted=true`。
- API 返回重复 cursor 或重复页：停止并失败，避免无限循环。
- 本地知识库索引损坏：停止采集，不在未知去重状态下继续保存。
- 当天尚未结束：只允许暂态观察，禁止最终封账。
- 日志和账本只保留 ID、hash、计数、日期、cursor 与错误码，不保留会话凭证或完整正文。

## 11. 迁移与兼容

1. 首次部署后，现有历史批次不反推“零日”，因为旧批次缺少越界证明。
2. 运行一次 `owner-history` 审计，从真实 API 历史重建「只看星主」逐日账本。
3. 已知 URL 且正文完整的内容作为去重事实；完整性未知的旧内容进入修复路径。
4. 历史审计通过后，定时任务切换到逐日账本模式，不再固定回刷 15 天。
5. 既有计划 ID、自动交付目标和日常调度时间保持不变。

## 12. 测试策略

### 12.1 单元与集成测试

必须覆盖：

- 「只看星主」超过 20 条并跨多页时可以持续翻页；
- API 越过日期边界后正确区分 `completed_content` 和 `completed_empty`；
- 尚未结束的当天永不被最终封账；
- 账本缺口按相邻日期回补，已完成日期不被固定重复扫描；
- 空页/短页是唯一正常耗尽证据，安全上限命中时失败关闭；
- canonical URL/topic ID 精确去重发生在外链正文处理之前；
- 跨 URL 语义重复被报告并阻止新增；
- `contentComplete=false/undefined` 的已知内容进入修复而不是跳过；
- 主题和广告过滤尽量在正文补全前发生；相关性判断使用完整正文；
- 每页检查点可恢复，旧 attempt 不能覆盖新状态；
- 手工历史运行不改变下一次定时调度；
- 日期完成必须等待该日所有 job 和保存对账完成。

### 12.2 仓库验证

实现完成后执行：

```bash
npm run typecheck
npm test
npm run package
npm run test:e2e
```

涉及批次、扩展或桥接协议的变更必须使用同一构建产物完成 E2E，避免源码与已加载扩展版本不一致。

### 12.3 真实数据验收

在已重新登录的 Edge 会话中执行一次可恢复的 `owner-history` 审计和补采，并验证：

1. API 正常耗尽，未命中安全上限，失败数为零。
2. 从最老实际星主主题日期到昨天的账本日期连续，每日均为内容、零或明确失败；最终验收不允许失败日。
3. 对所有通过过滤的主题与本地知识库重新对账；每个主题要么有 canonical URL 精确映射，要么有经审计的高置信语义重复映射，未映射数为零。
4. 已知但正文不完整的条目已修复，新增和修复内容均通过完整性校验。
5. 精确重复和语义重复没有产生重复 delivery ID；历史可疑重复只出现在报告中。
6. 当前批次 manifest 与实际保存结果一致；若 manifest 非空，仅处理其中的精确 ID。
7. 再运行一次日常模式时，已完成历史日期不会被固定回刷，只处理当天暂态和最近封账/缺口范围。

## 13. 完成标准

本需求只有同时满足以下条件才完成：

- 逐日账本、缺口回补、历史审计、前置去重和失败关闭均已实现并通过自动化测试；
- 真实历史审计达到 API 耗尽，过滤后的「只看星主」内容全部存在于本地库且正文完整；
- 日期覆盖连续，确实无有效内容的日期有显式 `completed_empty` 记录；
- 没有未解决的失败日、缺失 URL 或本批次新增重复；
- 日常定时任务已从固定 15 天回刷切换为账本驱动，并经二次运行验证。
