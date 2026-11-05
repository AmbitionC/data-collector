import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTREACH_READY_CHANNELS, recheckOutreachPost, outreachPostSchema, type OutreachAction, type OutreachResult } from '@data-collector/shared';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
import { InvestOutreachService } from '../../packages/bridge/src/outreach/service.js';

const dirs = createTemporaryDirectoryTracker();
afterEach(() => dirs.cleanup());

const NOW = Date.parse('2026-11-06T12:40:00Z'); // 北京 20:40
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function post(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, id: '20261106-xueqiu-weekly', channel: 'xueqiu', kind: 'weekly', title: null, digest: null,
    body: '恐慌指数周报\n历史统计与公开规则读数，不是实盘成绩，不构成投资建议。\n本文由 AI 辅助生成，数据来自 Invest Journey 规则引擎。',
    bodyHtml: null, images: ['fear.png'], cover: 'fear.png', link: null,
    notBefore: '2026-11-06T20:00+08:00', notAfter: '2026-11-07T22:00+08:00', dataDate: '20261106',
    gate: { version: 1, passed: true, problems: [], checkedAt: '2026-11-06T20:31:00+08:00' },
    ...overrides,
  };
}

async function setup(posts: Record<string, unknown>[], execute?: (action: OutreachAction) => Promise<OutreachResult>,
  options: { available?: boolean; now?: () => number } = {}) {
  const repo = await dirs.create('outreach-repo-'), config = await dirs.create('outreach-config-');
  for (const p of posts) {
    const dir = join(repo, 'outreach', 'outbox', String(p.id));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'post.json'), JSON.stringify(p));
    for (const img of p.images as string[]) await writeFile(join(dir, img), PNG);
  }
  const git: string[][] = [], sent: OutreachAction[] = [];
  const service = new InvestOutreachService({
    configDir: config, repoPath: repo, readyChannels: ['xueqiu', 'wechat'],
    git: async (_repo, args) => { git.push(args); return { code: 0, stderr: '', stdout: '' }; },
    execute: async (action, _id) => { sent.push(action); return execute ? execute(action) : { kind: 'outreach-published', channel: 'xueqiu', id: (action as any).id, url: 'https://xueqiu.com/1/2', observedAt: new Date(NOW).toISOString() }; },
    available: () => options.available ?? true,
    now: options.now ?? (() => NOW),
  });
  const receipt = async (id: string) => JSON.parse(await readFile(join(repo, 'outreach', 'receipts', `${id}.json`), 'utf8'));
  return { service, repo, git, sent, receipt };
}

describe('引流稿件复核', () => {
  it('雪球稿件带链接或提公众号一律拒发', () => {
    const base = outreachPostSchema.parse(post());
    expect(recheckOutreachPost(base, 'outbox')).toEqual([]);
    expect(recheckOutreachPost({ ...base, body: `${base.body}\n详见 invest-journey.cn` }, 'outbox').join()).toContain('.cn');
    expect(recheckOutreachPost({ ...base, body: `${base.body}\n关注公众号` }, 'outbox').join()).toContain('公众号');
    expect(recheckOutreachPost({ ...base, body: base.body.replace('不构成投资建议', '') }, 'outbox').join()).toContain('不构成投资建议');
    expect(recheckOutreachPost({ ...base, body: `${base.body}\n510300` }, 'outbox').join()).toContain('6 位代码');
    expect(recheckOutreachPost({ ...base, gate: { ...base.gate, passed: false } }, 'outbox').join()).toContain('审核闸');
  });
  it('公众号链接必须是本站且带渠道参数', () => {
    const wx = outreachPostSchema.parse(post({ id: '20261106-wechat-weekly', channel: 'wechat', title: '周报', bodyHtml: '<p>x</p>',
      link: 'https://invest-journey.cn/?ch=wechat' }));
    expect(recheckOutreachPost(wx, 'outbox')).toEqual([]);
    expect(recheckOutreachPost({ ...wx, link: 'https://invest-journey.cn/' }, 'outbox').join()).toContain('链接');
    expect(recheckOutreachPost({ ...wx, bodyHtml: '<a href="https://evil.example/?ch=1">x</a>' }, 'outbox').join()).toContain('正文链接');
  });
  it('随版本发布的可发渠道清单默认为空：没核对过页面的渠道不发', () => {
    expect(OUTREACH_READY_CHANNELS).toEqual([]);
  });
});

describe('引流发布服务', () => {
  it('到期稿件发一次、写回执、只提交回执目录并推送；再跑不重发', async () => {
    const { service, git, sent, receipt } = await setup([post()]);
    expect((await service.tick()).outcome).toBe('published');
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect((await receipt('20261106-xueqiu-weekly')).status).toBe('published');
    expect(git.some(args => args[0] === 'commit' && args.includes('outreach/receipts'))).toBe(true);
    expect(git.some(args => args[0] === 'push')).toBe(true);
    expect((await service.tick()).outcome).toBe('idle');
    expect(sent).toHaveLength(1);
  });

  it('未到时间不发，过期写 expired 不发', async () => {
    const early = post({ id: '20261107-xueqiu-weekly', notBefore: '2026-11-07T20:00+08:00', notAfter: '2026-11-08T22:00+08:00' });
    const late = post({ id: '20261101-xueqiu-weekly', notBefore: '2026-11-01T20:00+08:00', notAfter: '2026-11-02T22:00+08:00' });
    const { service, sent, receipt, repo } = await setup([early, late]);
    await service.tick();
    expect(sent).toHaveLength(0);
    expect((await receipt('20261101-xueqiu-weekly')).status).toBe('expired');
    expect(await readdir(join(repo, 'outreach', 'receipts'))).toEqual(['20261101-xueqiu-weekly.json']);
  });

  it('复核不过写 refused，不发', async () => {
    const { service, sent, receipt } = await setup([post({ body: '没有声明的稿件 http://x.cn' })]);
    await service.tick();
    expect(sent).toHaveLength(0);
    expect((await receipt('20261106-xueqiu-weekly')).status).toBe('refused');
  });

  it('结果不确定：写 uncertain、整体暂停，后续稿件一律不发，恢复后也不重发原稿', async () => {
    let calls = 0;
    const second = post({ id: '20261106-wechat-weekly', channel: 'wechat', title: '周报', bodyHtml: '<p>x</p>', link: 'https://invest-journey.cn/?ch=wechat',
      notBefore: '2026-11-06T20:30+08:00' });
    const { service, sent, receipt } = await setup([post(), second], async () => {
      calls += 1;
      return { kind: 'attention', code: 'RECEIPT_NOT_OBSERVED', message: '点了发布但没看到内容', submission: 'uncertain' };
    });
    expect((await service.tick()).outcome).toBe('attention');
    expect((await receipt('20261106-xueqiu-weekly')).status).toBe('uncertain');
    expect((await service.tick()).outcome).toBe('paused');
    expect(calls).toBe(1);
    await service.resume();
    expect((await service.tick()).outcome).toBe('paused'); // 台账里仍有 uncertain，重新暂停
    expect(sent.map(a => (a as any).id)).toEqual(['20261106-xueqiu-weekly']);
  });

  it('掉登录/验证码：整体暂停、不写回执，恢复后同一稿件可再发', async () => {
    let barrier = true;
    const { service, sent, receipt } = await setup([post()], async action => barrier
      ? { kind: 'attention', code: 'LOGIN_REQUIRED', message: '雪球登录已失效', submission: 'not_attempted' }
      : { kind: 'outreach-published', channel: 'xueqiu', id: (action as any).id, url: null, observedAt: new Date(NOW).toISOString() });
    expect((await service.tick()).outcome).toBe('paused');
    await expect(receipt('20261106-xueqiu-weekly')).rejects.toThrow();
    expect((await service.tick()).outcome).toBe('paused');
    barrier = false;
    await service.resume();
    expect((await service.tick()).outcome).toBe('published');
    expect(sent).toHaveLength(2);
  });

  it('两次发布间隔不足时本轮只发一篇', async () => {
    const second = post({ id: '20261106-xueqiu-event', kind: 'event' });
    let now = NOW;
    const { service, sent } = await setup([post(), second], undefined, { now: () => now });
    expect((await service.tick()).outcome).toBe('published');
    expect(sent).toHaveLength(1);
    expect((await service.tick()).outcome).toBe('waiting');
    now += 121_000;
    expect((await service.tick()).outcome).toBe('published');
    expect(sent).toHaveLength(2);
  });

  it('插件没连上就等，不写任何回执', async () => {
    const { service, sent, repo } = await setup([post()], undefined, { available: false });
    expect((await service.tick()).outcome).toBe('waiting');
    expect(sent).toHaveLength(0);
    await expect(readdir(join(repo, 'outreach', 'receipts'))).rejects.toThrow();
  });
});
