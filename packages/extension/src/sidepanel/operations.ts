import { operationDraftsSchema, reviewNowcoderReply, type NowcoderOperation, type NowcoderOperationSummary, type OperationUpdate } from '@data-collector/shared';

type Message = <T>(request: unknown) => Promise<T>;
const STATUS = { queued: '待起草', drafted: '待核对', reviewed: '已核对', replied: '已回复（人工记录）', skipped: '暂不回复' };

export function bindOperations(document: Document, message: Message): { show(): void } {
  const get = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
  const panel = get('operations-panel'), list = get('ops-list'), status = get('ops-status');
  const source = get<HTMLSelectElement>('ops-source');
  const primary = get<HTMLTextAreaElement>('ops-primary'), alternative = get<HTMLTextAreaElement>('ops-alternative');
  const notes = get<HTMLTextAreaElement>('ops-notes'), anchor = get<HTMLInputElement>('ops-anchor');
  const feedback = get<HTMLTextAreaElement>('ops-feedback');
  const tone = get<HTMLSelectElement>('ops-tone'), replyUrl = get<HTMLInputElement>('ops-reply-url');
  let loaded = false, busy = false, dirty = false, selection = 0, editRevision = 0;
  let entries: NowcoderOperationSummary[] = [], current: NowcoderOperation | undefined;

  function controls(): void {
    for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy;
    get<HTMLButtonElement>('ops-add').disabled = busy || !source.value;
    for (const id of ['ops-save', 'ops-reviewed', 'ops-skip', 'ops-replied']) {
      get<HTMLButtonElement>(id).disabled = busy || !current || current.status === 'replied';
    }
    primary.readOnly = alternative.readOnly = anchor.readOnly = busy || current?.status === 'replied';
    notes.readOnly = feedback.readOnly = replyUrl.readOnly = busy || current?.status === 'replied';
    tone.disabled = busy || current?.status === 'replied';
  }
  function meter(): void {
    const a = reviewNowcoderReply(primary.value), b = reviewNowcoderReply(alternative.value);
    get('ops-reply-meter').textContent = `首选 ${a.characters}/160 字 · 另一版 ${b.characters}/160 字。${[...new Set([...a.warnings, ...b.warnings])].join(' ')}`;
  }
  for (const input of [primary, alternative, notes, feedback, anchor, tone, replyUrl]) {
    input.addEventListener('input', () => { dirty = true; editRevision++; meter(); });
    input.addEventListener('change', () => { dirty = true; editRevision++; });
  }
  function drawList(): void {
    list.replaceChildren();
    for (const item of entries) {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'ops-list-item';
      button.textContent = `${STATUS[item.status]} · ${item.title}`;
      button.setAttribute('aria-pressed', String(item.id === current?.id));
      button.onclick = () => { void choose(item.id); };
      row.append(button); list.append(row);
    }
  }
  function drawDetail(entry: NowcoderOperation): void {
    current = entry; dirty = false;
    get('ops-detail').hidden = false;
    get('ops-title').textContent = entry.title;
    get('ops-entry-status').textContent = `${STATUS[entry.status]} · ${entry.assessment.fit === 'high' ? '话题相关' : entry.assessment.fit === 'medium' ? '相邻话题' : '先观察'}`;
    get('ops-angle').textContent = entry.assessment.angle;
    get('ops-limitations').textContent = entry.assessment.limitations.join(' ');
    get<HTMLAnchorElement>('ops-open-source').href = entry.canonicalUrl;
    primary.value = entry.drafts?.primary ?? ''; alternative.value = entry.drafts?.alternative ?? '';
    anchor.value = entry.drafts?.anchor ?? ''; notes.value = entry.drafts?.notes ?? '';
    tone.value = entry.drafts?.tone ?? 'empathetic'; replyUrl.value = entry.replyUrl ?? '';
    feedback.value = entry.note;
    meter(); drawList(); controls();
  }
  function failure(error: unknown): void {
    const value = error instanceof Error ? error.message : '';
    status.textContent = /message port|receiving end|context invalidated|failed to fetch|networkerror/iu.test(value)
      ? '连接暂时中断，已保留当前草稿；请重试。' : value || '操作失败，已保留当前草稿，请重试。';
  }
  async function choose(id: string, discard = false): Promise<boolean> {
    if (dirty && !discard) { status.textContent = '当前修改未保存，请先保存，或放弃修改后重读。'; return false; }
    const token = ++selection;
    const observedEditRevision = editRevision;
    try {
      const result = await message<{ entry: NowcoderOperation }>({ type: 'operations.get', id });
      if (token === selection && editRevision === observedEditRevision) { drawDetail(result.entry); return true; }
      if (token === selection) status.textContent = '保留了重读期间的新修改，请先保存后再切换。';
      return false;
    } catch (error) { if (token === selection) failure(error); return false; }
  }
  async function load(): Promise<void> {
    if (busy) return;
    busy = true; controls();
    try {
      const [queue, library] = await Promise.all([
        message<{ entries: NowcoderOperationSummary[] }>({ type: 'operations.list' }),
        message<{ entries: { id: string; source: string; title: string; materialKind?: string }[] }>({ type: 'library.list' }),
      ]);
      entries = queue.entries;
      const candidates = library.entries.filter(item => item.source === 'nowcoder' && item.materialKind !== 'nowcoder-hot' && !item.id.startsWith('hot-')).slice(0, 200);
      source.replaceChildren();
      for (const item of candidates) {
        const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; source.append(option);
      }
      drawList();
      if (!dirty) {
        const id = current?.id ?? entries[0]?.id;
        if (id && !await choose(id)) return;
      }
      status.textContent = dirty ? '列表已刷新，保留了未保存的编辑。' : entries.length ? `已读取 ${entries.length} 条私有运营记录。` : '还没有运营记录，选择原帖加入队列。';
    } catch (error) { failure(error); }
    finally { busy = false; controls(); }
  }
  async function save(nextStatus?: OperationUpdate['status']): Promise<void> {
    if (!current || busy) return;
    busy = true; controls();
    try {
      const hasDraft = Boolean(primary.value.trim() || alternative.value.trim());
      if (!hasDraft && !nextStatus) throw new Error('还没有回复，请先起草后保存。');
      const checked = hasDraft ? operationDraftsSchema.safeParse({ primary: primary.value, alternative: alternative.value,
        tone: tone.value, anchor: anchor.value, notes: notes.value }) : undefined;
      if (checked && !checked.success) throw new Error('请填写两版短回复与原帖锚点；回复最多160字，链接使用裸域名。');
      const drafts = checked?.success ? checked.data : undefined;
      const patch: OperationUpdate = { revision: current.revision, contextHash: current.contextHash,
        note: feedback.value,
        ...(drafts ? { drafts } : {}), ...(nextStatus ? { status: nextStatus } : {}),
        ...(replyUrl.value.trim() ? { replyUrl: replyUrl.value.trim() } : {}) };
      const result = await message<{ entry: NowcoderOperation }>({ type: 'operations.update', id: current.id, patch });
      entries = entries.map(item => item.id === result.entry.id ? result.entry : item);
      drawDetail(result.entry); status.textContent = nextStatus === 'replied' ? '已记录评论链接；这是人工记录。' : '草稿已保存到本机。';
    } catch (error) { failure(error); }
    finally { busy = false; controls(); }
  }
  async function copy(value: string, brief = false): Promise<void> {
    if (!value.trim()) { status.textContent = '还没有可复制的回复，请先起草。'; return; }
    if (!brief && ([...value].length > 160 || /https?:\/\//iu.test(value))) {
      status.textContent = '回复最多160字，链接使用裸域名；请调整后再复制。'; return;
    }
    try { await navigator.clipboard.writeText(value); status.textContent = brief
      ? '起草资料已复制，请交给 Codex；生成后刷新查看。'
      : '已复制，未发布。请到原帖核对后自行使用。'; }
    catch { status.textContent = '复制失败，草稿仍保留，可直接选中文本复制。'; }
  }
  get<HTMLButtonElement>('ops-add').onclick = async () => {
    if (busy || dirty) { if (dirty) status.textContent = '请先保存当前修改，再加入其他帖子。'; return; }
    busy = true; controls();
    try {
      const { entry } = await message<{ entry: NowcoderOperation }>({ type: 'operations.add', sourceId: source.value });
      entries = [entry, ...entries.filter(item => item.id !== entry.id)]; drawDetail(entry);
      status.textContent = entry.drafts ? '该帖已有草稿，已保留原记录。' : '已加入队列，可复制起草资料给 Codex。';
    } catch (error) { failure(error); }
    finally { busy = false; controls(); }
  };
  get<HTMLButtonElement>('ops-refresh').onclick = () => { void load(); };
  get<HTMLButtonElement>('ops-save').onclick = () => { void save(); };
  get<HTMLButtonElement>('ops-reviewed').onclick = () => { void save('reviewed'); };
  get<HTMLButtonElement>('ops-replied').onclick = () => { void save('replied'); };
  get<HTMLButtonElement>('ops-skip').onclick = () => { void save('skipped'); };
  get<HTMLButtonElement>('ops-discard').onclick = () => { if (current) void choose(current.id, true); };
  get<HTMLButtonElement>('ops-copy-primary').onclick = () => { void copy(primary.value); };
  get<HTMLButtonElement>('ops-copy-alternative').onclick = () => { void copy(alternative.value); };
  get<HTMLButtonElement>('ops-brief').onclick = async () => {
    if (!current) return;
    try { await copy(JSON.stringify(await message({ type: 'operations.brief', id: current.id }), null, 2), true); }
    catch (error) { failure(error); }
  };
  return { show() {
    for (const section of document.querySelectorAll<HTMLElement>('.state-panel')) section.hidden = true;
    panel.hidden = false;
    if (!loaded) { loaded = true; void load(); }
  } };
}
