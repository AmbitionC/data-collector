import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * 落地目标与来源路由。
 *
 * **零配置即可用**：常用去向（life-teachers / fe-journey）内置在 BUILT_IN_TARGETS，
 * 仓库存在即自动启用；不存在则自动忽略，降级为只落本机 Markdown 库。
 * 只有需要偏离默认时才写 `~/.data-collector/sinks.json` 覆盖 —— 该文件只由 Bridge 读取
 * （凭证不出本机、不进扩展）。
 */

const categoriesSchema = z.array(z.string().trim().min(1).max(60)).max(40);

const markdownSinkSchema = z.object({
  type: z.literal('markdown'),
  categories: categoriesSchema.optional(),
});
const repoInboxSinkSchema = z.object({
  type: z.literal('repo-inbox'),
  repoPath: z.string().trim().min(1).max(4096),
  inboxDir: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(60).optional(),
  /** 该去向的分类清单（侧边栏下拉选项）。 */
  categories: categoriesSchema.optional(),
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

/** 最小缺省：只有本机 Markdown 库；空路由表示所有来源都回退到 `markdown`。 */
export const DEFAULT_SINKS_CONFIG: SinksConfig = {
  sinks: { markdown: { type: 'markdown' } },
  routes: {},
};

/**
 * 内置的知识库去向。这是个人自用工具，常用去向直接写死，**不需要任何配置文件**：
 * 仓库在本机存在就自动启用，不存在就自动忽略（降级为只落本机库）。
 * 分类清单与各目标仓库的真实分类保持一致（life-teachers 见其 CLAUDE.md 主分类；
 * fe-journey 见 knowledge/_tree.json 顶层分组）。
 *
 * 只有需要偏离这套默认（换目录、加新目标、改路由）时，才写 `~/.data-collector/sinks.json` 覆盖。
 */
const BUILT_IN_TARGETS = [
  {
    id: 'life-teachers',
    repoPath: '~/code/life-teachers',
    label: 'life-teachers 收件箱',
    categories: ['投资', '财富', '职场', '认知', '教育', '其他'],
    sources: ['wechat', 'zsxq'],
    /** 本机库同时留底，便于对照与检索。 */
    alongsideLibrary: true,
  },
  {
    id: 'fe-journey',
    repoPath: '~/code/front-end-journey-resource',
    label: 'fe-journey 收件箱',
    categories: [
      '面经',
      'Agent 与大模型核心',
      '前端核心',
      '服务端工程',
      '数据工程',
      '计算机与算法基础',
      '项目与职业',
    ],
    sources: ['nowcoder'],
    alongsideLibrary: false,
  },
] as const;

function expandHome(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 组装内置默认：只启用本机上确实存在的目标仓库。
 * `exists` 可注入（测试用），缺省按真实文件系统判断。
 */
export async function builtInSinksConfig(
  exists: (path: string) => Promise<boolean> = isDirectory,
): Promise<SinksConfig> {
  const config: SinksConfig = {
    sinks: { markdown: { type: 'markdown' } },
    routes: {},
  };
  for (const target of BUILT_IN_TARGETS) {
    if (!(await exists(expandHome(target.repoPath)))) continue;
    config.sinks[target.id] = {
      type: 'repo-inbox',
      repoPath: target.repoPath,
      label: target.label,
      categories: [...target.categories],
    };
    for (const source of target.sources) {
      config.routes[source] = target.alongsideLibrary
        ? ['markdown', target.id]
        : [target.id];
    }
  }
  return config;
}

/**
 * 读取并校验 sinks.json；**文件不存在时使用内置默认**（见 BUILT_IN_TARGETS）。
 * 解析失败（JSON 非法或 schema 不符）时抛错，以便尽早发现配置问题。
 */
export async function loadSinksConfig(path: string): Promise<SinksConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return builtInSinksConfig();
    throw error;
  }
  const parsed = sinksConfigSchema.parse(JSON.parse(raw));
  // 保证 markdown 目标始终可用，作为未配置来源的兜底落点。
  if (!parsed.sinks.markdown) {
    parsed.sinks.markdown = { type: 'markdown' };
  }
  return parsed;
}
