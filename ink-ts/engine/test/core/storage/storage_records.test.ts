/**
 * storage 纯面测试：CheckPoint/ChainLink 记录、序列化与 marker 还原、
 * 敏感键剥离、嵌套递归 copy-on-write、元组/只读数组归一。
 *
 * 范围：storage_records.ts + storage_constants.ts 的纯数据面行为。
 * 后端实现（memory/sqlite/postgres）属于宿主侧 IO，本套件不覆盖——
 * create_storage 与各后端实现延后到 backend/ 层做接口对接测试。
 *
 * 对标 pytest test_storage.py 中不依赖真实后端的纯语义用例：
 * to_dict/from_dict 往返、敏感键剥离、PatchChain/Message/ToolCall
 * 内联 marker、嵌套 copy-on-write、tuple → readonly 数组归一等。
 */

import { describe, expect, it } from 'vitest';

import { InterruptState } from '../../../src/core/interrupt/interrupt_types.js';
import { Message, ToolCall } from '../../../src/core/llm/messages.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';
import { CheckpointRecord, fromJsonable, jsonableStrip } from '../../../src/core/storage/storage_records.js';
import {
  DEFAULT_CHAIN_WALK_LIMIT,
  DEFAULT_LIST_CHECKPOINTS_LIMIT,
  MESSAGE_MARKER,
  PATCH_CHAIN_MARKER,
  SCHEME_MEMORY,
  SCHEME_POSTGRES,
  SCHEME_SQLITE,
  TOOL_CALL_MARKER,
} from '../../../src/core/storage/storage_constants.js';

describe('storage 常量与 marker', () => {
  it('协议前缀字面量稳定（跨语言对账）', () => {
    expect(SCHEME_MEMORY).toBe('memory');
    expect(SCHEME_SQLITE).toBe('sqlite');
    expect(SCHEME_POSTGRES).toBe('postgresql');
  });

  it('默认值（魔法数字已抽为具名常量）', () => {
    expect(DEFAULT_CHAIN_WALK_LIMIT).toBe(10000);
    expect(DEFAULT_LIST_CHECKPOINTS_LIMIT).toBe(100);
  });

  it('marker 字面量稳定（与 Python 一致，跨语言序列化对账）', () => {
    expect(PATCH_CHAIN_MARKER).toBe('__patch_chain__');
    expect(MESSAGE_MARKER).toBe('__engine_message__');
    expect(TOOL_CALL_MARKER).toBe('__engine_tool_call__');
  });
});

describe('CheckpointRecord 默认值与 from_dict 缺省回落', () => {
  it('构造期缺省值与 Python 字段默认值一致', () => {
    const cp = new CheckpointRecord({ checkpoint_id: 0, thread_id: 't' });
    expect(cp.node).toBeNull();
    expect(cp.graph_path).toEqual([]);
    expect(cp.state).toEqual({});
    expect(cp.parent_id).toBeNull();
    expect(cp.reason).toBeNull();
    expect(cp.created_at).toBe(0);
    expect(cp.version).toBe(1);
    expect(cp.event_seq).toBe(0);
    expect(cp.error).toBeNull();
    expect(cp.interrupt).toBeNull();
    expect(cp.graph_version).toBeNull();
    expect(cp.plan).toBeNull();
  });

  it('options.now 注入 created_at（core 零时间依赖）', () => {
    const cp = new CheckpointRecord({ checkpoint_id: 0, thread_id: 't', options: { now: 1700 } });
    expect(cp.created_at).toBe(1700);
  });

  it('from_dict 缺省字段回落到 Python `or 缺省` 同一口径（0/空串触发回落）', () => {
    const cp = CheckpointRecord.from_dict({
      checkpoint_id: 1,
      thread_id: 't',
      version: 0, // Python: int(0 or 1) = 1
      event_seq: 0,
      created_at: 0, // 回落 → 0（fallback=0）
    });
    expect(cp.version).toBe(1);
    expect(cp.event_seq).toBe(0);
  });

  it('from_dict 非法整数字符串抛 RangeError（镜像 Python int() ValueError）', () => {
    expect(() =>
      CheckpointRecord.from_dict({ checkpoint_id: '1.5', thread_id: 't' }),
    ).toThrow(RangeError);
  });

  it('from_dict 非对象形态抛 TypeError', () => {
    expect(() => CheckpointRecord.from_dict(123)).toThrow(TypeError);
  });
});

describe('CheckpointRecord state 深拷贝隔离', () => {
  it('构造后改动原 state 不影响快照（浅拷贝曾共享嵌套引用）', () => {
    const original = { config: { model: 'm', retries: 0 }, ok: 1 };
    const cp = new CheckpointRecord({ checkpoint_id: 1, thread_id: 't', state: original });
    // 外部在构造后改动嵌套对象：版本链快照不得随之漂移
    (original['config'] as Record<string, unknown>)['model'] = 'mutated';
    original['ok'] = 99;
    const state = cp.state as Record<string, unknown>;
    expect((state['config'] as Record<string, unknown>)['model']).toBe('m');
    expect(state['config'] as Record<string, unknown>).not.toBe(original['config']);
    expect(state['ok']).toBe(1);
  });
});
