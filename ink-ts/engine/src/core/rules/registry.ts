/**
 * 谓词注册表与内置 config 校验器（rules.py 注册表段移植）。
 *
 * 与 NodeTypeRegistry 同哲学：谓词名是不透明字符串，注册表不解释含义；
 * 哪些名字存在、如何判定，由注册方决定。内置通用谓词（通用种子：字段
 * 存在/比较/枚举/包含/唯一性/状态转换）构造时自动登记；领域谓词经
 * register 增补。重复注册（含覆盖内置谓词）视为编程错误，显式拒绝。
 *
 * config 校验器随谓词登记，声明错误（非法 op/缺值/引用越界）在建图期
 * 暴露，不延后到执行期 fail-open 静默失效；未登记校验器 = 该谓词 config
 * 不做建图期形态校验（执行期仍由谓词自身兜底 fail-open）。
 */

import { isRecord } from '../json.js';
import type { JsonRecord } from '../json.js';
import { GraphDefinitionError } from '../errors.js';
import { BUILTIN_PREDICATES, COMPARE_OPS } from './predicates.js';
import type { PredicateConfigValidator, RulePredicate } from './_types.js';
import { pyRepr, pySorted } from './_py.js';

/** 谓词注册表：谓词名 → 执行函数（内置通用谓词 + 领域注册谓词）。 */
export class RuleTypeRegistry {
  private readonly predicates = new Map<string, RulePredicate>(
    Object.entries(BUILTIN_PREDICATES) as [string, RulePredicate][],
  );
  private readonly configValidators = new Map<string, PredicateConfigValidator>(
    Object.entries(BUILTIN_CONFIG_VALIDATORS) as [string, PredicateConfigValidator][],
  );

  /** 登记谓词名 → 执行函数（重复登记抛错，防静默覆盖语义）。 */
  register(name: string, predicate: RulePredicate): void {
    if (this.predicates.has(name)) {
      throw new GraphDefinitionError(`谓词重复注册: ${name}`);
    }
    this.predicates.set(name, predicate);
  }

  /**
   * 登记谓词 config 校验器（校验规则 id + config 形态，非法抛错）。
   *
   * 领域谓词可随注册登记校验器；未登记 = 该谓词 config 不做建图期形态
   * 校验（执行期仍由谓词自身兜底 fail-open）。
   */
  register_config_validator(name: string, validator: PredicateConfigValidator): void {
    if (!this.predicates.has(name)) {
      throw new GraphDefinitionError(`config 校验器须先登记谓词: ${name}`);
    }
    if (this.configValidators.has(name)) {
      throw new GraphDefinitionError(`config 校验器重复登记: ${name}`);
    }
    this.configValidators.set(name, validator);
  }

  /** 按谓词名的 config 形态校验（无登记 = 跳过；非法抛声明错误）。 */
  validate_config(rule_id: string, name: string, config: JsonRecord): void {
    const validator = this.configValidators.get(name);
    if (validator !== undefined) {
      validator(rule_id, config);
    }
  }

  /** 按谓词名取执行函数（未知谓词抛错——引用即声明错误）。 */
  create(name: string): RulePredicate {
    const predicate = this.predicates.get(name);
    if (predicate === undefined) {
      throw new GraphDefinitionError(`未知谓词: ${name}`);
    }
    return predicate;
  }

  /** 谓词是否已注册。 */
  has(name: string): boolean {
    return this.predicates.has(name);
  }

  /** 已注册谓词名（插入序，供校验/展示）。 */
  names(): string[] {
    return [...this.predicates.keys()];
  }

  /** 已注册谓词数量（对应 Python len(registry)）。 */
  get length(): number {
    return this.predicates.size;
  }
}

/** 路径字段校验：str 或省略（其余形态 = 声明错误）。 */
function pathField(
  rule_id: string,
  config: JsonRecord,
  key = 'path',
): void {
  const value = config[key];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new GraphDefinitionError(
      `规则 ${rule_id} 的 ${key} 须为字符串或省略: ${pyRepr(value)}`,
    );
  }
}

/** 枚举取值集校验：非空集合形态。 */
function enumValuesField(rule_id: string, config: JsonRecord): void {
  const values = config['values'];
  if (!Array.isArray(values) || values.length === 0) {
    throw new GraphDefinitionError(
      `规则 ${rule_id} 的 values 须为非空集合（枚举取值集）`,
    );
  }
}

/** compare 声明校验：op 合法 + 字面量/对象内字段比较至少一侧存在。 */
function checkCompareConfig(rule_id: string, config: JsonRecord): void {
  const op = config['op'];
  if (typeof op !== 'string' || !(COMPARE_OPS as readonly string[]).includes(op)) {
    throw new GraphDefinitionError(
      `规则 ${rule_id} 的 compare op 非法: ${pyRepr(op)}（仅 ${COMPARE_OPS.join(', ')}）`,
    );
  }
  pathField(rule_id, config);
  if ('other_path' in config) {
    pathField(rule_id, config, 'other_path');
  } else if (!('value' in config)) {
    throw new GraphDefinitionError(
      `规则 ${rule_id} 的 compare 须声明 value 或 other_path 之一`,
    );
  }
}

/** in_enum/not_in_enum 声明校验。 */
function checkEnumConfig(rule_id: string, config: JsonRecord): void {
  pathField(rule_id, config);
  enumValuesField(rule_id, config);
}

/** unique_pairs 声明校验：keys 非空清单。 */
function checkUniquePairsConfig(rule_id: string, config: JsonRecord): void {
  const keys = config['keys'];
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new GraphDefinitionError(`规则 ${rule_id} 的 keys 须为非空清单`);
  }
  if (!keys.every((key) => typeof key === 'string')) {
    throw new GraphDefinitionError(`规则 ${rule_id} 的 keys 须为字符串清单`);
  }
}

/**
 * state_transition 声明校验：状态清单非空 + 引用合法性 + 取值路径合法。
 *
 * terminal_states 与 allowed 白名单引用的状态必须声明在 states 内——
 * 引用越界是声明错误，建图期拒绝；不延后到执行期：StateMachine 构造期
 * 的抛错会被谓词 fail-open 吞掉，规则静默失效且无从定位。
 */
function checkStateTransitionConfig(rule_id: string, config: JsonRecord): void {
  const states = config['states'];
  if (!Array.isArray(states) || states.length === 0) {
    throw new GraphDefinitionError(`规则 ${rule_id} 的 states 须为非空状态清单`);
  }
  const statesSet = new Set(states as unknown[]);
  const terminal = config['terminal_states'];
  if (terminal !== undefined && terminal !== null) {
    if (!Array.isArray(terminal)) {
      throw new GraphDefinitionError(
        `规则 ${rule_id} 的 terminal_states 须为集合形态`,
      );
    }
    const unknown = (terminal as unknown[])
      .filter((state) => !statesSet.has(state))
      .sort();
    if (unknown.length > 0) {
      throw new GraphDefinitionError(
        `规则 ${rule_id} 的 terminal_states 引用了未声明状态: ${pyRepr(pySorted(unknown))}`,
      );
    }
  }
  const allowed = config['allowed'];
  if (allowed !== undefined && allowed !== null) {
    if (!isRecord(allowed)) {
      throw new GraphDefinitionError(
        `规则 ${rule_id} 的 allowed 须为前态 → 后态集合映射`,
      );
    }
    for (const [src, dsts] of Object.entries(allowed)) {
      if (!statesSet.has(src)) {
        throw new GraphDefinitionError(
          `规则 ${rule_id} 的 allowed 引用了未声明前态: ${pyRepr(src)}`,
        );
      }
      if (!Array.isArray(dsts)) {
        throw new GraphDefinitionError(
          `规则 ${rule_id} 的 allowed 对前态 ${pyRepr(src)} 的后态须为集合形态`,
        );
      }
      const unknown = (dsts as unknown[])
        .filter((state) => !statesSet.has(state))
        .sort();
      if (unknown.length > 0) {
        throw new GraphDefinitionError(
          `规则 ${rule_id} 的 allowed 引用了未声明后态: ${pyRepr(pySorted(unknown))}`,
        );
      }
    }
  }
  pathField(rule_id, config, 'from_path');
  pathField(rule_id, config, 'to_path');
}

/** present/absent/truthy/falsy 声明校验（仅路径字段）。 */
function checkSimplePathConfig(rule_id: string, config: JsonRecord): void {
  pathField(rule_id, config);
}

/** equals/not_equals/contains/not_contains 声明校验（路径 + 任意值）。 */
function checkValueConfig(rule_id: string, config: JsonRecord): void {
  pathField(rule_id, config);
  if (!('value' in config)) {
    throw new GraphDefinitionError(`规则 ${rule_id} 缺 value 取值`);
  }
}

/** 内置谓词的 config 校验器（注册表构造时自动注入）。 */
const BUILTIN_CONFIG_VALIDATORS: Readonly<Record<string, PredicateConfigValidator>> = {
  present: checkSimplePathConfig,
  absent: checkSimplePathConfig,
  truthy: checkSimplePathConfig,
  falsy: checkSimplePathConfig,
  equals: checkValueConfig,
  not_equals: checkValueConfig,
  contains: checkValueConfig,
  not_contains: checkValueConfig,
  compare: checkCompareConfig,
  in_enum: checkEnumConfig,
  not_in_enum: checkEnumConfig,
  unique_pairs: checkUniquePairsConfig,
  state_transition: checkStateTransitionConfig,
};