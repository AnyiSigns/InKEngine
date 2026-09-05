/**
 * 域上下文窗口投影镜像测试（对照 Python test_domain_window.py 语义全覆盖）。
 *
 * 覆盖：多工具并行轮、轮内工具序、跨回合边界、完成性回复、域归属（本域/
 * 公共集/他域剔除）、max_tool_rounds 截断、last_body_message 边界、
 * build_domain_window 投影结果序、message_text/archive_digest 原语。
 *
 * TS 差异说明：轮内 tool 序修复为引擎侧先行修复（可偏离 Python parity，
 * 见 context_window.ts 的 iter_tool_rounds 头注）；消息/工具调用构造复用
 * core/llm/messages 的 Message/ToolCall 工厂。
 */

import { describe, expect, it } from 'vitest';

import { Message, ToolCall, assistant, tool_result, user } from '../../../src/core/llm/messages.js';
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  archive_digest,
  build_domain_window,
  iter_tool_rounds,
  last_body_message,
  message_text,
} from '../../../src/core/context/context_window.js';

// 测试用工具→域归属表：write/query 各自成域，shared_lookup 为公共集（null）
const TOOL_GROUPS: Record<string, string | null> = {
  write_body: 'write',
  polish_text: 'text',
  shared_lookup: null,
};

function group_of(tool_name: string): string | null {
  return TOOL_GROUPS[tool_name] ?? null;
}

/** 带 tool_calls 的 assistant 消息（ToolCall 对象形态）。 */
function aiCall(text: string, ...names: string[]): Message {
  return assistant(text, {
    tool_calls: names.map((n) => new ToolCall({ id: `c-${n}`, name: n })),
  });
}

function toolMsg(name: string): Message {
  return tool_result('{"ok": true}', `c-${name}`);
}

/** 窗口内 assistant 调用的工具名序列（消息流原序）。 */
function windowToolNames(window: unknown[]): string[] {
  const names: string[] = [];
  for (const m of window) {
    const msg = m as Message;
    if (msg.role !== 'assistant' || msg.tool_calls === null) continue;
    for (const tc of msg.tool_calls) names.push(tc.name);
  }
  return names;
}

describe('build_domain_window 窗口投影', () => {
  it('跨回合保留全部用户消息；异域旧轮剔除（工具轮只取最近回合）', () => {
    const messages = [
      user('第一句'),
      aiCall('完成正文', 'write_body'),
      toolMsg('write_body'),
      user('第二句'),
      aiCall('查设定', 'shared_lookup'),
      toolMsg('shared_lookup'),
      assistant('写正文完成'),
    ];
    const window = build_domain_window(messages, 'write', { group_of });
    const users = window
      .filter((m) => (m as Message).role === 'user')
      .map((m) => (m as Message).content);
    expect(users).toEqual(['第一句', '第二句']);
    expect(windowToolNames(window)).toEqual(['shared_lookup']);
    const last = window[window.length - 1] as Message;
    expect(last.content).toBe('写正文完成');
  });

  it('异域工具轮整轮剔除，本域/公共集保留', () => {
    const messages = [
      user('润色并写正文'),
      aiCall('先润色', 'polish_text'),
      toolMsg('polish_text'),
      aiCall('写正文', 'write_body'),
      toolMsg('write_body'),
      aiCall('查设定', 'shared_lookup'),
      toolMsg('shared_lookup'),
    ];
    const window = build_domain_window(messages, 'write', { group_of });
    expect(windowToolNames(window)).toEqual(['write_body', 'shared_lookup']);
    const keptAi = window
      .filter((m) => (m as Message).role === 'assistant' && (m as Message).tool_calls !== null)
      .map((m) => (m as Message).content);
    expect(keptAi).toEqual(['写正文', '查设定']);
  });

  it('轮内任一工具属本域 → 整轮保留（防上下文撕裂）', () => {
    const messages = [
      user('混合轮'),
      aiCall('同轮两工具', 'polish_text', 'write_body'),
      toolMsg('polish_text'),
      toolMsg('write_body'),
    ];
    const window = build_domain_window(messages, 'write', { group_of });
    expect(window.length).toBe(4);
    expect(windowToolNames(window)).toEqual(['polish_text', 'write_body']);
  });

  it('纯异域轮整轮剔除', () => {
    const messages = [user('只润色'), aiCall('润色', 'polish_text'), toolMsg('polish_text')];
    const window = build_domain_window(messages, 'write', { group_of });
    expect(window.map((m) => (m as Message).content)).toEqual(['只润色']);
  });

  it('工具轮数上限截断（默认 8；用户消息不设限）', () => {
    const messages = [user('开始')];
    for (let i = 0; i < 20; i += 1) {
      messages.push(aiCall(`轮${i}`, 'shared_lookup'));
      messages.push(toolMsg('shared_lookup'));
    }
    const window = build_domain_window(messages, 'query', { group_of });
    const rounds = window.filter((m) => (m as Message).tool_calls !== null).length;
    expect(rounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });

  it('max_tool_rounds 覆写生效', () => {
    const messages = [user('开始')];
    for (let i = 0; i < 5; i += 1) {
      messages.push(aiCall(`轮${i}`, 'shared_lookup'));
      messages.push(toolMsg('shared_lookup'));
    }
    const window = build_domain_window(messages, 'query', {
      group_of,
      max_tool_rounds: 2,
    });
    const rounds = window.filter((m) => (m as Message).tool_calls !== null).length;
    expect(rounds).toBe(2);
  });

  it('ToolCall 对象形态（流式累积产出）同样解析工具名', () => {
    const msg = assistant('对象形态', {
      tool_calls: [new ToolCall({ id: 'c1', name: 'write_body' })],
    });
    const window = build_domain_window(
      [user('x'), msg, tool_result('{}', 'c1')],
      'write',
      { group_of },
    );
    expect(window).toContain(msg);
  });

  it('未登记工具按公共集处理，所有域可见', () => {
    const messages = [
      user('x'),
      aiCall('未知工具', 'brand_new_tool'),
      toolMsg('brand_new_tool'),
    ];
    const window = build_domain_window(messages, 'write', { group_of });
    expect(windowToolNames(window)).toEqual(['brand_new_tool']);
  });

  it('空消息与无工具轮：不产出多余内容', () => {
    expect(build_domain_window([], 'write', { group_of })).toEqual([]);
    const window = build_domain_window([user('只有用户消息')], 'write', { group_of });
    expect(window.length).toBe(1);
    expect((window[0] as Message).content).toBe('只有用户消息');
  });
});

describe('iter_tool_rounds 工具轮切分', () => {
  it('轮序与消息流一致；轮内 tool 序修复为原序', () => {
    const messages = [
      user('开始'),
      aiCall('轮一', 'shared_lookup'),
      toolMsg('shared_lookup'),
      aiCall('轮二', 'write_body'),
      toolMsg('write_body'),
    ];
    const rounds = iter_tool_rounds(messages);
    expect(rounds.map(([ai, _]) => (ai as Message).content)).toEqual(['轮一', '轮二']);
    expect(rounds.map(([, tools]) => tools.length)).toEqual([1, 1]);
  });

  it('多工具并行轮：轮内 tool 消息保持消息流原序（修复 [t3,t2,t1] 反转）', () => {
    const messages = [
      user('并行轮'),
      aiCall('同轮三工具', 'a', 'b', 'c'),
      toolMsg('a'),
      toolMsg('b'),
      toolMsg('c'),
    ];
    const rounds = iter_tool_rounds(messages);
    expect(rounds.length).toBe(1);
    const tools = rounds[0]![1].map((m) => (m as Message).tool_call_id);
    expect(tools).toEqual(['c-a', 'c-b', 'c-c']);
  });

  it('遇用户消息停止（只取最近回合）', () => {
    const messages = [
      aiCall('上一回合轮', 'write_body'),
      toolMsg('write_body'),
      user('新回合'),
      aiCall('本回合轮', 'write_body'),
      toolMsg('write_body'),
    ];
    const rounds = iter_tool_rounds(messages);
    expect(rounds.map(([ai, _]) => (ai as Message).content)).toEqual(['本回合轮']);
  });

  it('完成性正文清空未配对 tool 缓冲（不误配给更早轮）', () => {
    const messages = [
      user('开始'),
      aiCall('有调用的轮', 'write_body'),
      toolMsg('write_body'),
      assistant('完成性正文'),
    ];
    const rounds = iter_tool_rounds(messages);
    expect(rounds.length).toBe(1);
    expect(rounds[0]![1].length).toBe(1);
  });
});

describe('last_body_message / message_text', () => {
  it('完成性回复不跨回合边界', () => {
    const messages = [
      assistant('上一回合正文'),
      user('新回合'),
      aiCall('调用', 'write_body'),
    ];
    expect(last_body_message(messages)).toBeNull();
  });

  it('跳过空白内容，取最近有内容正文', () => {
    const messages = [user('x'), assistant('   '), assistant('有内容')];
    const body = last_body_message(messages);
    expect(body).not.toBeNull();
    expect((body as Message).content).toBe('有内容');
  });

  it('message_text 双形态取值', () => {
    expect(message_text(user('文本'))).toBe('文本');
    expect(message_text({ content: '字典文本' })).toBe('字典文本');
    expect(message_text({})).toBe('');
    expect(message_text(assistant())).toBe('');
  });
});

describe('archive_digest 归档摘要', () => {
  it('确定性组装：用户目标 + 最近正文 + 工具轮数', () => {
    const window = [
      user('帮我设计几个角色'),
      aiCall('创建角色', 'write_body'),
      toolMsg('write_body'),
      assistant('已完成角色创建，共 3 名角色。'),
    ];
    const digest = archive_digest(window);
    expect(digest).toContain('帮我设计几个角色');
    expect(digest).toContain('已完成角色创建');
    expect(digest).toContain('工具轮数：1');
    expect(archive_digest(window)).toBe(digest);
  });

  it('用户目标只取最近 3 条', () => {
    const window = Array.from({ length: 5 }, (_, i) => user(`目标${i}`));
    const digest = archive_digest(window);
    expect(digest).not.toContain('目标0');
    expect(digest).toContain('目标2');
    expect(digest).toContain('目标4');
  });

  it('无用户消息/正文仍产出工具轮数', () => {
    const digest = archive_digest([aiCall('调用', 'write_body'), toolMsg('write_body')]);
    expect(digest).toBe('工具轮数：1');
  });

  it('按 max_chars 截断总长', () => {
    const window = [user('很长的目标'.repeat(200)), assistant('很长的正文'.repeat(200))];
    expect(archive_digest(window, { max_chars: 100 }).length).toBe(100);
  });

  it('空窗口产出 0 工具轮数', () => {
    expect(archive_digest([])).toBe('工具轮数：0');
  });
});
