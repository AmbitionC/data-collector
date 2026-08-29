# 牛客 Agent 面经定向搜索与插件交付设计

## 1. 背景与目标

当前 `nowcoder-agent-market` 已具备一条可靠的固定计划链路：Bridge 搜索牛客候选，浏览器扩展在后台详情页读取正文，本机库去重，Bridge 按时效、岗位、证据等级和问题簇筛选，达到目标后原子同步到 `front-end-journey-resource` 收件箱。

上一轮用 Browser Use 完成的检索体验还没有进入 Data Collector 产品：用户可以输入关键词、选择“最新”、查看大厂面经候选并继续向下寻找，但现有 Side Panel 只能运行写死的定时预设。固定计划还缺少当前查询、结果排名、扩展构建、取消和精确重试等证据，无法完整证明一次交付全部来自当前插件运行。

本次目标是把这类检索变成 Data Collector 的正式“定向搜索”能力：

- 用户或 CLI 提供一个或多个牛客搜索关键词；
- 搜索严格按最新发布排序，先预览候选，再由插件采集详情；
- 用户选中的候选优先，系统继续从同一搜索池补位，直到得到目标数量；
- 一次运行可恢复、可取消、可幂等重试、可审计；
- 搜索阶段由 Bridge 完成，详情阶段只使用 Data Collector 浏览器扩展，不依赖 Codex Browser Use、Playwright、Puppeteer 或模型推理；
- 固定每日计划保持原有调度语义，定向运行使用独立、显式的运行规格；
- 本次上线验收必须通过插件真实得到当前批次精确 10 篇可交付面经，并完成资源仓库发布。

## 2. 设计原则

1. **复用现有可信链路。** 搜索只负责发现；详情采集、稳定内容 ID、本机库、证据等级、30 天规则、Agent 研发岗位判断、问题簇去重和收件箱同步继续复用现有实现。
2. **不模拟搜索页 DOM。** Side Panel 提供与 Browser Use 等价的关键词和“最新”能力，Bridge 直接请求牛客搜索 JSON 接口；扩展只打开详情 URL。页面 DOM 改版不应破坏搜索。
3. **当前运行闭环。** 定向运行的交付只能来自该运行的搜索会话和详情任务，不得用历史 pending 内容凑足目标。
4. **精确终态。** 私有 `completed` 必须同时满足 `deliveryIds.length === deliveryItems.length === publicDeliveryItems.length === accepted === delivered === target`，且 ID、URL、问题簇均唯一；私有记录中的全部 job 属于当前 run/attempt。公开响应单独以去除 job ID 的 `publicDeliveryItems` 验证同样的 target、ID/URL/簇和 marker 不变量。少一篇就进入 `completed_with_attention`，且没有可消费的部分批次。
5. **证据优先。** 无法证明“最新”的搜索结果不能静默降级；无法证明扩展构建、详情完整性或当前批次归属时不能交付。
6. **长任务可控制。** 运行中可停止；取消、重试和 Side Panel 重开均有确定语义，晚到结果不能复活已取消批次。
7. **最小权限。** 不增加 `<all_urls>`、Cookie 权限或扩展 CSP 外网连接；搜索仍由只监听回环的 Bridge 执行。

## 3. 产品边界

### 3.1 本次范围

- Side Panel “任务”页新增牛客定向搜索表单、候选预览和运行进度；
- Bridge 新增持久搜索会话、定向运行规格、精确批次查询、取消和重试；
- CLI 暴露同一能力，供后续 Codex 交付 Skill 调用；
- 批次记录搜索排序、查询、排名、扩展构建和执行引擎审计；
- 浏览器扩展声明牛客详情能力并支持批次取消；
- 更新协议、产品文档、冒烟和构建产物 E2E；
- 使用新版插件采集并发布 10 篇面经及有效知识点。
- 将“用户显式启动、明确勾选交付 Agent Journey 的定向运行”列为普通手动采集之外的第三类授权例外；CLI 必须显式携带 `--deliver`。

### 3.2 非目标

- 不把牛客搜索页做成通用 DOM 自动化器；
- 不绕过登录、验证码、付费墙或站点访问控制；
- 不采集评论、Cookie、LocalStorage 或搜索页整屏 HTML；
- 不让用户勾选绕过 30 天、A/B 证据、Agent 岗位、完整性或去重门槛；
- 不改变知识星球计划、普通“保存这一页/批量保存本页”采集或已入库显式同步的产品边界；
- 不修改或部署 `fe-journey-faas`。

## 4. 总体架构

```text
Side Panel / CLI
  -> loopback HTTP + bearer token
  -> Bridge 创建持久 SearchSession
     -> 牛客 JSON Search（order=create）
     -> 规范化、全局最新排序、历史去重、候选预览
  -> Bridge 创建 Directed Run（先持久化，再派发）
     -> WebSocket job.collect
     -> Data Collector 扩展后台详情标签页（并发 <= 2）
     -> 专用 Nowcoder extractor
     -> Bridge 本机库 / 候选索引
     -> 30 天 + Agent 研发岗位 + A/B + 问题簇选择
     -> 不足则从同一 SearchSession 自动补位
     -> 达标后写入隔离 staging
     -> 全部校验通过后发布唯一 exact-batch marker
     -> marker 存在后 target 条才对 manifest 可消费
```

搜索请求不经过扩展页面 CSP；详情请求使用用户现有浏览器会话。Bridge 在开始时冻结扩展版本/build/capability 证据，活跃定向运行持有 artifact lease；每次派发、结果落库、补位和发布前都复核磁盘产物与在线扩展仍是同一 build。Service Worker runtime ID 可因同 build 重启而变化，但所有 runtime ID 都写入审计；build 变化立即 attention。

## 5. 用户体验

### 5.1 表单位置与字段

定向搜索区放在“任务”页标题与 `#plans-list` 之间，不放入每秒 `replaceChildren()` 的计划卡片容器。

- **搜索词**：每行一个，1–12 条；NFKC 规范化后每条 1–80 个字符，总长度不超过 480；去重并拒绝控制字符。
- **目标篇数**：1–10，默认 10。
- **排序**：只读显示“最新发布”；请求固定为 `order=create`。
- **预览候选**：按钮建立或刷新持久搜索会话。
- **交付授权**：明确勾选“达到目标后交付到 Agent Journey 收件箱”；未勾选不能启动自动交付运行。
- **采集并交付 N 篇**：默认勾选当前可采集候选，选中项只决定优先级；系统可从其余候选继续补位。按钮文案必须把自动交付副作用写出来。

表单草稿和最后一个会话 ID 可存入 `chrome.storage.local`；不得存正文、Cookie、token 或完整搜索响应。

### 5.2 候选预览

候选按可验证发布时间倒序展示：

- 标题；
- 规范详情 URL 的站点内类型；
- 命中的查询；
- 搜索页声明的发布时间；
- 页码和页内排名；
- `可采集 / 已处理 / 已在本批 / 待详情验证` 状态。

已处理项禁用并显示稳定原因。缺少可验证时间的候选可显示，但不参与“最新已验证”的自动选择。

### 5.3 运行状态

界面按同一批次展示：

```text
搜索中 -> 候选已就绪 -> 详情采集中 -> 最终筛选 -> 发布准备 -> 发布 marker
                                      |-> 需处理
                                      |-> 已取消（仅进入 publishing 前）
                                      `-> 已完成
```

运行中提供“停止”。终态展示搜索命中、详情调度、详情保存、合格、交付、拒绝原因和公司覆盖。错误使用中文可行动文案，不显示原生英文异常；1 秒计划轮询不得覆盖定向搜索的粘性错误或终态。

### 5.4 自动补位

用户选中项按当前顺序优先派发。每轮终态后重新执行最终筛选；不足目标时，从同一会话未调度候选中补位。默认沿用 8 条首轮、每轮 4 条和最多 24 个详情页的安全预算。达到目标后不再创建新任务；已经开始的详情任务正常收尾，但只有确定性选择出的前 `target` 条进入交付。

## 6. 数据模型与协议

### 6.1 运行规格

定向运行使用独立的 `NowcoderDirectedRun`，不向固定计划 ID、每日调度状态或 `CollectionBatch` 塞入可变关键词。两条链路只在内部复用搜索、详情任务、最终选择和收件箱同步原语：

```ts
type NowcoderDirectedRunSpec = {
  queries: string[];
  queryHash: string;
  target: number;
  sort: 'latest';
  maxDetails: 24;
  searchSessionId: string;
  idempotencyKey: string;
  deliveryMode: 'agent-journey-inbox';
};
```

定时计划继续使用当前 preset 和 `CollectionBatch`。Side Panel 与 CLI 只创建 `NowcoderDirectedRun`，不得把任意查询覆盖到预设配置中。定向 store 采用自己的版本化、原子、0600 持久文件，并在启动时兼容空状态；固定计划 store 无需因该功能升级格式。

`NowcoderDirectedRun` 另外持久化：

- `status: running | cancelling | publishing | cancelled | completed | completed_with_attention | failed`；
- `phase: collecting | selecting | staging | publishing`、当前轮次、候选 cursor、当前轮 job IDs；
- `attempt`、`retryOf`、冻结扩展 build/capability、观察到的 runtime IDs；
- 私有 `deliveryItems[]` 每项为 `{ jobId, stableContentId, canonicalUrl, contentHash, clusterId }`；公开 API 使用去掉 jobId 的 `publicDeliveryItems[]`，并提供不可逆 `lineageId` 供对账；
- `publishReceipt`，包含 exact IDs、entry hashes、marker path/hash 和发布时间；
- `activeOwnedTabs`、`peakOwnedTabs`、`terminalOwnedTabs`。

store 每次改变 phase/cursor/job ownership/publish receipt 都先原子持久化再产生外部动作。Bridge 启动时按这些 checkpoint 对 JobStore、staging 和 marker 对账：采集中只重派同 attempt 未终态 job；选择阶段不重新搜索；staging/publishing 阶段按 receipt/marker 幂等续写；marker 已存在则只能完成，不能回退为取消。

### 6.2 搜索会话

`NowcoderSearchSession` 在打开任何详情页之前原子持久化，至少包含：

- 会话 ID、规范查询、查询哈希、创建/过期时间；
- `requestedSort: 'latest'`、`provider: 'nowcoder-json'`、`sortVerified: true`；
- 每个请求的页码、响应数量和耗时；
- 每个候选的稳定候选 ID、规范 URL、内容类型、命中查询、页码、页内排名、发布时间和处理状态；
- 搜索错误和 attention 原因；
- 不包含正文、HTML、Cookie、认证头或作者隐私字段。

搜索 JSON 接口必须发送 `type: 'post'` 和 `order: 'create'`。必须优先使用响应中的真实详情 URL 并经过 Nowcoder HTTPS allowlist 规范化，不能只凭 ID 猜 `/discuss/<id>`。JSON 请求失败时，定向会话进入 attention；没有显式、已验证最新排序的 SSR 响应不得参与定向交付。

### 6.3 HTTP 与扩展消息

共享 schema 约束以下 API，并由 Server、扩展 connection、Side Panel 和 CLI 共用：

- `POST /v1/nowcoder/search-sessions`：创建预览；
- `GET /v1/nowcoder/search-sessions/:sessionId`：恢复预览；
- `POST /v1/nowcoder/runs`：从会话创建幂等定向批次，请求只可携带该会话内的 `selectedCandidateIds`；
- `GET /v1/nowcoder/runs/:runId`：精确读取定向运行；
- `POST /v1/nowcoder/runs/:runId/cancel`：持久状态进入 `publishing` 之前幂等取消；进入 `publishing` 后返回 409 并继续收敛；
- `POST /v1/nowcoder/runs/:runId/retry`：body 必须携带新的 retry idempotency key，按原冻结候选创建带 lineage 的新 run ID/attempt。

扩展内部消息使用对应的 `nowcoder.search.preview`、`nowcoder.search.run`、`nowcoder.run.status`、`nowcoder.run.cancel` 和 `nowcoder.run.retry`。未知字段、过期会话、非会话候选 ID、重复活跃 queryHash 或错误 idempotency key 均在 Bridge 边界拒绝。详情仍走普通 `job.collect`；取消由 Bridge 发送带 job ID 和运行 attempt 的 `job.cancel`，不引入搜索页内容脚本协议。

CLI 提供同一协议的无 UI 入口，支持重复 `--query`、`--target`、必填 `--latest`、必填 `--deliver`、`--wait` 和机器可读单 JSON 输出。后续交付 Skill 只能调用该 CLI 或固定计划 CLI，不调用 Browser Use。

### 6.4 批次审计

定向批次至少记录：

- `executionEngine: 'bridge-fetch+edge-extension'`；
- `codexBrowserUse: false`、`llmCalls: 0`、`llmTokens: 0`；
- 应用版本、Bridge build、扩展版本、扩展 build 和 `nowcoder-detail-v1` capability；
- 搜索会话 ID、queryHash、查询、provider、`order=create`、sortVerified、页码、排名和发布时间；
- run/batch/attempt/idempotency/retry lineage；
- 搜索命中、详情调度、详情保存、合格、交付和拒绝计数；
- 按 run/attempt 归属的真实 owned tab 配置上限、观察峰值和终态遗留数量，不用全局 scheduler 计数冒充标签页；
- `deliveryItems` 中每个 current-run job ID、稳定内容 ID、规范 URL、content hash 和 cluster ID，以及 exact-batch marker receipt。

私有报告使用模式 `0600` 原子写入，不保存正文、HTML、作者、Cookie、认证头或本机绝对源文件路径。

## 7. 状态、幂等、重试与取消

### 7.1 幂等

- `idempotencyKey` 在同一规范 request body 下重放返回同一批次；不同 body 重用同一 key 返回冲突。
- 全局最多一个活跃定向运行；同一请求/幂等键重放返回现有运行，不同查询在活跃期返回 409。这样 Bridge 只持有一个底层 artifact lease，且用户不会同时启动两个争夺相同浏览器容量和 inbox 发布锁的运行。
- 搜索会话候选 ID 由会话 ID 和规范 URL 派生，UI 不能注入任意 URL。

### 7.2 重试

- 重试请求必须提供新的 retry idempotency key；它创建新 run ID/attempt，保留 `retryOf` 和原始 run spec，并使用原会话冻结的候选集合，不重新搜索偷偷更换内容；相同 retry key 重放返回同一个新 run；
- 原会话 TTL 只限制首次 start；已有 run 即使会话过期也可从自身冻结候选创建 retry；
- 已由原 attempt 成功交付或已在永久来源历史处置的 URL 不再进入新 attempt；
- 临时失败允许按现有冷却规则重试，永久质量拒绝不盲目重采；
- 原批次和新批次的证据、计数、交付 ID 不相互覆盖。

### 7.3 取消

- 取消先持久化 `cancelling` 意图，再停止发现和后续补位；
- Bridge 向扩展发送当前批次任务取消，扩展中止排队/活跃任务并只关闭自己登记的标签页；批次与 job 都携带不可猜测 attempt，旧 attempt 的结果、回执和取消消息不得影响新 attempt；
- 每个 job result/result save/sync 入口检查批次取消 fence，晚到结果可保留为本机证据，但不得计入批次选择或触发同步；
- 重复取消返回同一终态；Side Panel 关闭不等于取消；
- 取消截止点与交付线性化点是两个不同事实：状态原子进入 `publishing` 后取消返回 409；exact-batch marker 仍是内容“可被 manifest 消费”的交付线性化点。`publishing` 之前成功取消时不存在 marker；进入 `publishing` 后服务必须完成或 attention，不能宣称 cancelled；
- 取消终态要求 owned tabs 为 0，`deliveryIds=[]`。

## 8. 选择与交付规则

定向批次候选顺序由用户优先选择、可验证发布时间、查询顺序、页码和排名确定。最终接受仍依次执行：

1. URL/current revision/永久来源历史去重；
2. 内容 hash、SimHash、问题序列和 cluster 去重；
3. 发布时间存在、非未来且在 30 天内；
4. 与 Agent、RAG、MCP、AI 应用、Code Agent 或相关生产工程直接相关；
5. 岗位属于 Agent/AI 研发或明确承担 Agent 系统开发；
6. 证据等级 A/B、正文完整、至少 3 个可核验技术问题；
7. 隐私、推广和付费截断硬门槛。

每条拒绝记录稳定 reason code 和中文说明。用户选择不改变这些规则。

永久来源历史仅在文件不存在时视为空；JSON 损坏、schema 错误或 I/O 失败必须让定向运行进入 attention，禁止 fail-open 造成重复发布。

定向交付不用现有逐条 `syncEntries(..., atomic:true)` 冒充外部事务，而使用专用 exact-batch publisher：

1. 在目标仓库不可消费的隔离 staging 中生成全部条目和 hash；
2. 校验 exact `deliveryItems`、当前 run/attempt、本机源文件和最终目录冲突；
3. 在同一锁内把条目幂等移动到最终 inbox 目录；此时没有 marker，manifest 必须忽略它们；
4. 最后原子写入唯一 batch marker，内容为 run ID、attempt、恰好 `run.spec.target` 个稳定 ID/目录/hash 和整体 hash；这是交付线性化点；每条交付元数据用 `deliveryKind: 'nowcoder-directed'`、`deliveryBatchId` 和定向 lineage 字段标识，不伪装成固定计划 ID；
5. `.codex/skills/data-collector-delivery/scripts/inbox-manifest.mjs` 对 directed run 只认 marker 精确列出的条目并复核 hash，marker 缺失、少一条、多一条或 hash 不同都停止；
6. marker 写入后 store 持久化 `publishReceipt`、私有 `deliveryItems`、公开 `publicDeliveryItems`、`deliveryIds` 和 completed。若进程在 marker 后崩溃，重启从 marker 恢复 completed；不会重投第二批。

marker 前崩溃或取消可能保留不可消费的 staging/无 marker 目录供诊断和重试，但不能生成 manifest。只有 receipt 集合与最终接受集合精确相等时才可完成。

本次真实验收的 `target=10`，且要求 10 条均有当前批次详情 job。任何历史候选池、跨批次手工拼接或部分交付都不算通过。

## 9. 安全与性能

- 所有 API 仅监听 loopback 并要求现有 bearer token；
- 查询只进入 JSON body，不进入路径、header、shell 或 HTML；
- 只接受 canonical HTTPS Nowcoder 详情 URL；
- 不扩大 manifest host permissions 和 CSP；
- 详情任务继续共享两槽优先级调度器，峰值不超过 2；
- `OwnedTabRegistry` 按 requestId/runId/attempt 记录真实 tab 创建和关闭；一个活跃 directed run 与普通任务的计数互不串账；第二个 directed run 在前一个终态前被 Bridge 拒绝；
- 取消立即关闭对应 request 的 owned tab，并以 AbortSignal race 终止页面完成等待、提取重试和关联长文等待；取消或终态后当前 run 的 owned tab 必须为 0；
- 活跃定向运行持有 artifact lease；同 build 的 Service Worker runtime 重启可恢复，build/capability 改变必须 attention；
- 搜索和采集阶段不调用模型；
- 搜索失败、验证码、登录或布局异常显式 attention，不以低质量结果补数。

## 10. 测试策略

实现严格采用测试先行，每个生产行为先观察对应测试因缺少该行为而失败。

### 10.1 共享契约

- 查询 NFKC、空白、数量、长度、控制字符、target 边界和未知字段；
- 独立 directed run spec、私有 `deliveryItems`/公开 `publicDeliveryItems`/计数/ID/URL/cluster 精确性及公开响应无 job ID；
- HTTP 请求/响应、取消、重试、精确 batch schema；
- `nowcoder-detail-v1` capability 和旧扩展拒绝。

### 10.2 Bridge

- 请求 body 精确包含 `order: 'create'`；跨页全局最新排序稳定；
- 使用真实返回 URL，拒绝猜测/非 allowlist URL；
- JSON 失败不使用未验证 SSR 伪装 latest；
- 会话原子持久化、过期恢复和 candidate ownership；
- idempotency 重放、同 queryHash 活跃冲突、retry lineage；
- 当前批次 exact target、24 条预算、无历史池补数；
- 首轮、refill、selection、staging、marker 前后 Bridge 重启恢复，不重复派发、搜索或发布；
- 取消发现、排队、活跃等待、补位和进入 `publishing` 前的发布准备，晚结果不能复活；进入 `publishing` 后返回冲突并收敛；
- 第 N 条 staging/move 失败、marker 写入失败、marker 后崩溃与发布期取消的线性化测试；
- retry 新 key、过期 session、重复 retry 和冻结候选测试；
- 批次审计、私有模式和无敏感字段。

### 10.3 扩展与 Side Panel

- 计划轮询不清空输入、焦点、选择和终态；
- 较旧预览响应不能覆盖较新的查询；
- worker/Side Panel 重启后从 Bridge 恢复；
- connection payload、Bearer、401/409/timeout 中文错误；
- cancel 有界终止 active wait/retry/linked-article，关闭当前 run owned tabs，不关闭用户标签页；
- 普通任务与唯一活跃 directed run 并发时 per-run owned-tab 峰值/终态互不串账；第二个 directed run 被拒绝；
- 中途 artifact 替换、不同 build 扩展重连进入 attention；同 build runtime 重启从 Bridge checkpoint 恢复；
- 构建产物中输入关键词 -> 最新预览 -> 采集 -> 补位 -> exact terminal；
- 扩展 trace 只打开详情 URL，从不打开 `/search`，不执行 type/click 排序操作；
- 微信、知识星球、普通详情采集和现有固定计划无回归。

### 10.4 真实验收

- 安装带新版本和 build ID 的扩展，Bridge health 证明在线且 capability 完整；
- 由 CLI/Side Panel 创建 directed run，target 为 10；
- batch 审计证明 `order=create`、`codexBrowserUse=false`、模型调用/Token 为 0；
- 私有 `deliveryIds`/`deliveryItems`、公开 `publicDeliveryItems`、accepted/delivered/target 都恰好 10，URL 与 cluster 唯一；私有项全部关联当前 run/attempt job，公开项不泄漏 job ID；
- owned tab 峰值不超过 2，终态为 0；
- exact-batch marker 与精确 current-run manifest 都恰好 10 条；无 marker 的 partial inbox/staging 不可消费；
- 资源仓库按自身 Skills 完成面经、知识点、简约清新 SVG 图、树/历史/热度验证、push 和 `sync-content`；
- 线上成功后只清理已确认消费的当前批次 inbox 条目。

## 11. 发布与后续默认流程

版本号按仓库约定统一 bump，生成新构建标记并重新打包扩展。协议、产品、Side Panel 状态文档和 Data Collector Delivery Skill 同步更新。

以后处理“搜索/收集牛客大厂 Agent 面经”时，默认流程是：

1. 用 Data Collector directed CLI（显式 `--deliver`）或 Side Panel（显式勾选交付授权）提交关键词和目标数量；
2. Bridge 按最新搜索并由浏览器扩展采集详情；
3. 只消费终态 `completed` 的 exact-batch manifest；
4. 使用资源仓库 Skills 整理和发布；
5. 不使用 Browser Use 搜索、点击、滚动牛客信息流或抓取详情。
