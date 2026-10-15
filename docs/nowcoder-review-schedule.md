# 牛客跨公司待审核收集

此功能复用现有 Data Collector 扩展、Bridge 与牛客面经提取器。周期设置初始关闭；保存设置不会立即收集。开启后沿用 Bridge 的 15 分钟到期检查，每个上海自然日 09:00 后最多启动一次。电脑休眠、Bridge 未运行或扩展离线时没有采集；当天恢复在线后才检查到期任务，不补造离线期间的每日运行。

## 使用

在侧栏「任务」里选择公司，勾选周期收集并点击保存。要只收集一次，点击牛客面经计划的手动按钮；新版侧栏请求待审核模式，周期设置可继续关闭。空公司选择不能提交。未保存的修改不会被状态轮询覆盖；保存失败留在屏上等待用户处理。

CLI 需要已存在的 Bridge 认证，支持以下显式操作：

```bash
npm run collector -- plans schedule
npm run collector -- plans schedule --json '{"enabled":true,"companies":["ant","tencent"],"reviewOnly":true}'
npm run collector -- plans schedule --json-file /absolute/private/schedule.json
npm run collector -- plans run nowcoder-agent-market --review-only --companies ant,tencent
```

`--config` 仍表示既有 Bridge 配置目录。关闭周期设置时保存同样的 JSON 并使用 `enabled:false`。仅查看状态不会启动收集。旧 CLI 不带 `--review-only` 的预设手动行为保持兼容。

## 库存与停机条件

库存按所配置资源仓库的已发布面经叶子和本机合格待处理来源统计，以较低库存公司优先；相等库存使用持久轮转顺序。发布目录分类和实际正文必须可读，不能用未知库存代替零。待处理来源需通过既有固定计划的质量与 30 天时间窗口；URL、正文指纹和证据 cluster 去重。

当已发布面经和合格待处理来源同时存在时，必须用显式指定的仓库外私有来源账本核对所有已发布叶子的来源身份，防止把转载或已发布内容重复计库存。Bridge 启动环境通过 `DATA_COLLECTOR_INTERVIEW_HISTORY` 提供账本的绝对路径，库存模块以 `readCompanyInventory(resourceRoot, libraryRoot, now, historyPath)` 接收；不猜路径、不读取资源仓库内 `.codex` 账本、不复制账本入仓库，也不通过侧栏或公开 API 暴露路径。

账本必须是资源仓库外的普通文件，路径各层不能包含符号链接；读取限制为 16 MiB、10,000 条来源记录，每个已发布叶子必须对应一条有效来源记录。缺少显式路径或完整身份记录时报告 `inventory-unverifiable`，路径或账本无效时报告 `inventory-invalid`，文件不可读时报告 `inventory-unavailable`，均不会先搜索。没有合格待处理来源时，不指定账本也可以根据真实目录和正文统计已发布库存；显式提供的账本仍需通过校验。私有账本不提交到 Git。

搜索与详情派发在同一批次共用串行队列，启动间隔至少两秒，详情一次只派一条。遇到登录、验证码、拒绝访问或 HTTP 429 会停止批次及未发送子任务；重启也不能重新派发同批队列。没有自动登录、验证码处理或反爬绕过。

## 本机审核边界

待审核模式在创建任务前固化：

- 批次：`nowcoderReviewOnly:true`、`nowcoderCompanies`、`reviewIds`；`deliveryIds` 始终为空。
- 子任务：`nowcoderReviewOnly:true` 与既有 `batchId/planId`。
- 本机 source.json 与 catalog：`nowcoderReviewOnly:true`，重新采集相同来源仍保持待审核标记。

`reviewIds` 是该批次通过既有面经筛选的稳定本机来源 ID。未达目标、停止或出错的运行如实记录终态，已保存原文仍保留本机。该模式不调用自动同步、提交或推送；其他自动批次以及「同步未同步」不能把这些来源补进交付池。用户逐条明确同步是单独操作，必须先检查来源并限定 ID。

加工发生在资源仓库。当前批次的审核材料必须限定精确 `sourceId/articleKey`，之后执行资源仓库内实际 `generate-knowledge-docs` 技能，给每个面经问题记录语义候选、复用/更新/创建理由、真实执行转录与回执，并取得独立知识质量审核。准备命令只返回 `needs_execution`；没有运行和审核证据不会发布。采集阶段不生成知识文章或增加知识热度。

本文描述的是代码能力。本次实现未启用周期配置、安装扩展、重启用户进程或实际采集。


## 与已有本地改动整合的私有来源边界

- `DATA_COLLECTOR_INTERVIEW_INVENTORY_ROOT` 可显式指定只读的已发布面经快照，独立于保存/交付 inbox 的目标目录。必须是绝对路径；不设置时保留原有目标目录行为。
- `DATA_COLLECTOR_INTERVIEW_HISTORY` 指向资源仓库外的私有来源台账。库存、搜索预览、定向派发和选择现在使用同一显式输入。配置文件缺失、符号链接、超大文件或不兼容记录会阻止该路径，不会悄悄变成空历史。
- 仓外 schemaVersion1 的采集身份读取支持 ISO updatedAt，并原样保留 prepared/B-partial。它们只能提供“曾处理来源”的排重身份，不代表合格库存或发布许可；库存仍要求完整可核验的发布绑定。
- `bodySha256` 和 `processUnitId` 不能代替采集时的16位 contentHash/clusterId。现代记录可通过schemaVersion2私有身份投影恢复真实原件中的采集身份；详见[身份投影契约](nowcoder-identity-projection.md)。缺当前来源绑定时继续阻止运行，不猜测、截断或升级等级。
- 待审核详情在串行派发边界再次读取本地、待审和历史来源；预览后已保存的重复项记录 SOURCE_ALREADY_COLLECTED，不再打开详情页。终态推进在释放限速队列后执行，避免下一任务等待自己。

升级不自动迁移或重写原台账，不新建定时器。已有脏工作区仍应通过独立整合、完整验证和保留回滚副本后再切换。打包成功不等于运行中的 Bridge/Chrome 已更新。

定向搜索的有效日期候选按已有最新排序最多保留500条；无日期素材单独最多保留500条，仍只供预览。超出量分别写入diagnostics.skippedCounts.candidate_limit/review_only_limit，不丢弃整个已成功的搜索结果。待审核运行中的已知来源按跳过计数，可在原请求/详情预算内继续补齐；真实整轮布局失败仍停止。
