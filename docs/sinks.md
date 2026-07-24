# 落地目标（Sink）与来源路由

0.2.0 只把采集结果写入本机 Markdown 库。本文档描述在此之上引入的**可插拔落地目标**与**按来源路由**，用于把同一篇采集结果送到一个或多个下游（本机库、或某个目标仓库的收件箱），供 Claude Code / Codex 等 Agent 后续在仓库内归档 / 整理 / 提炼。

## 概念

- **来源注册表**（`packages/shared/src/sources.ts`）：一个来源的声明式定义（主机匹配、规范化身份参数、允许的内容类型、展示名）。当前支持 `wechat`、`zsxq`、`nowcoder`。新增来源 = 加一条描述符 + 在扩展侧写一个提取器。
- **ContentSink**（`packages/bridge/src/sinks/`）：内容落地目标抽象。
  - `markdown`：本机 Markdown 知识库（默认、永远可用，行为与 0.2.0 一致）。
  - `repo-inbox`：把内容原样投递到某个 git 仓库的收件箱目录。
- **路由**：按来源把整理后的内容分发到一个或多个 sink。未配置的来源回退到 `markdown`。

## 收件箱条目格式

`repo-inbox` 为每篇内容在目标仓库写出：

```
<repo>/<inboxDir>/<source>/<YYYY-MM-DD>-<稳定ID>-<标题slug>/
├── original.md   # YAML frontmatter(title/author/date/source/source_url/collected_at/archived_at/kind) + 正文
├── meta.json     # 机器可读元信息：source/kind/url/publishedAt/suggestedCategory/suggestedTags/summary/images/图片下载数
└── assets/       # 随文图片（经与本机库相同的 SSRF 防护管线下载）
```

`archived_at` 初始为空，表示未归档；Agent 归档后可回填。正文与本机库使用同一套 HTML→Markdown 转换，保证两条落地路径一致。

## 配置：`sinks.json`

放在配置目录（默认 `~/.data-collector/sinks.json`，权限建议 `0600`）。**只由 Bridge 读取，扩展永不接触**——业务/云凭证不进浏览器。文件缺失时只启用本机 Markdown 库，所有来源都落本机库（与 0.2.0 完全一致）。

字段：

- `sinks`：`{ <id>: 定义 }`。
  - `{ "type": "markdown" }`
  - `{ "type": "repo-inbox", "repoPath": "…", "inboxDir": "_inbox", "commit": true, "push": false }`
    - `repoPath` 支持 `~` 展开；`inboxDir` 默认 `_inbox`。
    - `commit`（默认 `true`）：写入后 `git add/commit` 到当前分支（不切分支）。
    - `push`（默认 `false`）：提交后 `git push`。**本机 Agent 无需 push；若由云端定时 Routine（每次全新克隆）消费收件箱，则需 `push: true`。**
- `routes`：`{ <source>: [sinkId, …] }`。未列出的来源回退到 `markdown`。

示例见 [`examples/sinks.example.json`](examples/sinks.example.json)。

## 端到端两层管线

1. **采集层（本工具）**：提取 → 整理 → 按路由投递到 sink（本机库 / 目标仓库收件箱）。确定性、离线、本机优先。
2. **加工层（Agent）**：Claude Code / Codex 定时或手动扫描目标仓库的 `_inbox/`，在仓库内完成归档 / 整理 / 知识点提炼，产出成品并按各仓库既有机制发布：
   - `life-teachers`：按 `CLAUDE.md` 的归档工作流产出 `authors/…/summary.md` 等。
   - `front-end-journey-resource`：按 `.codex/skills/` 产出 `interview/` 面经贴与 `knowledge/` 知识点，push 后由仓库 Action 同步。

完整设计见 [`docs/superpowers/specs/2026-07-24-collection-platform-design.md`](superpowers/specs/2026-07-24-collection-platform-design.md)。
