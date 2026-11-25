import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTICLE_POLICY } from '../articles/autopilot.js';
import { readCommentRoute } from './commentRoute.js';

/** 2026-11-25 user: while one account does both, a post takes the place of that hour's comment. */
export const POST_SPACING = { beforeMs: 45 * 60_000, afterMs: 60 * 60_000, recheckMs: 5 * 60_000 } as const;
export interface PostRecord { settled(slotId: string): boolean; lastAttemptAt?: string }

/** When comments may next be considered; null when no post is near. */
export function postHoldUntil(now: number, posts: PostRecord): number | null {
  const after = posts.lastAttemptAt ? Date.parse(posts.lastAttemptAt) + POST_SPACING.afterMs : 0;
  if (now < after) return after;
  const day = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10), midnight = Date.parse(`${day}T00:00:00+08:00`);
  for (const slot of ['am', 'pm'] as const) {
    const start = midnight + ARTICLE_POLICY.slots[slot].start * 60_000, end = midnight + ARTICLE_POLICY.slots[slot].end * 60_000;
    if (now < start - POST_SPACING.beforeMs || now >= end || posts.settled(`${day}-${slot}`)) continue;
    return Math.min(end, Math.max(start, now) + POST_SPACING.recheckMs);
  }
  return null;
}

/** Undefined hold when comments run on their own account. Unreadable post records throw, so nothing is sent blind. */
export async function readPostHold(configDir: string, now: number): Promise<number | null> {
  if (!readCommentRoute(configDir)) return null;
  const state = JSON.parse(await readFile(join(configDir, 'nowcoder-autopilot', 'articles.json'), 'utf8')) as { slots: Record<string, unknown> };
  const root = join(configDir, 'nowcoder-articles'), times: string[] = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith('.json')) continue;
    const entry = JSON.parse(await readFile(join(root, name), 'utf8')) as { publicationAttempts?: Array<{ state: string; createdAt: string }> };
    for (const attempt of entry.publicationAttempts ?? []) if (attempt.state !== 'rejected') times.push(attempt.createdAt);
  }
  const lastAttemptAt = times.sort().at(-1);
  return postHoldUntil(now, { settled: id => !!state.slots[id], ...(lastAttemptAt ? { lastAttemptAt } : {}) });
}
