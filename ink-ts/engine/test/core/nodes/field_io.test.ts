/**
 * llm 内核 config 化字段 I/O（field_io.ts）纯函数单测：
 * - output_field 归一（缺省 reply；非字符串/空值回落；保留键写入拒绝）；
 * - read_fields 归一（按序去重去空；非字符串忽略）；
 * - 保留键黑名单覆盖内部状态键（_ 前缀族：_route_to/_thread_skeleton/
 *   _round_continuation/_round_graph/_recent_tops）与结构性通道键；
 * - 只读投影文本构造（无命中 = null；值形态字符串/结构化；投影不进消息链
 *   ——文本段拼接语义）。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  build_read_projection,
  config_read_fields,
  is_reserved_output_key,
  llm_output_key,
  parse_output_field_key,
} from '../../../src/core/nodes/field_io.js';

describe('output_field 归一与保留键护栏', () => {
  it('缺省 config → 回复落 reply（现状行为）；显式 reply 同义', () => {
    expect(llm_output_key({})).toBe('reply');
    expect(llm_output_key({ system_prompt: 'x' })).toBe('reply');
    expect(llm_output_key({ output_field: 'reply' })).toBe('reply');
    expect(parse_output_field_key({})).toBe('');
  });

  it('显式非保留键 → 归一为该键（trim；空串 = 缺省回落）', () => {
    expect(parse_output_field_key({ output_field: 'plan' })).toBe('plan');
    expect(llm_output_key({ output_field: ' plan ' })).toBe('plan');
    expect(llm_output_key({ output_field: '' })).toBe('reply');
    expect(llm_output_key({ output_field: '   ' })).toBe('reply');
    // 非字符串形态（数字/布尔/对象）= 未配置回落 reply（宽容不击穿）
    expect(llm_output_key({ output_field: 7 })).toBe('reply');
    expect(llm_output_key({ output_field: null })).toBe('reply');
    expect(llm_output_key({ output_field: undefined })).toBe('reply');
  });

  it('保留键黑名单：_ 前缀内部键（_route_to/_thread_skeleton/_round_continuation/_round_graph/_recent_tops）拒绝', () => {
    for (const key of [
      '_route_to',
      '_thread_skeleton',
      '_round_continuation',
      '_round_graph',
      '_recent_tops',
    ]) {
      expect(is_reserved_output_key(key)).toBe(true);
      expect(() => parse_output_field_key({ output_field: key })).toThrow(GraphDefinitionError);
      expect(() => llm_output_key({ output_field: key })).toThrow(GraphDefinitionError);
    }
  });

  it('保留键黑名单：结构性节点通道键（messages/pending/tool_rounds/display_*）拒绝；自定义字段键放行', () => {
    for (const key of ['messages', 'pending', 'tool_rounds', 'display_messages', 'display_seq']) {
      expect(is_reserved_output_key(key)).toBe(true);
      expect(() => parse_output_field_key({ output_field: key })).toThrow(GraphDefinitionError);
    }
    expect(is_reserved_output_key('plan')).toBe(false);
    expect(is_reserved_output_key('review')).toBe(false);
    expect(is_reserved_output_key('final_result')).toBe(false);
    // 空键不算保留（由归一回落处理）
    expect(is_reserved_output_key('')).toBe(false);
  });
});

describe('read_fields 归一', () => {
  it('缺省/非数组 → 空清单', () => {
    expect(config_read_fields({})).toEqual([]);
    expect(config_read_fields({ read_fields: 'plan' })).toEqual([]);
    expect(config_read_fields({ read_fields: null })).toEqual([]);
  });

  it('按序去重去空；非字符串条目忽略', () => {
    expect(config_read_fields({ read_fields: ['plan', ' review ', 'plan', '', 3, null, 'review'] })).toEqual([
      'plan',
      'review',
    ]);
  });
});

describe('只读投影（build_read_projection）', () => {
  it('无 read_fields / 全部字段缺失 → null', () => {
    expect(build_read_projection({}, [])).toBeNull();
    expect(build_read_projection({}, ['plan'])).toBeNull();
    expect(build_read_projection({ plan: '' }, ['plan'])).toBeNull();
    expect(build_read_projection({ plan: null, review: undefined }, ['plan', 'review'])).toBeNull();
  });

  it('文本段拼接：每个命中键 = [key] 块 + 值；不写回状态', () => {
    const state: Record<string, unknown> = { plan: '步骤1', review: { risk: '高' }, other: '忽略' };
    const text = build_read_projection(state, ['plan', 'review']);
    expect(text).not.toBeNull();
    expect(text).toContain('[plan]');
    expect(text).toContain('步骤1');
    expect(text).toContain('[review]');
    expect(text).toContain(JSON.stringify({ risk: '高' }));
    expect(text).not.toContain('忽略');
    // 投影只读：不改写状态
    expect(state).toEqual({ plan: '步骤1', review: { risk: '高' }, other: '忽略' });
  });

  it('数字/布尔值文本化', () => {
    const text = build_read_projection({ plan: 42, review: true }, ['plan', 'review']);
    expect(text).toContain('42');
    expect(text).toContain('true');
  });
});
