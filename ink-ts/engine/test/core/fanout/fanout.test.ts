/**
 * fan_out 并发原语单测（语义对标 ink_engine/tests/test_fanout_events.py 中
 * fan_out 部分，逐条同名同义移植；事件协议端到端用例依赖未移植的
 * engine/events 装配，不在本模块范围内）。
 *
 * 语义检查点：
 * - 全部成功：successes 按输入顺序、success_indices 对齐、全成功标记；
 * - 部分失败剔除：成功保留、失败留痕（index/原因），all_succeeded 翻转；
 * - None（null）是合法成功值，不被当作剔除（经哨兵区分）；
 * - 全失败 / 空列表 / 非法并发上限（ValueError → RangeError）；
 * - 并发上限护栏：同时执行数不超过 limit；
 * - propagate 控制流异常：传播并取消未完成兄弟任务（AbortSignal 协作 seam
 *   是 asyncio 取消注入的 TS 对应表达，兄弟监听 signal 即退出）；
 * - propagate 不干扰普通失败剔除语义。
 */
import { describe, expect, it } from 'vitest';

import { fan_out } from '../../../src/core/fanout/fanout.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可协作取消的延时（监听 fan_out 注入的 AbortSignal，类比 asyncio.sleep 被取消注入打断）。 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 控制流异常（Python 侧模拟 InterruptSignal 的 BaseException 形态的对应）。 */
class ControlFlow extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlFlow';
  }
}

describe('fan_out 全部成功 / 部分失败剔除 / 空列表与参数边界', () => {
  it('全部成功：结果按输入顺序、success_indices 对齐、全成功标记', async () => {
    const task = async (i: number): Promise<number> => {
      await sleep(0);
      return i * 2;
    };

    const result = await fan_out([task, task, task], 2);
    expect(result.successes).toEqual([0, 2, 4]);
    expect(result.success_indices).toEqual([0, 1, 2]);
    expect(result.failures).toEqual([]);
    expect(result.all_succeeded).toBe(true);
  });

  it('部分失败剔除：成功保留、失败留痕、非全成功', async () => {
    const task = async (i: number): Promise<number> => {
      if (i === 1) throw new Error(`task ${i} failed`);
      return i;
    };

    const result = await fan_out([task, task, task], 2);
    expect(result.successes).toEqual([0, 2]);
    expect(result.success_indices).toEqual([0, 2]);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.index).toBe(1);
    expect(result.failures[0]!.error).toContain('failed');
    expect(result.all_succeeded).toBe(false);
  });

  it('null 是合法成功值：经 success_indices 定位、不被当作失败剔除', async () => {
    const task = async (i: number): Promise<null> => {
      if (i === 1) throw new Error('boom');
      return null;
    };

    const result = await fan_out([task, task, task], 2);
    expect(result.successes).toEqual([null, null]);
    expect(result.success_indices).toEqual([0, 2]);
    expect(result.failures.map((f) => f.index)).toEqual([1]);
  });

  it('全部失败：successes/success_indices 为空、failures 全量留痕', async () => {
    const task = async (_i: number): Promise<number> => {
      throw new Error('boom');
    };

    const result = await fan_out([task, task], 1);
    expect(result.successes).toEqual([]);
    expect(result.success_indices).toEqual([]);
    expect(result.failures.length).toBe(2);
  });

  it('空列表：直接返回空结果', async () => {
    const result = await fan_out([], 3);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.success_indices).toEqual([]);
  });

  it('非法并发上限（<=0）：抛 RangeError（Python ValueError 映射）', async () => {
    await expect(fan_out([], 0)).rejects.toThrow(RangeError);
    await expect(fan_out([], 0)).rejects.toThrow('fan_out 并发上限必须为正');
    await expect(fan_out([], -1)).rejects.toThrow(RangeError);
  });
});

describe('fan_out 并发护栏 / 控制流传播', () => {
  it('并发上限护栏：同时执行数不超过 limit（JS 单线程下计数天然互斥）', async () => {
    let now = 0;
    let max = 0;
    const task = async (_i: number): Promise<number> => {
      now += 1;
      if (now > max) max = now;
      await sleep(10);
      now -= 1;
      return 0;
    };

    const tasks = Array.from({ length: 8 }, () => task);
    await fan_out(tasks, 3);
    expect(max).toBeLessThanOrEqual(3);
  });

  it('propagate 控制流异常：原样传播并取消未完成兄弟任务', async () => {
    const done: number[] = [];
    const fast = async (_i: number): Promise<number> => {
      throw new ControlFlow('stop');
    };
    const slow = async (_i: number, signal: AbortSignal): Promise<number> => {
      await abortableSleep(300, signal);
      done.push(_i);
      return _i;
    };

    await expect(fan_out([fast, slow], 2, { propagate: ControlFlow })).rejects.toThrow(ControlFlow);
    expect(done).toEqual([]);
  });

  it('propagate 不干扰普通失败剔除语义', async () => {
    const fail = async (_i: number): Promise<number> => {
      throw new Error('boom');
    };

    const result = await fan_out([fail], 1, { propagate: ControlFlow });
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.index).toBe(0);
    expect(result.failures[0]!.error).toBe('boom');
    expect(result.successes).toEqual([]);
  });
});
