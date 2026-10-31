import { nowcoderOperationActionSchema, nowcoderOperationResultSchema, type NowcoderOperationAction, type NowcoderOperationResult } from '@data-collector/shared';

interface OperationsTabs {
  create(url: string): Promise<{ id?: number }>;
  wait(id: number): Promise<void>;
  execute(id: number, action: NowcoderOperationAction): Promise<unknown>;
  close(id: number): Promise<unknown>;
  handoff(id: number, url: string): Promise<unknown>;
}

export class NowcoderOperationsRunner {
  busy = false;
  constructor(private readonly tabs: OperationsTabs) {}

  async run(raw: NowcoderOperationAction): Promise<NowcoderOperationResult> {
    const action = nowcoderOperationActionSchema.parse(raw);
    if (this.busy) return { kind: 'attention', code: 'OPERATIONS_BUSY', message: '另一个牛客页面操作正在执行', submission: 'not_attempted' };
    this.busy = true;
    let id: number | undefined, keep = false, executing = false;
    try {
      id = (await this.tabs.create(action.url)).id;
      if (id === undefined) throw new Error('No owned tab');
      await this.tabs.wait(id);
      executing = true;
      const result = nowcoderOperationResultSchema.parse(await this.tabs.execute(id, action));
      if (result.kind === 'attention') {
        // Showing the tab is best effort; never erase an observed challenge or
        // close its page merely because focusing the window failed.
        keep = true;
        await this.tabs.handoff(id, action.url).catch(() => undefined);
        return { ...result, tabUrl: action.url };
      }
      return result;
    } catch {
      if (id !== undefined) { await this.tabs.handoff(id, action.url).then(() => { keep = true; }).catch(() => undefined); }
      return { kind: 'attention', code: 'EXTENSION_OPERATION_FAILED', message: '插件页面操作中断，请核验保留的页面',
        submission: executing && action.kind === 'publish' ? 'uncertain' : 'not_attempted', ...(id !== undefined ? { tabUrl: action.url } : {}) };
    } finally {
      if (id !== undefined && !keep) await this.tabs.close(id).catch(() => undefined);
      this.busy = false;
    }
  }
}
