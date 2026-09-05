/**
 * knowledge_signals 模块公开面（镜像 Python knowledge_signals.__all__）。
 *
 * 公开形态：常量（阈值/信号标签/来源可信度基准）+ 信号与分类（ExecutionSignal/
 * SignalClassifier）+ 蒸馏（Distiller/DistillOutcome/DistillConfig/
 * DeterministicDistiller/RoleDistiller/resolve_distill_chain）+ 复用
 * （ReuseDecision/reuse_or_distill）+ 精准补丁（build_precise_patch——
 * 与 knowledge_set 修正语义同源的单一契约点，见 KnowledgeSetBase.update）。
 */

export {
  DEFAULT_COMPLEXITY_THRESHOLD,
  DEFAULT_INTERVENTION_THRESHOLD,
  REPEAT_THRESHOLD,
  SIGNAL_GAP,
  SIGNAL_INSIGHT,
  SIGNAL_PITFALL,
  SIGNAL_REPEATED_ROOT_CAUSE,
  SIGNAL_USER_CORRECTION,
  SOURCE_RANK,
} from './_types.js';
export { SOURCE_DIALOG, SOURCE_MODEL, SOURCE_USER, SOURCE_WEB } from './_types.js';
export type { Clock, JsonRecord } from './_types.js';

export { ExecutionSignal, SignalClassifier } from './signals.js';
export { DeterministicDistiller, DistillConfig, DistillOutcome } from './distill.js';
export type { Distiller } from './distill.js';
export { RoleDistiller, resolve_distill_chain } from './distill_role.js';
export { ReuseDecision, reuse_or_distill } from './reuse.js';
export {
  buildPrecisePatch as build_precise_patch,
} from '../knowledge_set/knowledge_set_core.js';
