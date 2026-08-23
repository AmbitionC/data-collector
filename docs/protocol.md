# 本机 Bridge 协议

协议版本为 `1`，应用版本为 `0.2.0`。Bridge 只监听 `127.0.0.1`，默认端口 `17321`。

## 固定身份自动授权

正式扩展的 manifest 公钥派生固定 ID。全新扩展没有 token 时按以下顺序连接：

1. 请求 `GET /health`，读取 Bridge 声明的 `trustedExtensionId`。
2. 将该值与 `chrome.runtime.id` 严格比较；不一致时进入 `identity_error`，不会重试授权。
3. 一致时连接 `ws://127.0.0.1:17321/v1/extension?bootstrap=1`。
4. Bridge 校验请求 Origin 必须是固定扩展 Origin，随后通过 `bridge.authorized` 返回 bearer token。
5. 扩展持久化 token，状态切换为 `connected`，并发送 `extension.hello`。

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

- `GET /health`：进程版本、受信任扩展 ID 与连接状态，不需要 token。
- `POST /v1/jobs`：创建任务。正文 `{ "url": "...", "requestedBy": "codex|cli|extension" }`。Codex/CLI 任务在扩展在线时立即派发；`extension` 表示 Side Panel 当前页采集，由当前 tab runner 直接回传，不立即回派。
- `GET /v1/jobs/:id`：查询任务状态和最终路径。
- `POST /v1/reveal`：只允许打开知识库根目录内已存在的文件，供 Side Panel 点击“在文件夹中查看”。
- `GET /v1/fe-journey/status`：读取固定周期状态、运行中标记和两个来源的下次到期时间。
- `POST /v1/fe-journey/collect`：立即检查或强制运行固定预设。请求体只接受 `{ "force"?: boolean, "nowcoder"?: boolean, "github"?: boolean }`，未知字段直接 `400`；未启用固定 `fe-journey` sink 时返回 `409 FE_JOURNEY_DISABLED`。
- `GET /v1/plans/status`：两个每日固定计划的到期、待补跑、下次运行和最近批次状态。
- `POST /v1/plans/run`：立即运行固定计划，只接受 `{ "planId": "zsxq-chen-teacher|nowcoder-agent-market", "force"?: boolean }`。
- `GET /v1/plans/batches?limit=20`：最近批次历史；`limit` 必须在 1–100 之间，可选固定 `planId` 过滤。

以上 `/v1/plans/*` 接口同样只允许回环访问并要求 bearer token。对应 Codex CLI 为 `data-collector plans status`、`data-collector plans run <plan-id> --force` 和 `data-collector plans batches --limit 20`；返回只包含计划、计数、覆盖和错误信息，不暴露 Cookie、凭证或本机仓库路径。

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

当前页任务若在发送 progress 前断线会保持 `queued`；扩展重连后，通用 `dispatchQueued` 会把它作为恢复任务派发，避免永久丢失。Bridge 重启也会把其他未完成任务恢复到可重派发状态。相同 URL 的任务可重复执行，文件层通过稳定内容 ID 幂等更新。

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

扩展每 20 秒发送心跳，使 Chrome 116+ 的 Manifest V3 service worker 在活跃连接期间保持可用。所有消息都在共享 schema 边界校验，内容脚本返回的数据按不可信输入处理；回传 URL 必须与任务一致，违规消息以 WebSocket `1008` 关闭。

同一 Bridge 只保留最新扩展连接。新连接替换旧连接时，Bridge 使用共享应用关闭码 `4009` 和原因 `replaced`。旧扩展进入持久 standby，不把替换误报为服务不可达，也不由 alarm/startup 自动重连；Side Panel 显示“另一个浏览器实例已接管”，用户可显式点击重试重新连接。

## 扩展为其他客户端

未来新增本机客户端时，应独立定义身份和授权方式，继续使用 token、URL allowlist 和 schema，不能仅因监听地址是回环就默认信任。云端 sink 应是 Bridge 写入后的独立模块，不能让扩展持有云端长期凭证。
