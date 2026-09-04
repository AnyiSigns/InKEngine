/**
 * 规则数据形态：RuleViolation / Rule / RuleSet（rules.py 数据段移植）。
 *
 * 三种数据全部可 JSON 序列化，随补丁链版本化/回退；from_dict 构造即
 * 校验——字段形态/枚举值非法建图期拒绝，不以 str() 静默强转（int 5
 * 不会被吞成 "5"）。RuleSet.parse 额外做谓词存在性与 config 形态校验，
 * 声明错误在建图期暴露，不延后到执行期 fail-open 静默失效。
 */

import type { Json, JsonRecord } from '../json.js';
import { isRecord, typeName } from '../json.js';
import { GraphDefinitionError } from '../errors.js';
import {
  RULE_CONSTRAINT,
  SEVERITY_ERROR,
  _VALID_RULE_TYPES,
  _VALID_SEVERITIES,
  type RuleConfig,
  type RulePredicate,
} from './_types.js';
import { pyRepr } from './_py.js';
import type { RuleTypeRegistry } from './registry.js';

/** 一条规则违规（可序列化，审核卡 conflicts 字段的可对齐单元）。 */
export class RuleViolation {
  /** 来源规则 id（钩子违规为 "__llm_hook__"）。 */
  readonly rule_id: string;
  /** 违规类别（领域标签，如 knowledge_gap/causal_chain）。 */
  readonly kind: string;
  /** 严重度：error = 硬冲突需裁决 / warning = 提示级。 */
  readonly severity: string;
  /** 人类可读的违规说明。 */
  readonly message: string;
  /** 关联实体类型（character/event/foreshadowing 等）。 */
  readonly entity_type: string | null;
  /** 关联实体 id。 */
  readonly entity_id: unknown;

  constructor(init: {
    rule_id: string;
    kind: string;
    severity: string;
    message: string;
    entity_type?: string | null;
    entity_id?: unknown;
  }) {
    this.rule_id = init.rule_id;
    this.kind = init.kind;
    this.severity = init.severity;
    this.message = init.message;
    this.entity_type = init.entity_type === undefined ? null : init.entity_type;
    this.entity_id = init.entity_id === undefined ? null : init.entity_id;
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      rule_id: this.rule_id,
      kind: this.kind,
      severity: this.severity,
      message: this.message,
      entity_type: this.entity_type,
      entity_id: (this.entity_id ?? null) as Json,
    };
  }

  /**
   * 从存储/传输数据还原（构造即校验：字段形态非法建图期拒绝）。
   *
   * 与 Rule.from_dict 对齐——强类型校验，非法类型抛 GraphDefinitionError，
   * 不以 str() 静默强转（int 5 不会被吞成 "5"）。rule_id / message 为
   * 必填，缺失或类型非法拒绝。
   */
  static from_dict(data: unknown): RuleViolation {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `违规声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const rule_id = data['rule_id'];
    if (!rule_id || typeof rule_id !== 'string') {
      throw new GraphDefinitionError('违规声明缺 rule_id（字符串）');
    }
    const message = data['message'];
    if (typeof message !== 'string') {
      throw new GraphDefinitionError('违规声明缺 message（字符串）');
    }
    const kind = data['kind'] === undefined ? 'rule' : data['kind'];
    if (typeof kind !== 'string') {
      throw new GraphDefinitionError('违规声明的 kind 须为字符串');
    }
    const severity = data['severity'] === undefined ? SEVERITY_ERROR : data['severity'];
    if (typeof severity !== 'string' || !_VALID_SEVERITIES.includes(severity as never)) {
      throw new GraphDefinitionError(
        `违规声明的严重度非法: ${pyRepr(severity)}（仅 ${_VALID_SEVERITIES.join(', ')}）`,
      );
    }
    const entity_type = data['entity_type'];
    if (entity_type !== undefined && entity_type !== null && typeof entity_type !== 'string') {
      throw new GraphDefinitionError('违规声明的 entity_type 须为字符串或省略');
    }
    const entity_id = data['entity_id'];
    if (entity_id !== undefined && entity_id !== null && typeof entity_id !== 'string') {
      throw new GraphDefinitionError('违规声明的 entity_id 须为字符串或省略');
    }
    return new RuleViolation({
      rule_id,
      kind,
      severity,
      message,
      entity_type: entity_type === undefined || entity_type === null ? null : entity_type,
      entity_id: entity_id === undefined || entity_id === null ? null : entity_id,
    });
  }
}

/** 一条声明式规则（纯数据：谓词名 + 参数，不携带执行代码）。 */
export class Rule {
  /** 规则 id（规则集内唯一，留痕/夹具断言锚点）。 */
  readonly id: string;
  /** 注册谓词名（RuleTypeRegistry 解析；未知谓词建图期拒绝）。 */
  readonly predicate: string;
  /** 谓词参数（数据访问路径/目标值/阈值等，谓词自解释）。 */
  readonly config: RuleConfig;
  /** 规则类型（constraint = 约束/校验，transition = 状态转换）。 */
  readonly type: string;
  /** 数据对象上的作用域路径（点分路径；null = 整对象）。 */
  readonly target_path: string | null;
  /** 目标为集合时逐条执行谓词（False = 谓词接收整个目标）。 */
  readonly iterate_items: boolean;
  /** 违规严重度（error/warning）。 */
  readonly severity: string;
  /** 违规类别标签（领域语义，留痕与夹具断言用）。 */
  readonly kind: string;
  /** 关联实体类型（留痕）。 */
  readonly entity_type: string | null;
  /** 规则说明（人类可读，可解释性）。 */
  readonly description: string;

  constructor(init: {
    id: string;
    predicate: string;
    config?: RuleConfig;
    type?: string;
    target_path?: string | null;
    iterate_items?: boolean;
    severity?: string;
    kind?: string;
    entity_type?: string | null;
    description?: string;
  }) {
    this.id = init.id;
    this.predicate = init.predicate;
    this.config = { ...init.config };
    this.type = init.type ?? RULE_CONSTRAINT;
    this.target_path = init.target_path === undefined ? null : init.target_path;
    this.iterate_items = init.iterate_items ?? false;
    this.severity = init.severity ?? SEVERITY_ERROR;
    this.kind = init.kind ?? 'rule';
    this.entity_type = init.entity_type === undefined ? null : init.entity_type;
    this.description = init.description ?? '';
    Object.freeze(this);
  }

  /** 序列化（缺省字段不落盘——最小数据形态）。 */
  to_dict(): JsonRecord {
    const data: JsonRecord = {
      id: this.id,
      predicate: this.predicate,
      config: { ...this.config },
    };
    if (this.type !== RULE_CONSTRAINT) data['type'] = this.type;
    if (this.target_path !== null) data['target_path'] = this.target_path;
    if (this.iterate_items) data['iterate_items'] = true;
    if (this.severity !== SEVERITY_ERROR) data['severity'] = this.severity;
    if (this.kind !== 'rule') data['kind'] = this.kind;
    if (this.entity_type !== null) data['entity_type'] = this.entity_type;
    if (this.description) data['description'] = this.description;
    return data;
  }

  /** 从声明数据还原（构造即校验：字段形态/枚举值非法建图期拒绝）。 */
  static from_dict(data: unknown): Rule {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `规则声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const rule_id = data['id'];
    const predicate = data['predicate'];
    if (!rule_id || typeof rule_id !== 'string') {
      throw new GraphDefinitionError('规则声明缺 id（字符串）');
    }
    if (!predicate || typeof predicate !== 'string') {
      throw new GraphDefinitionError(`规则 ${rule_id} 缺 predicate（字符串）`);
    }
    const config = isRecord(data['config']) ? (data['config'] as RuleConfig) : {};
    if (data['config'] !== undefined && data['config'] !== null && !isRecord(data['config'])) {
      throw new GraphDefinitionError(
        `规则 ${rule_id} 的 config 须为 dict，收到 ${typeName(data['config'])}`,
      );
    }
    const rule_type = data['type'] === undefined ? RULE_CONSTRAINT : data['type'];
    if (typeof rule_type !== 'string' || !_VALID_RULE_TYPES.includes(rule_type as never)) {
      throw new GraphDefinitionError(
        `规则 ${rule_id} 的类型非法: ${pyRepr(rule_type)}（仅 ${_VALID_RULE_TYPES.join(', ')}）`,
      );
    }
    const severity = data['severity'] === undefined ? SEVERITY_ERROR : data['severity'];
    if (typeof severity !== 'string' || !_VALID_SEVERITIES.includes(severity as never)) {
      throw new GraphDefinitionError(
        `规则 ${rule_id} 的严重度非法: ${pyRepr(severity)}（仅 ${_VALID_SEVERITIES.join(', ')}）`,
      );
    }
    const target_path = data['target_path'];
    if (target_path !== undefined && target_path !== null && typeof target_path !== 'string') {
      throw new GraphDefinitionError(`规则 ${rule_id} 的 target_path 须为字符串或省略`);
    }
    const iterate_items = data['iterate_items'] === undefined ? false : data['iterate_items'];
    if (typeof iterate_items !== 'boolean') {
      throw new GraphDefinitionError(`规则 ${rule_id} 的 iterate_items 须为布尔值`);
    }
    const kind = data['kind'] === undefined ? 'rule' : data['kind'];
    if (typeof kind !== 'string') {
      throw new GraphDefinitionError(`规则 ${rule_id} 的 kind 须为字符串`);
    }
    const entity_type = data['entity_type'];
    if (entity_type !== undefined && entity_type !== null && typeof entity_type !== 'string') {
      throw new GraphDefinitionError(`规则 ${rule_id} 的 entity_type 须为字符串或省略`);
    }
    const description = data['description'] === undefined ? '' : data['description'];
    if (typeof description !== 'string') {
      throw new GraphDefinitionError(`规则 ${rule_id} 的 description 须为字符串`);
    }
    return new Rule({
      id: rule_id,
      predicate,
      config,
      type: rule_type,
      target_path: target_path === undefined ? null : target_path,
      iterate_items,
      severity,
      kind,
      entity_type: entity_type === undefined || entity_type === null ? null : entity_type,
      description,
    });
  }
}

/** 规则集（知识集内规则的载体，纯数据可随补丁链版本化/回退）。 */
export class RuleSet {
  /** 规则集名（如 domain.main）。 */
  readonly name: string;
  /** 规则序列（按声明序执行）。 */
  readonly rules: readonly Rule[];
  /** 规则集说明。 */
  readonly description: string;

  constructor(init: { name: string; rules: readonly Rule[]; description?: string }) {
    this.name = init.name;
    this.rules = [...init.rules];
    this.description = init.description ?? '';
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      name: this.name,
      description: this.description,
      rules: this.rules.map((rule) => rule.to_dict()),
    };
  }

  /** 从声明数据还原（逐条规则构造即校验，非法声明建图期拒绝）。 */
  static from_dict(data: unknown): RuleSet {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `规则集声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const name = data['name'];
    if (!name || typeof name !== 'string') {
      throw new GraphDefinitionError('规则集缺 name（字符串）');
    }
    const raw_rules = data['rules'];
    if (!Array.isArray(raw_rules)) {
      throw new GraphDefinitionError('规则集缺 rules 清单');
    }
    return new RuleSet({
      name,
      rules: raw_rules.map((raw) => Rule.from_dict(raw)),
      description: (data['description'] ?? '') as string,
    });
  }

  /**
   * 解析并校验规则集声明（谓词名存在性在建图期暴露，不延后到执行期）。
   *
   * registry 提供时逐条校验谓词已注册（未知谓词 = 声明错误，显式拒绝
   * 而非执行期静默跳过），并做谓词 config 形态校验。
   */
  static parse(data: unknown, registry?: RuleTypeRegistry | null): RuleSet {
    const rule_set = RuleSet.from_dict(data);
    const seen = new Set<string>();
    for (const rule of rule_set.rules) {
      if (seen.has(rule.id)) {
        throw new GraphDefinitionError(
          `规则集 ${rule_set.name} 规则 id 重复: ${rule.id}`,
        );
      }
      seen.add(rule.id);
      if (registry !== undefined && registry !== null) {
        if (!registry.has(rule.predicate)) {
          throw new GraphDefinitionError(
            `规则集 ${rule_set.name} 引用了未注册的谓词: ` +
              `${rule.predicate}（规则 ${rule.id}）`,
          );
        }
        registry.validate_config(rule.id, rule.predicate, rule.config);
      }
    }
    return rule_set;
  }
}

/** RulePredicate 类型由注册表消费方引用（类型面一致性锚点）。 */
export type { RulePredicate };