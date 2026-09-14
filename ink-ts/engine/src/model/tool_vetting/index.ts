/**
 * tool_vetting 公共导出桶（S2 端口提供方契约面：迁移后插件经 @ink-ts/engine
 * 取型 MCP 监管契约，dock 不直引 `_` 前缀私有文件）。
 *
 * 单点导出以下符号供 dock/index 具名再导出；断链即 S2 迁移失败。
 */
export type { ToolSourceValue } from './_types.js';
export { ShadowRunResult, ToolManifest, ToolSource, VettingVerdict } from './_types.js';