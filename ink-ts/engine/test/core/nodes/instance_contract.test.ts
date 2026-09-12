/**
 * 实例级契约派生（derive_instance_contract）单测：
 * - 零漂移：config 无 output_field/read_fields → 派生结果 === 原契约；
 * - output_field 分化 → 产出面替换 reply（如 plan/review），输入面不变；
 * - read_fields 分化 → 输入需求面并入必读字段，不影响产出面；
 * - 保留键护栏贯通（_route_to 等经派生同样拒绝）；
 * - safety_tier/version 保留；幂等（对已派生契约再派生 = 契约等价）。
 */
import { describe, expect, it } from 'vitest';

import { NodeContract } from '../../../src/model/contracts/contracts.js';
import { GraphDefinitionError } from '../../../src/model/errors.js';
import {
  required_field_names,
  produced_field_names,
} from '../../../src/core/link_validator/link_validator.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/model/schema/schemaValidator.js';
import { derive_instance_contract } from '../../../src/core/nodes/instance_contract.js';
import { llm_decider_contract } from '../../../src/core/nodes/llm_decider.js';
import { router_judge_contract } from '../../../src/core/nodes/router.js';

function names(contract: NodeContract, which: 'in' | 'out'): string[] {
  const schema = which === 'in' ? contract.input_schema : contract.output_schema;
  const set = which === 'in' ? required_field_names(schema) : produced_field_names(schema);
  return [...set].sort();
}

describe('零漂移：无字段分化的 config 派生 = 原契约', () => {
  it('空 config / 只含无关键 / 只含 max_tool_rounds → 返回原契约实例', () => {
    const base = llm_decider_contract();
    expect(derive_instance_contract(base, {})).toBe(base);
    expect(derive_instance_contract(base, { max_tool_rounds: 8 })).toBe(base);
    expect(derive_instance_contract(base, { system_prompt: 'x' })).toBe(base);
    // 显式 output_field=reply（等价现状写入键）也不改变契约
    expect(derive_instance_contract(base, { output_field: 'reply' })).toBe(base);
  });
});

describe('output_field 分化 → 产出面', () => {
  it('llm_decider 基契约 + output_field=plan → 产出 {plan}（不再含 reply）；输入面保持空', () => {
    const derived = derive_instance_contract(llm_decider_contract(), { output_field: 'plan' });
    expect(names(derived, 'out')).toEqual(['plan']);
    expect(names(derived, 'in')).toEqual([]);
    expect(derived.safety_tier).toBe(0);
    expect(derived.version).toBe(1);
  });

  it('读入字段不影响产出面；输出=review 只替换 reply', () => {
    const derived = derive_instance_contract(llm_decider_contract(), {
      read_fields: ['plan'],
      output_field: 'review',
    });
    expect(names(derived, 'out')).toEqual(['review']);
    expect(names(derived, 'in')).toEqual(['plan']);
  });
});

describe('read_fields 分化 → 输入需求面', () => {
  it('llm_main 形态：读 plan+review 出 reply → 需求面 {plan,review}、产出面 {reply}', () => {
    const derived = derive_instance_contract(llm_decider_contract(), {
      read_fields: ['plan', 'review'],
    });
    expect(names(derived, 'in')).toEqual(['plan', 'review']);
    expect(names(derived, 'out')).toEqual(['reply']);
  });

  it('router_judge 基契约 + read plan → 需求面并入 plan、产出面保持 _route_to', () => {
    const derived = derive_instance_contract(router_judge_contract(), {
      read_fields: ['plan'],
    });
    expect(names(derived, 'in')).toEqual(['plan']);
    expect(names(derived, 'out')).toEqual(['_route_to']);
  });

  it('既有必填输入面的类型并入 read_fields（并集，不丢原字段）', () => {
    const custom = new NodeContract({
      input_schema: new SchemaSpec({
        name: 'custom.in',
        fields: [new SchemaField({ name: 'query', required: true, kind: FIELD_STRING })],
      }),
      output_schema: null,
    });
    const derived = derive_instance_contract(custom, { read_fields: ['plan'] });
    expect(names(derived, 'in')).toEqual(['plan', 'query']);
  });
});

describe('护栏与幂等', () => {
  it('保留键（_route_to 等）作 output_field 经派生同样拒绝', () => {
    expect(() =>
      derive_instance_contract(llm_decider_contract(), { output_field: '_route_to' }),
    ).toThrow(GraphDefinitionError);
  });

  it('幂等：对已派生实例契约再以同 config 派生 = 契约等价（to_dict 相同）', () => {
    const first = derive_instance_contract(llm_decider_contract(), {
      output_field: 'plan',
      read_fields: ['plan'],
    });
    const second = derive_instance_contract(first, {
      output_field: 'plan',
      read_fields: ['plan'],
    });
    expect(second.to_dict()).toEqual(first.to_dict());
  });
});
