import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { browserFamilySchema, nowcoderAccountIdSchema } from '@data-collector/shared';
import { HttpError } from '../server/http.js';

/** Temporary owner-approved assignment of comments to the article browser's account. Delete the file to go back. */
const schema = z.object({ browser: browserFamilySchema, accountId: nowcoderAccountIdSchema, since: z.iso.datetime() }).strict();
export type CommentRoute = z.infer<typeof schema>;
export const commentRoutePath = (configDir: string) => join(configDir, 'nowcoder-autopilot', 'comments.route.json');
/** A missing file is the default collector account; anything unreadable stops comments rather than picking an account. */
export function readCommentRoute(configDir: string): CommentRoute | undefined {
  let raw: string;
  try { raw = readFileSync(commentRoutePath(configDir), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new HttpError(409, 'COMMENT_ROUTE_INVALID', '评论账号设置无法读取，已停止评论'); }
  try { return schema.parse(JSON.parse(raw)); } catch { throw new HttpError(409, 'COMMENT_ROUTE_INVALID', '评论账号设置格式无效，已停止评论'); }
}
