import TurndownService from 'turndown';

/**
 * 把清洗后的 HTML 转成 Markdown。本机库与收件箱 sink 共用同一套转换规则，
 * 保证两条落地路径产出的正文一致。
 */
export function renderMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  return service.turndown(html).trim();
}
