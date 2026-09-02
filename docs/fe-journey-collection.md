# fe-journey 固定采集与消费

## 边界

这条链路只解决“收什么”和“收完如何消费”：面经、工程知识、运营选题素材和优秀项目候选。项目只有候选评分与聚合，不涉及会员权益；不提供订阅配置、关键词设置、诊断、情报中台或管理后台。

产品定位统一为：**Agent Journey：专注 Agent 全栈研发的学习与成长平台**。

## 运行方式

- 每日固定计划：知识星球 08:00、牛客 Agent 面经 09:00（`Asia/Shanghai`）；Edge 离线时保留，重连补跑。
- 计划状态：`npm run collector -- plans status`。
- 立即补跑：`npm run collector -- plans run nowcoder-agent-market --force` 或 `plans run zsxq-chen-teacher --force`。
- 最近批次：`npm run collector -- plans batches --limit 20`。
- 常驻 FeJourney 只自动检查 GitHub：每 7 日、每轮最多 12 个项目，不创建浏览器页签。牛客自动采集只由上面的每日固定计划负责。
- 兼容的手动 FeJourney 补跑：`npm run collector -- fe-journey collect --force`。该显式命令仍可检查牛客并打开详情页；日常牛客操作优先使用固定计划或 `nowcoder run` 定向运行。
- 查看状态：`npm run collector -- fe-journey status`。
- 夹具冒烟：`npm run smoke:fe-journey`。
- 固定计划与报告契约冒烟：`npm run smoke:plans`。
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
真实面经差距报告 / 运营候选 → 审核后 interview / knowledge 更新
```

采集过程中不启动 Claude Code CLI，也不把页面内容通过 Agent 会话传输。Bridge 与 Edge 通过本机令牌保护的 HTTP/WebSocket 通信；采集层与 Codex 加工层通过 `_inbox/**/original.md + meta.json` 文件契约通信。

## 质量与去重

- `candidateKinds` 可多选：`interview`、`knowledge`、`operation`、`project`。
- `qualityScore` 是 0–100 的确定性初筛；推广导流、求职闲聊、正文过短和缺少可消费类型都会降分并写入 `exclusionReasons`。
- GitHub 另有 `projectScore`，只根据学习价值、工程要素、运行说明、明确的测试命令/CI 文件、Agent 技术证据、维护/许可证和文档证据初筛；Star/Fork 只用于发现，不参与质量得分。
- 同 URL 用稳定 ID 覆盖；同正文用规范化 SHA-256 前 16 位识别；轻度改写用 64 位 SimHash 聚类。公开内容必须按 `clusterId` 聚合，不能一条原文生成一篇内容。
- 牛客详情额外保存 A/B/C 真实性等级和问题指纹。A/B 才能形成题库与运营建议；C 级、截断和付费不可见内容只进入排除或待处理。
- 在资源仓库运行 `.codex/skills/curate-fe-journey-inbox/scripts/build-interview-gap.mjs <resource-root> --date YYYY-MM-DD`，生成忽略的 `interview-gap-*.md` 与 `operation-topics-*.md`。脚本只做确定性初筛，Codex 必须按题意、生产深度和追问链确认 `covered/evolved/new`。

## 失败与恢复

- GitHub README 明确返回 404 时只跳过该项目；API 限流或服务故障依次尝试固定的 `raw.githubusercontent.com` 与官方 GitHub README HTML 后备地址，均失败才把整轮记为失败，不会伪装成空的成功批次。
- GitHub 候选部分写入失败会把首个警告持久化到状态文件；全部写入失败时整轮记为失败，不更新 `lastSuccessAt`。
- FeJourney 来源整轮失败后按 1 小时短退避；常驻服务只自动重试 GitHub。显式手动运行成功后仍记录各来源自己的周期状态。
- 固定或显式牛客详情任务在扩展离线时保持队列，扩展重新连接后派发。固定计划同一时刻最多派发一个详情任务。
- Bridge 拥有的非定向牛客任务因 Service Worker 丢失最多自动恢复一次；同一运行时的 WebSocket 短暂重连不消耗次数。第二次 worker loss 转为 `needs_attention/RECOVERY_LIMIT_EXCEEDED`，不会继续开页。
- 升级前缺少恢复计数的 `queued`、`dispatched`、`collecting` 牛客任务按预算已用尽处理，Bridge 启动时直接终止；显式重试才会重新入队。
- 牛客详情任务进入 `failed` 或 `needs_attention` 后，只有显式固定发现或手动运行才会清除旧错误并重新入队；后台 FeJourney 不再自动重试牛客任务。
- 状态保存在 `~/.data-collector/fe-journey-state.json`；候选索引在本机库 `_catalog/fe-journey.json`。
- 采集状态文件损坏时只降级关闭 fe-journey 并在状态接口暴露错误，不覆盖损坏文件，也不阻断 Bridge 启动。
- 候选索引损坏只禁用 fe-journey 并在状态接口暴露错误，Bridge、微信和知识星球采集仍可启动和落盘。
- 固定资源仓库不存在或自定义 `sinks.json` 没有 `fe-journey` sink 时，周期保持关闭，立即执行接口明确返回禁用。
