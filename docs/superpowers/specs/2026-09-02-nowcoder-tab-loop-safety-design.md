# 牛客采集页签循环安全设计

## 背景

2026-09-02 09:00 启动的 `nowcoder-agent-market` 定时批次在浏览器离线后长期保持
`running`。Edge 再次连接时，Bridge 将普通 `dispatched` / `collecting` 子任务无条件恢复为
`queued` 并重新派发。用户手动关闭扩展创建的牛客详情页时，扩展又把它当作普通
`COLLECTION_FAILED`；固定计划或定向运行会继续补下一条。重复重连时，同一子任务没有持久化
恢复次数上限，因此可能形成“关闭后又打开”的循环。

## 已确认事实

- 当前事故不是新的定向搜索运行；所有定向运行均已终态。
- 残留固定批次 `nowcoder-agent-market-20260902010037794-7bf81b4e` 仍为
  `running`，12 个子任务中 11 个已保存、1 个长期停在 `collecting`。
- `JobStore.recover()` 对普通在途任务无条件回退到 `queued`，没有恢复代次。
- `waitForTabComplete()` 能观察存活 Service Worker 中的 `tabs.onRemoved`，但关闭错误没有稳定的
 机器可读代码；Service Worker 丢失时只剩 Bridge 的在途状态。
- Bridge 的普通任务派发没有验证 fixed-plan 父批次仍为 `running`。

## 目标

1. 用户关闭扩展拥有的牛客采集页签时，视为明确的“停止本次牛客运行”，不得继续补下一条。
2. Service Worker 或 WebSocket 丢失仍允许一次自动恢复，但同一任务不能无界恢复。
3. 父批次已经终态后，任何残留 `queued` 子任务都不得再次触发 `job.collect`。
4. 事故中的旧批次在升级后的第一次恢复中进入可解释终态，不再打开牛客页面。
5. 侧栏能显示牛客定向运行仍然活跃，避免固定计划页面显示正常却存在隐藏运行。

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

`JobRecord` 增加向后兼容的可选 `recoveryCount`。`JobStore.recover()` 对普通任务执行：

- 第一次观察到 `dispatched` / `collecting`：`recoveryCount + 1` 并回到 `queued`；
- 第二次仍未收到终态：进入 `needs_attention`，代码为 `RECOVERY_LIMIT_EXCEEDED`；
- directed jobs 仍由原有 directed reconciliation 管理；ZSXQ attempt fence 保持原有语义。

`recover()` 返回本次因超过预算而终态化的任务，Server 对它们调用既有
`notifyJobTerminal()`，使 fixed plan 正常对账并离开 `running`。

对升级前已经长期在途的 `nowcoder-agent-market` 任务，缺少 `recoveryCount` 视为已经使用过一次
恢复；这样升级后的首次连接直接转 `needs_attention`，不会再次重开。新创建任务从 0 开始，仍有
一次真实崩溃恢复机会。

### 4. 状态可见性

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
- 旧批次升级后不重开；成功采集、首次崩溃恢复、ZSXQ 和 directed 既有测试继续通过。
