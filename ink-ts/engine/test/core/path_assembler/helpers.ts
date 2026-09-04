/**
 * path_assembler 测试共助（Python test_path_assembler.py conftest/helpers 移植）。
 *
 * 测试结点池 = 实验同源 10 结点（多源汇聚 + 双答案收尾）；注册表随契约登记、
 * 工厂为无副作用 stub（canary 可跑通——executor 接线类用例 defer 后不再使用
 * 执行路径）。EdgeEvidenceStore / FingerprintCacheStore 用默认 in-memory seam
 * （构造零参；Python 侧 ":memory:" 形态无对应物）。
 */

import { NodeContract } from '../../../src/core/contracts/contracts.js';
import type { PathAssemblyConfig } from '../../../src/core/contracts/contracts.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/index.js';
import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import type { StateSchema } from '../../../src/core/state/schema.js';
import type { Retriever } from '../../../src/core/retrieval/index.js';
import type { FingerprintCacheStore } from '../../../src/core/fingerprint_cache/index.js';
import {
  AssemblyEnvelope,
  AssemblyRequest,
  PathAssembler,
} from '../../../src/core/path_assembler/index.js';
import type { AssemblyDraftContext, DraftProvider } from '../../../src/core/path_assembler/index.js';

export const ENTRY: readonly string[] = ['user_query'];
export const DUMMY_NOW = 1_800_000_000.0;

export type PoolSpec = readonly [string, readonly string[], readonly string[]];

/** 测试结点池（实验同源：10 结点，多源汇聚 + 双答案收尾）。 */
export const POOL_SPECS: readonly PoolSpec[] = [
  ['intent_parse', [], ['intent', 'domains']],
  ['domain_router', ['intent'], ['spec', 'query']],
  ['web_search', ['query'], ['search_results']],
  ['code_gen', ['spec'], ['code']],
  ['code_gen_v2', ['spec'], ['code']],
  ['test_gen', ['code'], ['tests']],
  ['doc_gen', ['spec', 'code'], ['doc']],
  ['qa_check', ['code', 'tests'], ['quality_report']],
  ['report_assemble', ['search_results', 'quality_report', 'doc'], ['answer']],
  ['answer_direct', ['search_results'], ['answer']],
];

export function field(name: string, required = false, kind: string = FIELD_STRING): SchemaField {
  return new SchemaField({ name, required, kind: kind as SchemaField['kind'] });
}

export function spec(name: string, ...fields: SchemaField[]): SchemaSpec {
  return new SchemaSpec({ name, fields });
}

export function contract(
  inputs: readonly string[] = [],
  outputs: readonly string[] = [],
  init: { safety_tier?: number; version?: number } = {},
): NodeContract {
  const input_schema = spec('in', ...inputs.map((n) => field(n, true)));
  const output_schema = spec('out', ...outputs.map((n) => field(n)));
  return new NodeContract({
    input_schema,
    output_schema,
    safety_tier: init.safety_tier ?? 0,
    version: init.version ?? 1,
  });
}

export function make_registry(
  pool_specs: readonly PoolSpec[] = POOL_SPECS,
  init: { safety_tier?: Record<string, number>; versions?: Record<string, number> } = {},
): NodeTypeRegistry {
  const registry = new NodeTypeRegistry();
  const tiers = init.safety_tier ?? {};
  const vers = init.versions ?? {};
  for (const [type_name, inputs, outputs] of pool_specs) {
    registry.register(
      type_name,
      () => async () => ({}),
      contract(inputs, outputs, {
        safety_tier: tiers[type_name] ?? 0,
        version: vers[type_name] ?? 1,
      }),
    );
  }
  return registry;
}

/** 池子快照：注册表内全部带契约类型（类型名 → 契约）。 */
export function pool_of(registry: NodeTypeRegistry): Record<string, NodeContract> {
  const pool: Record<string, NodeContract> = {};
  for (const name of registry.types()) {
    const c = registry.contract_for(name);
    if (c !== undefined) pool[name] = c as NodeContract;
  }
  return pool;
}

export function make_request(
  goal_fields: readonly string[],
  init: {
    entry?: readonly string[];
    domain?: string;
    tier?: number;
    provider?: DraftProvider | null;
    top_k?: number;
    state_schema?: StateSchema | null;
  } = {},
): AssemblyRequest {
  return new AssemblyRequest({
    goal_schema: spec('goal', ...goal_fields.map((name) => field(name, true))),
    entry_fields: init.entry ?? ENTRY,
    domain: init.domain ?? 'code',
    max_safety_tier: init.tier ?? 0,
    draft_provider: init.provider ?? null,
    top_k: init.top_k ?? 2,
    state_schema: init.state_schema ?? null,
  });
}

/** 固定文本草稿源（模拟模型行为：计调用次数，可断言重试/兜底）。 */
export class FixedDraftProvider {
  readonly texts: string[];
  calls: AssemblyDraftContext[] = [];

  constructor(...texts: string[]) {
    this.texts = texts;
  }

  async draft(context: AssemblyDraftContext): Promise<string> {
    this.calls.push(context);
    const index = Math.min(this.calls.length - 1, this.texts.length - 1);
    return this.texts[index]!;
  }
}

export interface AssemblerOverrides {
  store?: EdgeEvidenceStore | null;
  retriever?: Retriever | null;
  config?: PathAssemblyConfig | null;
  sink?: ((record: Record<string, unknown>) => void) | null;
  now?: number | null;
  cache?: FingerprintCacheStore | null;
  cache_epsilon?: number;
  rng?: (() => number) | null;
}

export function make_assembler(
  registry: NodeTypeRegistry | null = null,
  overrides: AssemblerOverrides = {},
): PathAssembler {
  return new PathAssembler({
    registry: registry ?? make_registry(),
    evidence_store: overrides.store ?? null,
    retriever: overrides.retriever ?? null,
    config: overrides.config ?? null,
    sink: overrides.sink ?? null,
    now: overrides.now ?? DUMMY_NOW,
    cache: overrides.cache ?? null,
    cache_epsilon: overrides.cache_epsilon ?? 0.0,
    rng: overrides.rng ?? null,
  });
}

/** 草稿信封构造选项（AssemblyEnvelope 字段子集）。 */
export interface DraftEnvelopeOverrides {
  beam_width?: number;
  max_path_length?: number;
  llm_retry_limit?: number;
  llm_draft?: boolean;
  llm_window?: number;
  draft_timeout?: number;
}

/** 草稿信封（llm_draft=True + 覆盖项）。 */
export function draft_envelope(overrides: DraftEnvelopeOverrides = {}): AssemblyEnvelope {
  return new AssemblyEnvelope({ llm_draft: true, ...overrides });
}
