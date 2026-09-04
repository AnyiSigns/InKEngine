/**
 * 进化工厂公开面（evolution.py __all__ 镜像）。
 *
 * 失败率优先入队 → 反思式变异 → 三层闸门防退化；导出集合严格对齐 Python
 * __all__：入队/产物形态（EvolutionCandidate/EvolutionOutcome）、变异策略
 * seam（MutationStrategy）与确定性基线（DeterministicMutation）、工厂组合
 * 入口（EvolutionFactory）、母体指标口径（entry_metrics）；另附闸门 seam
 * 类型（EvolutionGate，真实 KnowledgeGate 结构满足，供宿主/测试注入）。
 */

export {
  DeterministicMutation,
  EvolutionCandidate,
  EvolutionFactory,
  EvolutionOutcome,
  entry_metrics,
} from './evolution.js';
export type {
  EvolutionGate,
  MutationStrategy,
} from './evolution.js';
