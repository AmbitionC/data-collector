# 本机 Bridge 协议

协议版本为 `1`，应用版本为 `0.4.35`。Bridge 只监听 `127.0.0.1`，默认端口 `17321`。

## 固定身份自动授权

正式扩展的 manifest 公钥派生固定 ID。全新扩展没有 token 时按以下顺序连接：

1. 请求 `GET /health`，读取 Bridge 声明的 `trustedExtensionId`。
2. 将该值与 `chrome.runtime.id` 严格比较；不一致时进入 `identity_error`，不会重试授权。
3. 一致时连接 `ws://127.0.0.1:17321/v1/extension?bootstrap=1`。
4. Bridge 校验请求 Origin 必须是固定扩展 Origin，随后通过 `bridge.authorized` 返回 bearer token。
5. 扩展持久化 token，状态切换为 `connected`，并通过 `extension.hello` 上报自身版本、构建标记与能力列表。

存储 token 的认证 socket 若在完成 `open`/`extension.hello` 前失败，扩展删除 `chrome.storage.local.bridgeToken`，仅通过指数退避 timer 再试。下一次从 `/health` 固定 ID 检查重新开始，再建立一次 bootstrap socket；不会在 close/error 回调中同步递归。health 不可达继续退避，ID 不匹配进入 `identity_error` 且不再定时重连。

后续连接使用：

```text
ws://127.0.0.1:17321/v1/extension?token=<token>
```

token 是至少 256 位的随机值，保存在扩展的 `chrome.storage.local` 和本机权限为 `0600` 的 `auth.json` 中。HTTP 保护接口发送：

```http
Authorization: Bearer <token>
```

WebSocket Origin 校验会阻止普通网页和其他扩展。Origin 与固定 ID 是浏览器内的调用边界，不是对同用户本机恶意进程的防护；能够控制本机用户账户的程序不在安全边界内。

## HTTP API

- `GET /health`：进程版本、磁盘构建标记、受信任扩展 ID 与连接状态；扩展在线时还返回
  `extensionVersion`/`extensionBuildId`/`extensionCapabilities`，用于证明 Bridge、磁盘产物和实际运行扩展一致且具备所需能力。不需要 token。
- `POST /v1/jobs`：创建任务。正文 `{ "url": "...", "requestedBy": "codex|cli|extension" }`。Codex/CLI 任务在扩展在线时立即派发；`extension` 表示 Side Panel 当前页采集，由当前 tab runner 直接回传，不立即回派。
- `GET /v1/jobs/:id`：查询任务状态和最终路径。
- `POST /v1/reveal`：只允许打开知识库根目录内已存在的文件，供 Side Panel 点击“在文件夹中查看”。
- `GET /v1/fe-journey/status`：读取 FeJourney 状态、运行中标记和两个来源的周期记录。常驻 FeJourney 调度只运行 GitHub，不创建牛客浏览器任务。
- `POST /v1/fe-journey/collect`：兼容的显式手动入口，可立即检查或强制运行固定预设。请求体只接受 `{ "force"?: boolean, "nowcoder"?: boolean, "github"?: boolean }`，未知字段直接 `400`；未启用固定 `fe-journey` sink 时返回 `409 FE_JOURNEY_DISABLED`。省略来源时仍运行双源，因此可能打开牛客详情页；自动牛客采集只走每日固定计划。
- `GET /v1/plans/status`：两个每日固定计划的到期、待补跑、下次运行和最近批次状态。
- `POST /v1/plans/run`：立即运行固定计划，只接受 `{ "planId": "zsxq-chen-teacher|nowcoder-agent-market", "force"?: boolean }`。
- `GET /v1/plans/batches?limit=20`：最近批次历史；`limit` 必须在 1–100 之间，可选固定 `planId` 过滤。
- `POST /v1/nowcoder/search-sessions` / `GET /v1/nowcoder/search-sessions/:sessionId`：创建或恢复最新排序的定向牛客搜索预览。
- `POST /v1/nowcoder/runs` / `GET /v1/nowcoder/runs/:runId`：从该会话候选创建或读取独立的定向运行；它不是 `CollectionPlan`。
- `POST /v1/nowcoder/runs/:runId/cancel` / `retry`：以 run attempt fence 取消或按 lineage 创建重试。

以上 `/v1/plans/*` 接口同样只允许回环访问并要求 bearer token。对应 Codex CLI 为 `data-collector plans status`、`data-collector plans run <plan-id> --force` 和 `data-collector plans batches --limit 20`；返回只包含计划、计数、覆盖、逐条拒绝 URL/原因和错误信息，不暴露 Cookie、凭证或本机仓库路径。

URL 只允许 HTTPS 的 `mp.weixin.qq.com`、`wx.zsxq.com`/知识星球子域、`www.nowcoder.com` 和 `github.com`。GitHub 文档只由 Bridge provider 生成，扩展若尝试页面提取会明确返回不支持布局。请求体、字段长度、图片数量和 WebSocket 帧都有上限。

任务状态：

```text
Codex/CLI: queued → dispatched → collecting → saved
                                  ├→ needs_attention
                                  └→ failed

当前页:    queued ───────────────→ collecting → saved
                                  ├→ needs_attention
                                  └→ failed
```

当前页任务若在发送 progress 前断线会保持 `queued`；扩展重连后，通用 `dispatchQueued` 会把它作为恢复任务派发，避免永久丢失。Bridge 拥有的非定向牛客任务因 worker loss 最多自动恢复一次；第二次进入 `needs_attention/RECOVERY_LIMIT_EXCEEDED`。升级前没有恢复计数的 `queued` / `dispatched` / `collecting` 牛客任务在启动时直接终止，不能触发 `job.collect`。同一 Service Worker 的 WebSocket 短暂重连只重放任务而不消耗该预算；定向运行由自己的 attempt fence 恢复，扩展当前页任务和知识星球保持各自原有语义。相同 URL 的任务可重复显式执行，文件层通过稳定内容 ID 幂等更新。

## WebSocket 消息

统一信封：

```json
{
  "protocolVersion": 1,
  "type": "job.collect",
  "requestId": "job-id",
  "timestamp": "2026-07-18T00:00:00.000Z",
  "payload": {}
}
```

主要消息：

- 扩展 → Bridge：`extension.hello`、`bridge.ping`、`job.progress`、`job.result`、`job.error`、`plan.result`
- Bridge → 扩展：`bridge.authorized`、`bridge.pong`、`job.collect`、`job.saved`、`plan.collect`

定向牛客详情的 `job.collect` 只在 `directedRunId` 和 `directedRunAttempt` **同时**存在时属于该运行；
`job.cancel` 使用同一对字段作为 fence，扩展的 owned-tab telemetry 也按同一 run/attempt 独立上报。
任何只带其中一个字段的消息都在协议边界拒绝。

固定计划的 `plan.result` 除汇总 `rejections` 外，还可携带 `rejectionDetails`；每项保存
未入选内容的规范 URL 与原因。Bridge 会把明细原样持久化到批次状态，便于定位正文不完整等问题。
所有知识星球任务（定时计划、侧栏单条/批量、重启后恢复派发）只会派发给 0.4.29 及以上、
显式声明 `zsxq-complete-content-v2` 且构建标记与当前磁盘产物精确一致的扩展。入库时还必须同时满足
`job.result.document.truncated === false`、`sourceMetadata.contentCompletenessVersion` 为同一 v2 协议，
且 Bridge 能确定预期构建时 `sourceMetadata.contentCompletenessBuildId` 与之精确一致。
缺少任一证明或正文不完整时，任务保持待处理/转为 `needs_attention`，不会降级归档半篇内容。
本机库目录用 `contentComplete` 保留该证明；
历史 `false` 或缺字段的知识星球条目会被同步层拒绝，必须先用新版重采。

列表页和单篇详情不以“某一帧非空”当作完整。扩展会多帧采样，保留同一规范 URL 下观察到的
最丰富正文；任何一帧出现过正向截断证据都不会被后续较短快照“洗掉”。只有最后一次语义变化后
连续稳定 24 秒才会给出完整证明；超时、身份不明、作者/时间无法证明均失败关闭。

知识星球来源证据只接受成功响应中的已知 topic 正文端点和 schema。主世界 hook 在解析前从原始
JSON 保留 64 位 `topic_id` 数字；`fetch` 与 `XMLHttpRequest(responseType="json")` 都不能先经过
JavaScript number 舍入，同时页面代码仍看到浏览器原有的普通 JSON 响应形状。问答必须同时取得
问题与回答；图片、附件、音视频及 inline 占位符必须能与结构化资源逐项对应。未知媒体字段、
数量/ID 不匹配、同一 topic 的正文或媒体风险冲突都会粘住为未证明，重注入后的 replay 也保留
这些冲突，不允许较长或较新的单帧把风险洗掉。

图片的 `original`、`large`、`thumbnail` 等 URL 都可作为精确身份别名，以兼容页面实际渲染的
尺寸；归档只写来源声明的最高质量原图。同帖纯图片/附件内容允许没有文字，但仍须通过 topic
身份、来源组件、媒体清单和 DOM 资源覆盖四项证明。详情页与列表页正文相等但资源集合不同时，
只有详情具备来源媒体权威证明才可替换；否则移除可跟随链接并保持 `truncated:true`，绝不打开
可能属于上一虚拟节点的长文。

页面点击展开只证明它实际展开的文字组件：proof 绑定 URL、topic、正文 revision、来源媒体
revision、DOM 媒体 revision 和同一 owner 下的全部展开控件。任一控件仍 pending，或身份、正文、
资源、折叠控件、节点 generation 发生变化，proof 都失效；来源正文冲突或媒体未证明时不能建立。

固定计划终态还受持久交付约束：每个当前 attempt 中已保存的知识星球 job 都必须拥有对应的
durable `deliveryId`，否则批次只能进入 `completed_with_attention`。Bridge 重启/重连会先幂等
补同步当前 attempt 的 saved jobs，再做终态结算；关闭自动同步或同步异常都不能静默报成功。
活跃知识星球 attempt 与 sink 落盘期间，自更新打包通过进程内门禁和跨进程 artifact lease 延后，
避免完整性校验使用构建 A、实际落盘时稳定产物已切到构建 B。

扩展每 20 秒发送心跳，使 Chrome 116+ 的 Manifest V3 service worker 在活跃连接期间保持可用。所有消息都在共享 schema 边界校验，内容脚本返回的数据按不可信输入处理；回传 URL 必须与任务一致，违规消息以 WebSocket `1008` 关闭。

同一 Bridge 只保留最新扩展连接。新连接替换旧连接时，Bridge 使用共享应用关闭码 `4009` 和原因 `replaced`。旧扩展进入持久 standby，不把替换误报为服务不可达，也不由 alarm/startup 自动重连；Side Panel 显示“另一个浏览器实例已接管”，用户可显式点击重试重新连接。

## 扩展为其他客户端

未来新增本机客户端时，应独立定义身份和授权方式，继续使用 token、URL allowlist 和 schema，不能仅因监听地址是回环就默认信任。云端 sink 应是 Bridge 写入后的独立模块，不能让扩展持有云端长期凭证。
