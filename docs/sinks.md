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

## 零配置（默认就能用）

常用去向已内置在代码里（`packages/bridge/src/sinks/config.ts` 的 `BUILT_IN_TARGETS`），**不需要写任何配置文件**：

| 来源 | 默认去向 | 分类下拉 |
|---|---|---|
| 微信公众号 / 知识星球 | 本机库 **+** `~/code/life-teachers` 收件箱 | 投资 / 财富 / 职场 / 认知 / 教育 / 其他 |
| 牛客网 | `~/code/front-end-journey-resource` 收件箱 | 面经 + knowledge 各顶层分组 |

仓库**存在才启用**：本机没克隆对应仓库时该去向自动消失、路由降级为只落本机库，不会凭空建目录。改路径/加去向直接改 `BUILT_IN_TARGETS` 即可。

## 需要偏离默认时：`sinks.json`（可选）

只有想临时覆盖内置默认（换目录、加新目标、改路由）时才建 `~/.data-collector/sinks.json`；**存在即完全接管**，内置默认不再生效。字段：

- `sinks`：`{ <id>: 定义 }`
  - `{ "type": "markdown" }`
  - `{ "type": "repo-inbox", "repoPath": "…", "inboxDir": "_inbox", "label": "…", "categories": [...], "commit": true, "push": false }`
    - `repoPath` 支持 `~` 展开；`inboxDir` 默认 `_inbox`；`label`/`categories` 缺省时分别由目录名派生 / 为空。
    - `commit`（默认 `true`）：写入后 `git add/commit` 到**当前分支**（不切分支）。
    - `push`（默认 `false`）：本机 Agent 无需；若由云端定时 Routine（每次全新克隆）消费收件箱才需要。
- `routes`：`{ <source>: [sinkId, …] }`。未列出的来源回退到 `markdown`。

**注意：`sinks.json` 只在 Bridge 启动时读取一次，改完需重启 Bridge。**

## 侧栏「去向」到底是什么意思

这一格最容易被误读，写清楚：

- **`默认：本机库 + life-teachers 收件箱`** —— 一篇内容**同时写两处**：
  1. `~/Documents/data-collector/知识星球/…/index.md`（本机 Markdown 库，留底、可检索、可在「已入库」页管理）；
  2. `~/code/life-teachers/_inbox/zsxq/<日期-ID-标题>/`（收件箱条目，等 Claude Code 归档）。
- **`只存到 life-teachers 收件箱`** —— **只写第 2 处，不再留本机备份**。选具体去向是**覆盖**默认路由，
  不是「在默认之外再加一份」。侧栏会把被放弃的去向写在提示里（「不再写入 本机库」），
  结果屏也会如实说出这一篇到底进了哪几处。

投递到收件箱后会在目标仓库 `git add` + `git commit`（**当前分支，不切分支**），
但**默认不 push** —— 本机的 Claude Code 直接读工作区就行，推送由你自己决定。
想让云端定时任务消费收件箱时才需要把 `push` 打开（见下方 `sinks.json`）。

**协议侧**：Bridge 的 `/health` 返回 `routing`（可选去向的 `id`/`label`/`categories` + 每个来源的默认去向，**不含本机路径/凭证**）。侧边栏 ready 面板据此呈现两级选择：一级「去向」（选定即覆盖本次路由，经 `POST /v1/jobs` 的 `sinks` 字段下发，仅本次生效），二级「分类」（随一级联动，首项「自动分类」；默认路由同时写多处时按去向分组列出各自的分类体系，不替用户瞎选）。

「在文件夹中查看」的放行范围 = 本机库根目录 **+ 每个已配置 sink 的写入根目录**，不多一个。
只认本机库的话，投到收件箱的条目会被当成越界请求一律拒掉，用户点了按钮却毫无反应。

覆盖示例见 [`examples/sinks.example.json`](examples/sinks.example.json)。

## 端到端两层管线

1. **采集层（本工具）**：提取 → 整理 → 按路由投递到 sink（本机库 / 目标仓库收件箱）。确定性、离线、本机优先。
2. **加工层（Agent）**：Claude Code / Codex 定时或手动扫描目标仓库的 `_inbox/`，在仓库内完成归档 / 整理 / 知识点提炼，产出成品并按各仓库既有机制发布：
   - `life-teachers`：按 `CLAUDE.md` 的归档工作流产出 `authors/…/summary.md` 等。
   - `front-end-journey-resource`：按 `.codex/skills/` 产出 `interview/` 面经贴与 `knowledge/` 知识点，push 后由仓库 Action 同步。

完整设计见 [`docs/superpowers/specs/2026-07-24-collection-platform-design.md`](superpowers/specs/2026-07-24-collection-platform-design.md)。
