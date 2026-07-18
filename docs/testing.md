# 测试与验收

## 自动化测试

确保使用 Node.js 22.12+，然后执行：

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:coverage
npm run package
```

测试层次：

- 单元：URL 规范化、DOM 提取、固定身份、自动授权、任务状态机、清洗、文件写入、Side Panel 状态、后台 `setPanelBehavior` 与打包白名单。
- 集成：真实 HTTP/WebSocket Bridge、Origin/token 认证、current-page 不重复派发、queued 重连恢复、`4009/replaced` 单连接接管、CLI 采集和错误退出。
- 端到端：用系统 Chrome 加载构建后的固定 ID 扩展，打开公众号 fixture，验证 Side Panel document 无需输入即可进入 ready；实际填写分类/标签并点击保存，断言无额外文章 tab、覆盖值进入 Markdown，再覆盖 catalog 去重和 CLI URL collection。
- 真实冒烟：请求指定在线公众号文章，复用生产提取器和知识库写入器，验证标题、作者、正文、最终路径和重复采集幂等性。

合并自动门槛使用离线 fixture E2E，并包含在上述自动化命令中。真实在线冒烟依赖外部站点与网络状态，只在网络可用时作为补充验收，不因其未执行或外部网络失败阻塞合并。

E2E 会依次查找 `CHROME_PATH`、`PUPPETEER_EXECUTABLE_PATH`、macOS Chrome、Linux Chrome/Chromium 和 Windows Chrome。需要指定浏览器时：

```bash
CHROME_PATH='/path/to/chrome' npm run test:e2e
```

### E2E 边界

headless Chrome 不能通过用户手势可靠打开 Edge 原生 Side Panel surface，因此自动化按既定边界直接访问 `chrome-extension://<fixed-id>/sidepanel/index.html`。测试从构建后 service worker URL 解析 ID 并与受信任 ID 比较，截图写入 `artifacts/screenshots/sidepanel-ready.png` 和 `sidepanel-collecting.png`。

为了让被采集文章保持 active tab，测试通过 CDP DOM 域观察后台 Side Panel document，并对真实分类/标签输入框赋值、点击“保存这一页”。测试监听 Chrome page target，确保当前页任务不会再创建同 URL 后台采集 tab。它验证页面、状态机、自动授权和采集链路，但不声称验证 Edge 原生侧栏容器。工具栏点击配置由 background 单元测试对 `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` 独立约束。

## 手工验收清单

1. 运行 `npm run package`，确认稳定安装目录和 `data-collector-extension-0.2.0.zip` 均生成。
2. 在 `edge://extensions` 删除任何旧 Data Collector，再加载 `artifacts/data-collector-extension`。
3. 启动 Bridge，在公众号文章点击扩展图标；Edge 一步打开 Side Panel，并自动显示“本机在线”。
4. 保存后文件包含标题、来源 URL、摘要、正文；Side Panel 显示最终路径。
5. 重复保存同一文章，返回相同路径，目录索引只有一个稳定 ID。
6. 登录知识星球后验证文章、动态、问答详情；退出后应显示需要登录，不保存登录页。
7. 停止 Bridge 后 Side Panel 显示服务离线；重启并点击“重新连接”后恢复。
8. 安装非正式 ID 时显示身份异常，并提示删除后从正式发布包重新安装。
9. 同时启动第二个已安装实例时，旧 Side Panel 显示“另一个浏览器实例已接管”且不反复重连；点击“在此实例重新连接”后可主动接管。
10. `unzip -l artifacts/data-collector-extension-0.2.0.zip` 只显示六个允许文件。

## 可复现打包

打包脚本从已校验的 `packages/extension/dist/manifest.json` 读取版本，先在临时目录准备完整 ZIP 和已解压目录，再切换稳定安装目录。只有 0.2.0 成品验证完成后才删除旧 ZIP。

```bash
npm run package
shasum -a 256 artifacts/data-collector-extension-0.2.0.zip
npm run package
shasum -a 256 artifacts/data-collector-extension-0.2.0.zip
```

两次 SHA-256 必须完全一致。发布前还应执行任务简报指定的当前源码扫描，并排除历史 `docs/superpowers`；预期没有遗留人工授权或旧入口文本。

## 可选：真实微信公众号在线冒烟

```bash
npm run build
node scripts/smoke-wechat.mjs 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g'
```

网络可用时可运行此补充验收；它不是合并硬门槛。脚本使用隔离知识库 `artifacts/smoke-library`，连续写入两次同一 URL；两次必须保存到同一路径且 catalog 只有一个条目。结果摘要写入 `artifacts/smoke-wechat.json`。

## 页面结构回归

站点页面变化时，先把去除个人信息后的最小 DOM 保存到 `tests/fixtures`，写一个会失败的提取测试，再修改专用提取器。不要用整页 `innerText` 或无限制选择器掩盖结构变化。
