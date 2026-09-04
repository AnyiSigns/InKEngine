/**
 * core/link_validator 测试：规则矩阵（字段覆盖/多源汇聚/reducer/安全档/版本/确定性）。
 *
 * 对标 pytest test_link_validator.py（27 个用例逐一对齐）。两级语义分断言：
 * 前缀可达性（弱校验，组装/路径校验用）不误杀多源汇聚合法路径；相邻覆盖
 * （强校验，显式边/手绘图用）只认直接覆盖。其余规则按矩阵逐条断言，
 * 理由顺序稳定可断言。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { NodeContract } from '../../../src/core/contracts/contracts.js';
import {
  produced_field_names,
  required_field_names,
  validate_link,
  validate_prefix_reachability,
} from '../../../src/core/link_validator/link_validator.js';
import {
  FIELD_ARRAY,
  FIELD_NUMBER,
  FIELD_OBJECT,
  FIELD_STRING,
  SchemaField,
  SchemaSpec,
  type FieldKind,
} from '../../../src/core/schema/schemaValidator.js';
import { StateSchema } from '../../../src/core/state/schema.js';

function _field(name: string, required = false, kind: FieldKind = FIELD_STRING): SchemaField {
  return new SchemaField({ name, required, kind });
}

function _spec(name: string, ...fields: SchemaField[]): SchemaSpec {
  return new SchemaSpec({ name, fields });
}

function _contract(init: {
  input_schema?: SchemaSpec | null;
  output_schema?: SchemaSpec | null;
  safety_tier?: number;
  version?: number;
} = {}): NodeContract {
  return new NodeContract(init);
}

function _channel_schema(): StateSchema {
  return new StateSchema({
    metrics: 'merge_metrics',
    notes: null,
    messages: 'add_messages',
  });
}

describe('相邻覆盖（强校验）', () => {
  it('test_adjacent_coverage_pass：起点产出覆盖目标必填输入', () => {
    const src = _contract({ output_schema: _spec('out', _field('x'), _field('y')) });
    const dst = _contract({ input_schema: _spec('in', _field('x', true)) });
    const [ok, reasons] = validate_link(src, dst);
    expect(ok).toBe(true);
    expect(reasons).toEqual([]);
  });

  it('test_adjacent_coverage_missing_required_rejected：必填缺覆盖拒绝，理由含全部缺字段且排序稳定', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')) });
    const dst = _contract({
      input_schema: _spec('in', _field('y', true), _field('x', true)),
    });
    const [ok, reasons] = validate_link(src, dst);
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('目标必填输入字段未被起点产出覆盖') && r.includes('y'))).toBe(true);
    expect(reasons.join('')).not.toContain('x'); // x 已覆盖，不误报
  });

  it('test_optional_input_not_covered_is_fine：可选输入不要求覆盖（宽容演进）', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')) });
    const dst = _contract({ input_schema: _spec('in', _field('z')) });
    expect(validate_link(src, dst)[0]).toBe(true);
  });

  it('test_adjacent_coverage_ignores_extra_outputs：起点多余产出不阻断链接', () => {
    const src = _contract({ output_schema: _spec('out', _field('x'), _field('extra')) });
    const dst = _contract({ input_schema: _spec('in', _field('x', true)) });
    expect(validate_link(src, dst)[0]).toBe(true);
  });
});

describe('前缀可达性（弱校验）+ 两级语义分断言', () => {
  it('test_multi_source_path_not_killed_by_adjacent_coverage：多源汇聚放行，相邻覆盖拒绝', () => {
    const producer_a = _contract({ output_schema: _spec('a', _field('code')) });
    const producer_b = _contract({ output_schema: _spec('b', _field('tests')) });
    const qa = _contract({
      input_schema: _spec('qa', _field('code', true), _field('tests', true)),
    });
    const [ok, reasons] = validate_prefix_reachability([producer_a, producer_b, qa]);
    expect(ok).toBe(true);
    void reasons;
    // 对照：相邻覆盖只认直接覆盖——单源链接校验必失败（多源路径不被误杀的证据）
    expect(validate_link(producer_a, qa)[0]).toBe(false);
    expect(validate_link(producer_b, qa)[0]).toBe(false);
  });

  it('test_prefix_reachability_uses_entry_fields：入口字段注入', () => {
    const entry = _contract({ input_schema: _spec('in', _field('goal', true)) });
    expect(validate_prefix_reachability([entry], { entry_fields: ['goal'] })[0]).toBe(true);
    const [ok, reasons] = validate_prefix_reachability([entry]);
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('输入字段不可达') && r.includes('goal'))).toBe(true);
  });

  it('test_prefix_reachability_gap_rejected：字段缺口拒绝', () => {
    const a = _contract({ output_schema: _spec('a', _field('code')) });
    const c = _contract({
      input_schema: _spec('c', _field('code', true), _field('tests', true)),
    });
    const [ok, reasons] = validate_prefix_reachability([a, c]);
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('tests'))).toBe(true);
  });

  it('test_prefix_reachability_no_contract_rejected：无契约结点不可参与组装', () => {
    const with_contract = _contract({ output_schema: _spec('o', _field('x')) });
    const [ok, reasons] = validate_prefix_reachability([null, with_contract]);
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('无契约'))).toBe(true);
  });
});

describe('安全档', () => {
  it('test_safety_tier_pruning_link：目标安全档超请求档位剪枝拒绝，同档放行', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')) });
    const high = _contract({ input_schema: _spec('in', _field('x', true)), safety_tier: 2 });
    const [ok, reasons] = validate_link(src, high, { max_safety_tier: 1 });
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('安全档') && r.includes('2'))).toBe(true);
    expect(validate_link(src, high, { max_safety_tier: 2 })[0]).toBe(true);
  });

  it('test_safety_tier_default_strictest：请求档位缺省 0 最严', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')) });
    const mid = _contract({ input_schema: _spec('in', _field('x', true)), safety_tier: 1 });
    expect(validate_link(src, mid)[0]).toBe(false);
  });

  it('test_safety_tier_pruning_sequence：路径校验逐结点剪枝', () => {
    const node = _contract({ safety_tier: 2 });
    expect(validate_prefix_reachability([node], { max_safety_tier: 1 })[0]).toBe(false);
    expect(validate_prefix_reachability([node], { max_safety_tier: 2 })[0]).toBe(true);
  });

  it('test_request_tier_out_of_range_rejected：请求档位越界 = 声明错误 fail-fast', () => {
    expect(() => validate_link(null, null, { max_safety_tier: 3 })).toThrow(GraphDefinitionError);
    expect(() => validate_link(null, null, { max_safety_tier: 3 })).toThrow(/档位越界/);
    expect(() => validate_prefix_reachability([], { max_safety_tier: -1 })).toThrow(
      GraphDefinitionError,
    );
    expect(() => validate_prefix_reachability([], { max_safety_tier: -1 })).toThrow(/档位越界/);
  });
});

describe('契约版本存在性', () => {
  it('test_version_registered_passes：两端版本均已登记放行', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')), version: 1 });
    const dst = _contract({ input_schema: _spec('in', _field('x', true)), version: 1 });
    const known = { producer: new Set([1]), consumer: new Set([1]) };
    const [ok, reasons] = validate_link(src, dst, {
      src_type: 'producer',
      dst_type: 'consumer',
      known_versions: known,
    });
    expect(ok).toBe(true);
    void reasons;
  });

  it('test_version_unregistered_rejected：引用的契约版本未登记拒绝', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')), version: 1 });
    const dst = _contract({ input_schema: _spec('in', _field('x', true)), version: 2 });
    const known = { producer: new Set([1]), consumer: new Set([1]) };
    const [ok, reasons] = validate_link(src, dst, {
      src_type: 'producer',
      dst_type: 'consumer',
      known_versions: known,
    });
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('版本未登记') && r.includes('2'))).toBe(true);
  });

  it('test_version_unknown_type_rejected：类型名未登记 fail-closed', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')) });
    const dst = _contract({ input_schema: _spec('in', _field('x', true)) });
    const known = { producer: new Set([1]) };
    const [ok, reasons] = validate_link(src, dst, {
      src_type: 'producer',
      dst_type: 'ghost',
      known_versions: known,
    });
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('版本未登记') && r.includes('ghost'))).toBe(true);
  });

  it('test_version_check_skipped_without_known_versions：未提供登记表 = 规则跳过', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')), version: 9 });
    const dst = _contract({ input_schema: _spec('in', _field('x', true)), version: 9 });
    expect(validate_link(src, dst, { src_type: 'a', dst_type: 'b' })[0]).toBe(true);
  });
});

describe('reducer 兼容（通道写入遵循 StateSchema.apply 语义）', () => {
  it('test_reducer_compat_merge_channel_accepts_object：合并累加通道对象写入合规', () => {
    const writer = _contract({ output_schema: _spec('o', _field('metrics', false, FIELD_OBJECT)) });
    expect(validate_link(writer, _contract(), { state_schema: _channel_schema() })[0]).toBe(true);
  });

  it('test_reducer_compat_merge_channel_rejects_non_object：合并累加通道非对象拒绝', () => {
    const writer = _contract({ output_schema: _spec('o', _field('metrics', false, FIELD_STRING)) });
    const [ok, reasons] = validate_link(writer, _contract(), { state_schema: _channel_schema() });
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('合并累加') && r.includes('metrics'))).toBe(true);
  });

  it('test_reducer_compat_additive_channel_accepts_array：累积追加通道序列写入合规', () => {
    const writer = _contract({ output_schema: _spec('o', _field('messages', false, FIELD_ARRAY)) });
    expect(validate_link(writer, _contract(), { state_schema: _channel_schema() })[0]).toBe(true);
  });

  it('test_reducer_compat_additive_channel_rejects_non_array：累积追加通道非序列拒绝', () => {
    const writer = _contract({ output_schema: _spec('o', _field('messages', false, FIELD_OBJECT)) });
    const [ok, reasons] = validate_link(writer, _contract(), { state_schema: _channel_schema() });
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('累积追加') && r.includes('messages'))).toBe(true);
  });

  it('test_reducer_compat_bare_channel_any_kind：裸通道任意字段形态合规', () => {
    const writer = _contract({ output_schema: _spec('o', _field('notes', false, FIELD_NUMBER)) });
    expect(validate_link(writer, _contract(), { state_schema: _channel_schema() })[0]).toBe(true);
  });

  it('test_reducer_compat_skipped_without_state_schema：未提供状态 schema = 规则跳过', () => {
    const writer = _contract({ output_schema: _spec('o', _field('metrics', false, FIELD_STRING)) });
    expect(validate_link(writer, _contract())[0]).toBe(true);
  });

  it('test_reducer_compat_in_sequence：路径校验同样检查通道写入（逐结点）', () => {
    const schema = _channel_schema();
    const writer = _contract({ output_schema: _spec('o', _field('metrics', false, FIELD_STRING)) });
    const [ok, reasons] = validate_prefix_reachability([writer], { state_schema: schema });
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('合并累加'))).toBe(true);
  });
});

describe('无契约', () => {
  it('test_no_contract_link_rejected：无契约结点不可参与组装', () => {
    const with_contract = _contract({ output_schema: _spec('o', _field('x')) });
    let result = validate_link(null, with_contract);
    expect(result[0]).toBe(false);
    expect(result[1].some((r) => r.includes('起点结点无契约'))).toBe(true);
    result = validate_link(with_contract, null);
    expect(result[0]).toBe(false);
    expect(result[1].some((r) => r.includes('目标结点无契约'))).toBe(true);
  });
});

describe('确定性', () => {
  it('test_validate_link_deterministic：同输入同输出（理由清单逐项相等）', () => {
    const src = _contract({ output_schema: _spec('out', _field('x')), version: 9 });
    const dst = _contract({
      input_schema: _spec('in', _field('y', true)),
      safety_tier: 2,
      version: 9,
    });
    const kwargs = {
      max_safety_tier: 1,
      src_type: 'producer',
      dst_type: 'consumer',
      known_versions: { producer: new Set([1]), consumer: new Set([1]) },
      state_schema: _channel_schema(),
    };
    const first = validate_link(src, dst, kwargs);
    const second = validate_link(src, dst, kwargs);
    expect(first).toEqual(second);
    expect(first[0]).toBe(false);
    expect(first[1].length).toBeGreaterThanOrEqual(2); // 覆盖缺字段 + 安全档至少两条
  });

  it('test_prefix_reachability_deterministic：同输入同输出', () => {
    const sequence = [
      _contract({ output_schema: _spec('a', _field('x')) }),
      _contract({ input_schema: _spec('b', _field('y', true)), safety_tier: 2 }),
    ];
    const first = validate_prefix_reachability(sequence, { max_safety_tier: 0 });
    const second = validate_prefix_reachability(sequence, { max_safety_tier: 0 });
    expect(first).toEqual(second);
    expect(first[0]).toBe(false);
  });
});

describe('字段名提取助手', () => {
  it('test_field_name_helpers：必填/产出字段名集合', () => {
    const spec = _spec('s', _field('x', true), _field('y'));
    expect(required_field_names(spec)).toEqual(new Set(['x']));
    expect(produced_field_names(spec)).toEqual(new Set(['x', 'y']));
    expect(required_field_names(null)).toEqual(new Set());
    expect(produced_field_names(null)).toEqual(new Set());
  });
});
