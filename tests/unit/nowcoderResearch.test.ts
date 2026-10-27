import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPrivateNowcoderResearch } from '../../packages/bridge/src/nowcoderResearch.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());
const NOW = '2026-10-28T01:00:00.000Z';
const URL = 'https://www.nowcoder.com/discuss/1001';

async function fixture() {
  const root = await temporaryDirectories.create('nowcoder-private-research-');
  const libraryRoot = join(root, 'library');
  const article = join(libraryRoot, 'article');
  await mkdir(article, { recursive: true });
  await writeFile(join(article, 'index.md'), '真实讨论正文');
  await writeFile(join(article, 'source.json'), JSON.stringify({ document: {
    schemaVersion: 1, source: 'nowcoder', kind: 'post', url: URL, canonicalUrl: URL,
    title: '面试准备求助', text: '项目做出来了，但不知道该如何讲清楚自己的设计选择。',
    html: '<p>项目做出来了，但不知道该如何讲清楚自己的设计选择。</p>',
    images: [], publishedAt: '2026-10-27T00:00:00.000Z', collectedAt: NOW,
  } }));
  return { root, libraryRoot, article };
}
async function bindJob(article: string, jobId: string) {
  const path = join(article, 'source.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.document.sourceMetadata = { collectionJobId: jobId };
  await writeFile(path, JSON.stringify(stored));
}

describe('private research collection', () => {
  it('freezes dated samples, captures only to the local sink, and replays a key without submitting jobs', async () => {
    const { root, libraryRoot, article } = await fixture();
    const calls: Array<{ url: string; body?: any }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = String(input), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/health')) return Response.json({ ok: true, extensionConnected: true, directedRunActive: false,
        version: '0.4.50', extensionVersion: '0.4.50', buildId: 'build', extensionBuildId: 'build', extensionCapabilities: ['nowcoder-detail-v1'] });
      if (url.includes('/api/sparta/pc/search')) return Response.json({ success: true, code: 0, data: { totalPage: 1, records: [
        { contentData: { url: URL, title: '面试准备求助', content: '项目追问', createTime: Date.parse('2026-10-27T00:00:00Z') } },
        { contentData: { url: 'https://www.nowcoder.com/discuss/1002', title: '过期材料', createTime: Date.parse('2026-09-01T00:00:00Z') } },
        { contentData: { url: 'https://www.nowcoder.com/discuss/1003', title: '未来时间', createTime: Date.parse('2026-11-01T00:00:00Z') } },
      ] } });
      if (url.endsWith('/v1/jobs') && init.method === 'POST') { await bindJob(article, body.id); return Response.json({ id: body.id, url: body.url, status: 'queued' }); }
      if (url.includes('/v1/jobs/')) return Response.json({ id: decodeURIComponent(url.split('/').at(-1)!), url: URL, status: 'saved', outputPath: join(article, 'index.md') });
      throw new Error('Unexpected request');
    };
    const dependencies = { fetch: fetcher, baseUrl: 'http://127.0.0.1:17321', token: 'test-secret',
      libraryRoot, runsRoot: join(root, 'research'), now: () => new Date(NOW), sleep: async () => {} };
    const spec = { queries: ['面试'], complaintQueries: [], latestTarget: 1, complaintTarget: 0,
      days: 7, idempotencyKey: 'exact-key', waitMs: 1000 };
    const run = await runPrivateNowcoderResearch(spec, dependencies);
    expect(run.status).toBe('completed');
    expect(run.items).toHaveLength(1);
    expect(run.items[0]).toMatchObject({ canonicalUrl: URL, status: 'saved', stratum: 'latest' });
    expect(calls.find(call => call.url.endsWith('/v1/jobs'))?.body).toMatchObject({ url: URL, sinks: ['markdown'], requestedBy: 'cli' });
    expect(calls.filter(call => /sync|deliver|search-sessions|plans/.test(call.url))).toEqual([]);
    expect(await readFile(run.items[0]!.snapshotPath!, 'utf8')).toContain('项目做出来了');
    const before = calls.length;
    expect((await runPrivateNowcoderResearch(spec, dependencies)).status).toBe('completed');
    expect(calls).toHaveLength(before);
  });

  it('preserves a needs-attention result and never collects another frozen candidate after an access blocker', async () => {
    const { root, libraryRoot } = await fixture();
    let submissions = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true, extensionConnected: true, directedRunActive: false,
        version: '0.4.50', extensionVersion: '0.4.50', buildId: 'build', extensionBuildId: 'build', extensionCapabilities: ['nowcoder-detail-v1'] });
      if (url.includes('/api/sparta/pc/search')) return Response.json({ success: true, code: 0, data: { totalPage: 1, records: [1001, 1002].map(id => ({contentData: {url: `https://www.nowcoder.com/discuss/${id}`, createTime: Date.parse('2026-10-27T00:00:00Z')}})) } });
      if (init.method === 'POST') { submissions++; return Response.json({ id: JSON.parse(String(init.body)).id }); }
      return Response.json({ status: 'needs_attention', url: URL, errorCode: 'AUTH_REQUIRED', errorMessage: '请先登录' });
    };
    const run = await runPrivateNowcoderResearch({ queries: ['面试'], complaintQueries: [], latestTarget: 2,
      complaintTarget: 0, days: 7, idempotencyKey: 'blocked-key', waitMs: 1000 }, {
      fetch: fetcher, baseUrl: 'http://127.0.0.1:17321', token: 'test-secret', libraryRoot,
      runsRoot: join(root, 'research'), now: () => new Date(NOW), sleep: async () => {},
    });
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('AUTH_REQUIRED');
    expect(submissions).toBe(1);
    expect(JSON.parse(await readFile(run.manifestPath, 'utf8')).status).toBe('failed');
  });

  it('rejects a returned document from another source URL without counting it as evidence', async () => {
    const { root, libraryRoot, article } = await fixture();
    const stored = JSON.parse(await readFile(join(article, 'source.json'), 'utf8'));
    stored.document.canonicalUrl = 'https://www.nowcoder.com/discuss/9999';
    await writeFile(join(article, 'source.json'), JSON.stringify(stored));
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true, extensionConnected: true, directedRunActive: false,
        version: '0.4.50', extensionVersion: '0.4.50', buildId: 'build', extensionBuildId: 'build', extensionCapabilities: ['nowcoder-detail-v1'] });
      if (url.includes('/api/sparta/pc/search')) return Response.json({success:true,code:0,data:{totalPage:1,records:[{contentData:{url:URL,createTime:Date.parse('2026-10-27T00:00:00Z')}}]}});
      if (init.method === 'POST') { const id=JSON.parse(String(init.body)).id; await bindJob(article,id); return Response.json({id}); }
      return Response.json({status:'saved',url:URL,outputPath:join(article,'index.md')});
    };
    const run = await runPrivateNowcoderResearch({queries:['面试'],complaintQueries:[],latestTarget:1,complaintTarget:0,days:7,idempotencyKey:'wrong-source',waitMs:1000},
      {fetch:fetcher,baseUrl:'http://127.0.0.1:17321',token:'test-secret',libraryRoot,runsRoot:join(root,'research'),now:()=>new Date(NOW),sleep:async()=>{}});
    expect(run.status).toBe('failed');
    expect(run.items.filter(item=>item.status==='saved')).toHaveLength(0);
    expect(run.error?.code).toBe('RESEARCH_SOURCE_MISMATCH');
  });

  it.each([
    ['old-publication', {publishedAt:'2020-01-01T00:00:00.000Z'}, 'RESEARCH_DATE_OUTSIDE_WINDOW'],
    ['future-publication', {publishedAt:'2030-01-01T00:00:00.000Z'}, 'RESEARCH_DATE_OUTSIDE_WINDOW'],
    ['stale-capture', {collectedAt:'2020-01-01T00:00:00.000Z'}, 'RESEARCH_STALE_DOCUMENT'],
    ['truncated-capture', {truncated:true}, 'RESEARCH_TARGET_UNAVAILABLE'],
    ['wrong-lineage', {sourceMetadata:{collectionJobId:'another-job'}}, 'RESEARCH_LINEAGE_MISMATCH'],
  ])('does not count %s as current complete evidence', async (key, changed, expected) => {
    const {root, libraryRoot, article}=await fixture();
    const source=JSON.parse(await readFile(join(article,'source.json'),'utf8'));
    Object.assign(source.document,changed);
    await writeFile(join(article,'source.json'),JSON.stringify(source));
    const fetcher:typeof fetch=async(input,init={})=>{
      const url=String(input);
      if(url.endsWith('/health'))return Response.json({ok:true,extensionConnected:true,directedRunActive:false,version:'x',extensionVersion:'x',buildId:'x',extensionBuildId:'x',extensionCapabilities:['nowcoder-detail-v1']});
      if(url.includes('/api/sparta/pc/search'))return Response.json({success:true,code:0,data:{totalPage:1,records:[{contentData:{url:URL,createTime:Date.parse('2026-10-27T00:00:00Z')}}]}});
      if(init.method==='POST'){const id=JSON.parse(String(init.body)).id;if(key!=='wrong-lineage')await bindJob(article,id);return Response.json({id});}
      return Response.json({status:'saved',url:URL,outputPath:join(article,'index.md')});
    };
    const run=await runPrivateNowcoderResearch({queries:['面试'],complaintQueries:[],latestTarget:1,complaintTarget:0,days:7,idempotencyKey:key,waitMs:1000},
      {fetch:fetcher,baseUrl:'http://127.0.0.1:17321',token:'test-secret',libraryRoot,runsRoot:join(root,'research'),now:()=>new Date(NOW),sleep:async()=>{}});
    expect(run.status).toBe('failed');expect(run.counts.saved).toBe(0);
    if(key==='truncated-capture')expect(run.counts.excluded).toBe(1);else expect(run.counts.failed).toBe(1);
    expect(run.error?.code).toBe(expected);
  });

  it('accepts a separately typed public hot-list observation without pretending it is a plugin export',async()=>{
    const {root,libraryRoot,article}=await fixture();
    const observation=join(root,'public-hot.json');
    const raw=JSON.stringify({schemaVersion:1,type:'nowcoder-public-hot-observation',visibility:'private',observer:'browser-visible-dom',
      listUrl:'https://www.nowcoder.com/',listTitle:'全站热榜',observedAt:NOW,scope:'首页可见一条',items:[{canonicalUrl:URL,title:'公开热帖',metrics:{heat:'123',likes:null,comments:null,views:null}}]});
    await writeFile(observation,raw);
    const fetcher:typeof fetch=async(input,init={})=>{
      const url=String(input);
      if(url.endsWith('/health'))return Response.json({ok:true,extensionConnected:true,directedRunActive:false,version:'x',extensionVersion:'x',buildId:'x',extensionBuildId:'x',extensionCapabilities:['nowcoder-detail-v1']});
      if(init.method==='POST'){const id=JSON.parse(String(init.body)).id;await bindJob(article,id);return Response.json({id});}
      if(url.includes('/v1/jobs/'))return Response.json({status:'saved',url:URL,outputPath:join(article,'index.md')});
      throw Error('public observations must not trigger another discovery');
    };
    const run=await runPrivateNowcoderResearch({queries:[],complaintQueries:[],latestTarget:0,complaintTarget:0,days:7,idempotencyKey:'public-hot-key',waitMs:1000,hotObservationPath:observation} as any,
      {fetch:fetcher,baseUrl:'http://127.0.0.1:17321',token:'test-secret',libraryRoot,runsRoot:join(root,'research'),now:()=>new Date(NOW),sleep:async()=>{}});
    expect(run.status).toBe('completed');expect(run.items[0]?.stratum).toBe('hot');
    expect(await readFile(join(run.manifestPath,'..','hot-input.original.json'),'utf8')).toBe(raw);
  });

  it('excludes an incomplete preview and fills the quota only from this run frozen dated candidates',async()=>{
    const {root,libraryRoot,article}=await fixture();let activeUrl=URL;
    const second='https://www.nowcoder.com/discuss/1002';
    const fetcher:typeof fetch=async(input,init={})=>{
      const url=String(input);
      if(url.endsWith('/health'))return Response.json({ok:true,extensionConnected:true,directedRunActive:false,version:'x',extensionVersion:'x',buildId:'x',extensionBuildId:'x',extensionCapabilities:['nowcoder-detail-v1']});
      if(url.includes('/api/sparta/pc/search'))return Response.json({success:true,code:0,data:{totalPage:1,records:[URL,second].map((u,i)=>({contentData:{url:u,title:i?'公开项目求助':'资料专栏',createTime:Date.parse('2026-10-27T00:00:00Z')}}))}});
      if(init.method==='POST'){
        const body=JSON.parse(String(init.body));activeUrl=body.url;
        const stored=JSON.parse(await readFile(join(article,'source.json'),'utf8'));
        Object.assign(stored.document,{url:activeUrl,canonicalUrl:activeUrl,truncated:activeUrl===URL,sourceMetadata:{collectionJobId:body.id}});
        await writeFile(join(article,'source.json'),JSON.stringify(stored));return Response.json({id:body.id});
      }
      return Response.json({status:'saved',url:activeUrl,outputPath:join(article,'index.md')});
    };
    const run=await runPrivateNowcoderResearch({queries:['项目'],complaintQueries:[],latestTarget:1,complaintTarget:0,days:7,idempotencyKey:'refill-frozen-key',waitMs:1000},
      {fetch:fetcher,baseUrl:'http://127.0.0.1:17321',token:'test-secret',libraryRoot,runsRoot:join(root,'research'),now:()=>new Date(NOW),sleep:async()=>{}});
    expect(run.status).toBe('completed');expect(run.counts).toMatchObject({saved:1,excluded:1,failed:0});
    expect(run.items.map(i=>[i.canonicalUrl,i.status])).toEqual([[URL,'excluded'],[second,'saved']]);
    expect(JSON.parse(await readFile(run.items[0]!.snapshotPath!,'utf8')).document.truncated).toBe(true);
    expect(JSON.parse(await readFile(join(run.manifestPath,'..','frozen-candidates.json'),'utf8')).latest).toHaveLength(2);
  });

  it('does not mistake a provider substring hit or an interview compilation for a complaint',async()=>{
    const {root,libraryRoot,article}=await fixture();const second='https://www.nowcoder.com/discuss/1002';let activeUrl=URL;
    const fetcher:typeof fetch=async(input,init={})=>{
      const url=String(input);
      if(url.endsWith('/health'))return Response.json({ok:true,extensionConnected:true,directedRunActive:false,version:'x',extensionVersion:'x',buildId:'x',extensionBuildId:'x',extensionCapabilities:['nowcoder-detail-v1']});
      if(url.includes('/api/sparta/pc/search'))return Response.json({success:true,code:0,data:{totalPage:1,records:[
        {contentData:{url:URL,title:'快手面经 快手测试开发岗面经-01',content:'这个工具有没有用，异常Offer如何处理',createTime:Date.parse('2026-10-27T00:00:00Z')}},
        {contentData:{url:second,title:'投了50份简历还是没有offer',content:'一面都没有，想求建议',createTime:Date.parse('2026-10-27T00:00:00Z')}},
      ]}});
      if(init.method==='POST'){const body=JSON.parse(String(init.body));activeUrl=body.url;const s=JSON.parse(await readFile(join(article,'source.json'),'utf8'));Object.assign(s.document,{url:activeUrl,canonicalUrl:activeUrl,sourceMetadata:{collectionJobId:body.id}});await writeFile(join(article,'source.json'),JSON.stringify(s));return Response.json({id:body.id});}
      return Response.json({status:'saved',url:activeUrl,outputPath:join(article,'index.md')});
    };
    const run=await runPrivateNowcoderResearch({queries:[],complaintQueries:['没有offer'],latestTarget:0,complaintTarget:1,days:7,idempotencyKey:'complaint-relevance-key',waitMs:1000},
      {fetch:fetcher,baseUrl:'http://127.0.0.1:17321',token:'test-secret',libraryRoot,runsRoot:join(root,'research'),now:()=>new Date(NOW),sleep:async()=>{}});
    expect(run.status).toBe('completed');expect(run.items[0]?.canonicalUrl).toBe(second);
  });

  it.each([
    ['React demo 项目展示', false], ['给秋招同学三条建议', false],
    ['分享面试建议', false], ['demo', false],
    ['求建议', true], ['给点建议', true], ['给我点建议', true], ['最近很emo', true],
  ])('uses explicit difficulty/request signals for %s', async (title, eligible) => {
    const {root,libraryRoot,article}=await fixture();
    const second='https://www.nowcoder.com/discuss/1002';let activeUrl=URL;
    const fetcher:typeof fetch=async(input,init={})=>{
      const url=String(input);
      if(url.endsWith('/health'))return Response.json({ok:true,extensionConnected:true,directedRunActive:false,version:'x',extensionVersion:'x',buildId:'x',extensionBuildId:'x',extensionCapabilities:['nowcoder-detail-v1']});
      if(url.includes('/api/sparta/pc/search'))return Response.json({success:true,code:0,data:{totalPage:1,records:[
        {contentData:{url:URL,title,createTime:Date.parse('2026-10-27T00:00:00Z')}},
        {contentData:{url:second,title:'投递求助',createTime:Date.parse('2026-10-27T00:00:00Z')}},
      ]}});
      if(init.method==='POST'){const body=JSON.parse(String(init.body));activeUrl=body.url;const stored=JSON.parse(await readFile(join(article,'source.json'),'utf8'));Object.assign(stored.document,{url:activeUrl,canonicalUrl:activeUrl,sourceMetadata:{collectionJobId:body.id}});await writeFile(join(article,'source.json'),JSON.stringify(stored));return Response.json({id:body.id});}
      return Response.json({status:'saved',url:activeUrl,outputPath:join(article,'index.md')});
    };
    const run=await runPrivateNowcoderResearch({queries:[],complaintQueries:['求助'],latestTarget:0,complaintTarget:1,days:7,idempotencyKey:'explicit-signal-key',waitMs:1000},
      {fetch:fetcher,baseUrl:'http://127.0.0.1:17321',token:'test-secret',libraryRoot,runsRoot:join(root,'research'),now:()=>new Date(NOW),sleep:async()=>{}});
    expect(run.status).toBe('completed');
    expect(run.items[0]?.canonicalUrl).toBe(eligible?URL:second);
  });

  it.each(['before-next', 'after-pacing'])('does not dispatch after the deadline %s', async boundary => {
    const {root,libraryRoot,article}=await fixture();let wall=0;let submissions=0;
    const clock=vi.spyOn(Date,'now').mockImplementation(()=>wall);
    const fetcher:typeof fetch=async(input,init={})=>{
      const url=String(input);
      if(url.endsWith('/health'))return Response.json({ok:true,extensionConnected:true,directedRunActive:false,version:'x',extensionVersion:'x',buildId:'x',extensionBuildId:'x',extensionCapabilities:['nowcoder-detail-v1']});
      if(url.includes('/api/sparta/pc/search'))return Response.json({success:true,code:0,data:{totalPage:1,records:[1001,1002].map(id=>({contentData:{url:`https://www.nowcoder.com/discuss/${id}`,createTime:Date.parse('2026-10-27T00:00:00Z')}}))}});
      if(init.method==='POST'){submissions++;const body=JSON.parse(String(init.body));await bindJob(article,body.id);return Response.json({id:body.id});}
      if(boundary==='before-next')wall=1000;
      return Response.json({status:'saved',url:URL,outputPath:join(article,'index.md')});
    };
    try {
      const run=await runPrivateNowcoderResearch({queries:['面试'],complaintQueries:[],latestTarget:2,complaintTarget:0,days:7,idempotencyKey:'deadline-guard-key',waitMs:1000},
        {fetch:fetcher,baseUrl:'http://127.0.0.1:17321',token:'test-secret',libraryRoot,runsRoot:join(root,'research'),now:()=>new Date(NOW),sleep:async ms=>{wall+=ms;}});
      expect(run.status).toBe('failed');
      expect(run.error?.code).toBe('RESEARCH_JOB_TIMEOUT');
      expect(submissions).toBe(1);
    } finally {clock.mockRestore();}
  });
});
