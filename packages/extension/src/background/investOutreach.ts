import { outreachActionSchema, outreachResultSchema, type OutreachAction, type OutreachChannel, type OutreachResult } from '@data-collector/shared';

/** 各渠道发布入口。页面操作只在插件自己开的标签页里做，不碰用户的页面。 */
export const OUTREACH_ENTRY_URLS: Record<OutreachChannel, string> = {
  wechat: 'https://mp.weixin.qq.com/',
  xueqiu: 'https://xueqiu.com/',
};

interface OutreachTabs {
  create(url: string): Promise<{ id?: number }>;
  wait(id: number): Promise<void>;
  execute(id: number, action: OutreachAction): Promise<unknown>;
  close(id: number): Promise<unknown>;
  handoff(id: number, url: string): Promise<unknown>;
  get?(id: number): Promise<{ url?: string }>;
}

export class InvestOutreachRunner {
  private running = false;
  get busy(): boolean { return this.running; }
  constructor(private readonly tabs: OutreachTabs) {}

  async run(raw: OutreachAction): Promise<OutreachResult> {
    const action = outreachActionSchema.parse(raw);
    const publish = action.kind === 'outreach-publish';
    if (this.running) return { kind: 'attention', code: 'OUTREACH_BUSY', message: '另一个引流发布正在执行', submission: 'not_attempted' };
    this.running = true;
    let id: number | undefined, keep = false;
    try {
      const created = await this.tabs.create(OUTREACH_ENTRY_URLS[action.channel]);
      id = created.id;
      if (id === undefined) return { kind: 'attention', code: 'TAB_FAILED', message: '无法打开发布页面', submission: 'not_attempted' };
      await Promise.race([this.tabs.wait(id), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('页面加载超时')), 20_000))]);
      const parsed = outreachResultSchema.safeParse(await this.tabs.execute(id, action));
      const result: OutreachResult = parsed.success ? parsed.data
        : { kind: 'attention', code: 'PAGE_RESULT_INVALID', message: '发布页面回执无效', submission: publish ? 'uncertain' : 'not_attempted' };
      if (result.kind === 'attention') {
        // 登录 / 验证 / 不确定：保留页面交给用户，不关闭。
        keep = true;
        const url = (await this.tabs.get?.(id).catch(() => undefined))?.url ?? OUTREACH_ENTRY_URLS[action.channel];
        await this.tabs.handoff(id, url).catch(() => undefined);
        return { ...result, tabUrl: url };
      }
      return result;
    } catch (error) {
      if (id !== undefined) { keep = true; await this.tabs.handoff(id, OUTREACH_ENTRY_URLS[action.channel]).catch(() => undefined); }
      return { kind: 'attention', code: 'OUTREACH_PAGE_FAILED', message: (error as Error).message.slice(0, 500) || '发布页面操作失败',
        submission: publish ? 'uncertain' : 'not_attempted' };
    } finally {
      if (id !== undefined && !keep) await this.tabs.close(id).catch(() => undefined);
      this.running = false;
    }
  }
}
