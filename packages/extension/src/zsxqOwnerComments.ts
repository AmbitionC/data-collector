import type { CollectedDocument } from '@data-collector/shared';
import { inlineMarkupToHtml } from './topicIndex.js';

export interface ZsxqOwnerComment {
  id: string;
  rootId: string;
  publishedAt: string;
  text: string;
  contextText: string;
  contextAuthor: string;
  contextComments?: Array<{ id: string; author: string; publishedAt: string; text: string }>;
  replyTo?: string;
  images: Array<{ url: string; alt?: string }>;
  attachments: Array<{ url: string; title?: string }>;
}
export interface ZsxqOwnerComments {
  groupId: string;
  topicId: string;
  ownerId: string;
  ownerName: string;
  collectedAt: string;
  pagesFetched: number;
  exhausted: boolean;
  unavailableReplyCount: number;
  comments: ZsxqOwnerComment[];
}
const escape = (s: string): string => s.replace(/[&<>"']/gu, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]!);

/** Append to the stored complete body; never replace it with the current feed preview. */
export function appendZsxqOwnerComments(
  document: CollectedDocument,
  bundle: ZsxqOwnerComments,
): { document: CollectedDocument; added: number } {
  if (!bundle.exhausted || document.source !== 'zsxq' || document.truncated !== false
    || String(document.sourceMetadata?.topicId ?? '') !== bundle.topicId) {
    throw new Error('ZSXQ_COMMENTS_PARENT_UNPROVEN：评论与完整原帖无法核验');
  }
  const rawIds = document.sourceMetadata?.ownerCommentIds;
  let previous: unknown = [];
  if (rawIds !== undefined) {
    if (typeof rawIds !== 'string') throw new Error('ZSXQ_COMMENTS_IDS_UNPROVEN：留存评论编号无效');
    try { previous = JSON.parse(rawIds); } catch { throw new Error('ZSXQ_COMMENTS_IDS_UNPROVEN：留存评论编号无效'); }
  }
  if (!Array.isArray(previous) || !previous.every(id => typeof id === 'string' && /^\d{15,25}$/u.test(id))) {
    throw new Error('ZSXQ_COMMENTS_IDS_UNPROVEN：留存评论编号无效');
  }
  const known = new Set(previous as string[]);
  const added = bundle.comments.filter(c => !known.has(c.id));
  if (added.length === 0) return { document, added: 0 };
  for (const item of added) known.add(item.id);
  const blocks = added.map(item => {
    const context = item.contextComments?.length
      ? item.contextComments.map(c => `<blockquote><p>${escape(c.author)} · ${escape(c.publishedAt)} · 评论 ID ${escape(c.id)}</p>${inlineMarkupToHtml(c.text)}</blockquote>`).join('\n')
      : item.contextText
      ? `<blockquote><p>${escape(item.contextAuthor)}（评论上下文）</p>${inlineMarkupToHtml(item.contextText)}</blockquote>` : '';
    return `<section data-zsxq-comment-id="${escape(item.id)}"><h3>${escape(bundle.ownerName)}${item.replyTo ? ` 回复 ${escape(item.replyTo)}` : ''}</h3>`
      + `<p>${escape(item.publishedAt)} · 评论 ID ${escape(item.id)}</p>${context}${inlineMarkupToHtml(item.text)}`
      + item.images.map(image => `<p><img src="${escape(image.url)}" alt="${escape(image.alt ?? '')}"></p>`).join('')
      + item.attachments.map(a => `<p><a href="${escape(a.url)}">${escape(a.title ?? a.url)}</a></p>`).join('') + '</section>';
  });
  const text = added.map(item => `${bundle.ownerName}${item.replyTo ? ` 回复 ${item.replyTo}` : ''}\n`
    + `${item.publishedAt} · 评论 ID ${item.id}\n`
    + (item.contextComments?.length
      ? item.contextComments.map(c => `${c.author}（评论上下文，${c.publishedAt}，评论 ID ${c.id}）：${c.text}\n`).join('')
      : item.contextText ? `${item.contextAuthor}（评论上下文）：${item.contextText}\n` : '') + item.text).join('\n\n');
  return { added: added.length, document: {
    ...document,
    collectedAt: bundle.collectedAt,
    html: document.html + '\n<section data-zsxq-owner-comments="v1"><h2>陈老师评论区追加回复</h2>' + blocks.join('\n') + '</section>',
    text: document.text + '\n\n陈老师评论区追加回复\n\n' + text,
    images: [...new Map([...document.images, ...added.flatMap(c => c.images)].map(image => [image.url, image])).values()],
    sourceMetadata: { ...document.sourceMetadata,
      ownerCommentIds: JSON.stringify([...known]),
      ownerCommentsComplete: true,
      ownerCommentsVerifiedAt: bundle.collectedAt,
      ownerCommentsOwnerId: bundle.ownerId,
      ownerCommentsUnavailableReplies: bundle.unavailableReplyCount,
    },
  } };
}
