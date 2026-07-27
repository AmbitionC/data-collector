/**
 * 构建时由 esbuild 的 define 替换成 `v<版本> · <短 sha>`（见 scripts/build.mjs）。
 * 侧栏右下角显示它，用户据此确认自己加载的到底是不是最新构建。
 */
declare const __BUILD_ID__: string;
