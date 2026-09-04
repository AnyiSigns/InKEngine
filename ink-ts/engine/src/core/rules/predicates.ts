/**
 * 内置通用谓词（规则 DSL 解释面：rules.py 谓词段移植）。
 *
 * 谓词 = 注册名 + 参数 → 违规清单（空 = 通过），全部确定性、零 LLM
 * 调用。数据访问经 _get_path 点分取值：属性/字典键/列表下标逐段解析，
 * 下划线前缀段一律拒绝（受限数据访问，不暴露对象内部属性）；「字段
 * 缺失 = 规则不适用」由引擎跳过，适用性显式断言用 present/absent。
 *
 * 与 Python 语义对齐面集中在 _py.ts：空列表/空字典为假（truthy 谓词）、
 * 数值/布尔同族比较（compare）、跨类型不可比较 = 规则不适用、违规
 * 消息文案的 repr/str 形态。状态转换谓词的状态机声明按 config 折叠为
 * 缓存键复用实例（高频评估热路径），声明错误经 config 校验器建图期
 * 拦截，此处只做形态折叠不做校验。
 */

import { isRecord, stableStringify } from '../json.js';
import type { JsonRecord } from '../json.js';
import { StateMachine } from '../state_machine/state_machine.js';
import type { RawIssue, RulePredicate } from './_types.js';
import { pyContains, pyEq, pyRepr, pySorted, pyStr, pyTruthy } from './_py.js';
import { getPath } from './_path.js';

/** present：字段存在（非 None）。config: {path}。 */
function issue(config: JsonRecord, default_message: string, entity_id: unknown = null): RawIssue[] {
  return [
    {
      message:
        'message' in config
          ? String(config['message'])
          : default_message,
      entity_id: 'entity_id' in config ? config['entity_id'] : entity_id,
    } as RawIssue,
  ];
}

/** present：字段存在（非 None）。config: {path}。 */
function predPresent(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const path = config['path'] as string | null | undefined;
  if (getPath(target, path) === null) {
    return issue(config, `字段缺失: ${path || '<root>'}`);
  }
  return [];
}

/** absent：字段缺失（None）。config: {path}。 */
function predAbsent(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const path = config['path'] as string | null | undefined;
  if (getPath(target, path) !== null) {
    return issue(config, `字段不应存在: ${path || '<root>'}`);
  }
  return [];
}

/** equals：字段值等于目标值。config: {path, value}。 */
function predEquals(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const path = config['path'] as string | null | undefined;
  if (pyEq(getPath(target, path), config['value'])) {
    return [];
  }
  return issue(config, `字段 ${path || '<root>'} 不等于期望值 ${pyRepr(config['value'])}`);
}

/** not_equals：字段值不等于目标值。config: {path, value}。 */
function predNotEquals(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const path = config['path'] as string | null | undefined;
  if (!pyEq(getPath(target, path), config['value'])) {
    return [];
  }
  return issue(config, `字段 ${path || '<root>'} 等于禁止值 ${pyRepr(config['value'])}`);
}

/** compare 比较算子集合（声明校验与执行共用同一枚举）。 */
const COMPARE_OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'] as const;

/**
 * 数值比较：config: {path, op, value | other_path}。
 *
 * value = 字面量比较；other_path = 与对象内另一字段比较（二选一）。
 * 任一侧缺失/不可比较（跨类型，Python TypeError 语义）= 规则不适用
 * （跳过，不误报）。数值/布尔同族按数值比较，字符串对按字典序。
 */
function predCompare(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const op = config['op'] as string;
  if (!(COMPARE_OPS as readonly string[]).includes(op)) {
    throw new Error(`compare 谓词的 op 非法: ${pyRepr(op)}（仅 ${COMPARE_OPS.join(', ')}）`);
  }
  const left = getPath(target, config['path'] as string | null | undefined);
  const right = 'other_path' in config
    ? getPath(target, config['other_path'] as string | null | undefined)
    : config['value'];
  if (left === null || right === null) return [];
  const numA = typeof left === 'number' || typeof left === 'boolean';
  const numB = typeof right === 'number' || typeof right === 'boolean';
  const comparable =
    (numA && numB) || (typeof left === 'string' && typeof right === 'string');
  if (!comparable) return []; // 类型不可比较 = 数据形态不适用，规则跳过
  const bothNum = numA && numB;
  const leftNum = bothNum ? Number(left) : NaN;
  const rightNum = bothNum ? Number(right) : NaN;
  const leftStr = bothNum ? '' : (left as string);
  const rightStr = bothNum ? '' : (right as string);
  const matched =
    op === 'lt' ? (bothNum ? leftNum < rightNum : leftStr < rightStr)
    : op === 'lte' ? (bothNum ? leftNum <= rightNum : leftStr <= rightStr)
    : op === 'gt' ? (bothNum ? leftNum > rightNum : leftStr > rightStr)
    : op === 'gte' ? (bothNum ? leftNum >= rightNum : leftStr >= rightStr)
    : op === 'eq' ? pyEq(left, right)
    : !pyEq(left, right);
  if (matched) return [];
  return issue(
    config,
    `字段 ${(config['path'] as string) || '<root>'} (${pyRepr(left)}) 不满足 ${op} ${pyRepr(right)}`,
  );
}

/** in_enum：字段值在合法取值集内（枚举合法性）。config: {path, values}。 */
function predInEnum(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const values = config['values'];
  if (!Array.isArray(values)) {
    throw new Error('in_enum 谓词缺 values 清单');
  }
  const path = config['path'] as string | null | undefined;
  const value = getPath(target, path);
  if (values.some((v) => pyEq(v, value))) {
    return [];
  }
  return issue(
    config,
    `字段 ${path || '<root>'} 取值 ${pyRepr(value)} 不在合法集内: ${pyRepr(pySorted(values))}`,
  );
}

/** not_in_enum：字段值不在禁止集内。config: {path, values}。 */
function predNotInEnum(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const values = config['values'];
  if (!Array.isArray(values)) {
    throw new Error('not_in_enum 谓词缺 values 清单');
  }
  const path = config['path'] as string | null | undefined;
  const value = getPath(target, path);
  if (!values.some((v) => pyEq(v, value))) {
    return [];
  }
  return issue(
    config,
    `字段 ${path || '<root>'} 取值 ${pyRepr(value)} 在禁止集内: ${pyRepr(pySorted(values))}`,
  );
}

/** contains：字段（字符串/集合）包含指定值。config: {path, value}。 */
function predContains(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const haystack = getPath(target, config['path'] as string | null | undefined);
  const needle = config['value'];
  if (haystack === null || needle === null) return [];
  const hit = pyContains(haystack, needle);
  if (hit) return [];
  return issue(config, `字段 ${(config['path'] as string) || '<root>'} 不含 ${pyRepr(needle)}`);
}

/** not_contains：字段（字符串/集合）不包含指定值。config: {path, value}。 */
function predNotContains(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const haystack = getPath(target, config['path'] as string | null | undefined);
  const needle = config['value'];
  if (haystack === null || needle === null) return [];
  const hit = pyContains(haystack, needle);
  if (!hit) return [];
  return issue(config, `字段 ${(config['path'] as string) || '<root>'} 含禁止值 ${pyRepr(needle)}`);
}

/**
 * unique_pairs：集合内条目在指定键组合上唯一（重复登记检测）。
 *
 * config: {keys: [k1, k2]}——target 须为集合（list），逐条按键取值组对；
 * 重复对 = 违规。实体锚点 = 组合末键的值（「重复引用同一目标」的语义），
 * 可经 entity_id_key 覆盖。键字段缺失的条目不参与唯一性（缺键 = 数据
 * 不完整，不误报）。
 */
function predUniquePairs(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const keys = config['keys'];
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('unique_pairs 谓词缺 keys 清单');
  }
  if (!Array.isArray(target)) return []; // 非集合形态 = 规则不适用
  const entityKey =
    (config['entity_id_key'] as string | undefined) || (keys[keys.length - 1] as string);
  const seen = new Set<string>();
  const out: RawIssue[] = [];
  for (const item of target) {
    const pair = keys.map((key) => getPath(item, key as string));
    if (pair.some((value) => value === null)) continue;
    const pairKey = stableStringify(pair);
    if (seen.has(pairKey)) {
      out.push({
        message: `条目组合 ${pyRepr(pair)} 重复登记`,
        entity_id: pyStr(getPath(item, entityKey)),
      } as RawIssue);
    } else {
      seen.add(pairKey);
    }
  }
  return out;
}

/** truthy：字段值为真（Python 真值语义：空列表/空字典为假）。config: {path}。 */
function predTruthy(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const path = config['path'] as string | null | undefined;
  if (pyTruthy(getPath(target, path))) {
    return [];
  }
  return issue(config, `字段 ${path || '<root>'} 应为真`);
}

/** falsy：字段值为假。config: {path}。 */
function predFalsy(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const path = config['path'] as string | null | undefined;
  if (!pyTruthy(getPath(target, path))) {
    return [];
  }
  return issue(config, `字段 ${path || '<root>'} 应为假`);
}

/** 状态转换谓词的状态机实例缓存（同一声明不重复构建——高频评估热路径）。 */
const transitionMachines = new Map<string, StateMachine>();

/** 按 config 声明取状态机实例（缓存命中直接复用；缓存键按声明折叠为规范形）。 */
function transitionMachine(config: JsonRecord): StateMachine {
  let allowedKey: unknown = config['allowed'];
  if (isRecord(config['allowed'])) {
    allowedKey = Object.entries(config['allowed'] as Record<string, unknown>)
      .sort(([k1], [k2]) => (k1 < k2 ? -1 : 1))
      .map(([src, dsts]) => {
        const list = Array.isArray(dsts) ? [...(dsts as unknown[])].sort() : dsts;
        return [src, list];
      });
  } else if (Array.isArray(config['allowed'])) {
    allowedKey = [...(config['allowed'] as unknown[])].sort();
  }
  const key = stableStringify({
    states: pySorted((config['states'] as unknown[]) ?? []),
    terminal: pySorted((config['terminal_states'] as unknown[]) ?? []),
    allowed: allowedKey,
    name: config['name'],
  });
  let machine = transitionMachines.get(key);
  if (machine === undefined) {
    machine = new StateMachine(
      ((config['states'] as unknown[] | undefined) ?? []) as string[],
      {
        terminal_states: (config['terminal_states'] as string[] | undefined) ?? [],
        allowed: isRecord(config['allowed'])
          ? (config['allowed'] as Record<string, readonly string[]>)
          : null,
        name: (config['name'] as string | undefined) ?? 'rule_transition',
      },
    );
    transitionMachines.set(key, machine);
  }
  return machine;
}

/**
 * state_transition：状态转换合法性（声明式状态机规则）。
 *
 * 状态转换规则建在 StateMachine 之上：config 携带状态机声明
 * （states/terminal_states/allowed）+ 前后状态取值路径（from_path/
 * to_path），非法转换（终态转出/越界状态/不在白名单）= 违规；目标状态
 * 缺失 = 规则不适用。
 */
function predStateTransition(target: unknown, config: JsonRecord, _context: JsonRecord | null): RawIssue[] {
  const states = config['states'];
  if (!Array.isArray(states) || states.length === 0) {
    throw new Error('state_transition 谓词缺 states 清单');
  }
  const machine = transitionMachine(config);
  const fromState = getPath(target, config['from_path'] as string | null | undefined);
  const toState = getPath(target, config['to_path'] as string | null | undefined);
  if (toState === null) {
    return []; // 目标状态缺失 = 规则不适用
  }
  if (machine.is_illegal_transition(fromState as string | null, toState as string)) {
    return issue(
      config,
      `非法状态转换: ${pyRepr(fromState)} -> ${pyRepr(toState)}（违反状态机 ${machine.name}）`,
    );
  }
  return [];
}

/** 内置通用谓词登记表（RuleTypeRegistry 构造时自动注入——通用种子）。 */
export const BUILTIN_PREDICATES: Readonly<Record<string, RulePredicate>> = {
  present: predPresent,
  absent: predAbsent,
  equals: predEquals,
  not_equals: predNotEquals,
  compare: predCompare,
  in_enum: predInEnum,
  not_in_enum: predNotInEnum,
  contains: predContains,
  not_contains: predNotContains,
  unique_pairs: predUniquePairs,
  truthy: predTruthy,
  falsy: predFalsy,
  state_transition: predStateTransition,
};

/** config 校验器复用的比较算子枚举（声明校验与执行共用）。 */
export { COMPARE_OPS };