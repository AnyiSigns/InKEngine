/**
 * 任务级执行归约测试：plan/spawn/tool 家族事件 → task_state 快照
 * （后台 task 家族随后台任务域废弃不再产出）。
 */

import { describe, expect, it } from 'vitest';

import { emptyTaskState, reduceTaskEvent } from '@/shared/session/taskState';
import type { HubEvent } from '@/shared/session/channelHub';

function ev(type: HubEvent['type'], payload: Record<string, unknown> = {}, at = 1): HubEvent {
  return { type, payload, at };
}

describe('plan 面', () => {
  it('plan_start 重置并记入步进总数', () => {
    const next = reduceTaskEvent(emptyTaskState(), ev('plan_start', { steps: 4, plan_id: 'p1' }));
    expect(next.planActive).toBe(true);
    expect(next.stepsTotal).toBe(4);
    expect(next.planId).toBe('p1');
  });

  it('plan_start 缺 steps 收敛为 0', () => {
    const next = reduceTaskEvent(emptyTaskState(), ev('plan_start', {}));
    expect(next.stepsTotal).toBe(0);
    expect(next.planActive).toBe(true);
  });

  it('plan_end 收口活跃态', () => {
    const started = reduceTaskEvent(emptyTaskState(), ev('plan_start', { steps: 2 }));
    const ended = reduceTaskEvent(started, ev('plan_end'));
    expect(ended.planActive).toBe(false);
  });
});

describe('spawn 展开子任务', () => {
  it('spawn_start 建独立运行行（按 node_id 关联）', () => {
    const next = reduceTaskEvent(emptyTaskState(), ev('spawn_start', { node_id: 'n1', label: '检索' }));
    expect(next.subtasks).toHaveLength(1);
    expect(next.subtasks[0]).toMatchObject({ key: 'n1', label: '检索', kind: 'spawn', status: 'running' });
  });

  it('spawn_start 缺 node_id 生成稳定占位键', () => {
    const next = reduceTaskEvent(emptyTaskState(), ev('spawn_start', { label: '匿名' }));
    expect(next.subtasks[0].key).toMatch(/^spawn-/);
    expect(next.subtasks[0].status).toBe('running');
  });

  it('spawn_end 收口为完成态', () => {
    const started = reduceTaskEvent(emptyTaskState(), ev('spawn_start', { node_id: 'n1' }));
    const ended = reduceTaskEvent(started, ev('spawn_end', { node_id: 'n1' }));
    expect(ended.subtasks[0].status).toBe('done');
  });
});

describe('tool 步进与子任务收口', () => {
  it('tool_end 携带子任务 key 收口该行并计一步', () => {
    const s0 = reduceTaskEvent(emptyTaskState(), ev('spawn_start', { node_id: 'n1' }));
    const s1 = reduceTaskEvent(s0, ev('tool_end', { node_id: 'n1', tool: 'fetch' }));
    expect(s1.subtasks[0].status).toBe('done');
    expect(s1.stepsDone).toBe(1);
  });

  it('tool_end 无 key 仅计一步（不触碰子任务）', () => {
    const s0 = reduceTaskEvent(emptyTaskState(), ev('plan_start', { steps: 3 }));
    const s1 = reduceTaskEvent(s0, ev('tool_end', { tool: 'think' }));
    expect(s1.stepsDone).toBe(1);
    expect(s1.subtasks).toHaveLength(0);
  });
});

describe('降级与健壮性', () => {
  it('未知事件类型原样返回（不崩）', () => {
    const s = reduceTaskEvent(emptyTaskState(), ev('unknown_future' as HubEvent['type'], {}));
    expect(s).toEqual(emptyTaskState());
  });

  it('缺字段载荷不抛（空 payload）', () => {
    expect(() => reduceTaskEvent(emptyTaskState(), ev('spawn_start'))).not.toThrow();
  });
});
