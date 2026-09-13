/**
 * 超 oracle 率统计（G2.2 判定式）：配方式（follow）gold 计划应当就是最短验收解——
 * 生成端的极小性守卫已拦下「单算子+收尾提交」捷径，若 held-out 任务仍被搜出
 * **严格更短**且过验收的算子序列，说明守卫漏掉了别的东西。判定逐任务进行，
 * 复用 teacher/search 的 BFS 唯一口径（禁第二份搜索）：两边都不含 EXIT、都含
 * `submit(+check_*)` 收尾，只按算子步数比长短（C.4 同源口径，拿含 EXIT 的轨迹
 * 长度去比是错的）。
 *
 * 深度限到 `goldLen-1` 即早停（A.2 钉死「必须限深」）：统计只需「是否存在更短
 * 解」，深于 `goldLen-1` 的展开对本门纯属空烧；不限深还会把预算烧在更短解判定
 * 之外的层上，凭空制造 over_budget 证据缺口。gold 已无展开余量（`goldLen-1 < 1`）
 * 的任务结构上不可能有更短解，计为未命中但**仍在分母**——分母是 follow 子集
 * 全体，不为抬高/压低比率做任何筛选。
 *
 * 超预算（`search budget exceeded`）按保守未命中处理并单独计数上报：预算耗尽
 * 不能证明「无更短解」，吞掉会让比率不可信；把它记成命中同样不可信，所以既不
 * 计入 hits 也不伪装成确证 miss，由 `overBudget` 数字把证据缺口显式暴露给门禁
 * notes。其余异常是输入破坏，当场抛出。goal 族多解是设计语义（accept 只读公开
 * spec），混进来会系统性虚报，直接 fail-fast 拒收。
 */

import { planBfs } from '../teacher/search.js';
import type { Graph } from '../world/operators.js';
import type { Task } from '../schema.js';

/** search 侧超预算错误的匹配串（teacher/search 出队点 fail-fast 的原文）。 */
const BUDGET_EXCEEDED = /search budget exceeded/;

/** 统计集选项：仅暴露预算覆写（生产口径用 planBfs 缺省预算）。 */
export interface BeyondOracleOptions {
  readonly nodeBudget?: number;
}

/**
 * 比率报告：`total` = 参与判定的 follow 任务数（全体进分母）；`hits` = 搜出
 * 严格更短验收解的任务数；`overBudget` = 判定失败退回未命中的任务数（⊆ 分母、
 * ∉ hits 之外的单列证据）；`rate = hits/total`，空集取 0（无试验可约束，
 * 与 ci95 n=0 返回 [0,0] 的占位惯例一致）。
 */
export interface BeyondOracleReport {
  readonly total: number;
  readonly hits: number;
  readonly overBudget: number;
  readonly rate: number;
}

/**
 * 对一批 follow 任务统计超 oracle 率；确定性来自 planBfs 的排序遍历与
 * `maxDepth = goldLen - 1` 显式早停，全程无随机（抽样口径是调用方的批次 seed）。
 */
export function beyondOracleRate(
  tasks: readonly Task[],
  graph: Graph,
  opts?: BeyondOracleOptions,
): BeyondOracleReport {
  let hits = 0;
  let overBudget = 0;
  for (const task of tasks) {
    if (task.style !== 'follow') {
      throw new Error('beyondOracleRate: G2.2 仅配方族（follow），goal 族任务混入即拒收');
    }
    const goldLen = task.plan_hidden.length;
    const maxDepth = goldLen - 1;
    if (maxDepth < 1) continue;
    let shorter: string[] | null;
    try {
      shorter = planBfs(task, graph, {
        maxDepth,
        ...(opts?.nodeBudget === undefined ? {} : { nodeBudget: opts.nodeBudget }),
      });
    } catch (err) {
      if (!(err instanceof Error && BUDGET_EXCEEDED.test(err.message))) throw err;
      overBudget++;
      continue;
    }
    if (shorter !== null) hits++;
  }
  const total = tasks.length;
  return { total, hits, overBudget, rate: total === 0 ? 0 : hits / total };
}
