/**
 * harness 域公开 re-export（snake_case 镜像 Python core/harness.py __all__）。
 *
 * 实现拆分为定义/构造/注册表/仓库四层文件（≤350 行纪律）：
 * - definition：常量/集合名/匹配器签名与 HarnessDefinition 纯数据形态；
 * - builder：build_minimal_harness（领域生成器起点）+ _keyword_match；
 * - registry：HarnessRegistry（按名取定义/集内激活/图与工具重建）；
 * - repository：HarnessVersion 与 HarnessRepository（补丁链版本仓库）。
 */
export {
  DEFAULT_ROUTE_THRESHOLD,
  HARNESS_COLLECTION,
  HARNESS_COLLECTION_PREFIX,
  harness_collection,
} from './definition.js';
export { HarnessDefinition } from './definition.js';
export type {
  CapabilityMatcher,
  HarnessDefinitionInit,
} from './definition.js';
export { build_minimal_harness, _keyword_match } from './builder.js';
export type { BuildMinimalHarnessOptions } from './builder.js';
export { HarnessRegistry } from './registry.js';
export type { HarnessRegistryOptions, HarnessBuildPipelineOptions } from './registry.js';
export { HarnessRepository, HarnessVersion } from './repository.js';
export type { HarnessRepositoryOptions, HarnessStorage, HarnessVersionInit } from './repository.js';
