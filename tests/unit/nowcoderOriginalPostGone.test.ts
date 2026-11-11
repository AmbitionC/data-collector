import { describe, expect, it } from 'vitest';
import { originalPostGone } from '../../packages/bridge/src/operations/activity.js';

const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
describe('deleted challenge post', () => {
  it('is gone only when the public API returns an empty record', async () => {
    expect(await originalPostGone('https://www.nowcoder.com/discuss/949815048909709312', reply({ success: true, data: { id: null, title: null, content: '' } }))).toBe(true);
    expect(await originalPostGone('https://www.nowcoder.com/discuss/949815048909709312', reply({ success: true, data: { id: 1, title: '还在', content: 'x' } }))).toBe(false);
    expect(await originalPostGone('https://www.nowcoder.com/discuss/949815048909709312', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBe(false);
    expect(await originalPostGone('https://example.com/x', reply({ success: true, data: {} }))).toBe(false);
  });
});
