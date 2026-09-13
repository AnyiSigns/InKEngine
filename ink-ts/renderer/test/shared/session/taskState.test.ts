/**
 * task_state 归约单测：计划步进 + 工具步进（spawn 展开子任务已随引擎
 * P8+S1 退役——无 spawn_start/spawn_end 事件，子任务行不再创建）。
 */
import { describe, expect, it } from 'vitest';
import { emptyTaskState, reduceTaskEvent } from '../../../src/shared/session/taskState';
import type { HubEvent } from '../../../src/shared/session/channelHub';

function ev(type: HubEvent['type'], payload: Record<string, unknown> = {}, at = 0): HubEvent {
  return { type, payload, at };
}

describe('plan 步进归约', () => {
  it('plan_start 开启计划并记录步进总数', () => {
    const started = reduceTaskEvent(emptyTaskState(), ev('plan_start', { steps: 2 }));
    expect(started.planActive).toBe(true);
    expect(started.stepsTotal).toBe(2);
  });

  it('plan_end 关闭计划', () => {
    const started = reduceTaskEvent(emptyTaskState(), ev('plan_start', { steps: 2 }));
    const ended = reduceTaskEvent(started, ev('plan_end'));
    expect(ended.planActive).toBe(false);
  });
});

describe('tool 步进归约', () => {
  it('tool_end 计一步（无子任务行可收口）', () => {
    const s0 = reduceTaskEvent(emptyTaskState(), ev('plan_start', { steps: 3 }));
    const s1 = reduceTaskEvent(s0, ev('tool_end', { tool: 'fetch' }));
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
    expect(() => reduceTaskEvent(emptyTaskState(), ev('plan_start'))).not.toThrow();
  });
});
