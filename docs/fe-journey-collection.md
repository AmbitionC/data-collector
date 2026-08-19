# fe-journey 固定采集与消费

## 边界

这条链路只解决“收什么”和“收完如何消费”：面经、工程知识、运营选题素材和优秀项目候选。项目只有候选评分与聚合，不涉及会员权益；不提供订阅配置、关键词设置、诊断、情报中台或管理后台。

产品定位统一为：**Agent Journey：专注 Agent 全栈研发的学习与成长平台**。

## 运行方式

- 常驻服务自动检查：牛客每 24 小时、每轮最多 24 个详情任务；GitHub 每 7 日、每轮最多 12 个项目。
- 手动补跑：`npm run collector -- fe-journey collect --force`。
- 查看状态：`npm run collector -- fe-journey status`。
- 夹具冒烟：`npm run smoke:fe-journey`。
- 公开网络发现冒烟：`LIVE=1 npm run smoke:fe-journey`；GitHub 限流时可提供已有的 `GITHUB_TOKEN` 环境变量。

预设位于 `packages/bridge/src/feJourney/preset.ts`，没有用户侧编辑入口。

## 数据流

```text
固定牛客公开搜索 ─→ 详情 URL 任务 ─→ Edge 现有登录会话提取 ┐
固定 GitHub Search ─→ 仓库元数据 + README ───────────────┤
                                                         ↓
本机 Markdown 库 → 质量分/排除原因 → 内容哈希/SimHash 聚类
                                                         ↓ 显式同步
front-end-journey-resource/_inbox（git ignored，本机）
                                                         ↓ Codex skill
interview / knowledge 更新 + 本地运营/项目/跳过项报告
```

采集过程中不启动 Claude Code CLI，也不把页面内容通过 Agent 会话传输。Bridge 与 Edge 通过本机令牌保护的 HTTP/WebSocket 通信；采集层与 Codex 加工层通过 `_inbox/**/original.md + meta.json` 文件契约通信。

## 质量与去重

- `candidateKinds` 可多选：`interview`、`knowledge`、`operation`、`project`。
- `qualityScore` 是 0–100 的确定性初筛；推广导流、求职闲聊、正文过短和缺少可消费类型都会降分并写入 `exclusionReasons`。
- GitHub 另有 `projectScore`，只根据学习价值、工程要素、运行说明、明确的测试命令/CI 文件、Agent 技术证据、维护/许可证和文档证据初筛；Star/Fork 只用于发现，不参与质量得分。
- 同 URL 用稳定 ID 覆盖；同正文用规范化 SHA-256 前 16 位识别；轻度改写用 64 位 SimHash 聚类。公开内容必须按 `clusterId` 聚合，不能一条原文生成一篇内容。

## 失败与恢复

- GitHub README 明确返回 404 时只跳过该项目；API 限流或服务故障依次尝试固定的 `raw.githubusercontent.com` 与官方 GitHub README HTML 后备地址，均失败才把整轮记为失败，不会伪装成空的成功批次。
- GitHub 候选部分写入失败会把首个警告持久化到状态文件；全部写入失败时整轮记为失败，不更新 `lastSuccessAt`。
- 牛客详情任务在扩展离线时保持队列，扩展重新连接后派发。
- 牛客详情任务进入 `failed` 或 `needs_attention` 后，会在下一次固定发现中清除旧错误并重新入队；已经成功和仍在途的任务不重复派发。
- 状态保存在 `~/.data-collector/fe-journey-state.json`；候选索引在本机库 `_catalog/fe-journey.json`。
- 候选索引损坏只禁用 fe-journey 并在状态接口暴露错误，Bridge、微信和知识星球采集仍可启动和落盘。
- 固定资源仓库不存在或自定义 `sinks.json` 没有 `fe-journey` sink 时，周期保持关闭，立即执行接口明确返回禁用。
