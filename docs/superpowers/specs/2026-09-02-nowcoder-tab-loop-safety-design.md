# 牛客采集页签循环安全设计

## 背景

2026-09-02 09:00 启动的 `nowcoder-agent-market` 定时批次在浏览器离线后长期保持
`running`。Edge 再次连接时，Bridge 将普通 `dispatched` / `collecting` 子任务无条件恢复为
`queued` 并重新派发。用户手动关闭扩展创建的牛客详情页时，扩展又把它当作普通
`COLLECTION_FAILED`；固定计划或定向运行会继续补下一条。重复重连时，同一子任务没有持久化
恢复次数上限，因此可能形成“关闭后又打开”的循环。

第一次修复后的受控恢复又暴露出第二个独立生产者：常驻 Bridge 启动时会立即执行 FeJourney，
其默认双源运行一次性创建了 18 条没有 `planId`、`batchId`、`directedRunId` 或
`recoveryCount` 的普通牛客任务。扩展并发处理两条，关掉一组后再派下一组，外观与无限循环相同；
而 `enableFeJourneyScheduler` 还隐式开启每日固定计划，两个调度器的所有权边界不清晰。

在 Edge 仍关闭的第二次受控启动中，18 条任务已经安全终止，但计划模块因 9 个历史牛客批次不满足
计数 schema 而 fail closed。根因是正常已完成的 selection 批次在重连时又按详情子任务重算，导致
selection-level `saved` / `skipped` 与 detail-level terminal counters 混用；更早的 pending pool
还可能让当前批次的 `discovered` 小于 `accepted + failed + needsAttention`。

## 已确认事实

- 当前事故不是新的定向搜索运行；所有定向运行均已终态。
- 残留固定批次 `nowcoder-agent-market-20260902010037794-7bf81b4e` 仍为
  `running`，12 个子任务中 11 个已保存、1 个长期停在 `collecting`。
- `JobStore.recover()` 对普通在途任务无条件回退到 `queued`，没有恢复代次。
- `waitForTabComplete()` 能观察存活 Service Worker 中的 `tabs.onRemoved`，但关闭错误没有稳定的
 机器可读代码；Service Worker 丢失时只剩 Bridge 的在途状态。
- Bridge 的普通任务派发没有验证 fixed-plan 父批次仍为 `running`。
- 后台 FeJourney 默认同时发现牛客和 GitHub，会在没有可见用户运行的情况下批量创建普通牛客任务。
- 现场任务账本中的 18 条 `fe-journey-nowcoder-*` 均为 `dispatched`，且没有恢复计数。
- `enableFeJourneyScheduler` 同时控制 FeJourney 与固定计划到期检查，不能独立证明谁启动了浏览器工作。

## 目标

1. 用户关闭扩展拥有的牛客采集页签时，视为明确的“停止本次牛客运行”，不得继续补下一条。
2. Service Worker 或 WebSocket 丢失仍允许一次自动恢复，但同一任务不能无界恢复。
3. 父批次已经终态后，任何残留 `queued` 子任务都不得再次触发 `job.collect`。
4. 事故中的旧批次在升级后的第一次恢复中进入可解释终态，不再打开牛客页面。
5. 侧栏能显示牛客定向运行仍然活跃，避免固定计划页面显示正常却存在隐藏运行。
6. 常驻 FeJourney 不得在后台创建牛客浏览器任务；两套 scheduler 必须由独立开关控制。
7. 升级前遗留的普通牛客 `queued` / `dispatched` / `collecting` 任务全部 fail closed。
8. 受影响的历史计划可自动、严格地迁移；正常终态批次重连后不再改写统计或禁用整个计划模块。

## 设计

### 1. 明确关页信号

扩展为 `waitForTabComplete()` 的页签移除错误使用稳定错误名
`CollectorTabClosedError`。`JobRunner.runRemoteJobNow()` 将该错误以及 Chrome 的权威
`No tab with id` 错误映射为 `job.error` 代码 `TAB_CLOSED_BY_USER`。扩展自身在 `finally`
中的正常回收不经过该错误分支。

### 2. 停止整个牛客运行

Bridge 收到 `TAB_CLOSED_BY_USER` 后先将当前子任务持久化为终态，再执行父级停止：

- `nowcoder-agent-market` fixed plan：批次进入 `completed_with_attention`，错误信息说明用户关页；
- Nowcoder directed run：复用现有 durable cancellation 流程；
- 普通单条任务：只终止当前任务。

固定牛客计划改为单任务在途：Bridge 每次只向扩展派发一个详情任务，收到该任务终态后才派发
下一个。这样用户关掉当前页时，扩展内不存在已经预排队、随后还会继续开页的同批兄弟任务。

派发边界新增 fixed-plan ownership fence：父批次不存在或不再 `running` 时，残留子任务进入
`failed(STALE_PLAN_RUN)`，不得发送 `job.collect`。用户关页后，批次先进入
`completed_with_attention`，尚未派发的同批任务再统一进入 `failed(PLAN_STOPPED_BY_USER)`。
`job.progress/result/error` 进入状态机或 sink 前也复核父批次；停止后的迟到内容不得落库。

### 3. 有界恢复

`JobRecord` 增加向后兼容的可选 `recoveryCount`。`JobStore.recover()` 对 Bridge 拥有、非 directed
的牛客任务执行：

- 第一次观察到 `dispatched` / `collecting`：`recoveryCount + 1` 并回到 `queued`；
- 第二次仍未收到终态：进入 `needs_attention`，代码为 `RECOVERY_LIMIT_EXCEEDED`；
- directed jobs 仍由原有 directed reconciliation 管理；ZSXQ attempt fence 保持原有语义。

`recover()` 返回本次因超过预算而终态化的任务，Server 对它们调用既有
`notifyJobTerminal()`，使 fixed plan 正常对账并离开 `running`。

对升级前缺少 `recoveryCount` 的 `queued`、`dispatched`、`collecting` 牛客任务，视为已经使用过
一次恢复；Bridge 启动恢复时直接转 `needs_attention`，并在扩展 hello 后只重放 durable failure，
不得发送 `job.collect`。新创建任务从 0 开始，仍有一次真实崩溃恢复机会。

### 4. 调度器所有权

常驻 FeJourney 调度显式调用 `{ nowcoder: false, github: true }`，只做无需浏览器的 GitHub 发现。
牛客后台采集只保留每日 `nowcoder-agent-market` 固定计划；显式手动 FeJourney 与 directed run
仍可按用户操作创建牛客任务。`enableFeJourneyScheduler` 不再回退开启 collection plan scheduler，
生产 CLI 分别显式开启两个开关。

### 5. 终态计划计数兼容

终态牛客批次的计数是筛选结果快照，重连和迟到终态不得再用详情子任务覆盖。只有收到当次
`TAB_CLOSED_BY_USER` / `RECOVERY_LIMIT_EXCEEDED`、且父批次仍为 `running` 时，才允许在 fixed
batch lock 内完成硬停止重算；父批次一旦终态，后续只清理 queued 子任务，父计数保持冻结。

存储加载只兼容一种可证明的旧坏形态：terminal `nowcoder-agent-market` 且
`selectionStatus=completed`、terminal counters 溢出 `discovered`。迁移恢复
`saved=accepted`，按 `accepted + failed + needsAttention` 提升 `discovered` 下界并重算 `skipped`，
然后立即原子持久化。其他来源或其他非法结构继续拒绝。所有新写入在落盘前经过严格 schema 校验。

### 6. 状态可见性

`plans.status` 同时返回 `directedRunActive`。固定任务页在该值为真时显示一条“牛客定向采集正在
运行”的提示；为假时不占界面。该提示只表达服务端事实，不在侧栏复制定向运行状态机。

## 非目标

- 不改变搜索、筛选、归档或知识点生成逻辑。
- 不增加新的调度器或后台常驻进程。
- 不改变知识星球采集的 attempt、正文完整性和账本语义。
- 不自动关闭用户自己打开的牛客页签；只处理 Data Collector 拥有的页签。

## 验收

- 手动关页产生 `TAB_CLOSED_BY_USER`，父级先终态化，后续重连的 `job.collect` 次数为 0。
- 同一个普通在途任务最多自动恢复一次；第二次重连进入 `needs_attention`。
- 父 fixed plan 终态后，残留 queued job 被 fence，绝不创建浏览器页签。
- directed run 的关页走取消并关闭其 owned tabs，不进入补量。
- fixed-plan 牛客详情始终最多一个在途；停止后的迟到 result 不写入 sink。
- 预置现场形态的 18 条旧普通任务后，启动并连接扩展收到 18 个 durable failure、0 个
  `job.collect`，等待窗口内不再产生消息。
- FeJourney scheduler 访问 GitHub 但不访问牛客，也不隐式触发固定计划的到期补跑。
- 旧 selection 计数迁移后计划文件可重新打开；正常终态批次即使存在旧
  `RECOVERY_LIMIT_EXCEEDED` child，重连前后计数仍完全一致。
- active hard-stop 的终态计数通过 schema 且可重新打开；非牛客 overflow 不适用兼容迁移。
- 旧批次升级后不重开；成功采集、首次崩溃恢复、ZSXQ 和 directed 既有测试继续通过。
