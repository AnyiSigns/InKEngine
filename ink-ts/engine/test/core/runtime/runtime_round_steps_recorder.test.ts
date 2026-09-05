/**
 * 回合步骤记录器（_RoundStepsRecorder）直接单测：有界容量、线程隔离、
 * 步骤序、round 边界重置、系统信号（step_id=null）不入步骤。
 */

import { describe, expect, it } from 'vitest';

import { EngineEvent } from '../../../src/core/events/events.js';
import { _RoundStepsRecorder, DEFAULT_STEP_LIMIT } from '../../../src/core/runtime/_round_steps_recorder.js';

function ev(
  type: string,
  thread_id: string,
  round_id: string | null,
  step_id: string | null,
  seq: number,
): EngineEvent {
  return new EngineEvent({ type, payload: { seq }, thread_id, round_id, step_id });
}

describe('回合步骤记录器（_RoundStepsRecorder）', () => {
  it('事件步骤序 = 录制序；thread 隔离；round 边界重置', async () => {
    const recorder = new _RoundStepsRecorder();
    await recorder.send(ev('a', 't1', 'r1', 'a-1', 1));
    await recorder.send(ev('b', 't2', 'r1', 'b-1', 1));
    await recorder.send(ev('a', 't1', 'r1', 'a-2', 2));
    expect(recorder.steps('t1').map((s) => s.step_id)).toEqual(['a-1', 'a-2']);
    expect(recorder.steps('t2').map((s) => s.step_id)).toEqual(['b-1']);
    expect(recorder.thread_count()).toBe(2);
    // 新回合：旧回合缓冲丢弃
    await recorder.send(ev('a', 't1', 'r2', 'a-3', 3));
    expect(recorder.steps('t1').map((s) => s.step_id)).toEqual(['a-3']);
  });

  it('系统信号/机制事件（step_id=null）不入步骤序列', async () => {
    const recorder = new _RoundStepsRecorder();
    await recorder.send(ev('turn_started', 't', 'r1', null, 0));
    await recorder.send(ev('reply_token', 't', 'r1', null, 1));
    await recorder.send(ev('node_trace', 't', 'r1', 'trace-1', 2));
    expect(recorder.steps('t').map((s) => s.step_id)).toEqual(['trace-1']);
  });

  it('容量上限：超过 N 只保留最近 N 步', async () => {
    const recorder = new _RoundStepsRecorder();
    for (let i = 1; i <= DEFAULT_STEP_LIMIT + 10; i += 1) {
      await recorder.send(ev('node_trace', 't', 'r1', `trace-${i}`, i));
    }
    const steps = recorder.steps('t');
    expect(steps.length).toBe(DEFAULT_STEP_LIMIT);
    expect(steps[0]!.step_id).toBe(`trace-${10 + 1}`);
    expect(steps[steps.length - 1]!.step_id).toBe(`trace-${DEFAULT_STEP_LIMIT + 10}`);
  });
});
