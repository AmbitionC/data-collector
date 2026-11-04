import { nowcoderOperationActionSchema, nowcoderOperationResultSchema, nowcoderOperationProgressSchema, sanitizeOperationError, type NowcoderOperationAction, type NowcoderOperationResult, type NowcoderOperationFailure } from '@data-collector/shared';

class OperationDeadlineError extends Error {
  constructor() { super('插件页面操作已到截止点，原页已保留，请核验原请求'); this.name = 'OperationDeadlineError'; }
}
function bounded<T>(promise: Promise<T>, milliseconds: number, error: Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error), Math.max(0, milliseconds));
    promise.then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
}
const bestEffort = (promise: Promise<unknown>) => bounded(promise, 3000, new Error('原页诊断或接手超时'));

interface OperationsTabs {
  create(url: string): Promise<{ id?: number }>;
  wait(id: number): Promise<void>;
  execute(id: number, action: NowcoderOperationAction, executionId: string, deadlineAt: number): Promise<unknown>;
  readProgress?(id: number, executionId: string): Promise<unknown>;
  close(id: number): Promise<unknown>;
  handoff(id: number, url: string): Promise<unknown>;
}

export class NowcoderOperationsRunner {
  busy = false;
  constructor(private readonly tabs: OperationsTabs) {}

  async run(raw: NowcoderOperationAction, dispatchedAt = Date.now()): Promise<NowcoderOperationResult> {
    const action = nowcoderOperationActionSchema.parse(raw);
    if (this.busy) return { kind: 'attention', code: 'OPERATIONS_BUSY', message: '另一个牛客页面操作正在执行', submission: 'not_attempted' };
    this.busy = true;
    let id: number | undefined, keep = false, executing = false;
    const executionId = crypto.randomUUID();
    // Finish checkpoint recovery before the Bridge's 90-second RPC deadline.
    // The same absolute deadline fences the injected page's final submit click.
    // The authenticated envelope timestamp includes worker/socket queue delay;
    // receiving an abandoned dispatch must never restart its sending budget.
    const deadlineAt = Math.min(dispatchedAt, Date.now()) + 60_000;
    let expired = false;
    const withinDeadline = <T>(start: () => Promise<T>) => {
      if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) { expired = true; throw new OperationDeadlineError(); }
      return bounded(start(), deadlineAt - Date.now(), new OperationDeadlineError())
        .catch(error => { if (error instanceof OperationDeadlineError) expired = true; throw error; });
    };
    let stage: NowcoderOperationFailure['stage'] = 'create_tab';
    try {
      await withinDeadline(() => this.tabs.create(action.url).then(tab => {
        id = tab.id;
        // A late tab creation never starts an abandoned script or loses its page.
        if (expired && id !== undefined) void bestEffort(this.tabs.handoff(id, action.url)).catch(() => undefined);
        return tab;
      }));
      if (id === undefined) throw new Error('No owned tab');
      stage = 'wait_tab'; await withinDeadline(() => this.tabs.wait(id!));
      stage = 'execute_script';
      const rawResult = await withinDeadline(() => {
        executing = true;
        return this.tabs.execute(id!, action, executionId, deadlineAt);
      });
      stage = 'parse_result';
      const result = nowcoderOperationResultSchema.parse(rawResult);
      if (result.kind === 'attention') {
        // Showing the tab is best effort; never erase an observed challenge or
        // close its page merely because focusing the window failed.
        keep = true;
        await bestEffort(this.tabs.handoff(id, action.url)).catch(() => undefined);
        return { ...result, ...(result.failure ? { failure: { ...result.failure, error: sanitizeOperationError(result.failure.error) } } : {}), tabUrl: action.url };
      }
      return result;
    } catch (error) {
      let checkpoint;
      if (id !== undefined && executing && this.tabs.readProgress) {
        try {
          const parsed = nowcoderOperationProgressSchema.safeParse(await bestEffort(this.tabs.readProgress(id, executionId)));
          if (parsed.success && parsed.data.executionId === executionId && parsed.data.url === action.url && parsed.data.actionKind === action.kind
            && (action.kind === 'publish' || !parsed.data.diagnostics.submitClickedAt)) checkpoint = parsed.data;
        } catch { /* Missing progress is unknown; it never authorizes another send. */ }
      }
      if (id !== undefined) { keep = true; await bestEffort(this.tabs.handoff(id, action.url)).catch(() => undefined); }
      const failure: NowcoderOperationFailure = { stage, executionId, occurredAt: new Date().toISOString(),
        ...(checkpoint ? { pageStage: checkpoint.pageStage } : {}),
        clickState: action.kind !== 'publish' || !executing ? 'not_attempted' : checkpoint?.diagnostics.submitClickedAt ? 'invoked' : 'unknown',
        error: sanitizeOperationError(error) };
      const verificationObserved = Boolean(checkpoint?.diagnostics.verificationObservedAt);
      return { kind: 'attention', code: verificationObserved ? 'VERIFICATION_REQUIRED' : error instanceof OperationDeadlineError ? 'OPERATION_DEADLINE_EXCEEDED' : 'EXTENSION_OPERATION_FAILED',
        message: verificationObserved ? '牛客要求验证，请在保留的页面完成验证' : error instanceof OperationDeadlineError ? '插件页面操作已到截止点，请核验保留的原页' : '插件页面操作中断，请核验保留的页面',
        submission: executing && action.kind === 'publish' ? 'uncertain' : 'not_attempted', failure,
        ...(checkpoint ? { diagnostics: checkpoint.diagnostics } : {}), ...(id !== undefined ? { tabUrl: action.url } : {}) };
    } finally {
      if (id !== undefined && !keep) await bestEffort(this.tabs.close(id)).catch(() => undefined);
      this.busy = false;
    }
  }
}
