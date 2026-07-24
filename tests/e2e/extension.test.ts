import { access, mkdir, readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, {
  type Browser,
  type Page,
  type Target,
  type WebWorker,
} from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/index.js';
import { TRUSTED_EXTENSION_ID } from '../../packages/shared/src/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_PATH = join(WORKSPACE, 'packages', 'extension', 'dist');
const TARGET_URL = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g';
let browser: Browser | undefined;
let bridge: BridgeHandle | undefined;
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(async () => {
  const activeBrowser = browser;
  const activeBridge = bridge;
  browser = undefined;
  bridge = undefined;
  const closeResults = await Promise.allSettled([
    Promise.resolve().then(() => activeBrowser?.close()),
    Promise.resolve().then(() => activeBridge?.close()),
  ]);
  const cleanupResults = await Promise.allSettled([temporaryDirectories.cleanup()]);
  const failures = [...closeResults, ...cleanupResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'E2E 资源清理失败');
});

async function sidePanelFor(targetPage: Page): Promise<{ page: Page; worker: WebWorker }> {
  const workerTarget = await browser!.waitForTarget(
    target => target.type() === 'service_worker' && target.url().endsWith('background.js'),
    { timeout: 20_000 },
  );
  const worker = await workerTarget.worker();
  if (!worker) throw new Error('扩展 Service Worker 未启动');
  const extensionId = new URL(workerTarget.url()).host;
  expect(extensionId).toBe(TRUSTED_EXTENSION_ID);
  const sidePanel = await browser!.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await targetPage.bringToFront();
  return { page: sidePanel, worker };
}

async function waitForVisiblePanel(page: Page, selector: string, timeout: number): Promise<void> {
  const session = await page.createCDPSession();
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      const { root } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { attributes } = await session.send('DOM.getAttributes', { nodeId });
      if (!attributes.includes('hidden')) return;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
  } finally {
    await session.detach();
  }
  throw new Error(`等待侧栏状态超时：${selector}`);
}

async function elementText(page: Page, selector: string): Promise<string> {
  const session = await page.createCDPSession();
  try {
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { outerHTML } = await session.send('DOM.getOuterHTML', { nodeId });
    return outerHTML
      .replace(/^<[^>]+>|<\/[^>]+>$/g, '')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .trim();
  } finally {
    await session.detach();
  }
}

async function captureCurrentFromSidePanel(
  page: Page,
  overrides: { userCategory: string; userTags: string[] },
): Promise<void> {
  const session = await page.createCDPSession();
  try {
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const category = document.querySelector('#category');
        const tags = document.querySelector('#tags');
        const capture = document.querySelector('#capture-button');
        if (!(category instanceof HTMLInputElement) ||
            !(tags instanceof HTMLInputElement) ||
            !(capture instanceof HTMLButtonElement)) {
          throw new Error('Side Panel capture controls are missing');
        }
        category.value = ${JSON.stringify(overrides.userCategory)};
        tags.value = ${JSON.stringify(overrides.userTags.join(', '))};
        capture.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    if (result.value !== true) throw new Error('Side Panel capture click failed');
  } finally {
    await session.detach();
  }
}

/** 发现 Playwright 预装的 Chromium（容器/CI 常见），避免依赖显式环境变量。 */
function playwrightChromiumCandidates(): string[] {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return [];
  try {
    return readdirSync(base)
      .filter(name => name.startsWith('chromium-') && !name.includes('headless_shell'))
      .map(name => join(base, name, 'chrome-linux', 'chrome'));
  } catch {
    return [];
  }
}

async function preferredChrome(): Promise<string | undefined> {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    ...playwrightChromiumCandidates(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function serveArticleFixture(page: Page, fixture: string): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.url().startsWith(TARGET_URL)) {
      void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
    } else {
      void request.continue();
    }
  });
}

describe('built Chrome extension', () => {
  it('automatically authorizes the side panel and captures the current page into the local library', async () => {
    const libraryRoot = await temporaryDirectories.create('data-collector-e2e-');
    bridge = await startBridge({
      port: 17321,
      libraryRoot,
      configDir: join(libraryRoot, '.config'),
      fetch: async () => {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1_200));
        return new Response(null, { status: 404 });
      },
    });
    const executablePath = await preferredChrome();
    if (!executablePath) {
      throw new Error('未找到 Chrome；请设置 PUPPETEER_EXECUTABLE_PATH 后重试');
    }
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      // 用浏览器自带的 --load-extension 加载扩展（不依赖 puppeteer 的
      // Extensions CDP 域——部分 Chromium 构建未编译该域）。
      // 容器/CI 无用户命名空间沙箱，需显式关闭沙箱；本地测试仅加载受信任 fixture。
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
      timeout: 20_000,
      protocolTimeout: 20_000,
      signal: AbortSignal.timeout(25_000),
    });

    const fixture = await readFile(join(WORKSPACE, 'tests', 'fixtures', 'wechat-article.html'), 'utf8');
    const articlePage = await browser.newPage();
    await serveArticleFixture(articlePage, fixture);
    await articlePage.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    const { page: sidePanel } = await sidePanelFor(articlePage);
    // ready-panel 仅在 bridgeStatus=connected 且当前页受支持时渲染，故它可见即代表
    // 扩展已自动授权并识别到目标页（改用侧栏 DOM 判定，规避个别 Chromium 构建里
    // service-worker evaluate 停滞的问题）。
    await waitForVisiblePanel(sidePanel, '#ready-panel', 15_000);
    expect(await elementText(sidePanel, '#page-title')).toContain('一夜之间');

    const screenshotDirectory = join(WORKSPACE, 'artifacts', 'screenshots');
    await mkdir(screenshotDirectory, { recursive: true });
    await sidePanel.screenshot({ path: join(screenshotDirectory, 'sidepanel-ready.png') });
    const openedArticleTargets: string[] = [];
    const recordArticleTarget = (target: Target) => {
      if (target.type() === 'page' && target.url().startsWith(TARGET_URL)) {
        openedArticleTargets.push(target.url());
      }
    };
    browser.on('targetcreated', recordArticleTarget);
    browser.on('targetchanged', recordArticleTarget);
    await captureCurrentFromSidePanel(sidePanel, {
      userCategory: 'E2E 指定分类',
      userTags: ['E2E 标签', '当前页面'],
    });
    await waitForVisiblePanel(sidePanel, '#collecting-panel', 10_000);
    await sidePanel.screenshot({ path: join(screenshotDirectory, 'sidepanel-collecting.png') });
    await waitForVisiblePanel(sidePanel, '#saved-panel', 15_000);

    const outputPath = await elementText(sidePanel, '#saved-path');
    expect(outputPath).toMatch(/index\.md$/);
    const markdown = await readFile(outputPath, 'utf8');
    expect(markdown).toContain('一夜之间，通胀的玩笑这次开大了');
    expect(markdown).toContain('重远投资观');
    expect(markdown).toContain(TARGET_URL);
    expect(markdown).toContain('category: "E2E 指定分类"');
    expect(markdown).toContain('  - "E2E 标签"');
    expect(markdown).toContain('  - "当前页面"');
    expect(openedArticleTargets).toEqual([]);
    expect((await browser.pages()).filter(page => page.url().startsWith(TARGET_URL)))
      .toHaveLength(1);
    browser.off('targetcreated', recordArticleTarget);
    browser.off('targetchanged', recordArticleTarget);

    // 本机库确实落盘了这一条（目录索引恰好 1 条）。
    const catalog = JSON.parse(
      await readFile(join(libraryRoot, '_catalog', 'index.json'), 'utf8'),
    ) as unknown[];
    expect(catalog).toHaveLength(1);
    // CLI/Codex 采集路径（扩展自开后台标签页）的浏览器行为在无头环境无法稳定夹具化：
    // 请求拦截晚于标签页导航，后台标签页拿不到夹具页、内容脚本不注入。其逻辑由
    // tests/unit/cli.test.ts 与 tests/integration/bridge.test.ts 覆盖；此处只夹紧侧栏
    // 「当前页保存」这条主用户路径（自动授权 → 识别 → 保存 → 已保存屏 + 正文落盘）。
  });
});
