/**
 * 算子图（runner 侧真源）与候选动作集（B.3 唯一口径）。
 *
 * `GRAPH` 由 world/operators 的 `OPS`/`NODES_BASE` 组装：全部 op/terminal/decoy
 * 的契约节点加 `entry`/`exit` 两个无契约结构节点；`entry` 不可被选、`exit` 恒在
 * 候选。`candidates` 是访问上限（`MAX_REPEAT`）过滤的唯一实现点，oracle/search/
 * runner 全部调用本函数，别处禁止再写第二份过滤（B.3 不变量：entry 永不在候选、
 * 每步至少含 exit）。
 *
 * `MAX_STEPS=12`（C.7/E.14 唯一口径）：深度 5 + submit + check + exit = 8，留 4
 * 步冗余。`applyOp` 的世界唯一实现仍在 world/operators.ts，这里只 re-export。
 */

import {
  applyOp,
  ENTRY,
  EXIT,
  GRAPH_BASE,
  histCount,
  MAX_REPEAT,
  requiresOk,
  type Graph,
  type GraphNode,
  type Kind,
  type State,
} from '../world/operators.js';

export { applyOp };

/** 单次 rollout 的最大步数（C.7/E.14 唯一口径）。 */
export const MAX_STEPS = 12;

/**
 * entry/exit 结构节点的 kind 口径：`'structural'` 不属于 op/terminal/decoy 分类。
 * 两节点无契约，不参与契约表分流（op/terminal 进义项槽、decoy 只做干扰），也不
 * 参与后续按 kind 归类的动作特征；当前消费方（candidates/枚举）都先按 id 分流，
 * 永不读取这两个节点的契约字段，故 kind 值不构成行为差。
 */
type StructuralKind = Kind | 'structural';

/**
 * 基础算子图：NODES_BASE 全量节点 + `entry`/`exit` 两个结构节点（kind='structural'）。
 * 结构节点无契约，字段为占位值；`GRAPH` 对外仍按 `Graph` 消费（契约读取方全部先按
 * kind/id 分流，structural 节点的 kind 域外差异不构成行为差）。
 */
export const GRAPH: Graph = (() => {
  const nodes: Record<string, Omit<GraphNode, 'kind'> & { readonly kind: StructuralKind }> = {
    ...GRAPH_BASE.nodes,
  };
  nodes[ENTRY] = {
    id: ENTRY,
    kind: 'structural',
    requires: {},
    provides: null,
    out_type: 'any',
    alive: true,
    requires_types: [],
  };
  nodes[EXIT] = {
    id: EXIT,
    kind: 'structural',
    requires: {},
    provides: null,
    out_type: 'any',
    alive: true,
    requires_types: [],
  };
  return { nodes } as unknown as Graph;
})();

/**
 * B.3 候选动作集唯一口径：`sorted(graph.nodes)` 排序遍历保证确定性；entry 禁入；
 * exit 恒在（且不因重复访问受 MAX_REPEAT 限制）；普通节点先按访问计数过滤，再走
 * 契约闸 `requiresOk`。访问上限过滤只在本函数实现。
 */
export function candidates(graph: Graph, st: Readonly<State>, hist: readonly string[]): string[] {
  const out: string[] = [];
  for (const nid of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nid]!;
    if (nid === ENTRY || !node.alive) continue;
    if (nid === EXIT) {
      out.push(nid);
      continue;
    }
    if (histCount(hist, nid) >= MAX_REPEAT) continue;
    if (requiresOk(node, st)) out.push(nid);
  }
  return out;
}
