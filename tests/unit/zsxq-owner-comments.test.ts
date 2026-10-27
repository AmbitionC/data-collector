import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import * as api from '../../packages/extension/src/zsxqApiFallback.js';

const groupId = '48844584441158';
const topicId = '22258242158441211';
const ownerId = '28851188188211';
const rootId = '55188252152425154';
const replyId = '45811454854222258';
const base = 'https://api.zsxq.com/v2';
const envelope = (data: unknown) => new Response(JSON.stringify({ succeeded: true, resp_data: data }));
const root = (index = 0) => ({
  comment_id: String(BigInt(rootId) + BigInt(index)),
  create_time: `2026-10-18T22:${String(index).padStart(2, '0')}:00.000+0800`,
  owner: { user_id: '1002', name: '提问者' }, text: '请问如何控制副业投入？',
  replies_count: 1,
  replied_comments: [{ comment_id: replyId, parent_comment_id: String(BigInt(rootId) + BigInt(index)),
    create_time: '2026-10-19T09:00:00.000+0800', owner: { user_id: ownerId, name: '陈老师' },
    repliee: { user_id: '1002', name: '提问者' }, text: '先做低成本试错。' }],
});
function transport(pages: unknown[], options: { wrongGroup?: boolean; denied?: boolean } = {}) {
  const requested: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const url = String(input); requested.push(url);
    if (options.denied) return new Response('{"succeeded":false,"code":1030}');
    if (url === `${base}/groups/${groupId}`) return envelope({ group: {
      group_id: options.wrongGroup ? '123456789' : groupId,
      owner: { user_id: ownerId, name: '陈老师' },
    } });
    if (url === `${base}/topics/${topicId}`) return envelope({ topic: {
      topic_id: topicId, group: { group_id: groupId },
    } });
    const parsed = new URL(url);
    if (parsed.pathname !== `/v2/topics/${topicId}/comments`) throw new Error(`Unexpected URL ${url}`);
    expect(parsed.searchParams.get('sort')).toBe('asc');
    expect(parsed.searchParams.get('count')).toBe('30');
    expect(parsed.searchParams.get('with_sticky')).toBe('true');
    const payload = pages.shift();
    if (payload === undefined) throw new Error('Unexpected extra comment page');
    return typeof payload === 'string' ? new Response(payload) : envelope({ comments: payload, index: '' });
  };
  return { fetcher, requested, aduid: 'test-device' };
}
const stored: CollectedDocument = {
  schemaVersion: 1, source: 'zsxq', kind: 'article',
  url: 'https://articles.zsxq.com/id_fixture.html', canonicalUrl: 'https://articles.zsxq.com/id_fixture.html',
  title: '投资与副业复盘', author: '陈老师', publishedAt: '2026-10-18T13:26:00.000Z',
  collectedAt: '2026-10-19T00:00:00.000Z', html: '<p>已核验完整原文 &amp; 图表</p>',
  text: '已核验完整原文 & 图表', images: [{ url: 'https://images.zsxq.com/existing.jpg' }],
  truncated: false, sourceMetadata: { topicId, authorRole: 'owner' },
};

describe('owner comments on selected ZSXQ posts', () => {
  it('keeps exact numeric IDs, context and timestamps; matching names do not establish ownership', async () => {
    const item = root();
    item.replied_comments.push({ ...item.replied_comments[0]!, comment_id: '45811454854222259',
      owner: { user_id: '9999', name: '陈老师' }, text: '同名成员，不是星主' });
    const raw = JSON.stringify({ succeeded: true, resp_data: { comments: [item], index: '' } })
      .replace(/"(55188252152425154|45811454854222258|45811454854222259)"/gu, '$1');
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, transport([raw]));
    expect(result).toMatchObject({ topicId, groupId, ownerId, pagesFetched: 1, exhausted: true });
    expect(result.comments).toEqual([expect.objectContaining({ id: replyId, rootId,
      text: '先做低成本试错。', contextText: '请问如何控制副业投入？',
      publishedAt: '2026-10-19T01:00:00.000Z' })]);
  });

  it('uses the last root creation time as the next cursor, even when nested replies are newer', async () => {
    const firstPage = Array.from({ length: 30 }, (_, i) => ({ ...root(i), replies_count: 0, replied_comments: [] }));
    const io = transport([firstPage, [root(30)]]);
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, io);
    expect(result.pagesFetched).toBe(2);
    expect(result.comments.map(c => c.id)).toEqual([replyId]);
    expect(new URL(io.requested.at(-1)!).searchParams.get('begin_time')).toBe('2026-10-18T22:29:00.000+0800');
  });

  it('accepts an empty complete comments page', async () => {
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, transport([[]]));
    expect(result).toMatchObject({ comments: [], exhausted: true, pagesFetched: 1 });
  });

  it('records stale reply counts without inventing unavailable source text', async () => {
    const item = { ...root(), replies_count: 2 };
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, transport([[item]]));
    expect(result.unavailableReplyCount).toBe(1);
    expect(result.comments).toHaveLength(1);
  });

  it('stops on denied access without issuing a comment request', async () => {
    const io = transport([], { denied: true });
    await expect(api.collectZsxqApiOwnerComments(groupId, topicId, io)).rejects.toThrow('AUTH_REQUIRED');
    expect(io.requested).toEqual([`${base}/groups/${groupId}`]);
  });

  it('rejects a different verified group before reading comments', async () => {
    const io = transport([], { wrongGroup: true });
    await expect(api.collectZsxqApiOwnerComments(groupId, topicId, io)).rejects.toThrow(/GROUP_UNPROVEN/u);
    expect(io.requested).toHaveLength(1);
  });

  it.each([
    ['missing identity', { ...root(), comment_id: undefined }],
    ['invalid timestamp', { ...root(), create_time: '10-18' }],
    ['wrong parent', { ...root(), replied_comments: [{ ...root().replied_comments[0]!, parent_comment_id: '12345678901234567' }] }],
    ['unresolved resource', { ...root(), replied_comments: [{ ...root().replied_comments[0]!, images: [{ image_id: '123' }] }] }],
  ])('fails closed for %s', async (_label, item) => {
    await expect(api.collectZsxqApiOwnerComments(groupId, topicId, transport([[item]]))).rejects.toThrow(/COMMENTS_.*UNPROVEN/u);
  });

  it('does not advance a repeated full page', async () => {
    const page = Array.from({ length: 30 }, (_, i) => ({ ...root(i), replied_comments: [], replies_count: 0 }));
    await expect(api.collectZsxqApiOwnerComments(groupId, topicId, transport([page, page])))
      .rejects.toThrow(/COMMENTS_CURSOR_UNPROVEN/u);
  });

  it('handles pinned comments outside chronological order without using them as a cursor', async () => {
    const pinned = { ...root(), sticky: true, create_time: '2026-10-27T12:00:00.000+0800',
      owner: { user_id: ownerId, name: '陈老师' }, replied_comments: [], replies_count: 0 };
    const regular = Array.from({ length: 29 }, (_, i) => ({ ...root(i + 1), replied_comments: [], replies_count: 0 }));
    const io = transport([[pinned, ...regular], []]);
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, io);
    expect(result.comments.map(c => c.id)).toEqual([rootId]);
    expect(new URL(io.requested.at(-1)!).searchParams.get('begin_time')).toBe('2026-10-18T22:29:00.000+0800');
  });

  it('rejects a conflicting duplicate owner reply instead of silently choosing a body', async () => {
    const item = root();
    item.replied_comments.push({ ...item.replied_comments[0]!, text: '另一份冲突正文' });
    await expect(api.collectZsxqApiOwnerComments(groupId, topicId, transport([[item]])))
      .rejects.toThrow(/COMMENTS_CONFLICT_UNPROVEN/u);
  });

  it('does not archive an empty owner comment as content', async () => {
    const item = root();
    item.replied_comments[0]!.text = '';
    await expect(api.collectZsxqApiOwnerComments(groupId, topicId, transport([[item]])))
      .rejects.toThrow(/COMMENTS_BODY_UNPROVEN/u);
  });

  it('keeps resolved images from the question context and owner reply', async () => {
    const item = { ...root(), images: [{ original: { url: 'https://images.zsxq.com/question.jpg' } }],
      replied_comments: [{ ...root().replied_comments[0]!, images: [{ original: { url: 'https://images.zsxq.com/reply.jpg' } }] }] };
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, transport([[item]]));
    const appended = api.appendZsxqOwnerComments(stored, result);
    expect(appended.document.images.map(i => i.url)).toEqual(['https://images.zsxq.com/existing.jpg',
      'https://images.zsxq.com/reply.jpg', 'https://images.zsxq.com/question.jpg']);
  });

  it('retains the actual nested question with its identity and time when the owner replies to that member', async () => {
    const item = root();
    item.text = '谢谢分享';
    item.replies_count = 2;
    item.replied_comments = [{ ...item.replied_comments[0]!, comment_id: '45811454854222257',
      owner: { user_id: '1003', name: '追问者' }, text: '仓位如何控制？',
      create_time: '2026-10-19T08:00:00.000+0800' },
    { ...item.replied_comments[0]!, repliee: { user_id: '1003', name: '追问者' }, text: '先控制到三成。' }];
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, transport([[item]]));
    const appended = api.appendZsxqOwnerComments(stored, result);
    expect(appended.document.text).toContain('仓位如何控制？');
    expect(appended.document.text).toContain('45811454854222257');
    expect(appended.document.text).toContain('2026-10-19T00:00:00.000Z');
    expect(appended.document.text).toContain('追问者');
    expect(appended.document.text).toContain('先控制到三成。');
  });

  it('counts unavailable replies once when the same pinned root is repeated across pages', async () => {
    const pinned = { ...root(), sticky: true, replies_count: 2 };
    const regular = Array.from({ length: 29 }, (_, i) => ({ ...root(i + 1), replied_comments: [], replies_count: 0 }));
    const result = await api.collectZsxqApiOwnerComments(groupId, topicId, transport([[pinned, ...regular],
      [{ ...pinned, likes_count: 5 }]]));
    expect(result.comments.map(c => c.id)).toEqual([replyId]);
    expect(result.unavailableReplyCount).toBe(1);
  });

  it('stops at the existing 12-page bound rather than reporting partial comments complete', async () => {
    const pages = Array.from({ length: 12 }, (_, page) => Array.from({ length: 30 }, (_, offset) => {
      const index = page * 30 + offset;
      return { ...root(), comment_id: String(BigInt(rootId) + BigInt(index)),
        create_time: new Date(Date.UTC(2026, 9, 18, 0, index)).toISOString(), replied_comments: [], replies_count: 0 };
    }));
    const io = transport(pages);
    await expect(api.collectZsxqApiOwnerComments(groupId, topicId, io)).rejects.toThrow(/COMMENTS_LIMIT_UNPROVEN/u);
    expect(io.requested.filter(url => url.includes('/comments?'))).toHaveLength(12);
  });

  it('retains the stored full article, canonical identity and assets when appending; repeats are idempotent', async () => {
    const bundle = await api.collectZsxqApiOwnerComments(groupId, topicId, transport([[root()]]));
    const first = api.appendZsxqOwnerComments(stored, bundle);
    expect(first.added).toBe(1);
    expect(first.document.html.startsWith(stored.html)).toBe(true);
    expect(first.document.text.startsWith(stored.text)).toBe(true);
    expect(first.document).toMatchObject({ canonicalUrl: stored.canonicalUrl, kind: 'article',
      images: stored.images, truncated: false });
    expect(first.document.text).toContain('提问者');
    expect(first.document.text).toContain('先做低成本试错。');
    expect(api.appendZsxqOwnerComments(first.document, bundle)).toEqual({ document: first.document, added: 0 });
  });
});
