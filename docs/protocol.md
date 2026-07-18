# 本机 Bridge 协议

协议版本为 `1`。Bridge 只监听 `127.0.0.1`，默认端口 `17321`。

## 配对与认证

Bridge 启动时生成一次性 6 位配对码，有效期 10 分钟。扩展调用：

```http
POST /v1/pair
Content-Type: application/json

{"code":"123456"}
```

成功后返回随机 256 位 bearer token。令牌保存在扩展的 `chrome.storage.local` 和本机权限为 `0600` 的 `auth.json` 中。配对接口仅接受本机来源；其余任务接口必须发送：

```http
Authorization: Bearer <token>
```

## HTTP API

- `GET /health`：进程、版本与扩展连接状态，不需要令牌。
- `POST /v1/jobs`：创建任务。正文 `{ "url": "...", "requestedBy": "codex|cli|extension" }`。
- `GET /v1/jobs/:id`：查询任务状态和最终路径。
- `POST /v1/reveal`：只允许打开知识库根目录内已存在的文件，供用户点击“在文件夹中查看”。

URL 只允许 HTTPS 的 `mp.weixin.qq.com`、`wx.zsxq.com` 与知识星球子域。请求体、字段长度、图片数量和 WebSocket 帧都有上限。

任务状态：

```text
queued → dispatched → collecting → saved
                        ├→ needs_attention
                        └→ failed
```

Bridge 重启会把未完成任务恢复到可重派发状态；扩展重连后继续派发。相同 URL 的任务可重复执行，但文件层通过稳定内容 ID 幂等更新。

## WebSocket

地址：`ws://127.0.0.1:17321/v1/extension?token=<token>`。服务器同时校验 `chrome-extension://<id>` Origin。

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

- 扩展 → Bridge：`extension.hello`、`bridge.ping`、`job.progress`、`job.result`、`job.error`
- Bridge → 扩展：`bridge.pong`、`job.collect`、`job.saved`

扩展每 20 秒发送心跳，使 Chrome 116+ 的 Manifest V3 service worker 在活跃连接期间保持可用。所有消息都在共享 schema 边界校验，内容脚本返回的数据按不可信输入处理；回传 URL 必须与任务一致，违规消息会以 WebSocket `1008` 关闭。

## 扩展为其他客户端

如果未来让另一个本机工具调用 Bridge，应复用配对、bearer token、URL allowlist 和 schema，而不是开放监听地址。云端 sink 应是 Bridge 写入后的独立模块，不能让扩展直接持有云端长期凭证。
