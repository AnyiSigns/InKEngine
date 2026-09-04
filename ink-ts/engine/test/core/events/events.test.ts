/**
 * 事件协议信封单测（语义对标 ink_engine/tests/test_events.py）：序列化
 * round-trip / 版本门禁 / 增量演进兼容。
 *
 * 语义检查点：
 * - EngineEvent to_dict/from_dict 往返完整（含 parent_step_id——轨迹树
 *   字段经存储序列化后仍可还原）；
 * - 协议版本不符在反序列化入口拒绝（ProtocolVersionError）；
 * - 旧事件（无 parent_step_id 字段）反序列化兼容（增量演进不破坏）；
 * - to_json 线格式往返（中文负载非 ASCII 原样可读）与不可序列化负载的
 *   字符串化降级；
 * - parse_event_lenient 逐条容错；
 * - 传输接口的收集器形态（CollectorTransport）原样保留事件。
 */
import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import {
  PROTOCOL_VERSION,
  CollectorTransport,
  EngineEvent,
  parse_event_lenient,
  ProtocolVersionError,
} from '../../../src/core/events/events.js';
import type { EngineEventInit, EngineTransport } from '../../../src/core/events/events.js';

function _event(overrides: Partial<EngineEventInit> = {}): EngineEvent {
  const base: EngineEventInit = {
    type: 'branch_run',
    payload: { delta: 2 },
    step_id: 'step-1',
    parent_step_id: 'decision-42',
    round_id: 'round-1',
    node: 's1',
    graph_path: ['sim', '0'],
    seq: 7,
    trace_id: 'trace-9',
    thread_id: 't1',
    version: PROTOCOL_VERSION,
  };
  return new EngineEvent({ ...base, ...overrides });
}

describe('事件信封：序列化往返 / 版本门禁 / 增量演进兼容', () => {
  it('序列化往返：全部字段（含 parent_step_id 轨迹树引用）还原', () => {
    const event = _event();
    const rebuilt = EngineEvent.from_dict(event.to_dict());
    expect(rebuilt.to_dict()).toEqual(event.to_dict());
    expect(rebuilt.parent_step_id).toBe('decision-42');
    expect(rebuilt.graph_path).toEqual(['sim', '0']);
  });

  it('默认 parent_step_id 为 null（顶层事件不带父引用，增量演进）', () => {
    const event = new EngineEvent({ type: 'reply_token', payload: { text: 'x' } });
    expect(event.parent_step_id).toBeNull();
    const rebuilt = EngineEvent.from_dict(event.to_dict());
    expect(rebuilt.parent_step_id).toBeNull();
  });

  it('旧事件（无 parent_step_id 字段）反序列化兼容——协议增量演进', () => {
    const legacy: JsonRecord = {
      type: 'thinking_start',
      version: PROTOCOL_VERSION,
      payload: {},
      step_id: 's-1',
      round_id: 'r-1',
      node: 'n',
      graph_path: [],
      seq: 1,
      trace_id: '-',
      thread_id: '-',
    };
    const rebuilt = EngineEvent.from_dict(legacy);
    expect(rebuilt.parent_step_id).toBeNull();
    expect(rebuilt.type).toBe('thinking_start');
  });

  it('协议版本不符在反序列化入口拒绝（不静默解析错位结构）', () => {
    const data = _event().to_dict();
    data.version = PROTOCOL_VERSION + 1;
    let caught: unknown;
    try {
      EngineEvent.from_dict(data);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProtocolVersionError);
    expect((caught as ProtocolVersionError).message).toContain('expected=2');
    expect((caught as ProtocolVersionError).message).toContain('found=3');
  });

  it('JSON 线格式往返（中文负载非 ASCII 原样可读）', () => {
    const event = _event({ payload: { note: '跨分支组装' } });
    const rebuilt = EngineEvent.from_dict(JSON.parse(event.to_json()));
    expect(rebuilt.to_dict()).toEqual(event.to_dict());
    expect(rebuilt.payload).toEqual({ note: '跨分支组装' });
  });
});

describe('传输接口：收集器形态', () => {
  it('收集器传输：原样保留事件对象（测试/日志/回放形态）', async () => {
    const collector = new CollectorTransport();
    const event = _event();
    await collector.send(event);
    expect(collector.events.length).toBe(1);
    expect(collector.events[0]!.to_dict()).toEqual(event.to_dict());
    // EngineTransport 为结构化契约（Python runtime_checkable 的编译期对应）
    const transport: EngineTransport = collector;
    expect(typeof transport.send).toBe('function');
  });
});

describe('to_json 降级 / 逐条容错解析', () => {
  it('to_json 对不可序列化负载字符串化降级，可序列化负载不受影响', () => {
    class Unserializable {
      marker = 'x';
    }

    const odd = new EngineEvent({
      type: 'odd',
      payload: { obj: new Unserializable() } as unknown as JsonRecord,
    });
    const raw = JSON.parse(odd.to_json());
    expect(raw.type).toBe('odd');
    expect(typeof raw.payload.obj).toBe('string'); // 字符串化降级

    const ok = new EngineEvent({ type: 'ok', payload: { n: 1 } });
    expect(ok.to_json()).toBe(
      '{"type": "ok", "version": 2, "payload": {"n": 1}, "step_id": null, ' +
        '"parent_step_id": null, "round_id": null, "node": null, "graph_path": [], ' +
        '"seq": null, "trace_id": "-", "thread_id": "-"}',
    );
  });

  it('parse_event_lenient 逐条容错：旧版本/结构非法返回 null，合法事件正常解析', () => {
    const good = _event();
    expect(parse_event_lenient(good.to_dict())!.to_dict()).toEqual(good.to_dict());
    const old = { ...good.to_dict(), version: PROTOCOL_VERSION + 1 };
    expect(parse_event_lenient(old)).toBeNull();
    expect(parse_event_lenient({ version: PROTOCOL_VERSION })).toBeNull(); // 缺 type
    expect(parse_event_lenient('not-a-dict')).toBeNull();
  });
});
