/**
 * `__next` 路由声明解析/校验测试（routing_next.ts）。
 *
 * 测什么：
 * - parse_routing_decision：四 kind（scope/channel/converge/sink）结构校验——非法
 *   kind / converge·sink 携带 target·channel / scope 缺目标 / target 与 temp_scope
 *   并存 / channel 缺 id / 契约与 count 取值域——显式抛错（fail-closed）；
 * - payload 内 `__next` 键解析优先（parse_next_in_payload）；
 * - 回复文本声明提取：fenced json 块 / 纯 JSON 回复 / `__next:` 行式（
 *   parse_next_in_text）；缺声明 = null 不抛错；
 * - routing_decision_from_output 组合优先级：payload 键 > 文本。
 */
import { describe, expect, it } from 'vitest';

import {
  parse_next_in_payload,
  parse_next_in_text,
  parse_routing_decision,
  routing_decision_from_output,
} from '../../../src/loop/route/routing_next.js';

describe('parse_routing_decision 结构校验（四 kind）', () => {
  it('scope 合法声明：target + 缺省通道委托', () => {
    const d = parse_routing_decision({ kind: 'scope', target: 'planner' });
    expect(d.kind).toBe('scope');
    expect(d.target).toBe('planner');
    expect(d.channel).toBeUndefined();
    expect(d.contract).toBeUndefined();
  });

  it('channel 合法声明：通道 + 目标 + 契约/并行', () => {
    const d = parse_routing_decision({
      kind: 'channel',
      channel: 'fan_out',
      target: 'collaborator',
      contract: 'best',
      count: 3,
    });
    expect(d.contract).toBe('best');
    expect(d.count).toBe(3);
  });

  it('kind 非法 = 显式抛错', () => {
    expect(() => parse_routing_decision({ kind: 'teleport', target: 'x' })).toThrow(/路由声明 kind 非法/);
  });

  it('converge/sink 不得携带 target/channel/temp_scope（收口无转场面）', () => {
    expect(() => parse_routing_decision({ kind: 'converge', target: 'x' })).toThrow(/不得携带 target/);
    expect(() => parse_routing_decision({ kind: 'sink', channel: 'delegate' })).toThrow(/不得携带 target\/channel/);
    expect(() => parse_routing_decision({ kind: 'sink', temp_scope: { role: 'x' } })).toThrow(/temp_scope/);
  });

  it('scope 缺目标 / target 与 temp_scope 并存 = 显式拒绝', () => {
    expect(() => parse_routing_decision({ kind: 'scope' })).toThrow(/scope 声明须给目标/);
    expect(() =>
      parse_routing_decision({ kind: 'scope', target: 'a', temp_scope: { role: 'b' } }),
    ).toThrow(/二选一/);
  });

  it('channel 缺通道 id / 缺目标 = 显式拒绝', () => {
    expect(() => parse_routing_decision({ kind: 'channel', target: 'a' })).toThrow(/channel 声明须给通道 id/);
    expect(() => parse_routing_decision({ kind: 'channel', channel: 'delegate' })).toThrow(/channel 声明须给目标/);
  });

  it('契约取值域 / count 取值域校验', () => {
    expect(() => parse_routing_decision({ kind: 'channel', channel: 'f', target: 'x', contract: 'all' })).toThrow(/提交契约/);
    expect(() => parse_routing_decision({ kind: 'channel', channel: 'f', target: 'x', count: 0 })).toThrow(/正整数/);
    expect(() => parse_routing_decision({ kind: 'channel', channel: 'f', target: 'x', count: 2.5 })).toThrow(/正整数/);
  });

  it('temp_scope 透传（本层只形状校验，深层校验在 temp_scope 模块）', () => {
    const d = parse_routing_decision({ kind: 'scope', temp_scope: { role: 'subagent', persona: '临时专家' } });
    expect(d.temp_scope).toEqual({ role: 'subagent', persona: '临时专家' });
  });
});

describe('产物/文本声明提取', () => {
  it('payload 保留键 `__next` → 类型化决策', () => {
    const d = parse_next_in_payload({ __next: { kind: 'channel', channel: 'delegate', target: 'subagent' } });
    expect(d?.kind).toBe('channel');
    expect(d?.target).toBe('subagent');
  });

  it('payload 无 `__next` = null', () => {
    expect(parse_next_in_payload({ message: '直答' })).toBeNull();
  });

  it('回复文本末尾 fenced json 块提取', () => {
    const d = parse_next_in_text('这是答复\n```json\n{"__next": {"kind": "sink"}}\n```');
    expect(d?.kind).toBe('sink');
  });

  it('回复文本 = 纯 JSON 回复提取', () => {
    const d = parse_next_in_text('{"message":"ok","__next":{"kind":"scope","target":"planner"}}');
    expect(d?.kind).toBe('scope');
    expect(d?.target).toBe('planner');
  });

  it('`__next:` 行式声明提取', () => {
    const d = parse_next_in_text('答复文本\n__next: {"kind":"converge"}');
    expect(d?.kind).toBe('converge');
  });

  it('文本无可解析声明 = null（不抛错）', () => {
    expect(parse_next_in_text('只是普通回复，没有路由')).toBeNull();
    expect(parse_next_in_text('')).toBeNull();
    expect(parse_next_in_text('```json\n{"kind":"nope"}\n```')).toBeNull();
  });

  it('payload 键优先于文本（组合解析）', () => {
    const d = routing_decision_from_output(
      { __next: { kind: 'sink' } },
      '{"__next":{"kind":"scope","target":"planner"}}',
    );
    expect(d?.kind).toBe('sink');
  });

  it('payload 无键时回落文本解析', () => {
    const d = routing_decision_from_output({ message: 'hi' }, '{"__next":{"kind":"sink"}}');
    expect(d?.kind).toBe('sink');
  });
});
