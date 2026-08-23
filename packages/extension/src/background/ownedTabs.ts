import type { BrowserTab } from './jobs.js';

export const OWNED_TABS_STORAGE_KEY = 'dataCollectorOwnedTabs';

export type OwnedTabPurpose = 'remote-job' | 'zsxq-plan' | 'linked-article';

interface OwnedTab {
  id: number;
  url: string;
  purpose: OwnedTabPurpose;
  createdAt: number;
}

interface AttentionTab {
  id: number;
  url: string;
  handedOffAt: number;
}

interface OwnedTabsState {
  version: 1;
  owned: OwnedTab[];
  attention?: AttentionTab;
}

export interface OwnedTabsStorage {
  get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface RawTabs {
  remove(id: number): Promise<void>;
}

function emptyState(): OwnedTabsState {
  return { version: 1, owned: [] };
}

function validTab(value: unknown): value is OwnedTab {
  if (typeof value !== 'object' || value === null) return false;
  const tab = value as Partial<OwnedTab>;
  return Number.isInteger(tab.id) && typeof tab.url === 'string' &&
    (tab.purpose === 'remote-job' || tab.purpose === 'zsxq-plan' || tab.purpose === 'linked-article') &&
    typeof tab.createdAt === 'number';
}

function readAttention(value: unknown): AttentionTab | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const tab = value as Partial<AttentionTab>;
  return Number.isInteger(tab.id) && typeof tab.url === 'string' && typeof tab.handedOffAt === 'number'
    ? tab as AttentionTab
    : undefined;
}

function parseState(value: unknown): OwnedTabsState {
  if (typeof value !== 'object' || value === null) return emptyState();
  const input = value as { version?: unknown; owned?: unknown; attention?: unknown };
  if (input.version !== 1 || !Array.isArray(input.owned)) return emptyState();
  const attention = readAttention(input.attention);
  return {
    version: 1,
    owned: input.owned.filter(validTab),
    ...(attention ? { attention } : {}),
  };
}

/**
 * Tracks only tabs created by Data Collector. User tabs are never registered and therefore never closed.
 */
export class OwnedTabRegistry {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: OwnedTabsStorage,
    private readonly tabs: RawTabs,
    private readonly now: () => number = () => Date.now(),
  ) {}

  track(tab: BrowserTab, purpose: OwnedTabPurpose): Promise<void> {
    if (tab.id === undefined || !tab.url) return Promise.resolve();
    return this.mutate(async state => {
      state.owned = state.owned.filter(item => item.id !== tab.id);
      state.owned.push({ id: tab.id!, url: tab.url!, purpose, createdAt: this.now() });
    });
  }

  async close(tabId: number): Promise<void> {
    await this.tabs.remove(tabId).catch(() => undefined);
    await this.mutate(async state => {
      state.owned = state.owned.filter(item => item.id !== tabId);
      if (state.attention?.id === tabId) delete state.attention;
    });
  }

  handoff(tabId: number, url: string): Promise<void> {
    return this.mutate(async state => {
      const previous = state.attention;
      if (previous && previous.id !== tabId) {
        await this.tabs.remove(previous.id).catch(() => undefined);
      }
      state.owned = state.owned.filter(item => item.id !== tabId);
      state.attention = { id: tabId, url, handedOffAt: this.now() };
    });
  }

  cleanupStale(): Promise<void> {
    return this.mutate(async state => {
      const stale = [...state.owned].sort((left, right) => left.id - right.id);
      for (const tab of stale) await this.tabs.remove(tab.id).catch(() => undefined);
      state.owned = [];
    });
  }

  private mutate(operation: (state: OwnedTabsState) => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(async () => {
      const values = await this.storage.get([OWNED_TABS_STORAGE_KEY]);
      const state = parseState(values[OWNED_TABS_STORAGE_KEY]);
      await operation(state);
      await this.storage.set({ [OWNED_TABS_STORAGE_KEY]: state });
    });
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
