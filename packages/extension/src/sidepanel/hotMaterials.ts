import { HOT_EMOTION_TAGS, HOT_SCREENSHOT_NOTICE, type HotSelection } from '@data-collector/shared';
import type { HotPreview, HotSaveResult } from '../background/hotMaterials.js';

type Message = <T>(request: unknown) => Promise<T>;

/** Independent manual view: polling the ordinary collector never overwrites its edits or errors. */
export function bindHotMaterials(document: Document, message: Message): { show(): void } {
  const get = <T extends HTMLElement>(id: string) => document.querySelector<T>(id)!;
  const panel = get<HTMLElement>('#hot-panel');
  const list = get<HTMLElement>('#hot-list');
  const status = get<HTMLElement>('#hot-status');
  const read = get<HTMLButtonElement>('#hot-read');
  const save = get<HTMLButtonElement>('#hot-save');
  const exportButton = get<HTMLButtonElement>('#hot-export');
  const notice = get<HTMLElement>('#hot-notice');
  notice.textContent = HOT_SCREENSHOT_NOTICE;
  let preview: HotPreview | undefined;
  let busy = false;
  const selected = new Map<string, HotSelection>();
  const drafts = new Map<string, HotSelection>();

  function controls(): void {
    read.disabled = busy;
    save.disabled = busy || selected.size === 0;
    exportButton.disabled = busy;
    save.textContent = busy ? '正在处理…' : `保存勾选的 ${selected.size} 条素材`;
    for (const input of list.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')) {
      const row = input.closest<HTMLElement>('[data-id]');
      input.disabled = busy || row?.dataset.saved === 'true';
    }
  }
  function label(text: string, control: HTMLElement): HTMLLabelElement {
    const result = document.createElement('label');
    result.append(document.createTextNode(text), control);
    return result;
  }
  function drawRows(): void {
    list.replaceChildren();
    for (const row of preview?.rows ?? []) {
      const material = row.document.operationMaterial!;
      const card = document.createElement('li');
      card.className = 'hot-card'; card.dataset.id = row.id; card.dataset.saved = String(row.alreadySaved);
      const draft = drafts.get(row.id) ?? { id: row.id, emotionTags: [], inspirationNote: '', attribution: 'source-quote' };
      drafts.set(row.id, draft);
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'hot-select';
      checkbox.setAttribute('aria-label', `选择 ${row.document.title}`);
      checkbox.checked = selected.has(row.id);
      checkbox.onchange = () => { if (checkbox.checked) selected.set(row.id, draft); else selected.delete(row.id); controls(); };
      const title = document.createElement('a'); title.href = row.document.canonicalUrl; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.textContent = row.document.title;
      const head = document.createElement('div'); head.className = 'hot-card-head'; head.append(checkbox, title); card.append(head);
      const meta = document.createElement('p'); meta.className = 'support compact';
      const metricLabels: Record<string, string> = { heat: '热度', likes: '赞', comments: '评论', views: '浏览' };
      meta.textContent = `发布时间：${material.observation.publishedAtText ?? '未知'} · `
        + Object.entries(material.observation.metrics).map(([key, value]) => `${metricLabels[key]} ${value ?? '未知'}`).join(' · ');
      card.append(meta);
      const scope = document.createElement('p'); scope.className = 'support compact';
      scope.textContent = `本页可见记录 · ${row.document.collectedAt} · ${row.alreadySaved ? '已在私有素材库' : '未保存'}`;
      card.append(scope);
      const quote = document.createElement('blockquote'); quote.textContent = material.evidence.excerpt || '列表未提供短摘；请打开原文核对。'; card.append(quote);
      const attribution = document.createElement('select'); attribution.className = 'hot-attribution';
      for (const [value, text] of [['source-quote', '来源短摘（未核实）'], ['author-self-report', '发帖人自述（未核实）']]) {
        const option = document.createElement('option'); option.value = value!; option.textContent = text!; attribution.append(option);
      }
      attribution.value = draft.attribution;
      attribution.onchange = () => { draft.attribution = attribution.value as HotSelection['attribution']; };
      card.append(label('原文归属', attribution));
      const tags = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = '编辑情绪标签（仅供选题参考）'; tags.append(legend);
      for (const tag of HOT_EMOTION_TAGS) {
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = draft.emotionTags.includes(tag);
        input.onchange = () => { draft.emotionTags = HOT_EMOTION_TAGS.filter(value => value === tag ? input.checked : draft.emotionTags.includes(value)); };
        tags.append(label(tag, input));
      }
      card.append(tags);
      const note = document.createElement('textarea'); note.className = 'hot-note'; note.maxLength = 1000; note.rows = 2;
      note.placeholder = '写选题问题或改写角度；未核实说法不要当作事实'; note.value = draft.inspirationNote;
      note.oninput = () => { draft.inspirationNote = note.value; }; card.append(label('编辑灵感笔记', note));
      list.append(card);
    }
    controls();
  }
  function failure(error: unknown, fallback: string): void {
    const text = error instanceof Error ? error.message : '';
    status.textContent = /message port|receiving end|context invalidated|failed to fetch/i.test(text)
      ? `${fallback}；连接暂时中断，请重试。` : text || fallback;
  }
  read.onclick = async () => {
    busy = true; status.textContent = '正在读取当前牛客页面的可见条目…'; controls();
    try {
      preview = await message<HotPreview>({ type: 'hot.preview' });
      selected.clear(); drafts.clear(); drawRows();
      status.textContent = preview.rows.length === 0 ? '本页没有识别到帖子。可能尚未加载或页面结构变化，请检查列表后重试。'
        : `预览 ${preview.rows.length} 条，本页可见热度不代表全站排名。请勾选需要的素材。${preview.capped ? '本次最多显示 60 条；滚动后可重新读取。' : ''}`;
    } catch (error) { failure(error, '读取热帖预览失败'); }
    finally { busy = false; controls(); }
  };
  save.onclick = async () => {
    if (!preview || selected.size === 0 || busy) return;
    busy = true; status.textContent = '正在保存至本机私有素材库…'; controls();
    try {
      const result = await message<HotSaveResult>({ type: 'hot.save', token: preview.token, selections: [...selected.values()] });
      for (const item of result.items) {
        if (item.status === 'failed') continue;
        const row = preview.rows.find(row => row.id === item.id); if (row) row.alreadySaved = true;
        selected.delete(item.id);
      }
      drawRows();
      const failures = result.items.filter(item => item.status === 'failed').map(item => `${preview!.rows.find(row => row.id === item.id)?.document.title ?? item.id}：${item.message}`);
      status.textContent = `已保存 ${result.saved} 条，已跳过 ${result.skipped} 条，失败 ${result.failed} 条。${failures.join('；')}`;
    } catch (error) { failure(error, '保存热帖素材失败'); }
    finally { busy = false; controls(); }
  };
  exportButton.onclick = async () => {
    busy = true; controls(); status.textContent = '正在读取本机私有素材…';
    try {
      const value = await message({ type: 'hot.export' });
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `nowcoder-hot-materials-${new Date().toISOString().slice(0, 10)}.private.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = '已导出本机库热帖素材 JSON（私有）；导入运营后台前确认其存储为私有。';
    } catch (error) { failure(error, '导出热帖素材失败'); }
    finally { busy = false; controls(); }
  };
  return { show() {
    for (const section of document.querySelectorAll<HTMLElement>('.state-panel')) section.hidden = true;
    panel.hidden = false;
    controls();
  } };
}
