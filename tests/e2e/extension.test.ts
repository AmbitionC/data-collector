import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const LIST_URL = 'https://wx.zsxq.com/group/48844584441158';
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
        // 分类是级联下拉（跟随「去向」联动），不是自由输入框。
        if (!(category instanceof HTMLSelectElement) ||
            !(tags instanceof HTMLInputElement) ||
            !(capture instanceof HTMLButtonElement)) {
          throw new Error('Side Panel capture controls are missing');
        }
        const wanted = ${JSON.stringify(overrides.userCategory)};
        if (![...category.options].some(option => option.value === wanted)) {
          throw new Error('分类下拉里没有 ' + wanted + '：' +
            [...category.options].map(option => option.value).join('/'));
        }
        category.value = wanted;
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

async function serveArticleFixture(
  page: Page,
  fixture: string,
  url: string = TARGET_URL,
): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.url().startsWith(url)) {
      void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
    } else {
      void request.continue();
    }
  });
}

/** 轮询扩展页里的一段表达式，直到它返回期望值（Bridge 重启期间会话会短暂失效，逐轮重建）。 */
async function waitForValue(
  page: Page,
  expression: string,
  matches: (value: string) => boolean,
  timeout: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let seen = '';
  while (Date.now() < deadline) {
    const session = await page.createCDPSession();
    try {
      const { result } = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      seen = String(result.value ?? '');
      if (matches(seen)) return;
    } catch {
      // 会话瞬时失效不算失败，下一轮重试。
    } finally {
      await session.detach().catch(() => undefined);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
  }
  throw new Error(`等待${label}超时，当前为「${seen}」`);
}

async function clickSidePanel(page: Page, selector: string): Promise<void> {
  const session = await page.createCDPSession();
  try {
    const { exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        if (!(button instanceof HTMLButtonElement)) throw new Error('找不到按钮 ${selector}');
        button.click();
      })()`,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
  } finally {
    await session.detach();
  }
}

/** 起本机 Bridge + 装好扩展的浏览器（两个用例共用同一套真实链路）。 */
async function startStack(): Promise<{ libraryRoot: string }> {
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
    // timeout 已经守住「启动卡死」；不要再挂 AbortSignal —— 它会在超时点直接杀掉
    // 浏览器进程，跑得久一点的用例会莫名其妙断在半路（Connection closed）。
    timeout: 20_000,
    protocolTimeout: 20_000,
  });
  return { libraryRoot };
}

async function waitForText(
  page: Page,
  selector: string,
  expected: string,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let seen = '';
  while (Date.now() < deadline) {
    seen = await elementText(page, selector);
    if (seen === expected) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  throw new Error(`等待 ${selector} 变为「${expected}」超时，当前为「${seen}」`);
}

describe('built Chrome extension', () => {
  it('automatically authorizes the side panel and captures the current page into the local library', async () => {
    const { libraryRoot } = await startStack();

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
      // 只能选下拉里真实存在的分类——这一条同时校验了「去向 → 分类」的联动确实渲染出来了。
      userCategory: '商业与投资',
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
    expect(markdown).toContain('category: "商业与投资"');
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

    // 改 Bridge 侧的去向配置后，扩展重连即可看到新去向——不需要重装扩展。
    await bridge!.close();
    const inboxRepo = await temporaryDirectories.create('data-collector-e2e-repo-');
    await writeFile(
      join(libraryRoot, '.config', 'sinks.json'),
      JSON.stringify({
        sinks: {
          markdown: { type: 'markdown' },
          'e2e-inbox': {
            type: 'repo-inbox',
            repoPath: inboxRepo,
            label: 'E2E 收件箱',
            categories: ['投资', '认知'],
          },
        },
        routes: { wechat: ['markdown', 'e2e-inbox'] },
      }),
      'utf8',
    );
    bridge = await startBridge({
      port: 17321,
      libraryRoot,
      configDir: join(libraryRoot, '.config'),
      fetch: async () => new Response(null, { status: 404 }),
    });
    // 扩展自己把新去向拉进了缓存。
    await waitForValue(
      sidePanel,
      `chrome.storage.local.get(null)
        .then(v => v.bridgeStatus + '|' + (v.routing?.sinks ?? []).map(sink => sink.id).join(','))`,
      value => value.split('|')[1].split(',').includes('e2e-inbox'),
      70_000,
      '扩展缓存里出现新去向 e2e-inbox',
    );

    // 而且下拉里真的能选到它：换到另一个受支持页面（当前页仍停在「已保存」屏）后重新渲染。
    const listPage = await browser!.newPage();
    await serveArticleFixture(
      listPage,
      await readFile(join(WORKSPACE, 'tests', 'fixtures', 'zsxq-list.html'), 'utf8'),
      LIST_URL,
    );
    await listPage.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    await listPage.bringToFront();
    await waitForValue(
      sidePanel,
      `[...document.querySelector('#destination').options].map(option => option.value).join(',')`,
      value => value.split(',').includes('e2e-inbox'),
      20_000,
      '「去向」下拉出现 e2e-inbox',
    );
    // CLI/Codex 采集路径（扩展自开后台标签页）的浏览器行为在无头环境无法稳定夹具化：
    // 请求拦截晚于标签页导航，后台标签页拿不到夹具页、内容脚本不注入。其逻辑由
    // tests/unit/cli.test.ts 与 tests/integration/bridge.test.ts 覆盖；此处只夹紧侧栏
    // 「当前页保存」这条主用户路径（自动授权 → 识别 → 保存 → 已保存屏 + 正文落盘）。
  });

  it('batch-saves a zsxq list page into one library entry per post, without reloading it', async () => {
    const { libraryRoot } = await startStack();

    const fixture = await readFile(join(WORKSPACE, 'tests', 'fixtures', 'zsxq-list.html'), 'utf8');
    const listPage = await browser!.newPage();
    await serveArticleFixture(listPage, fixture, LIST_URL);
    // 数一下这个页面被导航了几次：只应有我们自己发起的那一次。
    let navigations = 0;
    listPage.on('framenavigated', frame => {
      if (frame === listPage.mainFrame()) navigations += 1;
    });
    await listPage.goto(LIST_URL, { waitUntil: 'domcontentloaded' });

    const { page: sidePanel } = await sidePanelFor(listPage);
    await waitForVisiblePanel(sidePanel, '#ready-panel', 15_000);
    // 列表页上「保存这一页」必须变成批量入口，否则整屏帖子会被糊成一篇。
    expect(await elementText(sidePanel, '#capture-button-label')).toBe('批量保存本页帖子');
    await waitForVisiblePanel(sidePanel, '#list-hint', 5_000);

    const screenshotDirectory = join(WORKSPACE, 'artifacts', 'screenshots');
    await mkdir(screenshotDirectory, { recursive: true });
    await sidePanel.screenshot({ path: join(screenshotDirectory, 'sidepanel-list-ready.png') });

    await clickSidePanel(sidePanel, '#capture-button');
    await waitForVisiblePanel(sidePanel, '#batch-panel', 10_000);
    // 采完最后一屏还要滚动确认没有新内容（约 6s），所以给足等待。
    await waitForText(sidePanel, '#batch-heading', '本轮批量归档完成', 30_000);
    await sidePanel.screenshot({ path: join(screenshotDirectory, 'sidepanel-batch-done.png') });

    // fixture 里有一条带着上一轮的折叠标记：新发起一批会先把页面还原，所以它也应被采到。
    expect(await elementText(sidePanel, '#batch-collected')).toBe('3');
    // 拿不到自身 URL 的那条如实计入「已跳过」，而不是静默少采。
    expect(await elementText(sidePanel, '#batch-skipped')).toBe('1');
    expect(await elementText(sidePanel, '#batch-failed')).toBe('0');

    const catalog = JSON.parse(
      await readFile(join(libraryRoot, '_catalog', 'index.json'), 'utf8'),
    ) as { url: string }[];
    // 各自入库：身份由各自的 /topic/ 地址派生，不会相互覆盖。
    expect(catalog).toHaveLength(3);
    expect(new Set(catalog.map(entry => entry.url))).toEqual(new Set([
      `${LIST_URL}/topic/511111111111111`,
      `${LIST_URL}/topic/522222222222222`,
      `${LIST_URL}/topic/544444444444444`,
    ]));
    // 批量不开新标签页：内容已在当前页提取完毕。
    expect((await browser!.pages()).filter(page => page.url().startsWith(LIST_URL)))
      .toHaveLength(1);
    // 而且绝不刷新用户所在的页面——刷新会把知识星球的「精华」分类退回「最新」。
    expect(navigations).toBe(1);
  });

  it('reports an unproductive batch as needing attention, and the screen stays put', async () => {
    await startStack();

    // 一条帖子都没有的列表页：批量必然零产出。这类「结束但没成果」的批次
    // 曾经被显示成「本轮批量归档完成」，而且错误屏会被下一次轮询覆盖掉。
    const listPage = await browser!.newPage();
    await serveArticleFixture(
      listPage,
      '<!doctype html><html><head><title>重远投资观-知识星球</title></head>'
        + '<body><app-root><div class="main-content-container"></div></app-root></body></html>',
      LIST_URL,
    );
    await listPage.goto(LIST_URL, { waitUntil: 'domcontentloaded' });

    const { page: sidePanel } = await sidePanelFor(listPage);
    await waitForVisiblePanel(sidePanel, '#ready-panel', 15_000);
    await clickSidePanel(sidePanel, '#capture-button');

    await waitForValue(
      sidePanel,
      `document.querySelector('#batch-heading').textContent`,
      value => value !== '正在批量归档' && value !== '',
      20_000,
      '批量进入终态',
    );

    const heading = await elementText(sidePanel, '#batch-heading');
    // 零产出绝不能用成功语气。
    expect(heading).not.toContain('完成');
    expect(heading).toContain('没有找到');
    expect(await elementText(sidePanel, '#batch-collected')).toBe('0');
    const panelTone = await sidePanel.evaluate(
      () => document.querySelector<HTMLElement>('#batch-panel')?.dataset.tone,
    );
    expect(panelTone).toBe('warn');

    await sidePanel.screenshot({
      path: join(WORKSPACE, 'artifacts', 'screenshots', 'sidepanel-batch-empty.png'),
    });

    // 轮询跑好几轮（默认 700ms 一次），终态不得被悄悄换掉。
    await new Promise(resolveDelay => setTimeout(resolveDelay, 3_500));
    expect(await elementText(sidePanel, '#batch-heading')).toBe(heading);
    expect(await elementText(sidePanel, '#batch-collected')).toBe('0');
  });
});
