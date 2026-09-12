/** 消息数据类与工具调用增量累积——对标 pytest test_llm_messages.py。
 *
 *  与 Python 差异：构造期默认 id 在 TS 端走注入 uuid 缺省固定 32 位 0；测试断言
 *  仅校验「id 存在」而非具体值（Python uuid4().hex 不可复现）。
 */

import { describe, expect, it } from 'vitest';

import { LLMConfigError } from '../../../src/model/llm/errors.js';
import {
  Message,
  ToolCall,
  ToolCallDelta,
  accumulate_tool_calls,
  assistant,
  message_role,
  project_history_baseline,
  system,
  tool_result,
  user,
} from '../../../src/model/llm/messages.js';

describe('message_role（角色归一）', () => {
  it('engine Message roles pass through', () => {
    expect(message_role(system('s'))).toBe('system');
    expect(message_role(user('u'))).toBe('user');
    expect(message_role(assistant('a'))).toBe('assistant');
    expect(message_role(tool_result('r', 'c1'))).toBe('tool');
  });

  it('dict type key with aliases', () => {
    expect(message_role({ type: 'human', content: 'x' })).toBe('user');
    expect(message_role({ type: 'ai', content: 'x' })).toBe('assistant');
    expect(message_role({ type: 'system' })).toBe('system');
  });

  it('dict role key preferred（Message.to_dict() 落 role 键）', () => {
    expect(message_role(user('u').to_dict())).toBe('user');
    expect(message_role({ role: 'assistant' })).toBe('assistant');
  });

  it('dict without role or type returns empty string', () => {
    expect(message_role({})).toBe('');
    expect(message_role({ type: null })).toBe('');
  });

  it('duck-typed class name fallback', () => {
    class HumanMessage {}
    class AIMessage {}
    class ToolMessage {}
    class Unknown {}
    expect(message_role(new HumanMessage())).toBe('user');
    expect(message_role(new AIMessage())).toBe('assistant');
    expect(message_role(new ToolMessage())).toBe('tool');
    expect(message_role(new Unknown())).toBe('unknown');
  });

  it('class named Message does not normalize to empty', () => {
    class MessageCls {}
    expect(message_role(new MessageCls())).toBe('messagecls');
  });

  it('role attribute aliases（鸭子类型对象携带 human/ai 角色）', () => {
    class Custom {
      role = 'ai';
    }
    expect(message_role(new Custom())).toBe('assistant');
  });
});

describe('Message（角色 + 序列化）', () => {
  it('roles round trip（系统/用户/助手/工具四角色输出形态）', () => {
    expect(system('s').to_openai_dict()).toEqual({ role: 'system', content: 's' });
    expect(user('u').to_openai_dict()).toEqual({ role: 'user', content: 'u' });
    expect(assistant('a').to_openai_dict()).toEqual({ role: 'assistant', content: 'a' });
    expect(tool_result('r', 'call_1').to_openai_dict()).toEqual({
      role: 'tool',
      content: 'r',
      tool_call_id: 'call_1',
    });
  });

  it('assistant with tool calls 序列化为 tool_calls 数组', () => {
    const msg = assistant('', {
      tool_calls: [new ToolCall({ id: 'call_1', name: 'get_weather', arguments: '{"city": "北京"}' })],
    });
    expect(msg.to_openai_dict()).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city": "北京"}' },
        },
      ],
    });
  });

  it('invalid role rejected', () => {
    expect(() => new Message('robot', 'x')).toThrow(LLMConfigError);
  });

  it('tool message requires tool_call_id', () => {
    expect(() => new Message('tool', 'x')).toThrow(LLMConfigError);
  });

  it('to_dict/from_dict round trip', () => {
    const msg = assistant('答', {
      tool_calls: [new ToolCall({ id: 'c1', name: 'lookup', arguments: '{"a":1}' })],
      reasoning: '想',
    });
    const restored = Message.from_dict(msg.to_dict());
    expect(restored.to_openai_dict()).toEqual(msg.to_openai_dict());
    expect(restored.role).toBe(msg.role);
    expect(restored.content).toBe(msg.content);
    expect(restored.tool_calls?.[0]!.id).toBe('c1');
    expect(restored.reasoning).toBe('想');
  });

  it('name emitted for user/assistant only', () => {
    expect(assistant('答', { name: 'security_reviewer' }).to_openai_dict()).toEqual({
      role: 'assistant',
      content: '答',
      name: 'security_reviewer',
    });
    expect(user('问', { name: 'user1' }).to_openai_dict()).toEqual({
      role: 'user',
      content: '问',
      name: 'user1',
    });
    expect(system('s').to_openai_dict()).toEqual({ role: 'system', content: 's' });
    expect(tool_result('r', 'c1').to_openai_dict()).toEqual({
      role: 'tool',
      content: 'r',
      tool_call_id: 'c1',
    });
  });

  it('name round trip and default omitted', () => {
    expect('name' in assistant('a').to_openai_dict()).toBe(false);
    const msg = assistant('答', { name: 'security_reviewer' });
    const restored = Message.from_dict(msg.to_dict());
    expect(restored.name).toBe('security_reviewer');
  });

  it('默认 id 由 uuid 缺省提供（注入 seam 缺省确定 0...0）', () => {
    const m = system('s');
    expect(typeof m.id).toBe('string');
    expect(m.id.length).toBeGreaterThan(0);
  });

  it('uuid 注入：传入 uuid 函数则使用', () => {
    const m = system('s', { uuid: () => 'abc123' });
    expect(m.id).toBe('abc123');
  });
});

describe('ToolCall（参数解析）', () => {
  it('parsed_arguments 合法 JSON 返回对象', () => {
    const tc = new ToolCall({ id: 'c1', name: 'n', arguments: '{"a": 1}' });
    expect(tc.parsed_arguments).toEqual({ a: 1 });
  });

  it('parsed_arguments 容错（空/非法/非对象）', () => {
    expect(new ToolCall({ id: 'c1', name: 'n', arguments: '' }).parsed_arguments).toEqual({});
    expect(new ToolCall({ id: 'c1', name: 'n', arguments: '{bad json' }).parsed_arguments).toEqual({});
    expect(new ToolCall({ id: 'c1', name: 'n', arguments: '"str"' }).parsed_arguments).toEqual({});
  });

  it('strict=true 抛出 LLMFormatError', () => {
    const tc = new ToolCall({ id: 'c1', name: 'n', arguments: '{bad' });
    expect(() => tc.parse_arguments(true)).toThrow();
    const tcEmpty = new ToolCall({ id: 'c1', name: 'n', arguments: '' });
    expect(() => tcEmpty.parse_arguments(true)).toThrow();
    const tcStr = new ToolCall({ id: 'c1', name: 'n', arguments: '"str"' });
    expect(() => tcStr.parse_arguments(true)).toThrow();
  });
});

describe('project_history_baseline（持久化消息链 → fork 试跑上下文基线）', () => {
  it('保留链首 system + user/assistant 文本链；tool 与纯工具片段丢弃、顺序保持', () => {
    // 源线程两回合完整 checkpoint 链（含 system/user/assistant/tool 与工具调用片段）
    const chain = [
      system('boot'),
      user('第一回合'),
      assistant('第一回复'),
      user('第二回合'),
      assistant('', {
        tool_calls: [new ToolCall({ id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' })],
      }),
      tool_result('工具输出', 'call_1'),
      assistant('第二回复'),
    ].map((m) => m.to_dict());
    const baseline = project_history_baseline(chain as never);
    // 文本链：链首 system 保留，tool/纯工具片段丢弃，user/assistant 顺序保持
    expect(baseline.map((m) => [m.role, m.content])).toEqual([
      ['system', 'boot'],
      ['user', '第一回合'],
      ['assistant', '第一回复'],
      ['user', '第二回合'],
      ['assistant', '第二回复'],
    ]);
    // 助手消息不再携带悬空 tool_calls（投影净化，防旧工具调用 id 回灌模型）
    for (const message of baseline) {
      expect(message.tool_calls).toBeNull();
      expect(message.attachments.length).toBe(0);
    }
  });

  it('非链首 system / 无正文 assistant 丢弃；非法记录跳过防击穿', () => {
    const chain = [
      user('带附件', { attachments: [] }),
      assistant(''),
      { role: 'system', content: '非链首系统' },
      { role: 'unknown', content: '噪声' },
      { role: 'assistant', content: '正文', tool_calls: null, reasoning: '不喂模型' },
    ];
    const baseline = project_history_baseline(chain as never);
    expect(baseline.map((m) => [m.role, m.content])).toEqual([
      ['user', '带附件'],
      ['assistant', '正文'],
    ]);
    // 非法记录（缺 role/畸形字段/非记录）跳过不击穿，合法条目保留
    expect(
      project_history_baseline([
        { content: 'no role' },
        { role: 'user', content: '你好' },
        'not-a-record',
      ] as never).map((m) => [m.role, m.content]),
    ).toEqual([['user', '你好']]);
    const withBad = project_history_baseline([
      { role: 'user', content: '合法' },
      { role: 'broken', content: 42 },
    ] as never);
    expect(withBad.map((m) => [m.role, m.content])).toEqual([['user', '合法']]);
  });

  it('无链首 system 的链：从首条 user 起（不臆造系统；装配按本线程 boot 合成）', () => {
    const chain = [user('直接问'), assistant('直接答')].map((m) => m.to_dict());
    const baseline = project_history_baseline(chain as never);
    expect(baseline.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(baseline[0]!.content).toBe('直接问');
  });
});

describe('accumulate_tool_calls', () => {
  it('merge by index（arguments 增量拼接、id/name 首见为准）', () => {
    const deltas = [
      new ToolCallDelta({ index: 0, id: 'call_1', name: 'get_weather', arguments_delta: '{"c' }),
      new ToolCallDelta({ index: 1, id: 'call_2', name: 'get_time', arguments_delta: '{}' }),
      new ToolCallDelta({ index: 0, arguments_delta: 'ity": "北京"}' }),
    ];
    const calls = accumulate_tool_calls(deltas);
    expect(calls.length).toBe(2);
    expect(calls[0]!.id).toBe('call_1');
    expect(calls[0]!.name).toBe('get_weather');
    expect(calls[0]!.arguments).toBe('{"city": "北京"}');
    expect(calls[1]!.id).toBe('call_2');
    expect(calls[1]!.arguments).toBe('{}');
  });

  it('out-of-order index keeps first seen order', () => {
    const deltas = [
      new ToolCallDelta({ index: 1, id: 'b' }),
      new ToolCallDelta({ index: 0, id: 'a' }),
    ];
    const calls = accumulate_tool_calls(deltas);
    expect(calls.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('empty input returns empty array', () => {
    expect(accumulate_tool_calls([])).toEqual([]);
  });
});