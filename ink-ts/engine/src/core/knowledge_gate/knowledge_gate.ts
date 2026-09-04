/**
 * 知识验证闸门三层组合入口（knowledge_gate.py KnowledgeGate 类移植）：
 * L1 准入 → L2 效果评估 → L3 目标筛选顺序执行（短路：前关不过不后走，
 * 未执行关返回占位结果说明原因）；样例测试为非谈判项；L3 之上可选人工
 * 审核层（默认弹卡可关）。执行语义经执行器/审核者 seam 注入。
 */

import { FixtureGateError, GraphDefinitionError } from '../errors.js';
import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import type { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';
import {
  assert_fixtures_pass,
  FixtureSet,
  RuleEngine,
  RuleSet,
} from '../rules/index.js';
import type { RuleTypeRegistry } from '../rules/index.js';
import type { SchemaSpec } from '../schema/schemaValidator.js';
import { SchemaValidator } from '../schema/schemaValidator.js';
import {
  _INJECTION_PATTERNS,
  _normalize_injection_text,
  _obfuscation_entropy_hits,
  _scan_surface,
} from './_injection.js';
import type { KnowledgeExecutor } from './_executor.js';
import { GateL2FixtureExecutor } from './_executor.js';
import { _default_l3_metrics } from './_metrics.js';
import { GateL1Result, GateL2Result, GateL3Result } from './_results.js';
import type { HumanReviewer } from './_review.js';

/** KnowledgeGate 构造选项（python __init__ 关键字参数镜像）。 */
export interface KnowledgeGateOptions {
  schema_validator?: SchemaValidator | null;
  l2_executor?: KnowledgeExecutor | null;
  injection_patterns?: readonly string[];
  registry?: RuleTypeRegistry | null;
  human_reviewer?: HumanReviewer | null;
  human_review_enabled?: boolean;
}

/** Python list repr 形态（错误/改善维度清单的人类可读呈现）。 */
function _list_repr(items: readonly string[]): string {
  return `[${items.map((item) => `'${item}'`).join(', ')}]`;
}

/**
 * 知识验证闸门：schema_validator（L1 形式合法关）；l2_executor（默认规则引擎
 * 执行器）；injection_patterns（注入模式，可覆盖）；registry（谓词注册表，
 * L1 简化用例与默认 L2 执行器共用）；human_reviewer / human_review_enabled
 * （L3 之上可选人工审核层，默认弹卡；False = 关闭）。
 */
export class KnowledgeGate {
  readonly schema_validator: SchemaValidator;
  readonly registry: RuleTypeRegistry | null;
  readonly l2_executor: KnowledgeExecutor;
  readonly injection_patterns: readonly string[];
  readonly human_reviewer: HumanReviewer | null;
  readonly human_review_enabled: boolean;

  constructor(options: KnowledgeGateOptions = {}) {
    this.schema_validator = options.schema_validator ?? new SchemaValidator();
    this.registry = options.registry ?? null;
    this.l2_executor =
      options.l2_executor ?? new GateL2FixtureExecutor(this.registry);
    this.injection_patterns = options.injection_patterns ?? _INJECTION_PATTERNS;
    this.human_reviewer = options.human_reviewer ?? null;
    this.human_review_enabled = options.human_review_enabled ?? true;
  }

  // ── L1 准入：schema 校验 + 安全扫描（指令注入）+ 最小功能 ──

  /**
   * L1 准入：形式合法 + 安全扫描 + 最小功能测试。security_scan 附加检查
   * （False 键 = 拒绝原因；None = 跳过，指令注入检测恒执行）；minimal_fixtures
   * = 简化用例（None = 只做规则条目「可加载」关，非规则条目跳过本关）。
   */
  check_l1(
    schema: SchemaSpec,
    entry: KnowledgeEntry,
    options?: {
      security_scan?: Readonly<Record<string, unknown>> | null;
      minimal_fixtures?: FixtureSet | null;
    },
  ): GateL1Result {
    const errors: string[] = [];
    errors.push(...this.schema_validator.validate(schema, entry.to_dict()));
    const injectionHits = this._scan_injection(entry);
    errors.push(...injectionHits.map((hit) => `指令注入检测命中: ${hit}`));
    const securityScan = options?.security_scan ?? null;
    if (securityScan !== null) {
      for (const [key, ok] of Object.entries(securityScan)) {
        if (ok === false) {
          errors.push(`安全扫描未通过: ${key}`);
        }
      }
    }
    errors.push(...this._minimal_functional_test(entry, options?.minimal_fixtures ?? null));
    if (errors.length > 0) {
      return new GateL1Result({
        passed: false,
        errors,
        injection_hits: injectionHits,
      });
    }
    return new GateL1Result({ passed: true });
  }

  /**
   * 最小功能测试（L1 第三子关）：规则条目恒做「可加载」关（无法加载 = 声明
   * 层面不可执行）；提供简化用例时轻量执行全绿才过；非规则条目不带用例跳过、
   * 带用例显式拒绝（fail-closed，不静默放行未定义语义的用例）。
   */
  private _minimal_functional_test(
    entry: KnowledgeEntry,
    minimalFixtures: FixtureSet | null,
  ): string[] {
    if (entry.kind !== 'rule') {
      if (minimalFixtures !== null) {
        return ['最小功能测试: 非规则条目无法执行简化用例' + '（需注入领域执行器）'];
      }
      return [];
    }
    const rawRule = entry.data['rule'];
    if (!isRecord(rawRule)) {
      return ['最小功能测试: 规则条目缺 data.rule 声明（无法加载）'];
    }
    let ruleSet: RuleSet;
    try {
      ruleSet = RuleSet.parse(
        { name: `entry-${entry.id}`, rules: [rawRule] },
        this.registry,
      );
    } catch (error) {
      if (error instanceof GraphDefinitionError) {
        return [`最小功能测试: 规则声明无法加载: ${error.message}`];
      }
      throw error;
    }
    if (minimalFixtures === null) {
      return [];
    }
    try {
      assert_fixtures_pass(ruleSet, minimalFixtures, {
        engine: new RuleEngine(this.registry),
      });
    } catch (error) {
      if (error instanceof FixtureGateError) {
        return [`最小功能测试: 简化用例未全绿: ${error.message}`];
      }
      throw error;
    }
    return [];
  }

  /** 指令注入检测：标题/标签 + 条目数据内的字符串值与键名命中清单。 */
  private _scan_injection(entry: KnowledgeEntry): readonly string[] {
    const texts: string[] = [entry.title, ...entry.tags];
    texts.push(..._scan_surface(entry.data));
    const joined = texts.join(' ');
    const normalized = _normalize_injection_text(joined);
    const hits: string[] = [];
    for (const pattern of this.injection_patterns) {
      if (normalized.includes(_normalize_injection_text(pattern))) {
        hits.push(pattern);
      }
    }
    hits.push(..._obfuscation_entropy_hits(joined));
    return [...new Set(hits)];
  }

  // ── L2 效果评估：完整 fixtures（非谈判项）──

  /**
   * L2 效果评估：完整 fixtures + 历史回归（regression 追加，通过时计入
   * regression_samples），fixture 全绿才通过；context_rules = 旧集 + 候选
   * 合并评估（样例面向整套规则集设计时传旧集）。
   */
  async check_l2(
    entry: KnowledgeEntry,
    fixtures: FixtureSet,
    options?: {
      regression?: FixtureSet | null;
      context_rules?: JsonRecord | null;
    },
  ): Promise<GateL2Result> {
    const regression = options?.regression ?? null;
    const contextRules = options?.context_rules ?? null;
    let combined = fixtures;
    if (regression !== null && regression.cases.length > 0) {
      combined = new FixtureSet({
        name: `${fixtures.name}+regression`,
        cases: [...fixtures.cases, ...regression.cases],
      });
    }
    let result = await this.l2_executor.run(entry, combined, {
      context_rules: contextRules,
    });
    if (result.passed && regression !== null) {
      result = new GateL2Result({
        passed: true,
        fixture_results: result.fixture_results,
        accuracy: result.accuracy,
        latency_ms: result.latency_ms,
        token_cost: result.token_cost,
        safety_score: result.safety_score,
        regression_samples: regression.cases.length,
        note: result.note,
      });
    }
    return result;
  }

  // ── L3 目标筛选：不差于旧版 + 至少一维严格优于 / 多样性保留 ──

  /**
   * L3 目标筛选：不差于旧版且至少一维严格优于才保留（old_metrics = None
   * 首版直接通过）；diversity = 等价变体保留开关（供下轮进化）；新旧无
   * 共同维度 = 口径漂移，显式抛错。
   */
  check_l3(
    new_metrics: Record<string, number>,
    old_metrics: Record<string, number> | null,
    options?: { diversity?: boolean },
  ): GateL3Result {
    const diversity = options?.diversity ?? true;
    if (old_metrics === null || old_metrics === undefined || Object.keys(old_metrics).length === 0) {
      return new GateL3Result({
        passed: true,
        reason: '无旧版可比（首版/空旧版直接保留）',
      });
    }
    const common = Object.keys(new_metrics).filter((dim) => dim in old_metrics);
    if (common.length === 0) {
      throw new GraphDefinitionError(
        '新旧版本无共同维度可比（口径漂移会让目标筛选失真）',
      );
    }
    const worsened = common.filter(
      (dim) => new_metrics[dim]! < old_metrics[dim]! - 1e-9,
    );
    if (worsened.length > 0) {
      return new GateL3Result({
        passed: false,
        reason: `劣于旧版: ${_list_repr(worsened)}（不差于旧版是保留前提）`,
      });
    }
    const improved = common.filter(
      (dim) => new_metrics[dim]! > old_metrics[dim]! + 1e-9,
    );
    if (improved.length > 0) {
      return new GateL3Result({
        passed: true,
        reason: `至少一维严格优于: ${_list_repr(improved)}`,
        dimension_improvements: improved,
        diversity_kept: diversity,
      });
    }
    // 无劣化也无严格优于：等价版本不重复保留（防知识膨胀）——除非多样性
    // 保留显式开启（变体并存为进化提供样本）
    if (diversity) {
      return new GateL3Result({
        passed: true,
        reason: '等价版本按多样性保留（变体并存，供下轮进化）',
        diversity_kept: true,
      });
    }
    return new GateL3Result({
      passed: false,
      reason: '与旧版等价且多样性保留关闭（无新增价值不落库）',
    });
  }

  // ── 组合入口：L1 → L2 → L3 顺序执行（短路：前关不过不后走）──

  /**
   * 三层闸门组合入口（逐层收口）：l1 不过 → l2/l3 为短路占位；new_metrics
   * 缺省从 L2 派生；通过三层后启用人工审核时须人工确认才放行（拒绝则 L3
   * 结果为未通过）。
   *
   * @returns [l1, l2, l3] 三层结果
   */
  async check(
    entry: KnowledgeEntry,
    options: {
      schema: SchemaSpec;
      fixtures: FixtureSet;
      old_metrics?: Record<string, number> | null;
      new_metrics?: Record<string, number> | null;
      regression?: FixtureSet | null;
      context_rules?: JsonRecord | null;
      security_scan?: Readonly<Record<string, unknown>> | null;
      minimal_fixtures?: FixtureSet | null;
      diversity?: boolean;
    },
  ): Promise<[GateL1Result, GateL2Result, GateL3Result]> {
    const l1 = this.check_l1(options.schema, entry, {
      security_scan: options.security_scan ?? null,
      minimal_fixtures: options.minimal_fixtures ?? null,
    });
    if (!l1.passed) {
      return [
        l1,
        new GateL2Result({ passed: false, note: 'L1 未通过（短路）' }),
        new GateL3Result({ passed: false, reason: 'L1 未通过（短路）' }),
      ];
    }
    const l2 = await this.check_l2(entry, options.fixtures, {
      regression: options.regression ?? null,
      context_rules: options.context_rules ?? null,
    });
    if (!l2.passed) {
      return [
        l1,
        l2,
        new GateL3Result({
          passed: false,
          reason: 'L2 样例测试未全绿（非谈判项）',
        }),
      ];
    }
    const hasNewMetrics =
      options.new_metrics !== undefined &&
      options.new_metrics !== null &&
      Object.keys(options.new_metrics).length > 0;
    const metrics = hasNewMetrics
      ? options.new_metrics!
      : _default_l3_metrics(entry, l2);
    let l3 = this.check_l3(metrics, options.old_metrics ?? null, {
      diversity: options.diversity ?? true,
    });
    if (l3.passed && this.human_reviewer !== null && this.human_review_enabled) {
      const approved = await this.human_reviewer.review(entry, l3);
      if (!approved) {
        l3 = new GateL3Result({
          passed: false,
          reason: '人工审核未通过（L3 之上可选人工层，默认弹卡可关）',
        });
      }
    }
    return [l1, l2, l3];
  }
}
