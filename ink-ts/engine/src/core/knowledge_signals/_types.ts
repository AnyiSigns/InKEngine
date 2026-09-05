/**
 * 信号感知/蒸馏域常量与校验集（knowledge_signals.py 常量面移植）。
 *
 * 五类信号标签/来源分级/触发阈值/建链挡位单点定义；SOURCE_* 经
 * knowledge_set 重导出（外部消费方沿用 knowledge_set.SOURCE_* 形态，
 * 本模块不另起一套来源枚举）；SOURCE_RANK 为模块级唯一可信度排序基准，
 * 确定性蒸馏与「复用优先于生成」共用——数值仅供排序，不产出可信度字段。
 */

import type { Clock } from '../context/context_types.js';
import type { JsonRecord } from '../json.js';
import { SOURCE_DIALOG, SOURCE_MODEL, SOURCE_USER, SOURCE_WEB } from '../knowledge_set/_types.js';

export { SOURCE_DIALOG, SOURCE_MODEL, SOURCE_USER, SOURCE_WEB };
export type { Clock, JsonRecord };

// 五类信号（分类路由的枚举化标签，防魔法字符串）
export const SIGNAL_PITFALL = 'pitfall'; // 踩坑：预期外失败（错误轨迹的可复用教训）
export const SIGNAL_USER_CORRECTION = 'user_correction'; // 用户修正：卡回路 accept/edit 反例
export const SIGNAL_INSIGHT = 'insight'; // 洞见：成功路径中的可复用经验
export const SIGNAL_GAP = 'gap'; // 流程缺口：缺某类能力 → 新建候选
export const SIGNAL_REPEATED_ROOT_CAUSE = 'repeated_root_cause'; // 重复根因：同一问题 ≥3 次

// 重复根因升级阈值（同一问题出现次数 ≥ 该值 → 转人工确认）
export const REPEAT_THRESHOLD = 3;

// 蒸馏触发阈值（任务复杂度/用户干预超阈值才按需蒸馏——非每回合）
export const DEFAULT_COMPLEXITY_THRESHOLD = 5;
export const DEFAULT_INTERVENTION_THRESHOLD = 1;

// 蒸馏建链挡位（router 挡位；router_config 缺失回落 main_config——与
// 挡位机制其余消费方同语义，见 tiers.resolve_tier_config）
export const DEFAULT_DISTILL_TIER = 'router';

// 蒸馏产物的来源归属（无信号可推导时回落模型来源）
export const _FALLBACK_SOURCE = SOURCE_MODEL;

// 来源可信度基准（数值仅供排序，不产出可信度字段）——模块级单一来源，
// DeterministicDistiller 与 reuse_or_distill 共用
export const SOURCE_RANK: Record<string, number> = {
  [SOURCE_USER]: 4,
  [SOURCE_MODEL]: 3,
  [SOURCE_DIALOG]: 2,
  [SOURCE_WEB]: 1,
};

// 信号类别与来源白名单（校验集；定义在 ExecutionSignal.from_dict 消费前，
// 避免「类方法引用定义在后的模块常量」的顺序误导——ENG1-14 语义保留）
export const _SIGNAL_KINDS: readonly string[] = [
  SIGNAL_PITFALL,
  SIGNAL_USER_CORRECTION,
  SIGNAL_INSIGHT,
  SIGNAL_GAP,
  SIGNAL_REPEATED_ROOT_CAUSE,
];
export const _SOURCES: readonly string[] = [SOURCE_WEB, SOURCE_DIALOG, SOURCE_MODEL, SOURCE_USER];

// Python repr 口径的错误消息装配（信号/配置声明文案携带可读形态）
// 族收敛：repr 近似拷贝的统一迁移点 = core/py_repr.ts 单源（已就绪）。
// 本实现差异：_str_repr 非递归（字符串/None 特判，其余 String）；
// _tuple_repr 单引号引元组项。后续批次可按批迁移，本文件暂不改实现。
export function _str_repr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

export function _tuple_repr(values: readonly unknown[]): string {
  return `(${values.map((v) => `'${String(v)}'`).join(', ')})`;
}