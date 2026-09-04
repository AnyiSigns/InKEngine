/**
 * 样例库机制（rules.py fixture 段移植）。
 *
 * 样例闸门 = 非谈判项：每个知识集自带样例库，新规则必须先让 fixture
 * 全绿才允许落库。判定语义：expected_pass=True 需要零违规且零失效跳过
 * ——谓词执行异常/产出畸形（fail-open 跳过）的规则在干净用例上不得判定
 * 通过（静默失效的规则不能骗过样例闸门，失效明细随用例结果留痕可审计）；
 * expected_pass=False 需要至少一条违规且 expected_kinds 全数出现（子集
 * 语义，允许额外类别），声明 unexpected_kinds 时额外类别被严格拒绝
 * （退化防线不可绕过）。
 */

import { isRecord, type JsonRecord } from '../json.js';
import { typeName } from '../json.js';
import { FixtureGateError, GraphDefinitionError } from '../errors.js';
import { pyRepr, pyTruthy } from './_py.js';
import { RuleEngine } from './engine.js';
import { RuleViolation } from './rule_data.js';
import type { RuleSet } from './rule_data.js';

/** 一个样例用例（纯数据，随规则集导出/导入）。 */
export class FixtureCase {
  /** 用例 id（样例集内唯一）。 */
  readonly id: string;
  /** 评估输入数据（JSON 兼容——规则集数据形态的契约）。 */
  readonly data: JsonRecord;
  /** 评估上下文（运行时参数，如输入文本/目标实体）。 */
  readonly context: JsonRecord;
  /** True = 期望零违规；False = 期望至少一条违规。 */
  readonly expected_pass: boolean;
  /** 必须出现的违规类别集（expected_pass=False 时逐项断言，子集语义）。 */
  readonly expected_kinds: readonly string[];
  /** 禁止出现的违规类别集（出现即失败——严格模式）。 */
  readonly unexpected_kinds: readonly string[];
  /** 用例说明（覆盖的场景）。 */
  readonly description: string;

  constructor(init: {
    id: string;
    data: JsonRecord;
    context?: JsonRecord;
    expected_pass?: boolean;
    expected_kinds?: readonly string[];
    unexpected_kinds?: readonly string[];
    description?: string;
  }) {
    this.id = init.id;
    this.data = { ...init.data };
    this.context = init.context === undefined ? {} : { ...init.context };
    this.expected_pass = init.expected_pass ?? true;
    this.expected_kinds = init.expected_kinds === undefined ? [] : [...init.expected_kinds];
    this.unexpected_kinds =
      init.unexpected_kinds === undefined ? [] : [...init.unexpected_kinds];
    this.description = init.description ?? '';
    Object.freeze(this);
  }

  /** 序列化（缺省字段不落盘——最小数据形态）。 */
  to_dict(): JsonRecord {
    const data: JsonRecord = { id: this.id, data: { ...this.data } };
    if (Object.keys(this.context).length > 0) {
      data['context'] = { ...this.context };
    }
    if (!this.expected_pass) {
      data['expected_pass'] = false;
      if (this.expected_kinds.length > 0) {
        data['expected_kinds'] = [...this.expected_kinds];
      }
    }
    if (this.unexpected_kinds.length > 0) {
      data['unexpected_kinds'] = [...this.unexpected_kinds];
    }
    if (this.description) {
      data['description'] = this.description;
    }
    return data;
  }

  /** 从声明数据还原（构造即校验，非法声明建图期拒绝）。 */
  static from_dict(data: unknown): FixtureCase {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `样例用例声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const caseId = data['id'];
    const rawData = data['data'];
    if (!caseId || typeof caseId !== 'string') {
      throw new GraphDefinitionError('样例用例缺 id（字符串）');
    }
    if (!isRecord(rawData)) {
      throw new GraphDefinitionError(
        `样例用例 ${caseId} 的 data 须为 dict，收到 ${typeName(rawData)}`,
      );
    }
    const context = data['context'];
    if (context !== undefined && context !== null && !isRecord(context)) {
      throw new GraphDefinitionError(`样例用例 ${caseId} 的 context 须为 dict`);
    }
    const kinds = data['expected_kinds'] === undefined ? [] : data['expected_kinds'];
    if (!Array.isArray(kinds) || !kinds.every((kind) => typeof kind === 'string')) {
      throw new GraphDefinitionError(
        `样例用例 ${caseId} 的 expected_kinds 须为字符串清单`,
      );
    }
    const unexpected = data['unexpected_kinds'] === undefined ? [] : data['unexpected_kinds'];
    if (!Array.isArray(unexpected) || !unexpected.every((kind) => typeof kind === 'string')) {
      throw new GraphDefinitionError(
        `样例用例 ${caseId} 的 unexpected_kinds 须为字符串清单`,
      );
    }
    const description = data['description'] === undefined ? '' : data['description'];
    if (typeof description !== 'string') {
      throw new GraphDefinitionError(`样例用例 ${caseId} 的 description 须为字符串`);
    }
    const rawPass = data['expected_pass'];
    return new FixtureCase({
      id: caseId,
      data: rawData,
      context: context === undefined || context === null ? {} : context,
      expected_pass: rawPass === undefined ? true : pyTruthy(rawPass),
      expected_kinds: kinds as string[],
      unexpected_kinds: unexpected as string[],
      description,
    });
  }
}

/** 样例库（每个知识集自带；新规则必须全绿才允许落库）。 */
export class FixtureSet {
  readonly name: string;
  readonly cases: readonly FixtureCase[];

  constructor(init: { name: string; cases: readonly FixtureCase[] }) {
    this.name = init.name;
    this.cases = [...init.cases];
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      name: this.name,
      cases: this.cases.map((case_) => case_.to_dict()),
    };
  }

  /** 从声明数据还原（逐用例构造即校验，非法声明建图期拒绝）。 */
  static from_dict(data: unknown): FixtureSet {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `样例库声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const name = data['name'];
    const rawCases = data['cases'];
    if (!name || typeof name !== 'string') {
      throw new GraphDefinitionError('样例库缺 name（字符串）');
    }
    if (!Array.isArray(rawCases)) {
      throw new GraphDefinitionError('样例库缺 cases 清单');
    }
    return new FixtureSet({
      name,
      cases: rawCases.map((raw) => FixtureCase.from_dict(raw)),
    });
  }
}

/** 单个样例用例的评估结果（闸门失败原因可读可审计）。 */
export class FixtureResult {
  readonly case_id: string;
  readonly passed: boolean;
  readonly violations: readonly RuleViolation[];
  readonly expected_pass: boolean;
  readonly missing_kinds: readonly string[];
  readonly reason: string;

  constructor(init: {
    case_id: string;
    passed: boolean;
    violations: readonly RuleViolation[];
    expected_pass: boolean;
    missing_kinds?: readonly string[];
    reason?: string;
  }) {
    this.case_id = init.case_id;
    this.passed = init.passed;
    this.violations = [...init.violations];
    this.expected_pass = init.expected_pass;
    this.missing_kinds = init.missing_kinds === undefined ? [] : [...init.missing_kinds];
    this.reason = init.reason ?? '';
    Object.freeze(this);
  }
}

/**
 * 样例库全量评估：规则集 × 每个用例 → 逐用例通过与否。
 *
 * 判定语义见文件头注释；失效跳过同样判失败（规则损坏 = 闸门失败，
 * 与用例方向无关）。
 */
export function run_fixtures(
  rule_set: RuleSet,
  fixtures: FixtureSet,
  options?: { engine?: RuleEngine | null },
): FixtureResult[] {
  const engine = options?.engine ?? new RuleEngine();
  const results: FixtureResult[] = [];
  for (const case_ of fixtures.cases) {
    const result = engine.evaluate(rule_set, case_.data, { context: case_.context });
    const kinds = new Set(result.issues.map((issue) => issue.kind));
    const missing = case_.expected_kinds.filter((kind) => !kinds.has(kind));
    const unexpectedHit = case_.unexpected_kinds.filter((kind) => kinds.has(kind));
    const broken = result.broken.map(([ruleId, reason]) => `${ruleId}: ${reason}`);
    const passed = case_.expected_pass
      ? result.issues.length === 0 && broken.length === 0
      : result.issues.length > 0 &&
        missing.length === 0 &&
        unexpectedHit.length === 0 &&
        broken.length === 0;
    let reason = '';
    if (!passed) {
      if (broken.length > 0) {
        reason = `规则失效（fail-open，不得视为通过）: ${broken.slice(0, 3).join('; ')}`;
      } else if (case_.expected_pass) {
        reason =
          `期望零违规，实际 ${result.issues.length} 条: ` +
          result.issues
            .slice(0, 3)
            .map((issue) => `${issue.kind}[${issue.rule_id}] ${issue.message}`)
            .join('; ');
      } else if (result.issues.length === 0) {
        reason = '期望至少一条违规，实际零违规';
      } else if (unexpectedHit.length > 0) {
        reason = `出现禁止的违规类别: (${unexpectedHit.map(pyRepr).join(', ')})`;
      } else {
        reason = `缺少期望违规类别: (${missing.map(pyRepr).join(', ')})`;
      }
    }
    results.push(
      new FixtureResult({
        case_id: case_.id,
        passed,
        violations: result.issues,
        expected_pass: case_.expected_pass,
        missing_kinds: missing,
        reason,
      }),
    );
  }
  return results;
}

/** 样例闸门判定：规则集对全部样例通过（新规则落库的前置检查）。 */
export function fixtures_all_green(
  rule_set: RuleSet,
  fixtures: FixtureSet,
  options?: { engine?: RuleEngine | null },
): boolean {
  return run_fixtures(rule_set, fixtures, options).every((result) => result.passed);
}

/** 样例闸门（非谈判项）：不满足即抛 FixtureGateError。 */
export function assert_fixtures_pass(
  rule_set: RuleSet,
  fixtures: FixtureSet,
  options?: { engine?: RuleEngine | null },
): void {
  const failures = run_fixtures(rule_set, fixtures, options).filter(
    (result) => !result.passed,
  );
  if (failures.length > 0) {
    const detail = failures.map((f) => `[${f.case_id}] ${f.reason}`).join('; ');
    throw new FixtureGateError(
      `样例闸门未通过（${failures.length}/${fixtures.cases.length} 个用例失败）: ${detail}`,
    );
  }
}