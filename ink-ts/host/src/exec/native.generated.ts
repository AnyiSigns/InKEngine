/**
 * 生成文件勿手改：原生执行件端点声明派生视图（真源 = plugins/endpoints/<id>/spec.json
 * 的 data.native：二进制文件名 file + env 覆盖键）。由 plugins/scripts/sync_plugin_manifest.mjs
 * 生成；host/src/exec/binary.ts 据此按声明定位；verify:plugin-manifest 强制逐字一致。
 */

export const NATIVE_BINARY_DECLS = [
  { id: 'exec', file: 'exec', env: 'INK_EXEC_BINARY' },
  { id: 'infer', file: 'infer', env: 'INK_INFER_BINARY' },
  { id: 'mcp', file: 'ink_ts_mcp', env: 'INK_MCP_BINARY' },
] as const;

export type NativeBinaryKind = (typeof NATIVE_BINARY_DECLS)[number]['id'];
