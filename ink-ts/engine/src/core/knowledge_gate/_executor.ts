/**
 * L2 效果评估执行器（knowledge_gate.py KnowledgeExecutor/GateL2FixtureExecutor
 * 段移植）。
 *
 * 执行器契约 = 引擎规定输入输出形态与失败兜底，执行体由使用方注入（默认
 * 执行器只覆盖规则引擎可评估的条目）。对 kind=rule/tool_rule 条目（data 为
 * Rule 声明形态）：组装 RuleSet → 样例库全量评估——样例测试为非谈判项
 * （fixture 全绿才可进入 L3），失败明细随结果留痕；声明/执行类条目（教训/
 * 模板/权重/路径技能/脚本）无谓词实现，L2 跳过规则执行并显式放行留痕
 * （L1 注入扫描与形式校验已覆盖其安全与结构）；其余形态 = 显式拒绝（由
 * 使用方注入领域执行器，不静默放行）。
 *
 * context_rules 提供时按「旧规则集 + 候选规则」合并评估：样例面向整套规则
 * 集语义设计时，单条候选无法单独全绿，合并后按整套语义共同判定。
 *
 * 时间 seam：耗时统计用注入的 monotonic（秒级，对齐 Python time.monotonic）；
 * 缺省恒 0 = 确定性基线（core 零 IO 纪律——不依赖真实时钟，指标留痕在宿主
 * 注入真实时钟后才有意义）。
 */

import { FixtureGateError, GraphDefinitionError } from '../errors.js';
import type { Json, JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import {
  KIND_INSIGHT,
  KIND_PATH,
  KIND_SCRIPT,
  KIND_TEMPLATE,
  KIND_WEIGHT,
} from '../knowledge_set/_types.js';
import type { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';
import { assert_fixtures_pass, RuleEngine, RuleSet } from '../rules/index.js';
import type { FixtureSet, RuleTypeRegistry } from '../rules/index.js';
import { SchemaValidator } from '../schema/schemaValidator.js';
import { GateL2Result } from './_results.js';

/** 缺省耗时基准：确定性基线（恒 0——core 不依赖真实时钟）。 */
const DEFAULT_MONOTONIC = (): number => 0;

/**
 * L2 效果评估的执行器协议（引擎规定契约，执行体由使用方注入）。
 *
 * 实现方负责「把知识作为规则加载并评估样例」的领域语义（如规则引擎加载
 * 规则集跑 fixture），引擎只规定输入输出形态与失败兜底。
 */
export interface KnowledgeExecutor {
  /** context_rules：上下文规则集声明（旧集 + 候选合并评估的基底；
   *  None = 仅按候选自身评估）。 */
  run(
    entry: KnowledgeEntry,
    fixtures: FixtureSet,
    options?: { context_rules?: JsonRecord | null },
  ): Promise<GateL2Result>;
}

/** 无规则执行语义、L2 跳过规则执行的条目类别（L1 已覆盖安全与结构）。 */
const SKIP_EXECUTION_KINDS: ReadonlySet<string> = new Set([
  KIND_INSIGHT,
  KIND_TEMPLATE,
  KIND_WEIGHT,
  KIND_PATH,
  KIND_SCRIPT,
]);

/** L2 默认执行器：规则条目经规则引擎跑完整 fixtures（确定性基线）。 */
export class GateL2FixtureExecutor {
  private readonly _schema_validator: SchemaValidator;
  private readonly _registry: RuleTypeRegistry | null;
  private readonly _monotonic: () => number;

  constructor(
    registry?: RuleTypeRegistry | null,
    options?: { monotonic?: () => number },
  ) {
    this._schema_validator = new SchemaValidator();
    this._registry = registry ?? null;
    this._monotonic = options?.monotonic ?? DEFAULT_MONOTONIC;
  }

  async run(
    entry: KnowledgeEntry,
    fixtures: FixtureSet,
    options: { context_rules?: JsonRecord | null } = {},
  ): Promise<GateL2Result> {
    if (SKIP_EXECUTION_KINDS.has(entry.kind)) {
      return new GateL2Result({
        passed: true,
        note: `${entry.kind} 条目（无执行语义，L2 跳过规则执行；` +
          'L1 注入扫描与形式校验已覆盖）',
      });
    }
    if (entry.kind !== 'rule' && entry.kind !== 'tool_rule') {
      return new GateL2Result({
        passed: false,
        note: `非规则条目（kind=${entry.kind}）需注入领域执行器`,
      });
    }
    const rawRule = entry.data['rule'];
    if (!isRecord(rawRule)) {
      return new GateL2Result({ passed: false, note: '规则条目缺 data.rule 声明' });
    }
    let ruleSet: RuleSet;
    try {
      const contextRules = options.context_rules ?? null;
      if (contextRules !== null) {
        const merged: JsonRecord = { ...contextRules };
        const existing = contextRules['rules'];
        const rules: unknown[] = Array.isArray(existing) ? [...existing] : [];
        rules.push(rawRule);
        merged['rules'] = rules as Json[];
        ruleSet = RuleSet.parse(merged, this._registry);
      } else {
        ruleSet = RuleSet.parse(
          { name: `entry-${entry.id}`, rules: [rawRule] },
          this._registry,
        );
      }
    } catch (error) {
      if (error instanceof GraphDefinitionError) {
        return new GateL2Result({
          passed: false,
          note: `规则声明非法: ${error.message}`,
        });
      }
      throw error;
    }
    const start = this._monotonic();
    try {
      assert_fixtures_pass(ruleSet, fixtures, {
        engine: new RuleEngine(this._registry),
      });
    } catch (error) {
      if (error instanceof FixtureGateError || error instanceof GraphDefinitionError) {
        return new GateL2Result({
          passed: false,
          accuracy: 0.0,
          latency_ms: (this._monotonic() - start) * 1000,
          note: error.message,
        });
      }
      throw error;
    }
    return new GateL2Result({
      passed: true,
      accuracy: 1.0,
      latency_ms: (this._monotonic() - start) * 1000,
      regression_samples: fixtures.cases.length,
    });
  }
}
