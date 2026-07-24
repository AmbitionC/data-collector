import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * sinks.json 定义「有哪些落地目标」与「每个来源默认路由到哪些目标」。
 * 该文件只由 Bridge 读取（业务/云凭证不出本机、不进扩展）。缺省时只启用本机 Markdown 库，
 * 所有来源都落本机库 —— 与 0.2.0 行为完全一致。
 */

const markdownSinkSchema = z.object({ type: z.literal('markdown') });
const repoInboxSinkSchema = z.object({
  type: z.literal('repo-inbox'),
  repoPath: z.string().trim().min(1).max(4096),
  inboxDir: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(60).optional(),
  commit: z.boolean().optional(),
  push: z.boolean().optional(),
});

export const sinkDefinitionSchema = z.discriminatedUnion('type', [
  markdownSinkSchema,
  repoInboxSinkSchema,
]);
export type SinkDefinition = z.infer<typeof sinkDefinitionSchema>;

export const sinksConfigSchema = z.object({
  sinks: z.record(z.string().trim().min(1).max(100), sinkDefinitionSchema),
  routes: z.record(z.string().trim().min(1).max(100), z.array(z.string().trim().min(1).max(100))),
});
export type SinksConfig = z.infer<typeof sinksConfigSchema>;

/** 缺省配置：只有本机 Markdown 库；空路由表示所有来源都回退到 `markdown`。 */
export const DEFAULT_SINKS_CONFIG: SinksConfig = {
  sinks: { markdown: { type: 'markdown' } },
  routes: {},
};

/**
 * 读取并校验 sinks.json；文件不存在时返回缺省配置。
 * 解析失败（JSON 非法或 schema 不符）时抛错，以便运维尽早发现配置问题。
 */
export async function loadSinksConfig(path: string): Promise<SinksConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SINKS_CONFIG;
    throw error;
  }
  const parsed = sinksConfigSchema.parse(JSON.parse(raw));
  // 保证 markdown 目标始终可用，作为未配置来源的兜底落点。
  if (!parsed.sinks.markdown) {
    parsed.sinks.markdown = { type: 'markdown' };
  }
  return parsed;
}
