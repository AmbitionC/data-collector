# Data Collector 固定来源计划与知识消费设计

**日期：** 2026-08-23  
**状态：** 待书面审阅  
**适用仓库：** `data-collector`、`front-end-journey-resource`、`life-teachers`  
**不改动：** `fe-journey-faas`

## 1. 背景与目标

Data Collector 已经能完成四件基础工作：

1. Edge Side Panel 手动保存当前微信公众号、知识星球或牛客详情页；
2. 知识星球当前列表页批量保存；
3. Codex 通过本机 Bridge/WebSocket 提交 URL，并让 Edge 使用现有登录态采集；
4. Bridge 按固定关键词周期发现牛客详情和 GitHub 项目候选，再保存到本机 Markdown 库。

本设计在这些能力上补齐两个真实的固定工作流：

- 每天检查知识星球 `48844584441158` 的“最新”“精华”“只看星主”，筛选陈老师发布的投资、创业、商业、认知和职业内容，保存本机并进入 `life-teachers` 私有收件箱；
- 每天从牛客发现腾讯、字节、阿里、蚂蚁的 Agent、AI 应用、大模型应用、RAG、MCP 和 AI 全栈面经及运营素材，保存本机并进入 `front-end-journey-resource` 私有收件箱，由 Codex 生成题库差距和运营选题报告。

完成标准不是“成功创建了几个后台标签页”，而是每个批次都有可核对的终态，合格正文已经保存，重复项只出现一次，失败和登录问题可恢复，下游报告能够追溯到来源。

## 2. 真实样本结论

2026-08-23 的真实 Edge 冒烟收集得到十篇合格的 8 月面经：字节 6、腾讯 2、阿里 2、蚂蚁 0。十篇均为唯一 URL、正文公开可读、发布时间在 2026 年 8 月、正文不少于 120 个字符，并包含具体面试过程或问题。

真实样本暴露了当前规则不能由静态夹具证明的缺陷：

- 标题含“一面”但不含“面经”的阿里云帖子被标成 `knowledge`，而不是 `interview`；
- Agent 面经会因为出现“React”或“设计”被落到“前端开发”或“产品与设计”；
- 付费墙只显示 40% 正文时仍可能得到 97 分；
- 页面侧栏的创作者榜曾被误选为正文；
- 同一内容换 URL、正文混入不同页面噪音时，全文哈希和 SimHash 不足以稳定去重；
- 当前牛客周期任务只证明 URL 入队，不证明详情任务最终保存；
- 搜索结果容易被字节内容占满，没有公司覆盖状态，也不能如实表达“本轮没有合格蚂蚁内容”。

这些样本成为 P0 的固定回归语料，不把未经许可的完整第三方正文提交进 Git；测试夹具仅保留能够复现选择器、付费提示、时间和题目结构的最小匿名片段。

## 3. 产品原则与明确边界

### 3.1 原则

- **本机登录态：** 私有或登录后内容只由 Edge 读取，Bridge 不保存 Cookie、LocalStorage、密码或站点令牌。
- **原始证据优先：** 原文先进入本机库；项目收件箱只接收可追溯副本和元数据。
- **可信度与相关度分离：** 内容相关不等于来源可信，两个维度分别判断。
- **缺口如实报告：** 没有合格的某公司内容时输出覆盖缺口，不以旧帖、付费帖或营销汇编凑配额。
- **自动采集、审阅发布：** 固定计划可自动运行，但不自动把第三方原文或 Codex 归纳结果发布到公开知识库。
- **固定个人预设：** 当前不做规则编辑器、多用户订阅、管理后台或工作流画布。

### 3.2 不做

- 不绕过登录、验证码、付费墙或站点反自动化；
- 不调用知识星球或牛客未公开的私有接口主动翻页；知识星球只旁观页面已经发出的响应来取得 `topic_id`；
- 不把登录凭证搬到 FaaS，不增加云端定时服务；
- 不引入数据库、向量数据库或外部模型 API；
- 不自动发布到 `interview/`、`knowledge/` 或线上产品；
- 不做历史全量爬取；首次启用只回看有限日期范围。

## 4. 方案选择

采用“本机 Bridge 固定计划 + Edge 后台页面 + 现有 ContentSink + Codex 文件消费”方案。

```text
本机固定计划
  ├─ zsxq-chen-teacher ──> Edge 后台列表页 ──> 三视图批采
  └─ nowcoder-agent-market ─> 公开搜索发现 ──> Edge 详情页采集
                                      │
                                      v
                         提取完整性 / 可信度 / 去重 / 分类
                                      │
                         ┌────────────┴────────────┐
                         v                         v
                    本机 Markdown 库       私有项目 _inbox
                                                   │
                                                   v
                                       Codex 归纳与差距报告
```

不采用以下方案：

- **直接调用站点私有 API：** 登录、签名和页面协议容易变化，扩大凭证与隐私边界；
- **FaaS 云端调度：** 无法安全复用用户本机登录状态，为个人工作流增加不必要的凭证管理；
- **通用可配置爬虫：** 当前只有两个固定任务，规则 UI 和通用 DSL 没有收益。

## 5. 子项目拆分

整个目标拆成三个可以分别回归、分别提交的子项目：

1. **P0 内容证据层：** 牛客提取完整性、发布时间、付费检测、可信度、来源分类和跨 URL 去重；
2. **P1 固定来源计划层：** 知识星球三视图计划、公司感知的牛客计划、批次终态和断线补跑；
3. **P2 消费与可见性层：** `life-teachers`/`fe-journey` 收件箱路由、Codex 差距与运营报告、Side Panel 任务状态卡。

P0 不依赖 P1；P1 只消费 P0 的判定结果；P2 只消费 P1 已进入终态的批次。每个子项目必须单独通过测试和提交，不能等到最后一次性验收。

## 6. P0：内容证据层

### 6.1 牛客提取

牛客详情提取器保持站点专用，不引入通用 Readability。提取顺序为：

1. `feed/main/detail` 和 `discuss` 的已知正文容器；
2. 页面内嵌 SSR 数据中的标题、作者、正文和 `createdAt`；
3. 仅在唯一候选明显领先时使用正文块打分兜底；
4. 以上都不满足时返回 `UNSUPPORTED_LAYOUT`，不保存疑似页面 chrome。

正文候选必须排除导航、评论、作者榜、推荐卡、购买面板和页脚。出现以下可见提示时设置 `contentAccess`：

- `full`：完整公开正文；
- `truncated`：出现“剩余 xx% 内容”“展开后仍缺失”等明确截断证据；
- `paywalled`：出现“订阅专栏后可继续查看”“购买后查看”等付费证据。

`truncated` 和 `paywalled` 可以保存在本机作为证据，但不能进入自动消费批次。

发布时间优先使用可见 `time[datetime]`，其次使用可见时间文本，最后读取同一详情对象的 SSR `createdAt`。无年份的 `MM-DD HH:mm` 按 Asia/Shanghai 与采集时间推断年份；不能可靠确定时不伪造日期。

### 6.2 来源与岗位元数据

在 `CollectedDocument.sourceMetadata` 下增加向后兼容字段，不改变 `schemaVersion: 1`：

```ts
interface NowcoderSourceMetadata {
  company?: 'bytedance' | 'tencent' | 'alibaba' | 'ant';
  companyLabel?: string;
  businessUnit?: string;
  role?: string;
  interviewRound?: string;
  interviewDate?: string;       // YYYY-MM-DD；只有正文可确定时才写
  contentAccess: 'full' | 'truncated' | 'paywalled';
  questionCount: number;
  evidenceGrade: 'A' | 'B' | 'C';
  evidenceReasons: string;      // 以 `；` 分隔的简短确定性理由
}
```

公司别名固定映射：

- 字节：字节、字节跳动、抖音、TikTok、火山引擎；
- 腾讯：腾讯、WXG、TEG、微信、微信支付；
- 阿里：阿里、阿里巴巴、淘天、淘宝、天猫、阿里云；
- 蚂蚁：蚂蚁、蚂蚁集团、支付宝、Alipay。

只在标题、作者正文自述或岗位字段中存在证据时写公司；文章中泛泛提到某公司不能算公司归属。

### 6.3 可信度分级

可信度是确定性分级，不调用大模型：

- **A：** 第一人称，能识别公司/岗位，存在轮次或面试日期，并抽取到至少 3 个实际问题；正文完整且无推广；
- **B：** 主体是第一手过程且有实际问题，但缺一个 A 级证据项，或带单个轻度项目推荐；
- **C：** 汇编/搬运、营销、付费或截断、没有真实过程、没有实际问题，或来源归属不清。

只有 A/B 进入自动消费。现有 `qualityScore` 继续表示主题相关度和信息量，不能再承担真实性判断。

### 6.4 分类与问题计数

- 牛客 A/B 级面试内容的 `suggestedCategory` 固定优先为“人工智能”，同步到 fe-journey 时映射为“面经”；
- `React`、`设计` 等正文词不能覆盖来源和候选类型的高优先分类；
- “一面”“二面”“技术面”“终面”“面完”等轮次信号能够独立支持 `interview`，不要求标题同时出现“面经”；
- 问题计数识别数字列表、问号句、面试官问/追问、分节标题，连续的描述文本不能被错误计成多题。

### 6.5 跨 URL 去重

去重顺序：

1. 规范 URL 对应稳定内容 ID；
2. 净化正文指纹：移除页面 UI、推广尾巴、回答模板、链接跟踪参数后计算；
3. 面经问题指纹：公司 + 作者 + 规范化问题集合；
4. SimHash 只用于候选聚类，不单独决定代表项。

同簇代表项按以下顺序选择：A 优于 B/C、完整优于截断、第一手优于汇编、发布时间更早优于晚、正文问题更完整优于短。删除本机条目时必须通过库管理接口同步移除候选目录项，不能再依靠手工编辑目录文件。

## 7. P1：固定来源计划层

### 7.1 通用计划与批次账本

固定计划不扩展为通用 DSL，只定义两个代码内置 profile：

```ts
type CollectionPlanId = 'zsxq-chen-teacher' | 'nowcoder-agent-market';

type BatchStatus = 'running' | 'completed' | 'completed_with_attention' | 'failed';

interface CollectionBatch {
  id: string;
  planId: CollectionPlanId;
  status: BatchStatus;
  startedAt: string;
  finishedAt?: string;
  discovered: number;
  accepted: number;
  saved: number;
  skipped: number;
  failed: number;
  needsAttention: number;
  coverage?: Record<string, number>;
  error?: string;
}
```

Bridge 继续每 15 分钟检查到期任务。计划到期但 Edge 离线时不把批次标失败；记录待运行标志，扩展重连后立即补跑。批次只有在全部详情任务进入 `saved`、`skipped`、`failed` 或 `needs_attention` 后才结束。

`Tabs cannot be edited right now` 等浏览器瞬态错误最多重试 3 次，等待 1、3、9 秒；登录问题直接进入 `needs_attention`，不反复刷新登录页。

状态以原子写入保存在 `~/.data-collector/collection-plans.json`。升级时继续读取现有 `fe-journey-state.json` 的牛客/GitHub周期信息；新文件只负责两个新 profile 和批次账本。

### 7.2 知识星球计划

`zsxq-chen-teacher` 固定配置：

- group：`48844584441158`；
- 时区：`Asia/Shanghai`；
- 每日目标时间：08:00；
- 视图：`最新`、`精华`、`只看星主`；
- 首次回看 30 天，日常回看 7 天；
- 每个视图最多 12 轮、三视图合计最多 60 个唯一 topic；
- 只保存星主发布内容；问答帖保留 `questioner`，但作者必须仍归属星主；
- 保存成功后自动同步到 `life-teachers` 私有 `_inbox`。

执行时在一个不激活的后台标签打开星球页，逐个选择视图并等待页面自己的请求和 DOM 稳定。扩展复用现有 topic response 旁观机制，将正文对回 `topic_id`。同一 topic 出现在多个视图时只保存一次，并在 `sourceMetadata.viewLabels` 中保存按逗号连接的视图集合。

“只看星主”以页面角色 `owner` 或接口中可验证的星主标志为准；显示名称只用于展示，不能作为唯一身份凭据。若页面改版导致无法验证星主，整批进入 `completed_with_attention`，不把所有成员内容误收进来。

内容方向沿用 `life-teachers` 的固定分类：投资、财富、职场、认知、教育、其他。只有命中投资、创业、商业模式、经营、财富、职业或认知强信号的内容进入收件箱；现有对打新、楼市、相亲等内容的保守排除继续生效。被排除内容在批次账本计入 `skipped`，保留原因，不进入收件箱。

### 7.3 牛客计划

`nowcoder-agent-market` 固定配置：

- 时区：`Asia/Shanghai`；
- 每日目标时间：09:00；
- 日常时间窗：最近 30 天；
- 发现池上限：60；
- 每日接受上限：12；
- 每公司上限：4；
- 公司：字节、腾讯、阿里、蚂蚁及第 6.2 节别名；
- 岗位：Agent、AI 应用、大模型应用、RAG、MCP、AI 全栈、Agent 平台；
- A/B 自动同步到 `fe-journey` 私有 `_inbox`，C 只留本机证据。

搜索词按“公司别名 × 岗位族”组成有限集合，并轮转起始公司，避免总是先耗尽字节结果。发现阶段只收规范详情 URL；详情采集后才根据正文日期、公司、岗位、可信度和完整性决定是否接受。

没有合格蚂蚁内容时，`coverage.ant = 0` 并在批次状态显示“本轮无合格内容”；不能扩大日期窗或降低可信度自动补齐。运营素材与面经可以来自同一页面，但分别标记 `operation` 和 `interview`，下游按用途消费。

## 8. P2：消费、Codex 联动与界面

### 8.1 本机库与项目收件箱

原始文档结构保持不变：`来源/分类/年份/稳定 ID + 标题/index.md` 与 `source.json`。自动计划只新增元数据和同步动作，不增加数据库。

- 知识星球 A 类目标内容：本机库 → `life-teachers/_inbox/zsxq/<id>/`；
- 牛客 A/B 候选：本机库 → `front-end-journey-resource/_inbox/nowcoder/<id>/`；
- 收件箱继续被 Git 忽略，只有 Codex 归纳后的正式 Markdown 由人工审阅后提交。

同步必须幂等：同一稳定 ID 更新同一收件箱目录。批次只有在本机保存完成后才尝试同步；同步失败不丢本机原文，并在批次标记失败原因。

### 8.2 Codex 命令

复用现有 bearer token 保护的本机 HTTP/WebSocket，增加固定计划命令，不新增通信服务：

```text
data-collector plans status
data-collector plans run zsxq-chen-teacher --force
data-collector plans run nowcoder-agent-market --force
data-collector plans batches --limit 20
```

原有 `data-collector collect URL --wait` 保持兼容。Codex 可以从状态命令读取本批统计、覆盖缺口和待登录原因，不读取浏览器 Cookie。

### 8.3 面试题差距报告

`front-end-journey-resource` 的现有 curator 在处理 A/B 面经簇时：

1. 从 `original.md` 提取独立问题，保留来源 URL、公司、岗位、日期和簇 ID；
2. 归一化同义词，例如“上下文压缩/Context Compaction”“重排/Rerank”；
3. 与 `interview/` 中现有四级问题标题比较；
4. 标为 `covered`、`evolved` 或 `new`；
5. 输出 `_inbox/_reports/interview-gap-YYYY-MM-DD.md`；
6. 对 `evolved/new` 给出目标文件和建议问题标题，但不直接覆盖正式题库。

报告按“主题 → 公司/岗位 → 来源证据”组织，禁止一篇面经生成一篇公开文章。第一版使用现有 Markdown 树、别名字典和 Codex 语义判断，不引入向量数据库。

### 8.4 运营选题报告

`operation` 候选按簇生成 `_inbox/_reports/operation-topics-YYYY-MM-DD.md`，每个选题包含：用户痛点、出现频率、涉及公司/岗位、来源链接、建议内容形态和是否已有对应文章。推广和 C 级内容不能成为唯一证据。

### 8.5 Side Panel

Side Panel 保持右侧固定布局，只在顶部导航增加“任务”入口。任务页只显示：

- 两个固定计划的上次运行、下次运行和运行中状态；
- 最近一批保存、跳过、失败、待登录数量；
- 牛客四家公司覆盖数量；
- “立即运行”“重试”和登录提醒。

不展示技术字段、查询编辑器或复杂日志。点击登录提醒只打开对应站点，不自动填写账号。

## 9. 错误与恢复

- **Edge 离线：** 计划保持待运行，重连后补跑；
- **登录失效：** 批次 `completed_with_attention`，用户登录后显式重试或下次自动续跑；
- **页面结构变化：** 保存 `UNSUPPORTED_LAYOUT` 和 URL，不落疑似正文；
- **付费/截断：** 本机可留证据，可信度 C，不进收件箱；
- **单条失败：** 其他条目继续，批次结束时给出准确数量；
- **全部失败：** 批次 `failed`，不更新成功游标；
- **状态文件损坏：** 不覆盖损坏文件，禁用对应计划并在健康接口显示错误；
- **同步失败：** 本机内容保留，批次可重试同步而不重新抓页面；
- **扩展升级：** 稳定扩展 ID 和自动身份校验保持不变。

## 10. 隐私与安全

- 所有计划、状态、原始内容和报告默认留在本机；
- 扩展权限不扩大到 `<all_urls>`，只保留明确来源域名；
- Bridge 接口继续仅监听 loopback，并要求 bearer token；
- 批次状态不包含 Cookie、请求头、页面令牌或私密接口响应；
- 日志只记录 URL、任务 ID、错误代码和计数，不记录完整私密正文；
- 第三方正文不自动提交到 Git 或公开仓库。

## 11. 测试与验收

### 11.1 自动化测试

P0：

- 牛客 `feed`、`discuss`、SSR fallback、页面 chrome、付费和截断夹具；
- 公司别名、轮次、问题计数、A/B/C 可信度；
- 来源优先分类；
- 去 UI 后正文指纹和跨 URL 问题指纹。

P1：

- 知识星球三视图选择、DOM 稳定等待、topic union、星主校验和日期停止条件；
- 牛客发现池、时间窗、公司上限、轮转公平性和覆盖缺口；
- 批次只有详情任务全部终态才完成；
- Edge 离线补跑、瞬态标签重试和登录恢复。

P2：

- 两个收件箱幂等同步；
- 差距报告的 `covered/evolved/new` 映射和证据链接；
- 运营选题按簇聚合；
- Side Panel 状态、立即运行、重试和登录提醒。

全局门禁：

```text
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run smoke:wechat
npm run smoke:fe-journey
```

### 11.2 真实验收

1. 十篇 2026 年 8 月牛客回归 URL 各保存一次，无付费、旧帖或跨 URL 重复混入；
2. 新阿里云“一面”帖子自动识别为面经并落到人工智能/面经分类；
3. 对知识星球三个视图实际运行，记录每个 topic 的视图集合，同一 topic 只落一次；
4. “只看星主”没有混入普通成员内容，问答保留提问者；
5. Edge 断开再连接后计划自动补跑，登录失效能显示待处理；
6. `life-teachers` 和 `fe-journey` 收件箱只出现符合规则的条目；
7. 生成带来源链接的题库差距和运营选题报告；
8. Side Panel 能看到批次终态和四家公司覆盖缺口；
9. 健康接口仍显示固定扩展身份已连接，未新增云端凭证或不必要软件；
10. `master` 工作区无生成物残留，所有必要改动已提交并推送。

## 12. 交付顺序

1. P0 内容证据层设计、测试、实现、真实十篇回归；
2. P1 通用批次账本与牛客固定计划；
3. P1 知识星球三视图计划与真实登录态冒烟；
4. P2 收件箱自动路由和 Codex 报告；
5. P2 Side Panel 任务页；
6. 全量测试、代码审查、残留清理、版本升级、提交、推送和运行中 Bridge 更新。

每一步都必须形成可运行的增量；若真实站点布局与夹具不一致，先保存诊断证据并补失败测试，再修复，不在提取器中增加宽泛选择器掩盖问题。
