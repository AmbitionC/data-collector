#!/usr/bin/env node
// Reader acceptance without any browser: checks the same public sources the site reads,
// the catalog API and the published content file, plus that the page itself responds.
// Usage: verify-reader.mjs interview:baidu-ai-14=<text from the article> [knowledge:key=<text>] ...
const API = 'https://fe-journey-main-ktantdfjcs.cn-hangzhou.fcapp.run/article/navList';
const CONTENT = 'https://font-end-journey-resources.oss-cn-hangzhou.aliyuncs.com';
const items = process.argv.slice(2).map(arg => { const [, module, key, text] = /^(interview|knowledge):([^=]+)=(.+)$/su.exec(arg) ?? []; if (!text) throw new Error(`参数格式错误：${arg}`); return { module, key, text }; });
if (!items.length) throw new Error('用法：verify-reader.mjs interview:key=正文片段 ...');
const get = async url => { const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }); if (!response.ok) throw new Error(`${response.status} ${url}`); return response.text(); };
const find = (nodes, key) => { for (const node of nodes) { if (node.key === key && node.isLeaf) return node; const hit = find(node.children ?? [], key); if (hit) return hit; } return undefined; };
const squash = value => value.replace(/\s+/gu, '');
const catalogs = new Map(), results = [];
for (const { module, key, text } of items) {
  try {
    if (!catalogs.has(module)) catalogs.set(module, JSON.parse(await get(`${API}?module=${module}`)).data.navData);
    const leaf = find(catalogs.get(module), key);
    if (!leaf) throw new Error('目录里没有这篇');
    const page = `https://www.agent-journey.cn/${module}?activeKey=${encodeURIComponent(key)}`;
    await get(page);
    if (!squash(await get(`${CONTENT}/${module}/${leaf.filePath}/${key}.md`)).includes(squash(text))) throw new Error('内容文件里没有这段正文');
    results.push({ module, key, ok: true, page });
  } catch (error) { results.push({ module, key, ok: false, reason: error instanceof Error ? error.message : 'unknown' }); }
}
const ok = results.every(result => result.ok);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ok, scope: 'catalog, content file and page response; not a visual render check', results }));
process.exit(ok ? 0 : 1);
