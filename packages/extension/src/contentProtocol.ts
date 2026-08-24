/**
 * 内容脚本与后台之间的完整正文证明版本。
 *
 * 后台 capability 只能证明 service worker 是新版；已打开标签页仍可能运行旧 listener。
 * 每次正文提取都回传这个版本和 bundle build-id，二者必须与当前后台完全一致。
 */
export const CONTENT_EXTRACTION_PROTOCOL = 'zsxq-complete-content-v2';

/** 当前 content/background bundle 在构建时共同烙入的精确产物标识。 */
export const CONTENT_BUILD_ID =
  typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '开发构建';

/**
 * 消息名本身携带 build-id：Chrome 会让同页多个 listener 竞争应答，payload 字段无法阻止
 * 旧 listener 先回 `loaded: 0`；只有让 A/B 两份 bundle 根本监听不同 type 才能隔离。
 */
export function contentRequestType(request: string, buildId = CONTENT_BUILD_ID): string {
  return `${request}.${CONTENT_EXTRACTION_PROTOCOL}.${buildId}`;
}

/** 精确构建消息名让同页仍存活的旧 listener 根本不会抢先响应。 */
export const CONTENT_DOCUMENT_REQUEST = contentRequestType('extract.document');
export const CONTENT_LIST_REQUEST = contentRequestType('extract.list');
export const CONTENT_SELECT_VIEW_REQUEST = contentRequestType('list.selectView');
export const CONTENT_RESTORE_REQUEST = contentRequestType('list.restore');
export const CONTENT_ADVANCE_REQUEST = contentRequestType('list.advance');
export const CONTENT_REFRESH_TOPICS_REQUEST = contentRequestType('list.refreshTopics');
export const CONTENT_DIAGNOSE_REQUEST = contentRequestType('list.diagnose');
export const CONTENT_HIGHLIGHT_REQUEST = contentRequestType('list.highlight');
export const CONTENT_ITEM_DIAGNOSE_REQUEST = contentRequestType('list.itemDiagnose');
export const CONTENT_HOOK_STATS_REQUEST = contentRequestType('list.hookStats');
export const CONTENT_FOCUS_LAST_REQUEST = contentRequestType('list.focusLast');

const CURRENT_CONTENT_REQUESTS: ReadonlySet<string> = new Set([
  CONTENT_DOCUMENT_REQUEST,
  CONTENT_LIST_REQUEST,
  CONTENT_SELECT_VIEW_REQUEST,
  CONTENT_RESTORE_REQUEST,
  CONTENT_ADVANCE_REQUEST,
  CONTENT_REFRESH_TOPICS_REQUEST,
  CONTENT_DIAGNOSE_REQUEST,
  CONTENT_HIGHLIGHT_REQUEST,
  CONTENT_ITEM_DIAGNOSE_REQUEST,
  CONTENT_HOOK_STATS_REQUEST,
  CONTENT_FOCUS_LAST_REQUEST,
]);

/** 内容脚本只给当前精确 bundle 的请求附完整性证明。 */
export function isCurrentContentRequest(type: unknown): type is string {
  return typeof type === 'string' && CURRENT_CONTENT_REQUESTS.has(type);
}
