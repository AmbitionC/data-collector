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

- 单元：URL 规范化、微信公众号/知识星球 DOM 提取、配对、任务状态机、清洗、摘要分类、文件写入、后台连接、弹窗状态与打包白名单。
- 集成：真实 HTTP/WebSocket Bridge、认证、重连恢复、CLI 采集和错误退出。
- 端到端：用系统 Chrome 加载真实 MV3 扩展，打开微信公众号域名页面，完成弹窗配对、当前页采集和 Markdown 落盘。
- 真实冒烟：请求指定在线公众号文章，复用扩展生产提取器和生产知识库写入器，验证标题、作者、正文、最终路径和重复采集幂等性。

E2E 会依次查找 `CHROME_PATH`、`PUPPETEER_EXECUTABLE_PATH`、macOS Chrome、Linux Chrome/Chromium 和 Windows Chrome。需要指定浏览器时：

```bash
CHROME_PATH='/path/to/chrome' npm run test:e2e
```

## 手工验收清单

1. `npm run collector -- bridge start` 后扩展显示配对界面。
2. 错误配对码失败，正确码成功，已使用的码不能再次兑换。
3. 打开微信公众号文章，保存后文件包含标题、来源 URL、摘要、正文。
4. 重复保存同一文章，返回相同路径，目录索引只有一个稳定 ID。
5. 登录知识星球，文章、动态、问答详情能够提取；问答记录回答数量。
6. 退出知识星球后重试，任务显示“需要登录”，不保存登录页。
7. 关闭扩展连接后 CLI 明确超时；重新连接后新任务可成功。
8. `unzip -l artifacts/data-collector-extension-0.1.0.zip` 只显示 6 个允许文件。

## 真实微信公众号冒烟

使用项目脚本：

```bash
npm run build
node scripts/smoke-wechat.mjs 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g'
```

脚本会请求真实页面并使用隔离知识库 `artifacts/smoke-library`（可用 `DATA_COLLECTOR_LIBRARY` 覆盖）。它连续写入两次相同 URL，只有在两次均保存到同一路径、正文有意义且目录中只有一个条目时才返回 0。结果摘要写入 `artifacts/smoke-wechat.json`。真实 MV3 扩展、配对、WebSocket Bridge 和弹窗链路由 `npm run test:e2e` 独立覆盖，使站点网络变化与浏览器自动化故障可以分别定位。

## 页面结构回归

站点页面变化时，先把去除个人信息后的最小 DOM 保存到 `tests/fixtures`，写一个会失败的提取测试，再修改专用提取器。不要用整页 `innerText` 或无限制选择器“修复”，它会把导航、评论、推荐和登录提示混入知识库。
