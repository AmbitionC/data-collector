import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { commentRoutePath, readCommentRoute } from '../../packages/bridge/src/operations/commentRoute.js';
import { NowcoderPublishingControl } from '../../packages/bridge/src/operations/publishingControl.js';
import { NowcoderOperationsActivity } from '../../packages/bridge/src/operations/activity.js';
import { initialState, leadBudgetClosed } from '../../packages/bridge/src/operations/autopilot.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const dirs = createTemporaryDirectoryTracker();
afterEach(() => dirs.cleanup());
const sourceUrl = 'https://www.nowcoder.com/discuss/123456';

it('reads the route, defaults when absent, and stops on an invalid file', async () => {
  const root = await dirs.create('comment-route-'), path = commentRoutePath(root);
  expect(readCommentRoute(root)).toBeUndefined();
  await mkdir(dirname(path), { recursive: true });
  const route = { browser: 'chrome', accountId: '544222414', since: '2026-11-25T14:00:00.000Z' };
  await writeFile(path, JSON.stringify(route)); expect(readCommentRoute(root)).toEqual(route);
  await writeFile(path, '{}'); expect(() => readCommentRoute(root)).toThrow(/格式无效/u);
});

it.each([undefined, 'article'] as const)('pauses both channels for one shared account (%s)', async channel => {
  const root = await dirs.create('comment-route-');
  const control = new NowcoderPublishingControl(join(root, 'c.json'), async () => [], { sharedAccount: () => true });
  const paused = await control.pause({ sourceUrl, requestId: randomUUID(), ...(channel ? { channel, browser: 'chrome' as const, accountId: '544222414' } : {}) });
  expect(control.verificationPendingFor('comment') && control.verificationPendingFor('article')).toBe(true);
  await control.clearVerification(paused.id);
  expect(control.verificationPendingFor('comment') || control.verificationPendingFor('article')).toBe(false);
});

it('never journals a comment when the logged-in account is not the assigned one', async () => {
  const beginPublication = vi.fn(), execute = vi.fn();
  const activity = new NowcoderOperationsActivity({ get: async () => ({}), beginPublication } as never, { assertAvailable: () => undefined, execute }, fetch, undefined,
    async () => { throw new Error('账号不符'); });
  await expect(activity.publish('ops-abcdef123456', { revision: 1, key: 'route-test-key-1', contextHash: 'a'.repeat(64), send: true })).rejects.toThrow('账号不符');
  expect(beginPublication).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

it('counts only the assigned account when deciding on a link', () => {
  const now = Date.parse('2026-11-27T04:00:00Z'), since = '2026-11-26T00:00:00.000Z', at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const old = Array.from({ length: 20 }, (_, i) => at(60 + i));
  const state = { ...initialState(), published: [...old, ...Array.from({ length: 10 }, (_, i) => at(i + 1))], leads: old.map(a => ({ at: a, sourceId: 'x' })) };
  expect(leadBudgetClosed(state, now)).toBe('weekly-share');
  expect(leadBudgetClosed(state, now, since)).toBeUndefined();
  expect(leadBudgetClosed({ ...state, published: state.published.slice(0, 29) }, now, since)).toBe('too-few-comments');
});
