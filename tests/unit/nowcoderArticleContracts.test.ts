import { expect, it } from 'vitest';

const account = { userId: '544222414', nickname: '测试创作者', profileUrl: 'https://www.nowcoder.com/users/544222414', observedAt: '2026-10-31T16:00:00.000Z' };
const draft = { schemaVersion: 1, id: 'article-abcdef123456', revision: 1, title: '字节 Agent 全栈一面｜题目整理', body: '来自不同公开记录的备考题单，非本人经历\n项目与工具调用\nagent-journey.cn', browser: 'chrome', accountId: account.userId, provenance: 'compiled', sourceUrls: ['https://example.com/question'] };
async function schemas() {
  const module = await import('../../packages/shared/src/nowcoderArticles.js').catch(() => undefined);
  expect(module, 'strict account-bound article contract exists').toBeDefined(); return module!;
}
it('validates account identity against its exact profile URL', async () => {
  const s = await schemas(); expect(s.nowcoderAccountIdentitySchema.parse(account)).toEqual(account);
  expect(s.nowcoderAccountIdentitySchema.safeParse({ ...account, profileUrl: 'https://www.nowcoder.com/users/1' }).success).toBe(false);
  expect(s.nowcoderAccountIdentitySchema.safeParse({ ...account, token: 'not-allowed' }).success).toBe(false);
});
it('binds a bounded local draft to a browser, account and provenance', async () => {
  const s = await schemas(); expect(s.articleDraftSchema.parse(draft)).toEqual(draft);
  for (const patch of [{ browser: 'any' }, { accountId: '' }, { title: '字'.repeat(51) }, { body: '' }, { provenance: 'real-looking-fiction' }]) expect(s.articleDraftSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
});
it('requires an expected account on publishing and accepts readonly verification only on real detail URLs', async () => {
  const s = await schemas();
  const action = { kind: 'article-publish', title: draft.title, body: draft.body, expectedAccountId: account.userId, provenance: 'compiled' };
  expect(s.articleActionSchema.parse(action)).toEqual(action);
  const { expectedAccountId, ...missing } = action; void expectedAccountId;
  expect(s.articleActionSchema.safeParse(missing).success).toBe(false);
  expect(s.articleActionSchema.safeParse({ kind: 'article-verify', title: draft.title, body: draft.body, expectedAccountId: account.userId, postUrl: 'https://example.com/discuss/1' }).success).toBe(false);
});
it('distinguishes observed publication from clicked intent and rejects forged receipt URLs', async () => {
  const s = await schemas();
  const result = { kind: 'article-published', receipt: { url: 'https://www.nowcoder.com/discuss/123456', title: draft.title, body: draft.body, accountId: account.userId, observedAt: account.observedAt } };
  expect(s.articleResultSchema.parse(result)).toEqual(result);
  expect(s.articleResultSchema.safeParse({ kind: 'article-clicked', diagnostics: { pageStartedAt: account.observedAt, submitClickedAt: account.observedAt } }).success).toBe(false);
  expect(s.articleResultSchema.safeParse({ ...result, receipt: { ...result.receipt, url: 'https://www.nowcoder.com/creation/write/article' } }).success).toBe(false);
});
