/**
 * 覆盖构造（C.1 `make_coverage_split`；从 gen/generator.ts 拆出以满足单文件
 * ≤350 行纪律，公开端口经 generator 再导出，appendix D 调用位置不受影响）。
 *
 * 每个（该切分**可产域**骨架 × style × family）恰 1 条；只允许同骨架重试
 * （50 次），禁止跨骨架顶替。goal 域族覆盖声明缩到适格池（R2-P0-2），
 * follow 域族缩到可产域（R2-P0-3 删任意步版）——goalEligible 不适格与 follow
 * 结构性非最小的骨架都以键显式上报（unproducible，不静默），可产域任一骨架
 * 产不出仍抛错（覆盖声明在可产域上成立）。骨架池默认走 poolFor（splits.ts
 * 唯一真源，与 generator 的切分池同口径）。
 *
 * 依赖说明：本文件与 generator.ts 互相引用（此处用其 STYLES/instanceTask，
 * generator 再导出此处符号），构成环但安全——本模块顶层只有函数与接口声明，
 * 不求值读入任何一侧的导出值，不会触发 splits.ts 头注警告的那类加载期 TDZ
 * （那里是顶层 IIFE 计算 STRATA 必须单向引用）。
 */

import { _skelId, type Skel } from './skeletons.js';
import { codepointCompare, poolFor } from './splits.js';
import { coverageKey, followUnproducible, goalEligible, isGoalDomain } from './producibility.js';
import { instanceTask, STYLES } from './generator.js';
import { makeRng } from '../world/rng.js';
import type { Split, Task } from '../schema.js';

/**
 * 覆盖构造结果：tasks = 恰 1 条/（适格池骨架 × style × family）；unproducible =
 * goal 域族适格性筛除的键（与注册表同口径）；ineligible = 被筛除的骨架 id 清单
 * （R2-P0-2 显式上报，不静默）。
 */
export interface CoverageSplitInfo {
  readonly tasks: Task[];
  readonly unproducible: readonly string[];
  readonly unproducibleCount: number;
  readonly ineligible: readonly string[];
  readonly ineligibleCount: number;
}

/**
 * C.1 `make_coverage_split` 的可判定版：见模块头注。
 * 骨架池默认取 poolFor(split)，可注入（小子集冒烟/构造抛错分支）。
 */
export function makeCoverageSplitInfo(
  split: Split,
  seed = 0,
  skeletons?: readonly Skel[],
): CoverageSplitInfo {
  const rng = makeRng(seed);
  const pool = [...(skeletons ?? poolFor(split))].sort((a, b) =>
    codepointCompare(_skelId(a), _skelId(b)),
  );
  const out: Task[] = [];
  const unproducible: string[] = [];
  const ineligible = new Set<string>();
  for (const style of ['follow', 'goal'] as const) {
    for (const fam of STYLES[style]) {
      for (const sk of pool) {
        const cid = _skelId(sk);
        const key = coverageKey(style, fam, cid);
        if (isGoalDomain(fam) && !goalEligible(sk.root, sk.plan)) {
          unproducible.push(key);
          ineligible.add(cid);
          continue;
        }
        if (!isGoalDomain(fam) && followUnproducible(sk)) {
          // follow 结构性非最小（采样域无 ≥2 条无捷径 witness）与注册表同口径
          // 上报；覆盖声明缩到可产域（不限 heldout，val/train 同判定同上报）。
          unproducible.push(key);
          continue;
        }
        let task: Task | null = null;
        for (let attempt = 0; attempt < 50; attempt++) {
          const candidate = instanceTask(rng, sk.root, sk.plan, fam, style);
          if (candidate !== null && candidate.split === split) {
            task = candidate;
            break;
          }
        }
        if (task === null) {
          throw new Error(`coverage ${split}/${style}/${fam}/${cid}: skeleton yields no task`);
        }
        out.push(task);
      }
    }
  }
  const ineligibleIds = [...ineligible].sort(codepointCompare);
  return {
    tasks: out,
    unproducible,
    unproducibleCount: unproducible.length,
    ineligible: ineligibleIds,
    ineligibleCount: ineligibleIds.length,
  };
}

/** C.1 `make_coverage_split` 签名保持：覆盖集任务列表（计数走 makeCoverageSplitInfo）。 */
export function makeCoverageSplit(split: Split, seed = 0): Task[] {
  return makeCoverageSplitInfo(split, seed).tasks;
}
