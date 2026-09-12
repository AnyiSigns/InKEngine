/**
 * 有界 BFS 与状态去重键——`provenance.safeActionConflictRate` 的检索内核。
 *
 * `stateDigest` 采用 C.4 口径：值字段（x/answer/verdict）+ 逐算子访问计数。计数必须
 * 进键——`MAX_REPEAT` 依赖访问次数，否则「同值不同访问数」的状态被误并，唯一合法
 * 延续会被剪掉，搜索不完备；完整 `hist` 不进键（顺序不影响可延续性，进键会爆炸去重空间）。
 * 本文件是唯一实现点，后续 `teacher/search.ts` 直接 import，禁止再写第二份。
 *
 * `reachesAccept` 是 nodeBudget 封顶的 BFS：出队即查验收（首个 accepted 即最短，
 * 但我们只需要「可达」判定）。超预算返回 truncated=true——冲突判定只认
 * `reached=true`，截断计保守（不谎报多解，也不假装不可达）。
 */

import { hashObj } from '../world/hash.js';
import { applyOp, EXIT, type Graph, type State } from '../world/operators.js';
import { MAX_STEPS, candidates } from '../runner/graph.js';
import { accept } from '../verify/acceptor.js';
import type { Task } from '../schema.js';

/** C.4 状态去重键：{x, answer, verdict} + 逐算子计数；不含完整 hist。 */
export function stateDigest(st: Readonly<State>): string {
  const counts: Record<string, number> = {};
  for (const nid of st.hist) counts[nid] = (counts[nid] ?? 0) + 1;
  return hashObj({ x: st.x, answer: st.answer, verdict: st.verdict, counts });
}

export interface ReachResult {
  readonly reached: boolean;
  /** 展开预算耗尽仍未判出——保守 false，不计冲突但如实上报。 */
  readonly truncated: boolean;
  readonly expanded: number;
}

/**
 * 从 start 出发，budget 次出队内能否到达 `accept` 态。EXIT 不显式展开：
 * 出队点已判 accept(st)，在非验收态选 EXIT 只等于失败，展开无增益。
 */
export function reachesAccept(graph: Graph, task: Task, start: State, budget: number): ReachResult {
  const seen = new Set<string>([stateDigest(start)]);
  const queue: Array<{ st: State; d: number }> = [{ st: start, d: 0 }];
  let expanded = 0;
  while (queue.length > 0) {
    const { st, d } = queue.shift()!;
    expanded++;
    if (expanded > budget) return { reached: false, truncated: true, expanded };
    if (accept(task, st)) return { reached: true, truncated: false, expanded };
    if (d >= MAX_STEPS) continue;
    for (const a of candidates(graph, st, st.hist)) {
      if (a === EXIT) continue;
      const next = applyOp(graph, a, st);
      if (next === null) continue;
      const digest = stateDigest(next);
      if (seen.has(digest)) continue;
      seen.add(digest);
      queue.push({ st: next, d: d + 1 });
    }
  }
  return { reached: false, truncated: false, expanded };
}
