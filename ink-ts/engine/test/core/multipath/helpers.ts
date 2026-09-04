/**
 * multipath 测试共助（test_multipath.py conftest/helpers 移植）。
 *
 * 行为结点池（MP_POOL）与行为注册表/组装候选构建属于执行器接线面
 * （executor 未迁移，对应集成用例 defer），本文件只承载纯逻辑测试所需的
 * 数据形态构建：EdgeKey 便捷构造、证据行构造、Junction 分支工厂、质量
 * 闸门/合成源 stub、图候选构建。
 */

import { Graph } from '../../../src/core/graph/graph.js';
import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { SchemaField, SchemaSpec, FIELD_STRING } from '../../../src/core/schema/schemaValidator.js';
import type { EdgeEvidence, EdgeKey } from '../../../src/core/edge_evidence/index.js';
import { ORIGIN_RUNTIME } from '../../../src/core/edge_evidence/index.js';
import { AssemblyCandidate } from '../../../src/core/path_assembler/index.js';
import {
  ChainEvidence,
  EdgeRef,
  JunctionBranch,
} from '../../../src/core/multipath/index.js';
import type { JunctionSynthContext } from '../../../src/core/multipath/index.js';

export const DUMMY_NOW = 1_800_000_000.0;
export const DOMAIN = 'code';
export const ENTRY: readonly string[] = ['user_query'];

/** EdgeKey 便捷构造（契约版本缺省 '1'，域 code，变体空——类型级口径）。 */
export function edge_key(src: string, dst: string, domain = DOMAIN): EdgeKey {
  return {
    src_type: src,
    dst_type: dst,
    src_contract_version: '1',
    dst_contract_version: '1',
    context_domain: domain,
    variant_hash: '',
  };
}

/** 证据行便捷构造（类型级：variant_hash 空）。 */
export function evidence_row(
  src: string,
  dst: string,
  init: {
    success?: number;
    fail?: number;
    avg_cost?: number;
    domain?: string;
    now?: number;
  } = {},
): EdgeEvidence {
  const now = init.now ?? DUMMY_NOW;
  return {
    key: edge_key(src, dst, init.domain ?? DOMAIN),
    success_count: init.success ?? 0,
    fail_count: init.fail ?? 0,
    avg_cost: init.avg_cost ?? 0.0,
    policy: false,
    origin: ORIGIN_RUNTIME,
    last_used_at: now,
    created_at: now,
  };
}

/** SchemaField 便捷构造（kind=string）。 */
export function field(name: string, required = false): SchemaField {
  return new SchemaField({ name, required, kind: FIELD_STRING });
}

/** SchemaSpec 便捷构造。 */
export function spec(name: string, ...fields: SchemaField[]): SchemaSpec {
  return new SchemaSpec({ name, fields });
}

/** NodeContract 便捷构造（输入必填、输出声明；版本缺省 1）。 */
export function contract(
  inputs: readonly string[] = [],
  outputs: readonly string[] = [],
  init: { safety_tier?: number; version?: number } = {},
): NodeContract {
  return new NodeContract({
    input_schema: spec('in', ...inputs.map((n) => field(n, true))),
    output_schema: spec('out', ...outputs.map((n) => field(n))),
    safety_tier: init.safety_tier ?? 0,
    version: init.version ?? 1,
  });
}

/** 图候选便捷构造：按类型链注册绑定（候选链 = 绑定插入序）。 */
export function chain_candidate(
  name: string,
  nodes: readonly [string, NodeContract][],
): AssemblyCandidate {
  const graph = new Graph({ name, entry: nodes.length > 0 ? nodes[0]![0] : '' });
  for (const [type_name, node_contract] of nodes) {
    graph.add_node_type(type_name, type_name, null, node_contract);
  }
  return new AssemblyCandidate({
    rank: 0,
    source: 'algorithm',
    repaired: false,
    graph,
    score: 0.0,
  });
}

/** Junction 支流便捷构造（收尾字段缺省 = answer；证据缺省 = 零证据）。 */
export function branch(
  index: number,
  init: {
    overlay: Record<string, unknown>;
    terminal_fields?: readonly string[];
    evidence?: ChainEvidence | null;
    edges?: readonly EdgeRef[];
  },
): JunctionBranch {
  const default_ref = new EdgeRef(
    'web_search',
    index === 0 ? 'answer_direct' : `answer_direct_${index}`,
    '1',
    '1',
  );
  const refs = init.edges ?? [default_ref];
  return new JunctionBranch({
    index,
    chain: ['intent_parse', 'domain_router', 'web_search', `t${index}`],
    overlay: init.overlay,
    terminal_fields: init.terminal_fields ?? ['answer'],
    edge_refs: refs,
    evidence: init.evidence ?? null,
  });
}

/** 质量闸门 stub（judge 按产物内容判定；记录调用）。 */
export class StubGate {
  readonly predicate: (artifact: Record<string, unknown>) => boolean;
  readonly calls: Array<[string, Record<string, unknown>]> = [];

  constructor(predicate: (artifact: Record<string, unknown>) => boolean) {
    this.predicate = predicate;
  }

  judge(domain: string, artifact: unknown): boolean {
    const copy = { ...(artifact as Record<string, unknown>) };
    this.calls.push([domain, copy]);
    return Boolean(this.predicate(copy));
  }
}

/** 异构合成源 stub（返回固定合成产物；记录上下文）。 */
export class StubSynth {
  readonly selection: Record<string, unknown>;
  readonly calls: JunctionSynthContext[] = [];

  constructor(selection: Record<string, unknown> | null = null) {
    this.selection = selection ?? { answer: 'synth' };
  }

  async synthesize(context: JunctionSynthContext): Promise<Record<string, unknown>> {
    this.calls.push(context);
    return { ...this.selection };
  }
}
