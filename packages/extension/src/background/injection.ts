import { needsTopicHook } from '@data-collector/shared';

/**
 * 自愈注入清单：扩展安装 / 更新后，之前就打开着的标签页里没有我们的脚本，
 * 后台补注入即可自愈 —— **绝不用刷新页面来自愈**，刷新会把知识星球的「精华」
 * 退回默认的「最新」，用户在精华页发起的采集就采成了别的内容。
 */
export interface InjectionStep {
  files: string[];
  /** MAIN 表示注入页面主世界（能改 window.fetch），缺省为扩展的隔离世界。 */
  world?: 'MAIN';
  /** 必需项失败要抛给调用方；可选项失败不该连累其余能力。 */
  required: boolean;
}

/**
 * 一个标签页要补哪些脚本。
 *
 * **两个都要补**。帖子号只存在于站点自己的接口响应里，靠主世界钩子旁观取回；
 * 只补内容脚本的话「已捕获帖子号」永远是 0，批量必然全部跳过，而面板还会让用户
 * 去滚动页面 —— 钩子都不在，滚多久都等不到结果。这条曾让批量功能对所有
 * 「装扩展之前就打开的标签页」彻底不可用，且从提示里完全看不出原因。
 *
 * 顺序也有讲究：主世界钩子先就位并把记录留在页面级 store，内容脚本随后发 replay
 * 请求取回。更新前已打开的旧页若只剩旧 build 记录，新 hook 会从空状态开始，详情采集
 * 因缺少当前 build 的精确 API 证据而失败关闭，绝不能把稳定首段冒充全文。
 */
export function injectionPlan(url: string | undefined): InjectionStep[] {
  if (url && isTopicHookHost(url)) {
    // 列表身份和详情完整正文证明都依赖当前精确 hook；任一步失败都不能降级采集。
    return [
      { files: ['inject.js'], world: 'MAIN', required: true },
      { files: ['content.js'], required: true },
    ];
  }
  return [{ files: ['content.js'], required: true }];
}

/** 这个地址是否需要主世界帖子号钩子；地址不合法一律当作不需要。 */
export function isTopicHookHost(rawUrl: string): boolean {
  try {
    return needsTopicHook(new URL(rawUrl));
  } catch {
    return false;
  }
}
