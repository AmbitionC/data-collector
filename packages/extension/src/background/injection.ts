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
 * 顺序也有讲究：内容脚本先就位，主世界钩子是靠 postMessage 把帖子号交给它的，
 * 监听器不在就白截了。
 */
export function injectionPlan(url: string | undefined): InjectionStep[] {
  const steps: InjectionStep[] = [{ files: ['content.js'], required: true }];
  if (url && isTopicHookHost(url)) {
    // 钩子补不上不该连累单页保存 —— 那条路径不需要帖子号。
    steps.push({ files: ['inject.js'], world: 'MAIN', required: false });
  }
  return steps;
}

/** 这个地址是否需要主世界帖子号钩子；地址不合法一律当作不需要。 */
export function isTopicHookHost(rawUrl: string): boolean {
  try {
    return needsTopicHook(new URL(rawUrl));
  } catch {
    return false;
  }
}
