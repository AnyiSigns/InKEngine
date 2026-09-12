/**
 * 声明式规则引擎公开面（rules.py __all__ 镜像）。
 *
 * 规则 = 数据（谓词名 + 参数），解释器 = 注册谓词；领域算法降维为声明
 * 式知识（规则集），执行语义由注册谓词决定，不提供任意代码执行（DSL
 * 拒绝图灵完备）。导出集合严格对齐 Python __all__：常量（规则类型/
 * 严重度/钩子占位 id）、数据形态（Rule/RuleSet/RuleViolation/Fixture*）、
 * 注册表与引擎（RuleTypeRegistry/RuleEngine/RuleCheckResult）、混合判定
 * 门面（ConstraintChecker + RuleHook）与样例闸门三函数。
 */

export {
  HOOK_RULE_ID,
  RULE_CONSTRAINT,
  RULE_TRANSITION,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
} from './_types.js';
export type { RawIssue, RulePredicate } from './_types.js';
export { RuleViolation, Rule, RuleSet } from './rule_data.js';
export { RuleTypeRegistry } from './registry.js';
export { RuleCheckResult } from './check_result.js';
export { RuleEngine } from './engine.js';
export { ConstraintChecker } from './checker.js';
export type { RuleHook } from './checker.js';
export { FixtureCase, FixtureSet, FixtureResult, run_fixtures, fixtures_all_green, assert_fixtures_pass } from './fixtures.js';