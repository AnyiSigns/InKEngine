/**
 * Search teacher（C.4 的 BFS 最短解）：v0 边权恒 1 且去重键完备，"有解必找到"
 * 与"步数即最优"同时成立——首个出队的 accepted 态就是最短解，无需启发式也无
 * 次优风险。去重键 `stateDigest` 的唯一实现在 data/conflict_bfs.ts（那里已声明
 * 本文件是它的第二个消费方），此处只 re-export，禁止第二份实现。
 *
 * 用途边界（E.13 标签纪律）：产出仅服务 ① 可解性 QA（生成器说可解，BFS 必须
 * 找得到）、② G2.2 超 oracle 统计、③ goal 族公开规划臂（该两族的 accept 只读
 * 公开 spec，故同一 plan_bfs 天然构成其上界）。不进训练集、不进特征——控制器
 * 看不见 expected 只能跟指令走，plan_bfs 找的是"任意到达验收态的路径"，与
 * oracle 在同一 obs 上会给出不同 action，混入即触发标签冲突。G2.2 比较口径
 * 同源：返回 plan 与 plan_hidden 都不含 EXIT，只按算子步数比长短；统计侧只需
 * "是否存在更短解"时把 maxDepth 钉到 len(gold)-1 即可早停。
 *
 * R5 轨迹约束（2026-09-14）：follow 族（spec.trace 存在）的验收要求 hist ==
 * trace 精确匹配——任何前缀 ≠ trace 前缀的状态永远不可能通过验收（后续无法
 * 修正前缀），故 BFS 沿 trace 前缀剪枝即可保持完备：解唯一 = trace 本身
 * （等长，G2.2 按定义归零）。goal 族无 trace，走完整 BFS（多解合法）。
 *
 * 预算在出队点 fail-fast 而非静默返回 null：本函数的语义是"有解必找到"，超
 * 预算意味着异常输入，值得当场暴露，不该和"确证无解"混成同一个返回值。确证
 * 无解（队列耗尽）返回 null。确定性由 candidates 的排序遍历与 FIFO 出队序闭
 * 环保证；队列用数组加头指针，shift 在大规模展开下会退化成 O(n²)。EXIT 永不
 * 入队：出队点已判 accept，在非验收态选 EXIT 等同认输，展开它没有增益（与
 * conflict_bfs 同一口径）。
 */

import { stateDigest } from '../data/conflict_bfs.js';
import { MAX_STEPS, candidates } from '../runner/graph.js';
import { EXIT, applyOp, initState, type Graph, type State } from '../world/operators.js';
import { accept } from '../verify/acceptor.js';
import type { Task } from '../schema.js';

export { stateDigest };

/** 搜索预算与深度上限；maxDepth 缺省取 MAX_STEPS（E.14 唯一口径）。 */
export interface PlanBfsOptions {
  readonly nodeBudget?: number;
  readonly maxDepth?: number;
}

/** 展开预算默认值：远超统计集上任何合法任务的可达状态规模。 */
const DEFAULT_NODE_BUDGET = 2_000_000;

/**
 * 从初始态出发的 BFS 最短解；返回的 plan 不含 EXIT，无解返回 null。
 * hist 即当条路径（st.hist ≡ plan），不再平行维护 plan 数组——两者同源，
 * 复制只加倍每节点内存，而深度判定也直接读 hist 长度。
 * R5：follow 族（spec.trace 存在）沿 trace 前缀剪枝，解唯一 = trace（等长）；
 * 更短解按定义不存在，故 G2.2 归零。goal 族走完整 BFS。
 */
export function planBfs(task: Task, graph: Graph, opts?: PlanBfsOptions): string[] | null {
  const nodeBudget = opts?.nodeBudget ?? DEFAULT_NODE_BUDGET;
  const maxDepth = opts?.maxDepth ?? MAX_STEPS;
  const trace = Array.isArray(task.spec.trace) ? (task.spec.trace as unknown as string[]) : null;
  const start = initState(task.x, task.spec);
  if (trace !== null) {
    // R5 前缀剪枝：验收要求 hist == trace。回溯检查每个前缀都在 candidates 里
    // 且类型合法（applyOp 非 null），则金计划本身即唯一解（等长）；否则无解。
    // maxDepth 语义不变：解超出深度上限即算截断（返回 null，与"比最短解浅则
    // 耗尽"同口径）；该分支按定义无更短解，nodeBudget 不消耗。
    if (trace.length > maxDepth) return null;
    let cur = start;
    for (const op of trace) {
      if (!candidates(graph, cur, cur.hist).includes(op)) return null;
      const next = applyOp(graph, op, cur);
      if (next === null) return null;
      cur = next;
    }
    return accept(task, cur) ? [...cur.hist] : null;
  }
  const seen = new Set<string>([stateDigest(start)]);
  const queue: State[] = [start];
  let head = 0;
  while (head < queue.length) {
    const st = queue[head++]!;
    if (head > nodeBudget) throw new Error('search budget exceeded');
    if (accept(task, st)) return [...st.hist];
    if (st.hist.length >= maxDepth) continue;
    for (const a of candidates(graph, st, st.hist)) {
      if (a === EXIT) continue;
      const next = applyOp(graph, a, st);
      if (next === null) continue;
      const digest = stateDigest(next);
      if (seen.has(digest)) continue;
      seen.add(digest);
      queue.push(next);
    }
  }
  return null;
}
