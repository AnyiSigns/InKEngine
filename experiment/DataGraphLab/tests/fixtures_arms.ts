/**
 * arms 测试公共夹具：真实任务工厂（arms.test.ts 与 arms_heuristic.test.ts 共用，
 * 拆分只挪不改——断言语义与逐字文本同 HEAD 前的 arms.test.ts 一致）。
 */

import { makeTask } from '../gen/generator.js';
import type { Family, Style, Task } from '../schema.js';

/** 在连续 seed 上取第一个生成成功的真实任务（null 换下一 seed）。 */
export function firstTask(style: Style, family?: Family, from = 1): Task {
  for (let seed = from; seed < from + 60; seed++) {
    const t = makeTask(seed, style, family);
    if (t !== null) return t;
  }
  throw new Error(`makeTask(style=${style}, family=${String(family)}) 于 seed ${from}.. 连续失败`);
}

/** 收集 n 个指定 style 的真实任务（家族不限，同 generator 的轮转口径）。 */
export function collectTasks(style: Style, n: number, from = 1): Task[] {
  const out: Task[] = [];
  for (let seed = from; seed < from + 200 && out.length < n; seed++) {
    const t = makeTask(seed, style);
    if (t !== null) out.push(t);
  }
  if (out.length !== n) throw new Error(`collectTasks(${style}) 仅产出 ${out.length}/${n}`);
  return out;
}
