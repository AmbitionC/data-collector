import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
const io = { stdout: vi.fn(), stderr: vi.fn() };
async function cli() {
  const module = await import('../../packages/bridge/src/articles/cli.js').catch(() => undefined);
  expect(module, 'article CLI exists').toBeDefined(); return module!.runArticlesCli;
}
it('refuses missing send, account, revision, invalid keys and unknown flags before HTTP', async () => {
  const run = await cli(), http = vi.fn(); vi.stubGlobal('fetch', http);
  const valid = ['nowcoder', 'articles', 'publish', '--id', 'article-abcdef123456', '--revision', '1', '--key', 'article-cli-key-001', '--browser', 'chrome', '--account', '544222414', '--send'];
  for (const args of [valid.filter(x => x !== '--send'), valid.slice(0, 12), valid.map(x => x === 'article-cli-key-001' ? 'bad' : x), [...valid, '--unknown', '1']]) {
    await expect(run(args, { baseUrl: 'http://127.0.0.1:12345', token: 'test' }, io)).rejects.toThrow();
  }
  expect(http).not.toHaveBeenCalled();
});
it('fetches the saved content hash and sends the bound publish request once', async () => {
  const run = await cli(), http = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ entry: { contentHash: 'a'.repeat(64) } }))).mockResolvedValueOnce(new Response(JSON.stringify({ publication: { state: 'published' }, receipt: { url: 'https://www.nowcoder.com/discuss/12345' } })));
  vi.stubGlobal('fetch', http);
  expect(await run(['nowcoder', 'articles', 'publish', '--id', 'article-abcdef123456', '--revision', '1', '--key', 'article-cli-key-001', '--browser', 'chrome', '--account', '544222414', '--send'], { baseUrl: 'http://127.0.0.1:12345', token: 'test' }, io)).toBe(0);
  expect(http).toHaveBeenCalledTimes(2);
  expect(JSON.parse(http.mock.calls[1]![1].body)).toMatchObject({ accountId: '544222414', browser: 'chrome', send: true, contentHash: 'a'.repeat(64) });
});
it('returns a nonzero status for uncertain publication without retrying', async () => {
  const run = await cli(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ publication: { state: 'uncertain' } }))));
  expect(await run(['nowcoder', 'articles', 'verify', '--id', 'article-abcdef123456', '--key', 'article-cli-key-001'], { baseUrl: 'http://127.0.0.1:12345', token: 'test' }, io)).toBe(1);
});
