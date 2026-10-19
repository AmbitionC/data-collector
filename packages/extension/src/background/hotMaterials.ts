import { collectedDocumentSchema, hotMaterialId, hotSelectionsSchema, renderHotMaterial, type CollectedDocument, type HotSelection } from '@data-collector/shared';

export interface HotRow { id: string; document: CollectedDocument; alreadySaved: boolean }
export interface HotPreview { token: string; rows: HotRow[]; capped: boolean }
export interface HotSaveResult { saved: number; skipped: number; failed: number; items: { id: string; status: 'saved' | 'skipped' | 'failed'; message: string }[] }
export interface HotDependencies {
  storage: { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
  readList(): Promise<{ documents: CollectedDocument[]; capped: boolean }>;
  library(): Promise<{ id: string; materialKind?: string; url: string }[]>;
  save(document: CollectedDocument): Promise<'ok' | 'failed' | 'bridge-down'>;
}

export class HotMaterialSession {
  private busy = false;
  get processing(): boolean { return this.busy; }
  constructor(private readonly dependencies: HotDependencies) {}
  async preview(): Promise<HotPreview> {
    if (this.busy) throw new Error('正在处理热帖素材，请等待本轮结束');
    this.busy = true;
    try {
      const list = await this.dependencies.readList();
      const known = await this.known();
      const rows = new Map<string, HotRow>();
      for (const input of list.documents.slice(0, 60)) {
        const document = collectedDocumentSchema.parse(input) as CollectedDocument;
        if (!document.operationMaterial) throw new Error('页面未返回当前版本热帖素材，请重新读取预览');
        const id = hotMaterialId(document.canonicalUrl);
        rows.set(id, { id, document, alreadySaved: known.has(id) });
      }
      const preview: HotPreview = { token: crypto.randomUUID(), rows: [...rows.values()], capped: list.capped };
      await this.dependencies.storage.set({ hotPreview: preview });
      return preview;
    } finally { this.busy = false; }
  }
  private async known(): Promise<Set<string>> {
    return new Set((await this.dependencies.library()).filter(entry => entry.materialKind === 'nowcoder-hot' || entry.id.startsWith('hot-')).map(entry => entry.id));
  }
  async save(token: string, selections: HotSelection[]): Promise<HotSaveResult> {
    if (this.busy) throw new Error('正在处理热帖素材，请等待本轮结束');
    this.busy = true;
    try {
      const parsed = hotSelectionsSchema.parse(selections);
      if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new Error('勾选条目重复');
      const snapshot = (await this.dependencies.storage.get(['hotPreview'])).hotPreview as HotPreview | undefined;
      if (!snapshot || snapshot.token !== token) throw new Error('预览已失效，请重新读取当前列表');
      const rows = new Map(snapshot.rows.map(row => [row.id, row]));
      if (parsed.some(item => !rows.has(item.id))) throw new Error('勾选内容不在本轮预览中，请重新读取');
      const known = await this.known();
      const items: HotSaveResult['items'] = [];
      for (const selection of parsed) {
        const row = rows.get(selection.id)!;
        if (row.alreadySaved || known.has(row.id)) {
          items.push({ id: row.id, status: 'skipped', message: '已在私有素材库' }); continue;
        }
        const original = collectedDocumentSchema.parse(row.document) as CollectedDocument;
        if (!original.operationMaterial) throw new Error('预览缺少素材元信息，请重新读取');
        const material = { ...original.operationMaterial,
          editorial: { emotionTags: selection.emotionTags, inspirationNote: selection.inspirationNote },
          evidence: { ...original.operationMaterial.evidence, attribution: selection.attribution } };
        const edited = { ...original, operationMaterial: material, html: renderHotMaterial(material) };
        let outcome: 'ok' | 'failed' | 'bridge-down';
        try { outcome = await this.dependencies.save(edited); } catch { outcome = 'failed'; }
        if (outcome === 'ok') {
          row.alreadySaved = true;
          row.document = edited;
          known.add(row.id);
          await this.dependencies.storage.set({ hotPreview: snapshot });
        }
        items.push({ id: row.id, status: outcome === 'ok' ? 'saved' : 'failed',
          message: outcome === 'ok' ? '已保存至私有热帖素材' : outcome === 'bridge-down' ? '本机服务连接中断；重试会跳过已保存条目' : '未收到保存成功回执，可重试' });
      }
      return { items, saved: items.filter(item => item.status === 'saved').length,
        skipped: items.filter(item => item.status === 'skipped').length, failed: items.filter(item => item.status === 'failed').length };
    } finally { this.busy = false; }
  }
}
