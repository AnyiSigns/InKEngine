/**
 * 知识闸门测试共享设施（Python test_knowledge_incubator.py 三层验证闸门段
 * _rule_schema/_fixtures/_registry/_rule_entry 工厂的 TS 对应物）。
 *
 * 领域谓词 forbid_value 语义：目标 data 的 value 字段等于 config.forbid 时
 * 产出一条违规（kind = 规则的 kind 声明，样例断言按 kind 对齐）——让样例
 * 闸门语义可读可判定（forbid=ok 会把正常用例拦下 = 坏规则）。
 */

import type { JsonRecord } from '../../../src/core/json.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import { KIND_INSIGHT, KIND_RULE, LEVEL_WORK } from '../../../src/core/knowledge_set/_types.js';
import { FixtureCase, FixtureSet, RuleTypeRegistry } from '../../../src/core/rules/index.js';
import { SchemaSpec } from '../../../src/core/schema/schemaValidator.js';

/** 规则条目 schema（knowledge_entry 形态；data.rule.message 必填）。 */
export function rule_schema(): SchemaSpec {
  return SchemaSpec.from_dict({
    name: 'knowledge_entry',
    fields: [
      { name: 'id', required: true, kind: 'string' },
      {
        name: 'level',
        required: true,
        kind: 'string',
        enum: ['work', 'project', 'user'],
      },
      { name: 'kind', required: true, kind: 'string' },
      { name: 'credibility', kind: 'number', min: 0.0, max: 1.0 },
      { name: 'data.rule.message', kind: 'string', required: true },
    ],
  });
}

/** L2/L1 完整样例库：pass1 期望零违规，fail1 期望 rule 类违规出现。 */
export function fixtures(): FixtureSet {
  return new FixtureSet({
    name: 'demo',
    cases: [
      new FixtureCase({ id: 'pass1', data: { value: 'ok' }, expected_pass: true }),
      new FixtureCase({
        id: 'fail1',
        data: { value: 'bad' },
        expected_pass: false,
        expected_kinds: ['rule'],
      }),
    ],
  });
}

/** 领域谓词注册表：forbid_value（value == config.forbid → 违规）。 */
export function rule_registry(): RuleTypeRegistry {
  const registry = new RuleTypeRegistry();
  registry.register('forbid_value', (target, config) => {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      return [];
    }
    const record = target as JsonRecord;
    if (record['value'] === config['forbid']) {
      return [{ message: '禁止值命中' }];
    }
    return [];
  });
  return registry;
}

/** 规则条目工厂（rule 声明含 message/predicate=forbid_value/config.forbid）。 */
export function rule_entry(message = '规则', forbid = 'bad'): KnowledgeEntry {
  return new KnowledgeEntry({
    id: 'k-1',
    level: LEVEL_WORK,
    kind: KIND_RULE,
    data: {
      rule: {
        id: 'r-1',
        message,
        predicate: 'forbid_value',
        config: { forbid },
        kind: 'rule',
      },
    },
    source: 'model',
    credibility: 0.7,
    title: '规则',
  });
}

/** 最小 schema：仅 id/level/kind（无执行语义条目过闸用）。 */
export function entry_schema(): SchemaSpec {
  return SchemaSpec.from_dict({
    name: 'knowledge_entry',
    fields: [
      { name: 'id', required: true, kind: 'string' },
      { name: 'level', required: true, kind: 'string' },
      { name: 'kind', required: true, kind: 'string' },
    ],
  });
}

/** 任意 kind 条目工厂（skip 类别/非规则条目过闸用）。 */
export function entry_of(kind: string, data: JsonRecord = {}): KnowledgeEntry {
  return new KnowledgeEntry({
    id: `k-${kind}`,
    level: LEVEL_WORK,
    kind,
    data,
    source: 'model',
    credibility: 0.7,
    title: '条目',
  });
}

/** insight 条目（教训形态：insight.message 内容面）。 */
export function insight_entry(message: string): KnowledgeEntry {
  return new KnowledgeEntry({
    id: 'k-insight',
    level: LEVEL_WORK,
    kind: KIND_INSIGHT,
    data: { insight: { message } },
    source: 'user',
    credibility: 0.7,
    title: '教训',
  });
}
