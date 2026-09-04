/**
 * gate 配置：规则参数（随 CODING.md 演进，增删规则须同步 CODING.md 第 7 节表）。
 */

export interface GateConfig {
  /** 文件行数上限（含注释与空行）。 */
  maxLines: number;
  /** 行数规则扫描的源码根（相对 ink-ts 根）。 */
  lineScanDirs: readonly string[];
  /** core 区相对路径（import/词汇规则只扫这里）。 */
  coreDirs: readonly string[];
  /** core 禁用的宿主/框架词（词边界匹配，命中即拒绝）。 */
  coreForbiddenTokens: readonly string[];
  /** core 允许的不透明协议串（锁定宿主字段/格式标识，命中词但不属协议串即拒绝）。 */
  coreOpaqueTokens: readonly string[];
  /** core 禁用的 import 前缀（如 node:）；未以 . 开头视为第三方。 */
  forbiddenImportPrefixes: readonly string[];
  /** core 允许的 node: 内置白名单（如 async_hooks = Python contextvars 等价物）。 */
  coreAllowedNodeModules: readonly string[];
  /** core 相对 import 中禁出现的子串（反向依赖下方层，如 adapters）。 */
  coreForbiddenRelSubstrings: readonly string[];
}

export const defaultConfig: GateConfig = {
  maxLines: 350,
  lineScanDirs: ['engine/src', 'engine/test', 'backend/src', 'cli/src', 'cli/test', 'frontend/src'],
  coreDirs: ['engine/src/core'],
  coreForbiddenTokens: ['cordis', 'tauri', 'electron', 'vitest', 'react', 'inkling'],
  coreOpaqueTokens: ['inkling.skill/v1'],
  forbiddenImportPrefixes: ['node:'],
  coreAllowedNodeModules: ['node:async_hooks'],
  coreForbiddenRelSubstrings: ['/adapters/'],
};
