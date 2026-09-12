/**
 * 骨架枚举与签名去冗余（C.1 的枚举/签名段；从 generator.ts 拆出以满足单文件
 * ≤350 行纪律，gen/generator.ts 与 gen/splits.ts 均 import 本文件）。
 *
 * 枚举只取 `kind=="op"` 的算子（终算子不入采样池），同算子重复受 `MAX_REPEAT`
 * 限制（与 runner/graph 的 candidates 同口径，否则会枚举出 runner 判非法的计划），
 * 类型合法性用 DFS 携带的字段类型表预检。签名 = 诱导函数：Int 用全域探针
 * [-50,50]（101 点，判定精确、代数碰撞可证无），Str 用 C.1 固定十串。枚举时按
 * 前缀增量携带 `探针 → 当前 x` 的向量，每条树边对全部探针各 applyOp 一次，整棵
 * 树的探针更新总量 = 骨架数 × 探针数，而非“每个骨架从头重放 101 探针”的
 * O(骨架数 × 深度 × 探针数)。同签名只留最短（同长取字典序首）——这是
 * “配方族最短路径 ≈ gold”的关键（G2.2 不奖励忽略指令的捷径）。
 */

import {
  applyOp,
  GRAPH_BASE,
  histCount,
  initState,
  MAX_REPEAT,
  OPS,
  runPlan,
  type Contract,
  type State,
} from '../world/operators.js';
import { t, type TypeName } from '../world/types.js';
import { canonicalJson, hashObj } from '../world/hash.js';
import type { Root } from '../schema.js';

/** 深度上限：算子序列最长 5 步（不含终算子），C.1 唯一口径。 */
export const MAX_DEPTH = 5;

/** Int 全域探针（-50..50，101 点）：签名去冗余从“探针近似”升级为可证正确。 */
export const PROBE_INT: readonly number[] = Array.from({ length: 101 }, (_, i) => i - 50);

/** Str 固定探针（C.1 原文十串）。 */
export const PROBE_STR: readonly string[] = [
  'a',
  'ab',
  'abc',
  'abcd',
  'abcde',
  'xyz',
  'Ab',
  'aBcD',
  'hello',
  'wxyzabc',
];

/** 骨架 = 起点类型 + 类型合法的算子序列（不含终算子）。 */
export interface Skel {
  readonly root: Root;
  readonly plan: readonly string[];
}

/** 签名 = 逐探针的（类型, 终值）；死路（仅非法骨架重放会碰到）记 null。 */
export type Sig = ReadonlyArray<{ readonly type: TypeName; readonly value: number | string } | null>;

/** 类型合法性预检（DFS 字段表版，语义同 requiresOk 但只看派生类型、无运行时状态）。 */
function requiresTypeOk(op: Contract, fields: Readonly<Record<string, TypeName>>): boolean {
  for (const [field, types] of Object.entries(op.requires)) {
    const cur = fields[field];
    if (cur === undefined) return false;
    if (!types.includes('any') && !types.includes(cur)) return false;
  }
  return true;
}

interface EnumNode {
  sk: Skel;
  sig: Sig;
}

/**
 * DFS 全枚举并携带探针向量：下探一条边时把算子对全部探针各 applyOp 一次，
 * 节点处 O(1) 读出当前向量即该骨架的签名。类型预检保证 applyOp 必不返回死路。
 */
function enumerateWithSigs(maxDepth: number): EnumNode[] {
  const out: EnumNode[] = [];
  const dfs = (
    root: Root,
    fields: Record<string, TypeName>,
    plan: readonly string[],
    xs: readonly (number | string)[],
  ): void => {
    if (plan.length > 0) {
      const sig: Sig = xs.map((v) => ({ type: t(v) as TypeName, value: v }));
      out.push({ sk: { root, plan: [...plan] }, sig });
    }
    if (plan.length >= maxDepth) return;
    for (const op of OPS) {
      if (op.kind !== 'op') continue;
      if (histCount(plan, op.id) >= MAX_REPEAT) continue;
      if (!requiresTypeOk(op, fields)) continue;
      const nf = { ...fields, [op.provides!]: op.out_type as TypeName };
      const nxs = xs.map((v) => {
        const st = applyOp(GRAPH_BASE, op.id, initState(v));
        // 类型预检保证契约可满足，applyOp 必返回非空；探针向量只跟踪 x。
        return (st as State).x as number | string;
      });
      dfs(root, nf, [...plan, op.id], nxs);
    }
  };
  dfs('Int', { x: 'Int' }, [], PROBE_INT);
  dfs('Str', { x: 'Str' }, [], PROBE_STR);
  return out;
}

/** 公开枚举入口：全部类型合法骨架（未去冗余）。 */
export function enumerateSkeletons(maxDepth: number = MAX_DEPTH): Skel[] {
  return enumerateWithSigs(maxDepth).map((n) => n.sk);
}

/** 诱导函数签名（C.1 原文语义）：对每个探针从头回放得到（类型, 终值）。 */
export function signature(root: Root, skeleton: readonly string[]): Sig {
  const probes: readonly (number | string)[] = root === 'Int' ? PROBE_INT : PROBE_STR;
  return probes.map((probe) => {
    const st = runPlan(skeleton, initState(probe));
    if (st === null) return null;
    return { type: t(st.x) as TypeName, value: st.x as number | string };
  });
}

/** 签名 → 去重键（规范序列化，杜绝撞串）。 */
function sigKey(sig: Sig): string {
  return canonicalJson(sig);
}

function comparePlan(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** 骨架排序：先 root 再逐元素比计划（对齐 C.1 的 Python 元组排序）。 */
export function compareSkel(a: Skel, b: Skel): number {
  if (a.root !== b.root) return a.root < b.root ? -1 : 1;
  return comparePlan(a.plan, b.plan);
}

/** (长度, 计划) 字典序：去冗余时“同签名只留最短、同长取字典序首”。 */
function isPreferred(a: Skel, b: Skel): boolean {
  if (a.plan.length !== b.plan.length) return a.plan.length < b.plan.length;
  return comparePlan(a.plan, b.plan) < 0;
}

/** 带签名去冗余（模块级 SKELETONS 的快速路径：直接用增量签名，不回放）。 */
function dedupeWithSigs(nodes: EnumNode[]): Skel[] {
  const best = new Map<string, Skel>();
  for (const { sk, sig } of nodes) {
    const key = sigKey(sig);
    const prev = best.get(key);
    if (prev === undefined || isPreferred(sk, prev)) best.set(key, sk);
  }
  return [...best.values()].sort(compareSkel);
}

/** 公开去冗余入口（逐骨架回放签名，供测试/独立复核与增量路径对账）。 */
export function dedupeBySignature(skels: readonly Skel[]): Skel[] {
  const best = new Map<string, Skel>();
  for (const sk of skels) {
    const key = sigKey(signature(sk.root, sk.plan));
    const prev = best.get(key);
    if (prev === undefined || isPreferred(sk, prev)) best.set(key, sk);
  }
  return [...best.values()].sort(compareSkel);
}

/** 去冗余后的全量骨架池（模块级一次性计算，H.1 量级 10^4）。 */
export const SKELETONS: readonly Skel[] = dedupeWithSigs(enumerateWithSigs(MAX_DEPTH));

/** C.1 `_skel_id`：骨架的稳定指纹（composition_id 口径，切分只看它）。 */
export function _skelId(sk: Skel): string {
  return hashObj([sk.root, [...sk.plan]]);
}
