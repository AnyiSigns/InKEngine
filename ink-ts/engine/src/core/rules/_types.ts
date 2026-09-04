/**
 * 声明式规则 DSL 的常量与类型面（rules.py 头段移植）。
 *
 * 规则 = 数据（谓词名 + 参数），执行语义由注册谓词决定；类型面只声明
 * 谓词/钩子的签名形态，不承载实现。违规严重度与类别沿用领域约定
 * （error/warning + 领域 kind 标签），与领域种子包的规则集词汇对齐。
 */

import type { Json, JsonRecord } from '../json.js';

/** 规则类型：constraint = 约束/校验。 */
export const RULE_CONSTRAINT = 'constraint';

/** 规则类型：transition = 状态转换。 */
export const RULE_TRANSITION = 'transition';

/** 规则类型：context_trigger = 情境触发（建议级，不由规则引擎执行）。 */
export const RULE_CONTEXT_TRIGGER = 'context_trigger';

/** 规则类型合法取值（Rule.from_dict 校验用）。 */
export const _VALID_RULE_TYPES = [
  RULE_CONSTRAINT,
  RULE_TRANSITION,
  RULE_CONTEXT_TRIGGER,
] as const;

/** 规则引擎可执行类型（常规校验路径）；情境触发类走专用建议通道。 */
export const _EXECUTABLE_RULE_TYPES = [RULE_CONSTRAINT, RULE_TRANSITION] as const;

/** 违规严重度：error = 硬冲突需裁决。 */
export const SEVERITY_ERROR = 'error';

/** 违规严重度：warning = 提示级。 */
export const SEVERITY_WARNING = 'warning';

/** 违规严重度：info = 建议级（仅情境建议通道产出，不参与硬冲突判定）。 */
export const SEVERITY_INFO = 'info';

/** 严重度合法取值。 */
export const _VALID_SEVERITIES = [SEVERITY_ERROR, SEVERITY_WARNING, SEVERITY_INFO] as const;

/** 钩子违规的 rule_id 占位（区分于规则违规，留痕可审计）。 */
export const HOOK_RULE_ID = '__llm_hook__';

/** 谓词产出的一条违规原语（message 必填，其余键可选，随规则/钩子就地归一化）。 */
export type RawIssue = {
  message: string;
  entity_id?: unknown;
  severity?: unknown;
  rule_id?: unknown;
  kind?: unknown;
  entity_type?: unknown;
};

/**
 * 谓词签名：(target, config, context) → 违规清单（空 = 通过）。
 *
 * context = 评估上下文，引擎注入 {"root": 数据对象}，调用方可增补
 * （如输入文本/调用时参数——规则集保持静态，运行时参数走 context）。
 */
export type RulePredicate = (
  target: unknown,
  config: JsonRecord,
  context: JsonRecord | null,
) => RawIssue[];

/** 谓词 config 校验器签名：规则 id + config → void（非法抛 GraphDefinitionError）。 */
export type PredicateConfigValidator = (rule_id: string, config: JsonRecord) => void;

/** 规则的 config 落库形态（声明数据，谓词自解释）。 */
export type RuleConfig = JsonRecord & { [key: string]: Json };