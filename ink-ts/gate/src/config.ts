/**
 * gate 配置：规则参数（随 CODING.md 演进，增删规则须同步 CODING.md 第 7 节表）。
 */

export interface GateConfig {
  /** 文件行数上限（含注释与空行）。 */
  maxLines: number;
  /** 行数规则扫描的源码根（相对 ink-ts 根）。 */
  lineScanDirs: readonly string[];
  /** core 区相对路径（import/词汇/私有 seam 规则扫这里；含 kernel 机制件区）。 */
  coreDirs: readonly string[];
  /** core 0-IO 纪律扩面层（node 内置/裸包 + core-token 判定集合 = coreDirs ∪ layerDirs；
   *  禁反向依赖条款与私有 seam 检查仍只作用 coreDirs，P1 裁决 1）。P0 值 =
   *  ['engine/src/dock']：随 P2-P5 搬迁逐层加入，禁逆向移除。 */
  layerDirs: readonly string[];
  /** adapters 区相对路径（反向依赖 core 私有模块检查）。 */
  adapterDirs: readonly string[];
  /** JSON 纪律扫描目录（parse/重复键/缩进，相对 ink-ts 根）。 */
  jsonScanDirs: readonly string[];
  /** core 私有模块「跨域契约模块」标注：目标文件头含此标记即放行跨域 import。 */
  coreSeamMarker: string;
  /** core 禁用的宿主/框架词（词边界匹配，命中即拒绝）。 */
  coreForbiddenTokens: readonly string[];
  /** core 允许的不透明协议串（锁定宿主字段/格式标识，命中词但不属协议串即拒绝）。 */
  coreOpaqueTokens: readonly string[];
  /** core 允许的 node: 内置白名单（如 async_hooks = Python contextvars 等价物）。 */
  coreAllowedNodeModules: readonly string[];
  /** core 相对 import 中禁出现的子串（反向依赖下方层，如 adapters）：仅作用
   *  coreDirs（机制层禁依赖下方 IO 实现；dock 公共面承载 adapters re-export 由
   *  layer-dag 矩阵执法，P1 裁决 1）。 */
  coreForbiddenRelSubstrings: readonly string[];
  /** layer-dag 层向门禁是否强制（false = 报告模式：违规打印 WARN 但 exit 0；P7 转强制）。 */
  layerDagEnforce: boolean;
  /** layer-dag 豁免清单（条目格式 `<导入文件相对路径>:<import 说明符>` 精确匹配）：
   *  基线为空数组——过渡豁免**单调收缩只减不增**（阶段结束条数 ≤ 上一阶段）。 */
  layerDagWhitelist: readonly string[];
  /** test-protection 是否强制（false = 报告模式；自 P0 生效，P8 行为波起强制）。 */
  testProtectionEnforce: boolean;
  /** no-pending 禁字（CODING §11.1.4 禁待定）：命中即违规。 「占位」经治理裁决除名（产品占位语义放行）。 */
  noPendingTokens: readonly string[];
  /** no-pending 强制位（false = 报告模式；保留词表零命中，经治理裁决 P0 即转强制）。 */
  noPendingEnforce: boolean;
  /** no-pending 扫描目录（root 相对，`.ts`/`.tsx` 文件）。 */
  noPendingDirs: readonly string[];
}

export const defaultConfig: GateConfig = {
  maxLines: 350,
  lineScanDirs: ['engine/src', 'engine/test', 'hosts/lib/src', 'hosts/lib/test', 'hosts/cli/src', 'hosts/cli/test', 'hosts/web/src', 'hosts/web/test', 'renderer/src', 'renderer/test', 'plugins/ui_features', 'plugins/tools/doc_parse/faces'],
  coreDirs: ['engine/src/core', 'engine/src/kernel'],
  layerDirs: ['engine/src/dock', 'engine/src/model', 'engine/src/graph'],
  adapterDirs: ['engine/src/adapters'],
  jsonScanDirs: ['seed_data', 'plugins', 'engine/schemas', 'engine/fixtures'],
  coreSeamMarker: '跨域契约模块',
  coreForbiddenTokens: ['cordis', 'tauri', 'electron', 'vitest', 'react', 'inkling'],
  coreOpaqueTokens: ['inkling.skill/v1'],
  coreAllowedNodeModules: ['node:async_hooks'],
  coreForbiddenRelSubstrings: ['/adapters/'],
  layerDagEnforce: false,
  layerDagWhitelist: [],
  testProtectionEnforce: false,
  noPendingTokens: ['待接线', '未来接线', '待引擎补全', '机制先行'],
  noPendingEnforce: true,
  noPendingDirs: ['engine/src', 'hosts/lib/src', 'hosts/cli/src', 'hosts/web/src', 'renderer/src', 'plugins'],
};
