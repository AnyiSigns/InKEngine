/**
 * 路径指纹：组装结果与请求上下文的身份指纹（算法归引擎，使用方仅阈值覆盖权）。
 *
 * 指纹算法在 TS 侧基于 graph.digest()（内部纯 FNV-1a 64 hex，跨语言字节
 * 等价不保证；Python 引擎已冻为参考实现，本仓内部稳定即视为一致）：
 * 拓扑 + 节点/条件引用 + 子图 + schema 参与；name 不参与。上下文指纹
 * 在图摘要之上叠加上下文与模型标识；组装请求指纹由请求侧字段
 * （目标字段/入口字段/域/安全档/模型）独立计算，请求侧与沉淀侧共用
 * 同一函数。任一维度漂移 = 指纹变化 → 旧条目自然不命中；与契约版本
 * 入键同语义，钉版本防静默复用漂移结果。
 *
 * core 零依赖：复用 Graph.digest 与本地规范 JSON 序列化，无 node:* / 第三方。
 */

import type { Graph } from '../graph/graph.js';
import { fnv1a64Hex } from '../graph/graph_types.js';

export function graph_fingerprint(graph: Graph): string {
  return graph.digest();
}

export function context_fingerprint(
  graph: Graph,
  init: { context?: Record<string, unknown> | null; model_id?: string | null } = {},
): string {
  const payload: Record<string, unknown> = {
    graph: graph.digest(),
    context: init.context ?? {},
    model_id: init.model_id ?? '',
  };
  return fnv1a64Hex(canonical_json(payload));
}

export function request_fingerprint(init: {
  goal_fields: readonly string[];
  entry_fields: readonly string[];
  domain: string;
  max_safety_tier: number;
  model_id: string;
}): string {
  const payload: Record<string, unknown> = {
    goal_fields: [...init.goal_fields].sort(),
    entry_fields: [...init.entry_fields].sort(),
    domain: String(init.domain),
    max_safety_tier: Math.trunc(Number(init.max_safety_tier)),
    model_id: init.model_id ?? '',
  };
  return fnv1a64Hex(canonical_json(payload));
}

/** 规范 JSON 序列化：键序无关（递归排序）、ensure_ascii 等价、跳过 undefined。 */
function canonical_json(value: unknown): string {
  return JSON.stringify(to_canonical(value));
}

function to_canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => to_canonical(v));
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = to_canonical(v);
  }
  return out;
}
