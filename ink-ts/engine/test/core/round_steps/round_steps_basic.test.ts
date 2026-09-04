/**
 * RoundSteps 回合步骤序列累积器移植对标测试（语义逐点对标
 * ink_engine/tests/test_round_steps.py 第一段：回合边界/回复流/思考卡
 * /规划卡/工具卡）。
 *
 * 覆盖：
 * - user：回合边界幂等；
 * - reply_token：正文段切分（工具/审批卡/节点卡边界另起新段）；
 * - set_final_reply：多段前缀剥离 / 单段未切段整段替换 / 末段定型 / 空回复
 *   no-op / 无流式时另起新段 / 已流式内容与最终一致不重复；
 * - thinking/plan：流式累积 → 收尾；空思考/空规划不残留；末步非该类卡收尾
 *   返回 "" 不误伤；
 * - tool：start/end 状态流转；同 tool_call_id 复用 + resume 复位；多次间隔
 *   重发同 id 不破坏 step_id 唯一性；无 tool_call_id 回退计数；未命中返回 ""。
 */

import { describe, expect, it } from 'vitest';

import { RoundSteps } from '../../../src/core/round_steps/index.js';

function stepsOf(rs: RoundSteps): ReturnType<RoundSteps['steps']> {
  return rs.steps();
}

// ---------------------------------------------------------------------------
// 回合边界
// ---------------------------------------------------------------------------

describe('回合边界 user', () => {
  it('幂等：同 content 多次调用不重复记录', () => {
    const rs = new RoundSteps('r1');
    expect(rs.user('帮我设计几个角色')).toBe('user');
    expect(rs.user('帮我设计几个角色')).toBe('user');
    const steps = stepsOf(rs);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      step_id: 'user',
      type: 'user',
      payload: { content: '帮我设计几个角色' },
    });
  });
});

// ---------------------------------------------------------------------------
// 正文流
// ---------------------------------------------------------------------------

describe('reply_token 段切分与终态校准', () => {
  it('工具边界切段 → 新 reply:2', () => {
    const rs = new RoundSteps('r1');
    rs.replyToken('先看大纲，');
    rs.replyToken('再写正文。');
    rs.toolStart('write', 'call-1');
    rs.replyToken('正文已生成，');
    const steps = stepsOf(rs);
    expect(steps.map((s) => s.type)).toEqual(['reply_token', 'tool', 'reply_token']);
    expect(steps[0]?.step_id).toBe('reply:1');
    expect(steps[0]?.payload['content']).toBe('先看大纲，再写正文。');
    expect(steps[2]?.step_id).toBe('reply:2');
    expect(steps[2]?.payload['content']).toBe('正文已生成，');
  });

  it('单段未切段 → set_final_reply 整段定型替换', () => {
    const rs = new RoundSteps('r1');
    rs.replyToken('流式正文');
    rs.setFinalReply('最终确认正文');
    const last = stepsOf(rs)[stepsOf(rs).length - 1]!;
    expect(last.payload['content']).toBe('最终确认正文');
  });

  it('末段已被切段 → set_final_reply 另起新段', () => {
    const rs = new RoundSteps('r1');
    rs.replyToken('先说明');
    rs.toolStart('query', 'c1');
    rs.setFinalReply('最终回复');
    const steps = stepsOf(rs);
    const last = steps[steps.length - 1]!;
    expect(last.type).toBe('reply_token');
    expect(last.payload['content']).toBe('最终回复');
    expect(steps[0]?.payload['content']).toBe('先说明');
  });

  it('多段前缀 → set_final_reply 仅替换末段剩余部分', () => {
    const rs = new RoundSteps('r1');
    rs.replyToken('执行层正文');
    rs.toolStart('query', 'c1');
    rs.replyToken('收尾段');
    rs.setFinalReply('执行层正文\n\n收尾段');
    const segments = stepsOf(rs).filter((s) => s.type === 'reply_token');
    expect(segments).toHaveLength(2);
    expect(segments[0]?.payload['content']).toBe('执行层正文');
    expect(segments[1]?.payload['content']).toBe('收尾段');
  });

  it('单段未切段：set_final_reply 整段替换', () => {
    const rs = new RoundSteps('r1');
    rs.replyToken('部分流式内容');
    rs.setFinalReply('完整最终回复');
    const steps = stepsOf(rs);
    const replySegs = steps.filter((s) => s.type === 'reply_token');
    expect(replySegs).toHaveLength(1);
    expect(steps[steps.length - 1]?.payload['content']).toBe('完整最终回复');
  });

  it('最终回复与已流式段拼接一致 → 不重复追加', () => {
    const rs = new RoundSteps('r1');
    rs.replyToken('内容A');
    rs.toolStart('query', 'c1');
    rs.replyToken('内容B');
    rs.setFinalReply('内容A内容B');
    const replySegs = stepsOf(rs).filter((s) => s.type === 'reply_token');
    expect(replySegs).toHaveLength(2);
  });

  it('空终态回复 → 不改动已流式段', () => {
    const rs = new RoundSteps('r1');
    rs.replyToken('已流式正文');
    rs.setFinalReply('');
    expect(stepsOf(rs)[stepsOf(rs).length - 1]?.payload['content']).toBe('已流式正文');
  });

  it('无流式正文 → 终态回复自成 reply:1', () => {
    const rs = new RoundSteps('r1');
    rs.toolStart('query', 'c1');
    rs.setFinalReply('候选已确认');
    const steps = stepsOf(rs);
    const last = steps[steps.length - 1]!;
    expect(last.type).toBe('reply_token');
    expect(last.step_id).toBe('reply:1');
    expect(last.payload['content']).toBe('候选已确认');
  });
});

// ---------------------------------------------------------------------------
// 思考卡 / 规划卡
// ---------------------------------------------------------------------------

describe('思考卡流式累积与收尾', () => {
  it('thinking 完整流程 → 定型 completed', () => {
    const rs = new RoundSteps('r1');
    rs.thinkingStart();
    rs.thinkingToken('先分析用户意图');
    rs.thinkingToken('，再决定分支。');
    rs.thinkingEnd();
    const steps = stepsOf(rs);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.type).toBe('thinking');
    expect(steps[0]?.step_id).toBe('think:1');
    expect(steps[0]?.payload).toEqual({
      status: 'completed',
      content: '先分析用户意图，再决定分支。',
    });
  });

  it('空思考不残留，但返回原 step_id 供前端移除空卡', () => {
    const rs = new RoundSteps('r1');
    rs.thinkingStart();
    rs.thinkingToken('先分析用户意图');
    rs.thinkingToken('，再决定分支。');
    rs.thinkingEnd();
    const emptyId = rs.thinkingStart();
    expect(rs.thinkingEnd()).toBe(emptyId);
    expect(stepsOf(rs)).toHaveLength(1);
  });

  it('卡已被其它步骤切断 → 收尾返回 "" 不误伤', () => {
    const rs = new RoundSteps('r1');
    rs.thinkingStart();
    rs.thinkingToken('思考');
    rs.toolStart('query', 'c1');
    expect(rs.thinkingEnd()).toBe('');
    expect(rs.planEnd()).toBe('');
    expect(stepsOf(rs)[0]?.payload['status']).toBe('running');
  });
});

describe('规划卡流式累积与收尾', () => {
  it('plan 完整流程 → 定型 completed', () => {
    const rs = new RoundSteps('r1');
    rs.planStart();
    rs.planToken('先查设定，');
    rs.planToken('再执行。');
    rs.planEnd();
    const steps = stepsOf(rs);
    expect(steps[0]?.type).toBe('plan');
    expect(steps[0]?.step_id).toBe('plan:1');
    expect(steps[0]?.payload['status']).toBe('completed');
    expect(steps[0]?.payload['content']).toBe('先查设定，再执行。');
  });
});

// ---------------------------------------------------------------------------
// 工具卡
// ---------------------------------------------------------------------------

describe('工具卡 start/end 流转', () => {
  it('基本 start/end → 状态流转', () => {
    const rs = new RoundSteps('r1');
    expect(rs.toolStart('query', 'call-1')).toBe('tool:call-1');
    rs.toolEnd('call-1', false);
    const payload = stepsOf(rs)[0]?.payload;
    expect(payload?.['status']).toBe('error');
    expect(payload?.['success']).toBe(false);
  });

  it('同 tool_call_id 复用 + resume 复位 running', () => {
    const rs = new RoundSteps('r1');
    rs.toolStart('entity', 'call-9');
    rs.reviewCard({ tool_call_id: 'call-9', reason: '需确认' });
    expect(stepsOf(rs)[0]?.payload['status']).toBe('pending');
    rs.toolStart('entity', 'call-9');
    const tools = stepsOf(rs).filter((s) => s.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.payload['status']).toBe('running');
    rs.toolEnd('call-9', true);
    expect(stepsOf(rs)[0]?.payload['status']).toBe('done');
  });

  it('P1 回归：tool:A 后隔 tool:B 再重发 tool:A 不破坏唯一性', () => {
    const rs = new RoundSteps('r1');
    expect(rs.toolStart('write', 'call-a')).toBe('tool:call-a');
    rs.toolEnd('call-a', true);
    expect(rs.toolStart('query', 'call-b')).toBe('tool:call-b');
    rs.toolEnd('call-b', true);
    expect(rs.toolStart('write', 'call-a')).toBe('tool:call-a');
    const tools = stepsOf(rs).filter((s) => s.type === 'tool');
    expect(tools.map((t) => t.step_id)).toEqual(['tool:call-a', 'tool:call-b']);
    expect(tools[0]?.payload['status']).toBe('running');
    rs.toolEnd('call-a', true);
    expect(tools[0]?.payload['status']).toBe('done');
    expect(stepsOf(rs)[1]?.payload['status']).toBe('done');
  });

  it('无 tool_call_id 回退计数 + 收尾只认末步', () => {
    const rs = new RoundSteps('r1');
    expect(rs.toolStart('query', '')).toBe('tool:1');
    expect(rs.toolStart('query', '')).toBe('tool:2');
    expect(rs.toolEnd('', true)).toBe('tool:2');
    const steps = stepsOf(rs).filter((s) => s.type === 'tool');
    expect(steps[0]?.payload['status']).toBe('running');
    expect(steps[1]?.payload['status']).toBe('done');
  });

  it('tool_call_id 无匹配卡 → 收尾返回 ""', () => {
    const rs = new RoundSteps('r1');
    rs.toolStart('query', 'call-1');
    expect(rs.toolEnd('call-unknown', true)).toBe('');
    expect(stepsOf(rs)[0]?.payload['status']).toBe('running');
  });
});