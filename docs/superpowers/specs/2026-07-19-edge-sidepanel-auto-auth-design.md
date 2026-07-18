# Data Collector Edge 侧边栏与自动授权设计

日期：2026-07-19

## 1. 目标

把 Data Collector 从短暂的工具栏弹窗改为 Microsoft Edge 原生右侧栏，并取消六位配对码。用户首次加载扩展后只需启动本机 Bridge；点击扩展图标即可在网页右侧打开 Data Collector，网页内容由浏览器自动缩放到左侧。

成功标准：

- Edge Beta 使用原生 Side Panel，不向目标网页注入布局样式。
- 工具栏图标切换侧边栏，面板在导航和切换标签页时持续识别当前页面。
- 首次连接不要求输入配对码，只接受固定 Data Collector 扩展身份。
- HTTP 写盘接口和后续 WebSocket 仍使用随机令牌，不向网页开放匿名写盘。
- 旧配对界面、消息、CLI 输出、协议说明和测试被完整移除。

## 2. 方案取舍

采用全局原生 Side Panel，而不是站点限定面板或 DOM 注入分栏。

- 全局 Side Panel 最符合“固定在右侧”的操作预期；在不支持的页面展示明确空状态。
- Edge 负责面板位置、拖动宽度和左侧网页自适应，扩展不修改微信或知识星球 DOM。
- 站点限定面板会在切换普通页面时关闭；DOM 注入容易与目标站点 CSS 冲突，均不采用。

浏览器只允许在用户手势下首次打开 Side Panel，因此扩展不能在安装瞬间强行展开。设置 `openPanelOnActionClick: true` 后，用户点击已固定的工具栏图标即可打开或切换侧栏。

## 3. 扩展结构与界面

Manifest 增加：

- `sidePanel` 权限。
- `side_panel.default_path = "sidepanel/index.html"`。
- 固定扩展 ID 所需的公开 `key`。

Manifest 移除 `action.default_popup`，保留工具栏 action 标题。Service Worker 在安装、启动和模块初始化时幂等调用 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`。

现有 `popup/` 资源整体迁移为 `sidepanel/`，不同时保留两套 UI：

- `sidepanel/index.html`
- `sidepanel/index.ts`
- `sidepanel/state.ts`
- `sidepanel/styles.css`

布局使用 `width: 100%`、`min-width: 280px`、`min-height: 100vh`。页脚不再绝对定位，窄面板下结果按钮改为单列，较宽面板下使用双列。面板持续轮询后台状态，并在标签激活、页面导航或标题变化后更新当前页面信息。

状态简化为：

- `loading`：读取当前页面和连接状态。
- `connecting`：已发现 Bridge，正在自动授权或建立 WebSocket。
- `unsupported`：当前页不是支持的详情页。
- `ready`：可保存，并允许覆盖分类和标签。
- `collecting`、`saved`、`needs_attention`、`job_error`：沿用现有采集反馈。
- `bridge_unavailable`：本机 Bridge 未启动，展示启动命令和重试按钮。
- `identity_error`：安装包身份与 Bridge 内置 ID 不一致，提示重新加载官方构建目录。

不再存在 `unpaired` 状态、配对输入框或 `pair.submit` 消息。

## 4. 固定身份与自动授权

构建仓库保存一份 Chromium 扩展公开密钥，Manifest 的 `key` 由该公开密钥生成，使 unpacked 扩展在 Chrome/Edge 中获得稳定 ID。私钥不进入扩展、ZIP、Bridge 或 Git；运行时只需要公开 key 和由其确定的扩展 ID。

Bridge 保存精确允许列表，只接受以下固定来源且 ID 必须完全相同：

- `chrome-extension://<data-collector-id>`
- `extension://<data-collector-id>`（兼容 Edge 暴露的扩展来源形式）

自动授权使用 WebSocket 握手而不是普通 HTTP `Origin`。浏览器 WebSocket 的 Origin 由浏览器生成，普通网页不能把自己声明成指定扩展。流程如下：

1. 扩展没有令牌，或现有令牌收到 `401` 时，连接 `/v1/extension?bootstrap=1`。
2. Bridge 先校验连接来自 loopback，再精确校验 Origin。
3. 身份通过后，Bridge 创建或读取 256 位随机令牌并发送 `bridge.authorized`。
4. 扩展保存令牌并在同一连接发送 `extension.hello`。
5. 后续 WebSocket 握手继续同时校验固定 Origin 与令牌；HTTP jobs/reveal 继续要求 Bearer token。
6. 扩展存储被清空时可再次 bootstrap，Bridge 返回当前令牌，无需人工操作。

删除 `POST /v1/pair`、六位码生成/过期逻辑和 CLI 配对提示。Bridge 启动输出改为本机地址、知识库目录与“等待受信任扩展自动连接”。CLI 仍从权限为 `0600` 的认证文件读取令牌。

安全边界变化是显式的：普通网页和非目标扩展无法通过浏览器 Origin 校验；拥有当前用户本机代码执行权限的恶意进程仍可能伪造网络握手。该取舍是用户选择自动模式后的便利性边界，不声称抵御同用户权限下的本机恶意软件。

## 5. 兼容与迁移

- 现有 Bridge 认证文件中的随机令牌继续有效。
- 现有扩展存储令牌若有效可直接连接；失效或缺失时自动 bootstrap。
- 添加 Manifest key 后扩展 ID 会固定，Edge 中当前 unpacked 安装需要重新加载新的 `artifacts/data-collector-extension`。如果 Edge 仍保留旧 ID，则先移除旧扩展再加载固定目录。
- Side Panel API 的最低浏览器基线仍为 Chrome/Edge 116；Manifest 保持最低版本 116。
- Bridge 仍只监听 `127.0.0.1`，不增加 Native Messaging、后台守护进程或其他软件。

## 6. 错误处理

- Bridge 未启动或端口不可达：指数退避重连，侧栏展示启动命令与立即重试。
- 旧令牌失效：一次自动 bootstrap；身份失败则停止循环并展示 `identity_error`。
- 非固定 Origin：WebSocket 升级返回 `401`，不生成或泄露令牌。
- 多个 Data Collector 连接：保留最新连接，旧连接以 `1012` 关闭。
- 页面不支持、需要登录或 DOM 变化：使用现有可恢复状态，不关闭侧栏。

## 7. 测试与验收

按测试驱动实现：

1. Manifest/打包测试先要求 `sidePanel`、固定 key、`side_panel`，并禁止 `default_popup` 与旧 `popup/` 文件。
2. Bridge 单元/集成测试先验证固定 Origin 自动授权、随机 Origin 拒绝、令牌持久化、旧令牌复用和 HTTP 未授权拒绝。
3. 连接测试先验证无令牌 bootstrap、收到授权消息后存储令牌、旧令牌 `401` 后自动回退，以及身份错误不无限重试。
4. UI 测试先移除配对表单断言，覆盖 connecting、Bridge 未启动、身份错误和自适应侧栏 DOM。
5. E2E 改为打开真实 Side Panel，而不是调用 popup；继续覆盖当前页采集与 CLI URL 采集。
6. 全量执行类型检查、构建、67 项以上回归、覆盖率、可复现 ZIP 和真实微信文章 smoke。

Edge Beta 手工验收：重新加载固定扩展目录，点击工具栏图标后右侧栏打开；左侧文章自适应；无需配对码；Bridge 在线后可保存指定微信文章并显示最终路径。

## 8. 交付

- 更新 `README.md`、产品、协议、安全和测试文档。
- 将本次不兼容的交互变更发布为 `0.2.0`。
- 构建并刷新 `artifacts/data-collector-extension`。
- 生成可复现 `artifacts/data-collector-extension-0.2.0.zip`。
- 提交并推送 `master`，由用户在 Edge Beta 重新加载后进行最终验收。
