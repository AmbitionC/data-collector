# 牛客运营批次与计量优化

用户在 2026-10-30 明确批准上一轮四项优化，并授权发布新版后再评论五条、对比耗时与 token。沿用 master，不新建 worktree，不重复请求已有授权。

## 目标与边界

把确定性的搜索、采集、语境读取、草稿保存、顺序发布和统计收进插件/Bridge/CLI 的固定批次命令。模型只做候选选择、参与判断和批量起草。保留完整正文、实际评论与覆盖范围；短上下文执行者按仓库回复参考工作，不靠统一风格模板降低质量。

沿用现有已认证 Bridge、配置好的扩展与 NowcoderOperationsStore，不引入模型服务、依赖、站点权限、收件箱投递或定时发评。无 Browser Use 日常找帖。关键图片无法从文字判断时仍须查看；验证、登录或访问限制保留现场并停止。

## 批次接口

新增 `nowcoder ops workflow --file /absolute/request.private.json [--send] [--wait 600000]`，以及 `nowcoder ops stats --id RUN_ID`。旧单条命令保持兼容。输入严格 schemaVersion=1，key 为12–100位字母/数字/下划线/连字符。

请求三种 kind：

- `search`：queries 为1–3个非空关键词，每个最多100字符；limitPerQuery 为1–20，默认8。逐查询复用现有最新JSON搜索、一页预算，合并规范URL去重，排除已回复来源，保留查询和覆盖诊断。
- `prepare`：candidates 为1–8项 `{sourceId,url}`，sourceId 必须与规范URL的 stableContentId 一致；maxPages 为1–3，默认2。串行使用现有配置扩展的普通 collect/job 合同保存正文，再 add/context。每项必须可核实完整正文，不能以搜索短摘替代。遇 needs_attention/failed/超时/验证停止并保留精确 job/run 和已经观察到的证据。此模式不投递收件箱。
- `publish`：items 为1–5项 `{key,draft}`，draft 为现有 operationDraftImportSchema；操作ID与单条发送键均去重。只有 CLI 显式 `--send` 才发。发送前校验整份清单的 schema、修订/正文/评论绑定、原文锚点及来源状态；每项保存稿后调用已有单次发布，串行执行。任何非 observed published 结果停止剩余项，保留未执行明细，不自动补发/补数。结果不确定仍用已有只读 verify。跨不同批次也靠已有单条台账禁止重复发送。

publish 缺少 `--send` 时，CLI 直接报错，不发请求、不保存草稿、不创建批次；后续显式加 `--send` 才创建首次运行，避免无发送试用占住幂等 key。

Bridge 新增受认证的 workflow POST/GET/stats 路由。运行记录在配置目录独立私有子目录，持久化请求摘要、状态、每项结果与阶段时间。key 绑定完整请求摘要；相同请求返回已有运行，不重放。不同请求复用 key 拒绝。全批 busy 覆盖异步落盘、采集、逐条间隙，纳入自更新/重启与外部冲突操作的栅栏；嵌套内部操作不与自身互斥死锁。

长任务在 Bridge 运行，CLI 在进程内等待并低频读取状态；模型不逐条轮询。进程重启后遗留 running/queued 记为待核验终态，不自动重跑发布。单条 dispatching/uncertain 记录仍为最终去重依据，批次日志不能覆盖它。全部写入私有目录，不改用户网页、不刷新用户标签页。

`--wait` 仅是客户端等待期限，不是服务端取消。到期明确返回运行ID、当前状态、waitingTimedOut 与查询方法，退出非零；后台仍执行原来已授权的批次，不能称为取消或未发送。支持 `workflow --id RUN_ID [--wait ...]` 继续等原运行；复用原 key/原请求只读取该运行，不重放。准备项沿用60秒 job等待期限；超时保留准确jobID，不用另一个采集结果填补。

终态 stdout 一份 JSON，含 runId、状态、摘要计数、耗时和私有 resultPath。完整准备材料/结果写本机私有文件；status/stats 不重复倾倒所有正文、旧稿和诊断。模型按需读取准备包，完整原始证据仍保留。准备包含当前完整帖文、实际评论、楼主标记/回复、赞数、图片引用、覆盖限制、版本绑定的 draftEnvelope，以及从冻结正文提取的原文 anchorOptions。正文相同只保留一份；当前正文与冻结来源不一致时明确标注并保留二者，不能隐去冲突。

## 页面读取与拒绝诊断

现有 `.comment-title` 节点出现不等于总数/评论已就绪，固定300ms也不保证楼中楼加载完成。用有界的条件等待得到稳定标题/正文、评论总数和当前可见评论指纹；展开后等待内容或完成状态变化。合法空评论页可返回未知总数，不能伪造0或完整覆盖。仍不能稳定时明确 attention/coverage，不能静默跳过真实变化。

CONTEXT_CHANGED 返回有界结构化差异：变化字段（title/body/images/comments/total）、新增/移除/变化的评论URL、前后总数；不回传整份旧新正文。此额外诊断要通过共享结果schema、Bridge持久证据和CLI回执，不能只在扩展内存在。计数/点赞/加载指示等非语义字段不冒充评论正文改变；已有有意忽略 likes 的比较保持不变。真正的内容变化仍拒绝，单次点击、编辑器模型校验、转发保护、持久 dispatching 和 uncertain 不重发保持。

## 固定执行资料与计量

新增精简运行参考，链接既有评论证据和推荐规则，附上述实际JSON示例、阶段停止规则、原文锚点用法、产品能力核验入口及外部 Skill 尚未上线的状态。仅推荐本轮已核实内容，域名裸写 agent-journey.cn；不编造亲历，不将读过评论说成高赞，不以减少必要语境换速度。

工作流自动记录 startedAt/finishedAt/elapsedMs、每阶段开始/结束/状态、真实成功/拒绝/未执行数及准确来源ID。统计同明细同源。插件没有宿主模型 token 权限，不声称能自行获取。

新增离线 `scripts/codex-run-usage.mjs --file /absolute/measurement.private.json`：输入显式 sessionPaths（一个或多个绝对JSONL路径）、from/to ISO时间。流式读取，只聚合范围内 token_usage_record 的逐响应 usage，按 response_id 去重，校验非负、cached<=input、reasoning<=output、total=input+output；输出缓存/非缓存输入、输出、推理子集、响应数和范围。不同时累计 token_count，缺失字段明确报错，不能当0。stdout 不含原始对话、工具数据或凭证。完整回复结束前只能报告标明截止点的快照。

## 验收与实发

TDD 覆盖去重、schema/key冲突、全清单预检、部分成功后的停止、重启/超时不重放、busy/update竞争、延迟评论/楼中楼、真实变化差异、CLI长等待与离线计数。跑 typecheck、全量单测、package、E2E，并由新上下文评审整份改动。版本统一升一个补丁号，master提交/推送、CI成功、GitHub release和本机Bridge/扩展构建标记一致。

实发仍只授权五条新评论。运营任务在发布验证后才开始：用独立短上下文执行者读精简运行参考，插件搜帖/准备，批量选写后由父任务核对上下文与草稿，再显式批次发送。成功数由 observed 回执去重，达到五条即停止。开发、测试、CI、发版耗时与运营实测分开。

对比边界统一为“开始本批选帖→第5条 observed 回执”，包含此期间参与任务的父/子执行者全部模型响应；读取必要规则、失败处理也计入，不只挑成功路径。旧版从已有原日志同边界重算。缓存/非缓存输入/输出分别报告，不估算人民币；时间与token提升均以实测为准。目标是4–8个模型回合和五条3–5分钟，未达目标如实报告原因。回复质量展示五条原文、真实链接和上下文切入点，不凭主观自评宣称转化改善。
