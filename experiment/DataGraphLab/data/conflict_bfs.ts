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
 *
 * `safeActionSet` 是标签软化（Phase 2 门禁，§6）的检索内核：一次有界 BFS 收集
 * 「从 start 出发、仍通向验收的首步动作集」。队元素携带首步动作，凡出队态被验收
 * 即把该首步动作计入安全集；start 自身已验收则 EXIT 安全（提前结束 = 通向验收，
 * 与冲突率口径一致）。超预算截断时只回传已证动作（保守下界，绝不谎报安全），
 * gold 由调用方（oracle）按构造保证强制并入。
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
  // 头指针消费代替 shift（与 teacher/search.ts 同源）：shift 每次重排整个数组，
  // 大预算 BFS 下退化为 O(n²)；只增队列用游标前进即可保持 FIFO 确定序。
  let head = 0;
  while (head < queue.length) {
    const { st, d } = queue[head]!;
    head++;
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

export interface SafeSetResult {
  /** 仍通向验收的首步动作集（升序稳定排序，含调用方强制并入的 gold 后的并集）。 */
  readonly safe: string[];
  /** 每个安全动作「到最近验收态的最短剩余步数」（BFS 深度；gold 强制并入时无深度，调用方自填）。 */
  readonly depths: Readonly<Record<string, number>>;
  /** 展开预算耗尽仍未穷尽——返回的安全集是保守下界（只含已证动作）。 */
  readonly truncated: boolean;
  readonly expanded: number;
}

/**
 * 从 start 出发、收集「首步动作 → 通向验收」的全部动作（Phase 2 标签软化内核）。
 * 一次 BFS 完成：队元素携带该路径的首步动作与当前深度，出队态被 accept 即把首步
 * 动作计入安全集（深度取首次发现 = 该动作到验收的最短剩余步数）；start 自身已验收
 * 则 EXIT 安全（提前结束也算通向验收，与冲突率同口径，深度 0）。EXIT 不显式展开
 * （与 reachesAccept 同因）；预算截断即停，只回传已证动作——保守下界：可能漏报
 * 安全动作，绝不把未证动作当安全（软化标签只敢给已证者）。
 *
 * 去重键与 `stateDigest`（C.4 值字段+逐算子计数）不同：这里只用值字段三元组
 * （x/answer/verdict）做 seen 去重，**显式放弃计数维**。理由：① 软化标签只要
 * 「存在一条通向验收的路径」即可，计数不同的同值状态被合并只可能少报安全动作
 * （保守方向），绝不误报——合并态下找到的路径在原状态（计数更宽）必合法；
 * ② 计数维使去重空间爆炸（3^12 级），BFS 在 30k 级训练集上不可行。口径差异
 * 在头注登记，`stateDigest` 仍是 search/冲突率的唯一实现。
 */
export function safeActionSet(graph: Graph, task: Task, start: State, budget: number): SafeSetResult {
  const safe = new Set<string>();
  const depths = new Map<string, number>();
  const seen = new Set<string>([valueKey(start)]);
  const queue: Array<{ st: State; d: number; first: string }> = [];
  let expanded = 0;
  let head = 0;
  if (accept(task, start)) {
    safe.add(EXIT);
    depths.set(EXIT, 0);
  }
  for (const a of candidates(graph, start, start.hist)) {
    if (a === EXIT) continue;
    const next = applyOp(graph, a, start);
    if (next === null) continue;
    const key = valueKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ st: next, d: 1, first: a });
  }
  while (head < queue.length) {
    const { st, d, first } = queue[head]!;
    head++;
    if (safe.has(first)) continue; // 该首步已证安全：其后代共享同一首步，无需再探
    expanded++;
    if (expanded > budget) return { safe: [...safe].sort(), depths: Object.fromEntries(depths), truncated: true, expanded };
    if (accept(task, st)) {
      safe.add(first);
      if (!depths.has(first)) depths.set(first, d);
      continue; // 已验收态的首步动作已证，不再从该态展开（其后动作共享同一首步）
    }
    if (d >= MAX_STEPS) continue;
    for (const a of candidates(graph, st, st.hist)) {
      if (a === EXIT) continue;
      const next = applyOp(graph, a, st);
      if (next === null) continue;
      const key = valueKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ st: next, d: d + 1, first });
    }
  }
  return { safe: [...safe].sort(), depths: Object.fromEntries(depths), truncated: false, expanded };
}

/** 软化 BFS 的 seen 键：只取值字段三元组（保守合并计数维，见 safeActionSet 头注）。 */
function valueKey(st: Readonly<State>): string {
  return hashObj({ x: st.x, answer: st.answer, verdict: st.verdict });
}
