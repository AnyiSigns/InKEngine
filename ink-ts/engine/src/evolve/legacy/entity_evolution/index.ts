/**
 * 实体演化公开面（entity_evolution.py __all__ 镜像：COLLAB_TOOL_NAME /
 * EntityEvolutionConfig / EntityEvolutionPipeline / EntityMutationGate /
 * EntityMutationResult；同增类型导出供宿主装配消费）。
 *
 * 闭环语义：协作者目录的自学习机制（镜像知识孵化管线）——回合事件 → 实体
 * 关联失败信号缓冲 → 按需变异（教训指纹去重）→ 三层闸门（EntityMutationGate）
 * → 严格更优替换 → 晋升；快照只读暴露演化状态（诊断面无可操作项）。
 */

export { COLLAB_TOOL_NAME } from './_types.js';
export { EntityEvolutionConfig, EntityMutationResult } from './_types.js';
export type {
  EntityEvolutionConfigOptions,
  EntityMutationResultOptions,
} from './_types.js';
export { EntityMutationGate } from './gate.js';
export type { EntityMutationCheckOptions } from './gate.js';
export { EntityEvolutionPipeline } from './pipeline.js';
export type {
  EntityEmitFn,
  EntityEvolutionPipelineOptions,
  EntityMutateFn,
} from './pipeline.js';
