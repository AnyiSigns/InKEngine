/**
 * 沉淀模块测试共享 helper（对标 ink_engine/tests/test_settle.py 通用夹具）。
 *
 * 时间 seam 纪律：本迁移不依赖实时钟断言——钩子经 settle/_time.ts 的
 * now()/set_now() 取时（测试可冻结确定值）。
 *
 * 延后（引擎端到端，待引擎执行器迁移后补）：
 * test_engine_end_to_end_success_run_records_edges /
 * test_engine_end_to_end_failure_run_records_only_failed_incoming /
 * test_engine_no_settle_zero_impact / test_engine_account_usage_tokens /
 * test_engine_loop_trace_counts_repeated_edges /
 * test_engine_spawn_instance_trace_merges——这些用例经 make_engine +
 * engine.ainvoke 走执行器（轨迹留痕/usage 帧/嵌套实例并入），TS 执行器
 * 尚未迁移，故延后。
 */

import { Graph } from '../../../src/core/graph/graph.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';
import type { EdgeKey } from '../../../src/core/edge_evidence/_types.js';
import { RunResult } from '../../../src/core/run_result/run_result.js';
import type { FingerprintCache, FingerprintCacheUpsertOpts } from '../../../src/core/settle/fingerprint.js';
import {
  SettleContext,
  TraceStep,
  path_key,
  token_key,
} from '../../../src/core/settle/types.js';

export const NOW = 1_800_000_000;

// ── 图夹具 ──────────────────────────────────────────────────────────────────

/** 线性图：start → mid → end（end 为出口；对标 conftest.demo_linear_graph）。 */
export function linearGraph(): Graph {
  const g = new Graph({ name: 'linear', entry: 'start' });
  g.add_node('start', async () => ({ count: 1 }));
  g.add_node('mid', async () => ({ count: 1 }));
  g.add_node('end', async () => ({ count: 1 }));
  g.add_edge('start', 'mid');
  g.add_edge('mid', 'end');
  g.add_exit('end');
  return g;
}

// ── EdgeKey / 证据行夹具 ─────────────────────────────────────────────────────

/** 六元齐全的边键构造（TS EdgeKey 无缺省值，测试逐字段提供）。 */
export function edgeKey(
  srcType: string,
  dstType: string,
  opts: { domain?: string; variant?: string } = {},
): EdgeKey {
  return {
    src_type: srcType,
    dst_type: dstType,
    src_contract_version: '1',
    dst_contract_version: '1',
    context_domain: opts.domain ?? 'code',
    variant_hash: opts.variant ?? '',
  };
}

// ── SettleContext 夹具 ───────────────────────────────────────────────────────

/** 步骤序列构造（对标 test_settle.py._steps）。 */
export function stepsOf(...items: Array<[string, string]>): TraceStep[] {
  return items.map(
    ([node, status]) => new TraceStep({ graph_path: [], node, status }),
  );
}

/**
 * SettleContext 构造（对标 test_settle.py._ctx）。
 * tokens 以「(图路径, 结点名)」形态传入（内部经 token_key 编码为账键）。
 */
export function makeCtx(
  steps: readonly TraceStep[],
  opts: {
    graph?: Graph | null;
    tokens?: Record<string, number> | null;
    reason?: string;
    interrupt?: unknown;
    error?: string | null;
    domain?: string;
  } = {},
): SettleContext {
  const graph = opts.graph ?? linearGraph();
  const tokens = new Map<string, number>();
  for (const [key, value] of Object.entries(opts.tokens ?? {})) {
    tokens.set(token_key([], key), value);
  }
  const reason = opts.reason ?? 'reply';
  return new SettleContext({
    thread_id: 't1',
    round_id: 'r1',
    trace_id: 'tr1',
    domain: opts.domain ?? 'code',
    steps,
    node_tokens: tokens,
    graphs: new Map([[path_key([]), graph]]),
    result: new RunResult({
      state: {},
      reason: reason === 'reply' ? TerminateReason.REPLY : reason,
      interrupt: opts.interrupt as never,
      error: opts.error ?? null,
    }),
  });
}

// ── 闸门 / 缓存桩 ───────────────────────────────────────────────────────────

/** 闸门桩（QualityGate 形态：evaluate(ctx) -> bool）。 */
export class StubGate {
  readonly passed: boolean;

  constructor(passed: boolean = true) {
    this.passed = passed;
  }

  async evaluate(_ctx: SettleContext): Promise<boolean> {
    return this.passed;
  }
}

/** 缓存桩（记录 upsert 调用：{fingerprint, ...opts}）。 */
export class FakeCache implements FingerprintCache {
  readonly upserts: Array<Record<string, unknown>> = [];

  async upsert(
    fingerprint: string,
    opts: FingerprintCacheUpsertOpts,
  ): Promise<void> {
    this.upserts.push({ fingerprint, ...opts });
  }
}

/** 静态值域 ctx 便捷构造：tokens 以结点名 → 值形态给出（顶层图路径）。 */
export function tokensOf(
  values: Record<string, number>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [node, value] of Object.entries(values)) {
    map.set(token_key([], node), value);
  }
  return map;
}
