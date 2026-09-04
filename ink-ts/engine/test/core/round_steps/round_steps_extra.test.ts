/**
 * RoundSteps 回合步骤序列累积器移植对标测试第二段：节点卡 / 审批卡 / 记忆
 * 命中 / 建议与错误 / 种子恢复 / step_id 截断 / 辅助访问器 / 录制顺序。
 *
 * 与 test_round_steps_basic.test.ts 合并对标 ink_engine/tests/test_round_steps.py
 * 的全部用例（按文件拆分：基本流 + 节点/审批/记忆/种子/截断）。
 */

import { describe, expect, it } from 'vitest';

import { RoundSteps } from '../../../src/core/round_steps/index.js';

function stepsOf(rs: RoundSteps): ReturnType<RoundSteps['steps']> {
  return rs.steps();
}

// ---------------------------------------------------------------------------
// 节点卡
// ---------------------------------------------------------------------------

describe('节点卡 start/stream/end/fail', () => {
  it('完整流式累积 + 标签保留 + stepLabel 读取', () => {
    const rs = new RoundSteps('r1');
    expect(rs.nodeStart('writer', '执笔写手')).toBe('node:writer');
    rs.nodeStream('writer', 0, '夜色渐深，');
    rs.nodeStream('writer', 0, '少年推门而入。');
    rs.nodeEnd('writer', 0, 12);
    const steps = stepsOf(rs);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.payload['label']).toBe('执笔写手');
    expect(steps[0]?.payload['status']).toBe('completed');
    expect(steps[0]?.payload['tokens']).toBe(12);
    expect(steps[0]?.payload['content']).toBe('夜色渐深，少年推门而入。');
    expect(rs.stepLabel('node:writer')).toBe('执笔写手');
  });

  it('同 id 复用保留首次标签（内部环节名不覆盖展示名）', () => {
    const rs = new RoundSteps('r1');
    rs.nodeStart('pipeline', '环节一');
    rs.nodeStart('pipeline', '环节二');
    const steps = stepsOf(rs);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.payload['label']).toBe('环节一');
  });

  it('node_labels 注入覆盖内部环节名', () => {
    const rs = new RoundSteps('r1', null, { pipeline: '统一文案' });
    rs.nodeStart('pipeline', '环节一');
    rs.nodeStart('pipeline', '环节二');
    const steps = stepsOf(rs);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.payload['label']).toBe('统一文案');
  });

  it('标签缺省 → 回退 node_id', () => {
    const rs = new RoundSteps('r1');
    rs.nodeStart('auditor', '');
    expect(stepsOf(rs)[0]?.payload['label']).toBe('auditor');
  });

  it('chapter_index 分卡 + 进度内嵌', () => {
    const rs = new RoundSteps('r1');
    rs.nodeStart('batch', '批量', { chapter_index: 1, chapter_total: 3 });
    rs.nodeStart('batch', '批量', { chapter_index: 2, chapter_total: 3 });
    const steps = stepsOf(rs);
    expect(steps.map((s) => s.step_id)).toEqual(['node:batch:1', 'node:batch:2']);
    expect(steps[0]?.payload['progress']).toEqual({ step: 'write', n: 1, total: 3 });
  });

  it('只有序号没有总数 → 不内嵌进度', () => {
    const rs = new RoundSteps('r1');
    rs.nodeStart('batch', '批量', { chapter_index: 2 });
    expect('progress' in (stepsOf(rs)[0]?.payload ?? {})).toBe(false);
  });

  it('node_fail 写 status=failed + reason + 保留已流式 content', () => {
    const rs = new RoundSteps('r1');
    rs.nodeStart('auditor', '质量审计官');
    rs.nodeStream('auditor', 0, '部分输出');
    rs.nodeFail('auditor', 0, '输出质量不满足角色节点要求');
    const payload = stepsOf(rs)[0]?.payload;
    expect(payload?.['status']).toBe('failed');
    expect(payload?.['reason']).toBe('输出质量不满足角色节点要求');
    expect(payload?.['content']).toBe('部分输出');
  });

  it('tokens=None → 不写 tokens 字段', () => {
    const rs = new RoundSteps('r1');
    rs.nodeStart('writer', '执笔');
    rs.nodeEnd('writer', 0, null);
    const payload = stepsOf(rs)[0]?.payload;
    expect(payload?.['status']).toBe('completed');
    expect('tokens' in (payload ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 审批卡 / 记忆命中 / 建议 / 错误
// ---------------------------------------------------------------------------

describe('审批卡连带工具卡置 pending', () => {
  it('review_card 把匹配工具卡置 pending；后续无影响', () => {
    const rs = new RoundSteps('r1');
    rs.toolStart('entity', 'call-5');
    rs.reviewCard({ tool_call_id: 'call-5', reason: '该操作会修改书籍数据' });
    expect(stepsOf(rs)[0]?.payload['status']).toBe('pending');
    rs.toolStart('query', 'call-6');
    rs.reviewCard({ tool_call_id: 'call-5', reason: 'r' });
    const tools = stepsOf(rs).filter((s) => s.type === 'tool');
    expect(tools[1]?.payload['status']).toBe('running');
  });
});

describe('记忆命中', () => {
  it('挂最近 plan 卡 + 同 id 幂等', () => {
    const rs = new RoundSteps('r1');
    rs.planStart();
    rs.planToken('执行方案');
    rs.planEnd();
    const hit = { id: 7, title: '偏好', snippet: '先抑后扬' };
    expect(rs.memoryHit([hit])).toBe('plan:1');
    expect(stepsOf(rs)[0]?.payload['memories']).toEqual([hit]);
    rs.memoryHit([hit]);
    expect((stepsOf(rs)[0]?.payload['memories'] as unknown[])).toHaveLength(1);
  });

  it('同一批内重复 id 也只挂一次', () => {
    const rs = new RoundSteps('r1');
    rs.thinkingStart();
    rs.thinkingToken('思考');
    rs.thinkingEnd();
    rs.memoryHit([{ id: 1, title: 'a' }, { id: 1, title: 'a' }]);
    expect((stepsOf(rs)[0]?.payload['memories'] as unknown[])).toHaveLength(1);
  });

  it('无挂载卡 → 独立 memory 步骤', () => {
    const rs = new RoundSteps('r1');
    expect(rs.memoryHit([{ id: 1, title: 't', snippet: 's' }])).toBe('memory:1');
    expect(stepsOf(rs)[stepsOf(rs).length - 1]?.type).toBe('memory_hit');
  });
});

describe('建议与错误步骤', () => {
  it('suggestions + error 顺序与计数器', () => {
    const rs = new RoundSteps('r1');
    expect(rs.suggestions(['继续写第二章'])).toBe('suggestions:1');
    expect(rs.error('模型调用失败')).toBe('error:1');
    expect(stepsOf(rs).map((s) => s.type)).toEqual(['suggestions', 'error']);
  });
});

// ---------------------------------------------------------------------------
// 种子恢复与顺序
// ---------------------------------------------------------------------------

describe('从 checkpoint 种子恢复中断回合', () => {
  it('step_id 与中断前连续', () => {
    const rs0 = new RoundSteps('r7');
    rs0.user('写第三章');
    rs0.thinkingStart();
    rs0.thinkingToken('决策思考');
    rs0.thinkingEnd();
    rs0.replyToken('先查询');
    rs0.toolStart('query', 'c1');
    const seed = rs0.steps();

    const rs1 = new RoundSteps('r7', seed);
    rs1.replyToken('结果汇总');
    rs1.toolStart('write', 'c2');
    rs1.thinkingStart();
    rs1.thinkingToken('第二张思考卡');
    rs1.thinkingEnd();
    const steps = stepsOf(rs1);
    expect(steps.filter((s) => s.type === 'thinking').map((s) => s.step_id)).toEqual([
      'think:1',
      'think:2',
    ]);
    expect(steps.filter((s) => s.type === 'reply_token').map((s) => s.step_id)).toEqual([
      'reply:1',
      'reply:2',
    ]);
    expect(steps.map((s) => s.type)).toEqual([
      'user',
      'thinking',
      'reply_token',
      'tool',
      'reply_token',
      'tool',
      'thinking',
    ]);
  });

  it('种子 payload 浅拷贝：累积期改写不回污原状态', () => {
    const seed = [
      {
        step_id: 'reply:1',
        type: 'reply_token',
        payload: { content: '原文' },
      },
    ];
    const seedCopy = JSON.parse(JSON.stringify(seed)) as typeof seed;
    const rs = new RoundSteps('r1', seedCopy);
    rs.replyToken('追加');
    expect((seedCopy[0]?.payload as { content: string })['content']).toBe('原文');
  });

  it('种子含非 dict 脏数据 → 跳过而非崩溃', () => {
    const rs = new RoundSteps(
      'r1',
      ['bad', null, { step_id: 'user', type: 'user', payload: {} }] as unknown[],
    );
    expect(stepsOf(rs).map((s) => s.step_id)).toEqual(['user']);
  });

  it('种子中无 id 的工具卡占计数 → 续流 tool:2', () => {
    const seed = [
      { step_id: 'tool:1', type: 'tool', payload: { tool_call_id: '' } },
    ];
    const rs = new RoundSteps('r1', seed);
    expect(rs.toolStart('query', '')).toBe('tool:2');
  });
});

// ---------------------------------------------------------------------------
// step_id 截断
// ---------------------------------------------------------------------------

describe('step_id 长度截断', () => {
  it('超长 tool_call_id：返回值与记录一致', () => {
    const rs = new RoundSteps('r1');
    const stepId = rs.toolStart('query', 'x'.repeat(500));
    expect(stepId).toHaveLength(200);
    expect(stepsOf(rs)[0]?.step_id).toBe(stepId);
  });

  it('超长 node_id：stream/end 与 start 同口径截断', () => {
    const rs = new RoundSteps('r1');
    const nodeId = 'n'.repeat(500);
    const stepId = rs.nodeStart(nodeId, '长节点');
    expect(rs.nodeStream(nodeId, 0, '内容')).toBe(stepId);
    expect(rs.nodeEnd(nodeId, 0, 1)).toBe(stepId);
    const payload = stepsOf(rs)[0]?.payload;
    expect(payload?.['content']).toBe('内容');
    expect(payload?.['status']).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 辅助访问器
// ---------------------------------------------------------------------------

describe('辅助访问器在空累积器上的行为', () => {
  it('last_step/last_step_id/step_label 缺省', () => {
    const rs = new RoundSteps('r1');
    expect(rs.lastStep()).toBeNull();
    expect(rs.lastStepId()).toBe('');
    expect(rs.stepLabel('nope')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 录制顺序即回放顺序
// ---------------------------------------------------------------------------

describe('事件顺序保留', () => {
  it('user → think → reply → tool → node → plan → card', () => {
    const rs = new RoundSteps('r1');
    rs.user('指令');
    rs.thinkingStart();
    rs.thinkingToken('思考');
    rs.thinkingEnd();
    rs.replyToken('正文');
    rs.toolStart('query', 'c1');
    rs.toolEnd('c1', true);
    rs.nodeStart('writer', '执笔');
    rs.nodeEnd('writer', 0, 3);
    rs.planStart();
    rs.planToken('规划');
    rs.planEnd();
    rs.reviewCard({ node_id: 'x', node_label: 'x', review_type: 'gate' });
    expect(stepsOf(rs).map((s) => s.type)).toEqual([
      'user',
      'thinking',
      'reply_token',
      'tool',
      'node',
      'plan',
      'review_card',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 组装阶段
// ---------------------------------------------------------------------------

describe('组装阶段折叠', () => {
  it('start → 重复 start 同 id 复用 → end 定型 done + 耗时', () => {
    const rs = new RoundSteps('r1');
    rs.user('查询资料');
    expect(rs.assemblyStart(1000.0)).toBe('assembly');
    expect(rs.assemblyStart(1200.0)).toBe('assembly');
    expect(rs.assemblyEnd(2500.0)).toBe('assembly');
    const steps = stepsOf(rs);
    expect(steps.map((s) => s.type)).toEqual(['user', 'assembly']);
    expect(steps[steps.length - 1]?.payload).toEqual({
      status: 'done',
      elapsed_ms: 1300000,
      started_at: 1200.0,
    });
  });

  it('无 start 的 end = 幂等空操作', () => {
    const rs = new RoundSteps('r1');
    expect(rs.assemblyEnd(2500.0)).toBe('');
    expect(stepsOf(rs)).toEqual([]);
  });

  it('墙钟回拨 → 不写负耗时，仍定型 done', () => {
    const rs = new RoundSteps('r1');
    rs.assemblyStart(2000.0);
    rs.assemblyEnd(1500.0);
    expect(stepsOf(rs)[0]?.payload).toEqual({ status: 'done', started_at: 2000.0 });
  });
});

// ---------------------------------------------------------------------------
// round_id 归一
// ---------------------------------------------------------------------------

describe('round_id 归一', () => {
  it('缺省归一为空串', () => {
    expect(new RoundSteps('').round_id).toBe('');
    expect(new RoundSteps('r1').round_id).toBe('r1');
  });
});