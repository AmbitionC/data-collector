import type { OrganizedDocument } from '../organize/index.js';

/** 一个 sink 落地一篇内容后的结果。 */
export interface SinkResult {
  /** sink 标识。 */
  sinkId: string;
  /** 是否成功落地（文件已写入即为成功；如 git push 等附带步骤失败不影响此值）。 */
  ok: boolean;
  /** 产出引用：本机文件绝对路径 / 收件箱条目路径 / 远端记录标识。 */
  outputRef: string;
  /** 附加信息（如图片下载数、git 提交状态、警告）。 */
  detail?: Record<string, unknown>;
}

/**
 * 内容落地目标抽象。采集整理完成后，Bridge 按路由把 OrganizedDocument 交给
 * 一个或多个 sink。0.2.0 只有本机 Markdown 库；本抽象把它变成可插拔的第一实现，
 * 并支持“投递到目标仓库收件箱”这类新目标。
 *
 * 信任边界：业务/云 sink 的凭证只由 Bridge 从本机配置读取，扩展永不接触。
 */
export interface ContentSink {
  readonly id: string;
  /** 面向用户的落地目标名称（侧边栏「去向」展示用，不含本机路径等敏感信息）。 */
  readonly label: string;
  save(input: OrganizedDocument): Promise<SinkResult>;
}
