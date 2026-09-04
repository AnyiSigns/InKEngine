/**
 * 实体变异三层闸门（entity_evolution.py EntityMutationGate 移植）。
 *
 * 复用 KnowledgeGate 判定件（注入扫描 / L1 组合 / L3 目标筛选），按实体
 * 形态适配：
 * - L1：教训增量（persona 的新增面）过指令注入扫描 + 实体声明可构造 /
 *   身份保留 / 模型引用三项安全扫描（persona 旧面在创建/先前变异时已过
 *   审，不重复扫描全量——防熵启发对长中文混英文 persona 误伤）；
 * - L2：变异无规则执行语义——确定性放行 + 留痕（结构一致性已在 L1 声明
 *   可构造关覆盖）；
 * - L3：教训覆盖严格增（coverage 维度）才替换，等价版本拒绝（同因重复
 *   天然不过）。
 */

import { EntitySpec } from '../entities/entities.js';
import {
  GateL1Result,
  GateL2Result,
  GateL3Result,
} from '../knowledge_gate/_results.js';
import { KnowledgeGate } from '../knowledge_gate/knowledge_gate.js';
import { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';
import {
  KIND_INSIGHT,
  LEVEL_WORK,
  SOURCE_MODEL,
} from '../knowledge_set/index.js';
import {
  FIELD_OBJECT,
  FIELD_STRING,
  SchemaField,
  SchemaSpec,
} from '../schema/schemaValidator.js';

/** 实体变异三层闸门判定选项（与 Python kw-only 参数一一对应）。 */
export interface EntityMutationCheckOptions {
  new_coverage: number;
  old_coverage: number;
  lesson_text: string;
}

/** 教训增量的 L1 schema（persona_delta 字段关；注入扫描兜底）。 */
function _delta_schema(): SchemaSpec {
  return new SchemaSpec({
    name: 'entity.evolution',
    fields: [
      new SchemaField({ name: 'id', required: true, kind: FIELD_STRING }),
      new SchemaField({ name: 'level', required: true, kind: FIELD_STRING }),
      new SchemaField({ name: 'kind', required: true, kind: FIELD_STRING }),
      new SchemaField({ name: 'data', required: true, kind: FIELD_OBJECT }),
    ],
  });
}

/** 实体变异三层闸门（L1 声明+注入 / L2 结构一致 / L3 严格更优）。 */
export class EntityMutationGate {
  readonly #gate: KnowledgeGate;

  constructor(options: { gate?: KnowledgeGate | null } = {}) {
    this.#gate =
      options.gate ?? new KnowledgeGate({ human_review_enabled: false });
  }

  /** 变异三层闸门（短路语义与 KnowledgeGate.check 对齐）。
   *
   * @returns [l1, l2, l3]：三层结果；l1 不过时 l2/l3 为未执行占位。 */
  async check(
    mutated: EntitySpec,
    current: EntitySpec,
    opts: EntityMutationCheckOptions,
  ): Promise<[GateL1Result, GateL2Result, GateL3Result]> {
    const entry = new KnowledgeEntry({
      id: `entity:${mutated.id}`,
      level: LEVEL_WORK,
      kind: KIND_INSIGHT,
      data: { persona_delta: opts.lesson_text },
      source: SOURCE_MODEL,
      title: `实体演化:${mutated.id}`,
      tags: ['entity', 'evolution'],
    });
    const l1 = this.#gate.check_l1(_delta_schema(), entry, {
      security_scan: {
        实体声明可构造: EntityMutationGate._constructible(mutated),
        身份保留: mutated.id === current.id,
        模型引用合法: EntityMutationGate._model_ok(mutated),
      },
    });
    if (!l1.passed) {
      return [
        l1,
        new GateL2Result({ passed: false, note: 'L1 未通过（短路）' }),
        new GateL3Result({ passed: false, reason: 'L1 未通过（短路）' }),
      ];
    }
    const l2 = new GateL2Result({
      passed: true,
      note: '实体变异无规则执行语义（L2 结构一致性校验通过）',
    });
    const l3 = this.#gate.check_l3(
      { coverage: opts.new_coverage, safety: 1.0 },
      { coverage: opts.old_coverage, safety: 1.0 },
      { diversity: false },
    );
    return [l1, l2, l3];
  }

  /** 实体声明可构造（变异产物能重新加载 = 声明层面合法）。 */
  private static _constructible(spec: EntitySpec): boolean {
    try {
      EntitySpec.from_dict(spec.to_dict());
      return true;
    } catch {
      return false;
    }
  }

  /** 模型引用合法（null = 会话默认模型；声明形态须成对）。 */
  private static _model_ok(spec: EntitySpec): boolean {
    if (spec.model === null || spec.model === undefined) {
      return true;
    }
    return Boolean(spec.model['provider'] && spec.model['model_id']);
  }
}
