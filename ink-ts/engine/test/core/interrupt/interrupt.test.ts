/**
 * interrupt 挂起/注入重入机制纯面对标测试（语义对标 ink_engine/tests/
 * test_interrupt_persistence.py 与 test_approval.py 中可由本模块自证的部分）：
 * InterruptState 序列化往返、键常量与宽容判定、InterruptSignal 信号形态、
 * InterruptCoordinator 的注入挂载/一次性消费/宽容消费/gate 发卡键单调计数
 * 与回合边界复位。
 *
 * 引擎级集成用例未移植（按 chain_rebase/approval 先例，随引擎运行时移植
 * 后再对标）：
 * - test_interrupt_persistence.py 的引擎集成用例（test_interrupt_persisted_
 *   in_checkpoint / test_get_latest_interrupt_roundtrip /
 *   test_get_latest_interrupt_none_when_no_pending /
 *   test_update_state_drops_interrupt_marker /
 *   test_resume_with_inject_via_public_run / test_sqlite_file_backend_roundtrip）
 *   与 test_checkpoint_record_serialization_roundtrip 的 CheckpointRecord 包裹
 *   层——断言 executor/storage 的 checkpoint 持久化、get_latest_interrupt、
 *   注入续流与 sqlite 落库还原（executor/graph/storage 未移植）；其中
 *   InterruptState 的 to_dict/from_dict 往返语义在本文件直接对标，无需
 *   CheckpointRecord/存储。
 * - test_approval.py 引擎级挂卡/续跑用例与同轮同工具 #2 指纹 3 例
 *   （engine.ainvoke resume_from + inject 续流与状态断言）——Graph 运行时 +
 *   协调器接线语义；协调器自身的发卡键计数/宽容消费/复位语义已在本文件
 *   纯面直测。
 */
import { describe, expect, it } from 'vitest';

import { InterruptError } from '../../../src/core/errors.js';
import {
  FINGERPRINT_SEP,
  GATE_KEY_PREFIX,
  InterruptCoordinator,
  InterruptSignal,
  InterruptState,
  interrupt_base_key,
  interrupt_key_matches,
} from '../../../src/core/interrupt/interrupt.js';

// ── InterruptSignal 信号形态 ──

describe('InterruptSignal 信号形态', () => {
  it('消息/名称/键/负载与 Python 构造一致', () => {
    const payload = { review_type: 'gate', question: '是否通过?' };
    const signal = new InterruptSignal('gate:write_file', payload);
    expect(signal).toBeInstanceOf(Error);
    expect(signal.name).toBe('InterruptSignal');
    expect(signal.message).toBe('interrupt[gate:write_file]');
    expect(signal.key).toBe('gate:write_file');
    expect(signal.payload).toBe(payload); // 引用透传（与 Python 赋值一致）
  });
});

// ── InterruptState 序列化往返 ──

describe('InterruptState 序列化往返', () => {
  it('to_dict/from_dict 往返保留挂起卡（对齐 test_checkpoint_record_serialization_roundtrip 的中断段）', () => {
    const state = new InterruptState('review:audit:n1', { question: '是否通过?' }, 'a', ['sub']);
    const restored = InterruptState.from_dict(state.to_dict());
    expect(restored.key).toBe('review:audit:n1');
    expect(restored.payload).toEqual({ question: '是否通过?' });
    expect(restored.node).toBe('a');
    expect(restored.graph_path).toEqual(['sub']);
  });

  it('经 JSON 序列化/反序列化往返等价（存储层落盘形态）', () => {
    const state = new InterruptState(
      'gate:write_file',
      { review_type: 'gate', expires_at: 1060 },
      'tool',
      ['sub', 'nested'],
    );
    const revived = JSON.parse(JSON.stringify(state.to_dict())) as Record<string, unknown>;
    const restored = InterruptState.from_dict(revived);
    expect(restored.key).toBe('gate:write_file');
    expect(restored.payload).toEqual({ review_type: 'gate', expires_at: 1060 });
    expect(restored.node).toBe('tool');
    expect(restored.graph_path).toEqual(['sub', 'nested']);
  });

  it('缺省字段回落默认值：payload={} node=null graph_path=[]，to_dict 显式写回', () => {
    const restored = InterruptState.from_dict({ key: 'review:audit:n1' });
    expect(restored.payload).toEqual({});
    expect(restored.node).toBeNull();
    expect(restored.graph_path).toEqual([]);
    expect(restored.to_dict()).toEqual({
      key: 'review:audit:n1',
      payload: {},
      node: null,
      graph_path: [],
    });
  });

  it('空 payload/graph_path（Python 假值）同样回落默认值', () => {
    const restored = InterruptState.from_dict({
      key: 'k',
      payload: {},
      node: null,
      graph_path: [],
    });
    expect(restored.payload).toEqual({});
    expect(restored.graph_path).toEqual([]);
  });

  it('frozen 语义：实例冻结、graph_path 防御拷贝（构造后改源数组不影响状态）', () => {
    const path = ['sub'];
    const state = new InterruptState('k', { a: 1 }, 'n', path);
    expect(Object.isFrozen(state)).toBe(true);
    path.push('late');
    expect(state.graph_path).toEqual(['sub']);
  });

  it('非字典输入抛 TypeError；缺 key 抛 Error', () => {
    expect(() => InterruptState.from_dict(null)).toThrow(TypeError);
    expect(() => InterruptState.from_dict([])).toThrow(TypeError);
    expect(() => InterruptState.from_dict({})).toThrow('缺 key');
  });
});

// ── 中断键基底与宽容判定 ──

describe('中断键基底与宽容判定', () => {
  it('FINGERPRINT_SEP/GATE_KEY_PREFIX 常量对齐 Python 公共面', () => {
    expect(GATE_KEY_PREFIX).toBe('gate:');
    expect(FINGERPRINT_SEP).toBe('#');
  });

  it('interrupt_base_key 剥离首个 # 后缀；无后缀 = 原键', () => {
    expect(interrupt_base_key('gate:write_file')).toBe('gate:write_file');
    expect(interrupt_base_key('gate:write_file#2')).toBe('gate:write_file');
    expect(interrupt_base_key('a#b#c')).toBe('a');
    expect(interrupt_base_key('design_session')).toBe('design_session');
  });

  it('相等键命中（任意键形态）', () => {
    expect(interrupt_key_matches('gate:write_file', 'gate:write_file')).toBe(true);
    expect(interrupt_key_matches('gate:write_file#2', 'gate:write_file#2')).toBe(true);
    expect(interrupt_key_matches('foo', 'foo')).toBe(true);
  });

  it('gate 基底宽容命中带指纹后缀的卡身份键', () => {
    expect(interrupt_key_matches('gate:write_file#2', 'gate:write_file')).toBe(true);
    expect(interrupt_key_matches('gate:write_file#3', 'gate:write_file')).toBe(true);
  });

  it('反向不命中：卡身份键不是基底的判定面', () => {
    expect(interrupt_key_matches('gate:write_file', 'gate:write_file#2')).toBe(false);
    expect(interrupt_key_matches('gate:write_file#2', 'gate:read_file')).toBe(false);
  });

  it('非 gate 键不做指纹前缀匹配', () => {
    expect(interrupt_key_matches('foo#1', 'foo')).toBe(false);
    expect(interrupt_key_matches('review:audit:n1#1', 'review:audit:n1')).toBe(false);
  });
});

// ── InterruptCoordinator 注入挂载与消费 ──

describe('InterruptCoordinator 注入挂载与消费', () => {
  it('inject 合并挂载；consume 一次性弹出（二次消费报 InterruptError）', () => {
    const c = new InterruptCoordinator();
    c.inject({ 'gate:write_file': 'reject', extra: 1 });
    c.inject({ extra: 2 }); // 覆盖已有键
    expect(c.has_inject('gate:write_file')).toBe(true);
    expect(c.consume('gate:write_file')).toBe('reject');
    expect(c.has_inject('gate:write_file')).toBe(false);
    expect(c.consume('extra')).toBe(2);
    expect(() => c.consume('gate:write_file')).toThrow(InterruptError);
    expect(() => c.consume('gate:write_file')).toThrow('中断点无注入值: gate:write_file');
  });

  it('consume_review 无注入返回 null（调用方按新中断处理）', () => {
    const c = new InterruptCoordinator();
    expect(c.consume_review('gate:write_file')).toBeNull();
    expect(c.consume_review('design_session')).toBeNull();
  });

  it('consume_review 精确命中基底键', () => {
    const c = new InterruptCoordinator();
    c.inject({ 'gate:write_file': 'reject' });
    expect(c.consume_review('gate:write_file')).toBe('reject');
    expect(c.has_inject('gate:write_file')).toBe(false);
  });

  it('consume_review 以基底键宽容命中带指纹的卡键（第二次审批决议续跑语义）', () => {
    const c = new InterruptCoordinator();
    c.inject({ 'gate:write_file#2': 'accept' });
    expect(c.has_inject('gate:write_file')).toBe(false);
    expect(c.consume_review('gate:write_file')).toBe('accept'); // 命中 #2
    expect(c.has_inject('gate:write_file#2')).toBe(false);
  });

  it('非 gate 键仅精确命中，不做 # 前缀匹配', () => {
    const c = new InterruptCoordinator();
    c.inject({ 'design_session#1': 'v' });
    expect(c.consume_review('design_session')).toBeNull();
    expect(c.consume_review('design_session#1')).toBe('v');
  });
});

// ── InterruptCoordinator gate 发卡键计数 ──

describe('InterruptCoordinator gate 发卡键计数', () => {
  it('同 (thread, base) 首次 = 原键，之后掺 #N 序号', () => {
    const c = new InterruptCoordinator();
    expect(c.next_gate_key('t1', 'gate:write_file')).toBe('gate:write_file');
    expect(c.next_gate_key('t1', 'gate:write_file')).toBe('gate:write_file#2');
    expect(c.next_gate_key('t1', 'gate:write_file')).toBe('gate:write_file#3');
  });

  it('消费不推进计数：决议注入与重入消费保持同一键（对齐同轮二次审批流）', () => {
    const c = new InterruptCoordinator();
    // 首卡挂起：基底键
    expect(c.next_gate_key('t1', 'gate:write_file')).toBe('gate:write_file');
    // 拒绝首卡 → 注入 + 重入消费（按基底键）
    c.inject({ 'gate:write_file': 'reject' });
    expect(c.consume_review('gate:write_file')).toBe('reject');
    // 第二节点同工具再挂卡 → 新键新卡 #2
    expect(c.next_gate_key('t1', 'gate:write_file')).toBe('gate:write_file#2');
    // 第二张卡决议以 #2 键注入，重入仍按基底键消费命中 #2
    c.inject({ 'gate:write_file#2': 'accept' });
    expect(c.consume_review('gate:write_file')).toBe('accept');
  });

  it('不同工具/不同线程的计数相互独立', () => {
    const c = new InterruptCoordinator();
    c.next_gate_key('t1', 'gate:write_file');
    c.next_gate_key('t1', 'gate:write_file');
    expect(c.next_gate_key('t1', 'gate:read_file')).toBe('gate:read_file'); // 新 base 独立
    expect(c.next_gate_key('t2', 'gate:write_file')).toBe('gate:write_file'); // 新线程独立
  });

  it('非 gate 键原样返回且不计数', () => {
    const c = new InterruptCoordinator();
    expect(c.next_gate_key('t1', 'review:audit:n1')).toBe('review:audit:n1');
    expect(c.next_gate_key('t1', 'review:audit:n1')).toBe('review:audit:n1');
    expect(c.next_gate_key('t1', 'gate:write_file')).toBe('gate:write_file'); // gate 计数仍从 1 起
  });

  it('reset_thread_gate_count 只复位该线程（回合边界 = 指纹复位点）', () => {
    const c = new InterruptCoordinator();
    c.next_gate_key('t1', 'gate:write_file');
    c.next_gate_key('t1', 'gate:write_file'); // t1 到 #2
    c.next_gate_key('t2', 'gate:write_file');
    c.next_gate_key('t2', 'gate:write_file'); // t2 到 #2
    c.reset_thread_gate_count('t1');
    expect(c.next_gate_key('t1', 'gate:write_file')).toBe('gate:write_file'); // 复位回基底
    expect(c.next_gate_key('t2', 'gate:write_file')).toBe('gate:write_file#3'); // t2 不受影响
  });
});
