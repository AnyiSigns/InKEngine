/**
 * 轨迹回放与归因（纯函数层；只生成更新计划，不落库）。
 *
 * 对标 ink_engine.core.settle 的 derive_traversals / run_verdict /
 * attribution_plan——沉淀模块的算法核心：
 * - derive_traversals：轨迹回放，同图路径内连续执行且图中存在该边 = 一条
 *   边遍历；计划驱动的跳跃（相邻执行结点间无图边）不构成遍历；
 * - run_verdict：证据归因方向判定（失败归因 / 中性 / 成功归因）；
 * - attribution_plan：按归因规则逐边生成 EdgeUpdate 计划。
 */

import type { EdgeEvidence } from '../edge_evidence/_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import {
  TRACE_FAILED,
  TRACE_SKIPPED,
  TRACE_SUCCESS,
  UPDATE_FAIL,
  UPDATE_SUCCESS,
} from './_constants.js';
import {
  EdgeUpdate,
  SettleContext,
  TraceStep,
  Traversal,
  edge_key_str,
  node_identity,
  path_key,
  token_key,
  traversal_edge_key,
} from './types.js';

// ── 轨迹回放 ────────────────────────────────────────────────────────────────

/**
 * 轨迹回放：同图路径内连续执行且图中存在该边 = 一条边遍历。
 *
 * 嵌套执行（子图/实例/分支）与并行组成员步骤可能插入主循环步骤之间——
 * 按图路径分组后取各路径内非成员步骤的相邻对，父图边链不被子层步骤打断；
 * 计划驱动的跳跃（相邻执行结点间无图边）不构成遍历——没有边的执行不产生
 * 证据。
 */
export function derive_traversals(ctx: SettleContext): Traversal[] {
  const sequences = new Map<string, TraceStep[]>();
  for (const step of ctx.steps) {
    if (step.member) continue; // 并行组成员无图边语义，不参与遍历推导
    const key = path_key(step.graph_path);
    const seq = sequences.get(key);
    if (seq === undefined) {
      sequences.set(key, [step]);
    } else {
      seq.push(step);
    }
  }
  const traversals: Traversal[] = [];
  for (const [pathKey, seq] of sequences) {
    const graph = ctx.graphs.get(pathKey);
    if (graph === undefined) continue;
    for (let i = 0; i + 1 < seq.length; i++) {
      const prev = seq[i]!;
      const cur = seq[i + 1]!;
      const targets = (graph.edges[prev.node] ?? []).map((e) => e.target);
      if (!targets.includes(cur.node)) continue;
      const srcIdentity = node_identity(graph, prev.node);
      const dstIdentity = node_identity(graph, cur.node);
      traversals.push(
        new Traversal({
          graph_path: prev.graph_path,
          src: prev,
          dst: cur,
          src_type: srcIdentity[0],
          dst_type: dstIdentity[0],
          src_contract_version: srcIdentity[1],
          dst_contract_version: dstIdentity[1],
          src_variant_hash: srcIdentity[2],
          dst_variant_hash: dstIdentity[2],
        }),
      );
    }
  }
  return traversals;
}

// ── 归因方向判定 ─────────────────────────────────────────────────────────────

/**
 * 证据归因方向判定（只记录不裁决的「裁决」= 归因方向）：
 * - 有失败结点 → 失败归因（只记失败结点入边）；
 * - 挂起（中断未决）/ 错误收尾（无失败结点，如计划步级错误）/ 预算截断 →
 *   中性不记（路径未走完，无证据裁决）；
 * - 其余（正常回复/停止）→ 成功归因（路径全通才证明每条边有效）。
 */
export function run_verdict(ctx: SettleContext): string {
  if (ctx.steps.some((s) => s.status === TRACE_FAILED)) {
    return UPDATE_FAIL;
  }
  if (ctx.steps.some((s) => s.status === TRACE_SKIPPED)) {
    return 'neutral';
  }
  if (ctx.result.interrupt !== null || ctx.result.reason === 'interrupted') {
    return 'neutral';
  }
  if (
    ctx.result.reason === TerminateReason.ERROR ||
    ctx.result.reason === TerminateReason.BUDGET_EXCEEDED
  ) {
    return 'neutral';
  }
  return UPDATE_SUCCESS;
}

// ── 归因计划 ─────────────────────────────────────────────────────────────────

/**
 * 归因计划（纯函数）：按归因规则逐边生成更新，不落库。
 *
 * - 成功归因：全部遍历边 success+delta（delta=1，成功才全边 +1）；
 * - 失败归因（归因对称）：失败事件视同整链可疑，惩罚按边权重 / 成功史
 *   加权分摊到全路径边——权重 = 该边成功计数 + 1（零证据边取 1），使
 *   「成功膨胀」被失败信号按真实证据强度回撤；失败结点的入边额外 +1 作为
 *   诊断信号（定位最可疑边），避免失败信号被稀释；
 * - 成本每次执行归集：目标结点执行边界 token 计账随归因携带；
 * - evidence_index 为可选边证据快照（钩子注入，字符串主键索引），缺省
 *   退化为等权（每边权重 1）的口径。
 */
export function attribution_plan(
  ctx: SettleContext,
  evidence_index: Map<string, EdgeEvidence> | null = null,
): EdgeUpdate[] {
  const verdict = run_verdict(ctx);
  if (verdict !== UPDATE_SUCCESS && verdict !== UPDATE_FAIL) {
    return [];
  }
  const traversals = derive_traversals(ctx);
  if (traversals.length === 0) {
    return [];
  }
  const updates: EdgeUpdate[] = [];
  const failedTr =
    traversals.find((t) => t.dst.status === TRACE_FAILED) ?? null;
  for (const tr of traversals) {
    const key = traversal_edge_key(tr, ctx.domain);
    const cost = ctx.node_tokens.get(token_key(tr.dst.graph_path, tr.dst.node)) ?? 0;
    if (verdict === UPDATE_SUCCESS) {
      updates.push(
        new EdgeUpdate({ key, kind: UPDATE_SUCCESS, cost: Number(cost), delta: 1 }),
      );
      continue;
    }
    // 失败：加权分摊（权重 = 成功史 + 1，等权退化 = 1）
    let weight = 1;
    if (evidence_index !== null) {
      const ev = evidence_index.get(edge_key_str(key));
      if (ev !== undefined) {
        weight = ev.success_count + 1;
      }
    }
    const delta = weight + (tr === failedTr ? 1 : 0);
    updates.push(new EdgeUpdate({ key, kind: UPDATE_FAIL, cost: Number(cost), delta }));
  }
  return updates;
}
