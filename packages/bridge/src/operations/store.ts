import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  NOWCODER_REPLY_GUIDANCE, NOWCODER_REPLY_STYLE_VERSION,
  nowcoderOperationSchema, operationAddSchema, operationIdSchema, operationSourceUrlSchema,
  operationUpdateSchema, stableContentId,
  nowcoderConversationSchema, operationPublishSchema,
  type NowcoderOperation, type NowcoderOperationSummary, type OperationUpdate, type NowcoderConversationSnapshot,
  type OperationPublication, type NowcoderOperationResult,
} from '@data-collector/shared';
import { listLibrary } from '../library/manage.js';
import { projectOrganized } from '../library/storedDocument.js';
import { atomicWriteText } from '../library/writer.js';
import { HttpError } from '../server/http.js';

const hash = (title: string, body: string) => createHash('sha256').update(`${title}\n${body}`).digest('hex');
const inside = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part); };
const normalize = (value: string) => value.replace(/\s+/gu, '');

export class NowcoderOperationsStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly libraryRoot: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async get(rawId: string): Promise<NowcoderOperation | undefined> {
    const id = operationIdSchema.parse(rawId), path = join(this.root, `${id}.json`);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 2_000_000) throw new Error('invalid file');
      const value = nowcoderOperationSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (value.id !== id || id !== `ops-${stableContentId(value.canonicalUrl)}`
        || value.contextHash !== hash(value.title, value.body)) throw new Error('identity mismatch');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new HttpError(409, 'OPERATIONS_CORRUPT', `运营记录损坏，请保留文件后核对：${id}`);
    }
  }

  async list(): Promise<NowcoderOperationSummary[]> {
    let files: string[];
    try { files = (await readdir(this.root)).filter(name => name.endsWith('.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (files.length > 2000) throw new HttpError(409, 'OPERATIONS_LIMIT', '运营记录超过2000条，请先整理本机记录');
    const entries: NowcoderOperationSummary[] = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      if (!operationIdSchema.safeParse(id).success) throw new HttpError(409, 'OPERATIONS_CORRUPT', '运营记录文件名损坏，请核对本机目录');
      const entry = await this.get(id);
      if (!entry) throw new HttpError(409, 'OPERATIONS_CORRUPT', '运营记录读取时发生变化，请重试');
      const { body, conversation, ...summary } = entry; void body; void conversation;
      entries.push(summary);
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  private async save(entry: NowcoderOperation): Promise<NowcoderOperation> {
    const parsed = nowcoderOperationSchema.parse(entry);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicWriteText(this.root, join(this.root, `${parsed.id}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  async add(rawSourceId: string): Promise<NowcoderOperation> {
    const { sourceId } = operationAddSchema.parse({ sourceId: rawSourceId });
    return this.serialize(async () => {
      const source = (await listLibrary(this.libraryRoot)).find(entry => entry.id === sourceId);
      if (!source || source.source !== 'nowcoder' || source.materialKind === 'nowcoder-hot') {
        throw new HttpError(409, 'OPERATIONS_SOURCE_REQUIRED', '请先采集牛客原帖的完整正文，再加入运营队列');
      }
      const canonicalUrl = operationSourceUrlSchema.parse(source.url);
      const id = `ops-${stableContentId(canonicalUrl)}`;
      const existing = await this.get(id);
      if (existing) return existing;
      const root = await realpath(this.libraryRoot);
      const lexical = resolve(root, dirname(source.relativePath), 'source.json');
      if (!inside(root, lexical)) throw new HttpError(409, 'OPERATIONS_SOURCE_INVALID', '来源路径越界，已停止读取');
      const path = await realpath(lexical);
      if (!inside(root, path) || (await stat(path)).size > 1_000_000) {
        throw new HttpError(409, 'OPERATIONS_SOURCE_INVALID', '来源路径或文件大小不符合起草范围');
      }
      let document: ReturnType<typeof projectOrganized>['document'];
      try { ({ document } = projectOrganized(JSON.parse(await readFile(path, 'utf8')))); }
      catch { throw new HttpError(409, 'OPERATIONS_SOURCE_IDENTITY', '来源正文或身份校验失败，请保留原件后重新核对'); }
      if (document.source !== 'nowcoder' || document.canonicalUrl !== canonicalUrl
        || stableContentId(document.canonicalUrl) !== sourceId || document.operationMaterial) {
        throw new HttpError(409, 'OPERATIONS_SOURCE_IDENTITY', '来源身份与本机目录不一致，请重新核对');
      }
      if (document.truncated || (document.sourceMetadata?.contentAccess && document.sourceMetadata.contentAccess !== 'full')) {
        throw new HttpError(409, 'OPERATIONS_SOURCE_INCOMPLETE', '需要可核验的完整正文；付费或截断预览不能用于完整起草');
      }
      const body = document.text.trim(), title = document.title.trim();
      if (body.length < 2 || body.length > 24_000) throw new HttpError(409, 'OPERATIONS_CONTEXT_LIMIT', '正文为空或过长，请先核对适合回复的完整帖子');
      const text = `${title}\n${body}`;
      const agent = /agent|langgraph|langchain|rag|大模型|ai.{0,8}(?:前端|应用|开发)|智能体/iu.test(text);
      const interview = /面经|一面|二面|面试记录|面试题/iu.test(title);
      const learning = /求助|求建议|求方向|不知道|怎么(?:做|学|选)|如何|迷茫|下一步/u.test(text);
      const assessment: NowcoderOperation['assessment'] = {
        fit: agent ? 'high' : /前端|后端|项目|面试/u.test(text) ? 'medium' : 'low',
        intent: interview ? 'interview' : learning ? 'learning' : 'general',
        angle: '尚未读取评论，补读当前讨论和楼主后续后再确定切入点。',
        reason: agent ? '正文包含与 Agent 学习或工程实践相关的具体内容。' : '仅属相邻或一般话题，需人工判断与产品的关联。',
        limitations: ['未读取评论，发布前请检查已有回答；初步匹配不代表平台合规认证。',
          ...(body.length < 80 || document.images.length > 0 ? ['正文较短或包含图片，本版未做图片识别。'] : [])],
      };
      const now = new Date().toISOString();
      return this.save({ schemaVersion: 1, visibility: 'private', id, sourceId, canonicalUrl, title, body,
        contextHash: hash(title, body), collectedAt: document.collectedAt,
        createdAt: now, updatedAt: now, revision: 1, status: 'queued', assessment, note: '' });
    });
  }

  async update(id: string, raw: OperationUpdate): Promise<NowcoderOperation> {
    const patch = operationUpdateSchema.parse(raw);
    return this.serialize(async () => {
      const entry = await this.get(id);
      if (!entry) throw new HttpError(404, 'OPERATIONS_NOT_FOUND', '运营记录不存在，请刷新列表');
      const unresolved = entry.publicationAttempts?.some(attempt => attempt.state === 'dispatching' || attempt.state === 'uncertain');
      const manualReceipt = patch.status === 'replied' && patch.replyUrl && !patch.drafts;
      if (unresolved && !manualReceipt) {
        throw new HttpError(409, 'OPERATIONS_PUBLICATION_UNRESOLVED', '发送中或结果不确定，请先核验评论，保留当前草稿');
      }
      if (patch.revision !== entry.revision) throw new HttpError(409, 'OPERATIONS_STALE', '草稿已被修改，请保留当前编辑并重新读取最新记录');
      if (patch.contextHash !== undefined && patch.contextHash !== entry.contextHash) {
        throw new HttpError(409, 'OPERATIONS_CONTEXT_CHANGED', '正文身份不匹配，已保留原草稿');
      }
      if (patch.drafts && (entry.status === 'replied' || patch.contextHash !== entry.contextHash)) {
        throw new HttpError(409, 'OPERATIONS_CONTEXT_CHANGED', '已回复记录或正文身份不匹配，已保留原草稿');
      }
      if (patch.drafts && !normalize(`${entry.title}\n${entry.body}`).includes(normalize(patch.drafts.anchor))) {
        throw new HttpError(400, 'OPERATIONS_ANCHOR_MISMATCH', '草稿锚点不在原帖中，请重新读原帖后起草');
      }
      if (patch.conversationHash !== undefined && patch.conversationHash !== entry.conversation?.hash) {
        throw new HttpError(409, 'OPERATIONS_CONVERSATION_CHANGED', '评论上下文已变化，请重新读取后起草');
      }
      const drafts = patch.drafts ?? entry.drafts;
      const status = patch.status ?? (patch.drafts ? 'drafted' : entry.status);
      const replyUrl = patch.replyUrl ?? entry.replyUrl;
      if ((status === 'drafted' || status === 'reviewed' || status === 'replied') && !drafts) {
        throw new HttpError(400, 'OPERATIONS_DRAFT_REQUIRED', '请先准备回复草稿');
      }
      if (status === 'replied' && !replyUrl) throw new HttpError(400, 'OPERATIONS_REPLY_URL_REQUIRED', '标记已回复前请填写真实牛客评论链接');
      const { draftConversationHash: previousConversationHash, ...base } = entry;
      const draftConversationHash = patch.drafts ? patch.conversationHash : previousConversationHash;
      return this.save({ ...base, status, note: patch.note ?? entry.note,
        revision: entry.revision + 1, updatedAt: new Date().toISOString(),
        ...(draftConversationHash ? { draftConversationHash } : {}),
        ...(unresolved && manualReceipt ? { publicationAttempts: entry.publicationAttempts!.map(a => a.state === 'dispatching' || a.state === 'uncertain'
          ? { ...a, state: 'published' as const, evidence: 'manual' as const, replyUrl: patch.replyUrl!, message: '人工记录评论链接，插件未验证发布', updatedAt: new Date().toISOString() } : a) } : {}),
        ...(drafts ? { drafts } : {}), ...(replyUrl ? { replyUrl } : {}) });
    });
  }

  async saveConversation(id: string, raw: NowcoderConversationSnapshot): Promise<NowcoderOperation> {
    const snapshot = nowcoderConversationSchema.parse(raw);
    return this.serialize(async () => {
      const entry = await this.get(id);
      if (!entry) throw new HttpError(404, 'OPERATIONS_NOT_FOUND', '运营记录不存在');
      if (snapshot.sourceUrl !== entry.canonicalUrl) throw new HttpError(409, 'OPERATIONS_SOURCE_MISMATCH', '插件上下文不属于指定原帖');
      if (entry.publicationAttempts?.some(a => a.state === 'dispatching' || a.state === 'uncertain')) throw new HttpError(409, 'OPERATIONS_UNRESOLVED', '发送结果待核验，不能覆盖上下文');
      const { draftConversationHash, ...rest } = entry; void draftConversationHash;
      return this.save({ ...rest, conversation: { hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), snapshot }, revision: entry.revision + 1, updatedAt: new Date().toISOString() });
    });
  }

  async beginPublication(id: string, raw: unknown, requestId: string): Promise<{ entry: NowcoderOperation; publication: OperationPublication; dispatch: boolean }> {
    const input = operationPublishSchema.parse(raw);
    return this.serialize(async () => {
      const entry = await this.get(id);
      if (!entry) throw new HttpError(404, 'OPERATIONS_NOT_FOUND', '运营记录不存在');
      const attempts = entry.publicationAttempts ?? [];
      const draftHash = createHash('sha256').update(entry.drafts?.primary ?? '').digest('hex');
      const prior = attempts.find(a => a.key === input.key);
      if (prior) {
        if (prior.draftHash !== draftHash || input.contextHash !== entry.contextHash || prior.requestedRevision !== input.revision) throw new HttpError(409, 'OPERATIONS_KEY_CONFLICT', '发送键已用于其他草稿或版本');
        return { entry, publication: prior, dispatch: false };
      }
      if (attempts.some(a => a.state !== 'rejected') || entry.status === 'replied') throw new HttpError(409, 'OPERATIONS_UNRESOLVED', '已有发送记录，请先核验，禁止重复评论');
      if (input.revision !== entry.revision || input.contextHash !== entry.contextHash) throw new HttpError(409, 'OPERATIONS_STALE', '草稿已被修改，请重新读取');
      if (!entry.drafts || !entry.conversation || entry.draftConversationHash !== entry.conversation.hash) throw new HttpError(409, 'OPERATIONS_CONTEXT_REQUIRED', '请先读取插件评论上下文并保存与该上下文绑定的草稿');
      if (Date.now() - Date.parse(entry.conversation.snapshot.readAt) > 30 * 60_000) throw new HttpError(409, 'OPERATIONS_CONTEXT_EXPIRED', '评论上下文超过30分钟，请重新读取和审阅');
      if (attempts.length >= 20) throw new HttpError(409, 'OPERATIONS_ATTEMPT_LIMIT', '发送尝试达到上限，请核对记录');
      const now = new Date().toISOString();
      const publication: OperationPublication = { key: input.key, requestId, draftHash, requestedRevision: input.revision, state: 'dispatching', createdAt: now, updatedAt: now };
      const saved = await this.save({ ...entry, publicationAttempts: [...attempts, publication], revision: entry.revision + 1, updatedAt: now });
      return { entry: saved, publication, dispatch: true };
    });
  }

  async finishPublication(id: string, key: string, result: NowcoderOperationResult): Promise<OperationPublication> {
    return this.serialize(async () => {
      const entry = await this.get(id);
      const attempt = entry?.publicationAttempts?.find(a => a.key === key);
      if (!entry || !attempt || attempt.state !== 'dispatching') throw new HttpError(409, 'OPERATIONS_ATTEMPT_CHANGED', '发送记录已变化，请核验');
      const valid = result.kind === 'published' && result.receipt.sourceUrl === entry.canonicalUrl && result.receipt.text === entry.drafts?.primary
        && !entry.conversation?.snapshot.comments.some(c => c.url === result.receipt.url);
      const publication: OperationPublication = { ...attempt, updatedAt: new Date().toISOString(),
        state: valid ? 'published' : result.kind === 'attention' && result.submission === 'not_attempted' ? 'rejected' : 'uncertain',
        ...(valid && result.kind === 'published' ? { replyUrl: result.receipt.url, evidence: 'observed' } : { message: result.kind === 'attention' ? result.message : '评论回执与原帖或草稿不符，请核验，禁止重发' }) };
      await this.save({ ...entry, publicationAttempts: entry.publicationAttempts!.map(a => a.key === key ? publication : a),
        ...(valid && result.kind === 'published' ? { status: 'replied', replyUrl: result.receipt.url } : {}), revision: entry.revision + 1, updatedAt: publication.updatedAt });
      return publication;
    });
  }

  async reconcilePublication(id: string, key: string, raw: NowcoderConversationSnapshot): Promise<OperationPublication> {
    const snapshot = nowcoderConversationSchema.parse(raw);
    return this.serialize(async () => {
      const entry = await this.get(id), attempt = entry?.publicationAttempts?.find(a => a.key === key);
      if (!entry || !attempt || !entry.drafts || !entry.conversation) throw new HttpError(409, 'OPERATIONS_ATTEMPT_REQUIRED', '未找到需要核验的发送记录');
      if (snapshot.sourceUrl !== entry.canonicalUrl) throw new HttpError(409, 'OPERATIONS_SOURCE_MISMATCH', '核验页面不是原帖');
      if (attempt.state === 'published' || attempt.state === 'rejected') return attempt;
      const before = new Set(entry.conversation.snapshot.comments.map(c => c.url));
      const matches = snapshot.comments.filter(c => !before.has(c.url) && normalize(c.text) === normalize(entry.drafts!.primary));
      const match = entry.conversation.snapshot.coverage.complete && matches.length === 1 ? matches[0] : undefined;
      const publication: OperationPublication = { ...attempt, updatedAt: new Date().toISOString(),
        state: match ? 'published' : attempt.state,
        ...(match ? { replyUrl: match.url, evidence: 'observed', message: '只读核验观察到唯一新增匹配评论' }
          : { message: entry.conversation.snapshot.coverage.complete ? '只读核验未见唯一新增匹配评论，仍禁止自动重发' : '发送前评论覆盖不完整，请人工核验；仍禁止自动重发' }) };
      await this.save({ ...entry, publicationAttempts: entry.publicationAttempts!.map(a => a.key === key ? publication : a),
        ...(match ? { status: 'replied', replyUrl: match.url } : {}), revision: entry.revision + 1, updatedAt: publication.updatedAt });
      return publication;
    });
  }

  async brief(id: string): Promise<unknown> {
    const entry = await this.get(id);
    if (!entry) throw new HttpError(404, 'OPERATIONS_NOT_FOUND', '运营记录不存在');
    return {
      type: 'nowcoder-reply-brief', visibility: 'private', styleVersion: NOWCODER_REPLY_STYLE_VERSION,
      task: '补读原帖评论和后续，参考真实热评为当前讨论起草两版回复，供用户审阅；不要发布。',
      guidance: NOWCODER_REPLY_GUIDANCE, commentsStatus: entry.conversation ? 'plugin-collected' : 'not-collected', commentContextRequired: !entry.conversation,
      ...(entry.conversation ? { conversationUntrusted: entry.conversation.snapshot } : {}),
      references: ['.codex/skills/data-collector-delivery/references/nowcoder-replies.md',
        '.codex/skills/data-collector-delivery/references/nowcoder-comment-evidence.md'],
      previousDrafts: entry.drafts ?? null, feedback: entry.note,
      sourceUntrusted: { title: entry.title, body: entry.body, canonicalUrl: entry.canonicalUrl, collectedAt: entry.collectedAt },
      assessment: { fit: entry.assessment.fit, intent: entry.assessment.intent,
        reason: entry.assessment.reason, limitations: entry.assessment.limitations },
      draftEnvelope: { schemaVersion: 1, opportunityId: entry.id, revision: entry.revision,
        contextHash: entry.contextHash,
        ...(entry.conversation ? { conversationHash: entry.conversation.hash } : {}),
        drafts: { primary: '第一版回复', alternative: '另一种切入点', tone: 'contextual', anchor: '原帖中的一段原话', notes: '评论证据与接话依据，内部记录，不发布' } },
    };
  }
}
