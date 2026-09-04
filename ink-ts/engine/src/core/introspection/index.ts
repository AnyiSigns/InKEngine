/**
 * 内省域公开 re-export（snake_case 镜像 Python core/introspection.py __all__）。
 *
 * 自指层观察原语：把引擎持有的运行时数据整理为 JSON 快照，注册为引擎
 * 工具（inspect_*）走标准流水线。TS seam 差异：introspection 是对运行时
 * 对象的反射，TS 侧不反射 JS 对象——图/注册表/实体目录以显式类型与
 * 鸭子类型 seam（EntityRegistryLike 等）表达。
 *
 * 实现拆分纪律（≤350 行/文件）：
 * - sources：权限/限额常量与 IntrospectionSources（宿主装配注入的数据源）；
 * - service：IntrospectionService（按工具名分发各 snapshot* 快照读取）；
 * - pipeline：introspection_tool_specs / make_introspection_executor /
 *   build_introspection_pipeline（元工具注册与流水线装配）。
 */
export { INTROSPECTION_PERMISSION, IntrospectionSources } from './sources.js';
export type { EntityRegistryLike, EntitySpecLike } from './sources.js';
export { IntrospectionService } from './service.js';
export {
  build_introspection_pipeline,
  introspection_tool_specs,
  make_introspection_executor,
} from './pipeline.js';
export type { IntrospectionPipelineOptions } from './pipeline.js';
