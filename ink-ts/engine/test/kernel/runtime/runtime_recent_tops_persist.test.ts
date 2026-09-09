/**
 * P4.1 反垄断窗口会话态持久化（#7）runtime 单测——测的是：
 * - 反垄断预算开启（AssemblyRecipe.anti_monopoly_enabled）时，组装回合把跨轮
 *   最近顶选指纹窗口随线程 checkpoint state 的独立保留键 `_recent_tops` 落库
 *   （与骨架/_round_continuation 同 state 通道、独立键不冲突）；
 * - 重启/跨会话（同一存储上重建 Runtime）后下一组装回合经 hydration 续窗口——
 *   窗口长度跨运行时连续增长（若缺持久化：新 Runtime 空窗口起算 = 长度 1）；
 * - 引擎默认（预算关）零漂移：回合 checkpoint state 不带 `_recent_tops` 新键。
 *
 * 回合驱动 = 真实组装（终态兜底 llm_decider 单节点图，确定性稳定顶选），无
 * LLM（确定性 stub 回复）；窗口指纹序列长度 = 该线程组装回合数。
 */

// gate: 超限(260 行) - 反垄断窗口会话态持久化单测（同一 seed host 多运行时重启断言，便于对照 P4.1 #7）

import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import { set_default_assembly_runtime, get_default_assembly_runtime } from '../../../src/kernel/path_assembler/index.js';
import { RECENT_TOPS_STATE_KEY } from '../../../src/kernel/runtime/index.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { MemoryStorage } from '../executor/helpers.js';

function boot_seed_entries(): KnowledgeEntry[] {
  return [
    new KnowledgeEntry({
      id: 'seed.boot.system_prompt',
      level: 'work',
      kind: KIND_RULE,
      data: { rule: { message: '系统提示基线' } },
      source: 'model',
      credibility: 0.9,
      title: '系统提示',
      tags: ['boot'],
    }),
  ];
}

/** 共享同一内存存储的 host（重启 = 同一存储上重建 Runtime，跨进程等价）。 */
class SharedStorageHost {
  readonly storage = new MemoryStorage();
  policy: unknown = new DefaultInterruptPolicy();
  async create_storage(): Promise<MemoryStorage> {
    return this.storage;
  }
  async resolve_llm(): Promise<null> {
    return null;
  }
  interrupt_policy(): unknown {
    return this.policy;
  }
  build_transport(): { send(): Promise<void> } {
    return { async send() {} };
  }
  async close(): Promise<void> {}
}

function toHost(host: SharedStorageHost): Host {
  return host as unknown as Host;
}

/** 反垄断开启配方（会话骨架关 = 每轮真实组装；确定性稳定顶选 = 窗口连续同
 *  指纹；自续关 = 每次 assemble_round 单轮）。 */
function antiMonopolyRecipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'p4-recent-tops',
    seeds: [['boot', boot_seed_entries]],
    harness_definitions: [
      new HarnessDefinition({ name: 'forge', description: '自举领域', keywords: ['自举'] }),
    ],
    event_type_specs: [new EventTypeSpec({ name: 'reply_token', renderer: 'StreamingRow' })],
    tool_wiring: {
      self_specs: () => self_tool_specs(),
      self_executor_factory: (pipeline, context_getter) =>
        make_self_executor(pipeline, context_getter as unknown as () => SelfToolContext),
      self_operation_of: (spec) => operation_of(spec),
    },
    approval_levels: {},
  });
  base.thread_skeleton_enabled = false;
  base.auto_continue_limit = 0;
  base.candidate_trial_enabled = false;
  base.anti_monopoly_enabled = true;
  base.anti_monopoly_window = 8;
  return Object.assign(base, overrides);
}

/** 线程最近 checkpoint 的 `_recent_tops` 首个窗口（key → fp 序列）。 */
async function firstRecentWindow(
  runtime: Runtime,
  thread_id: string,
): Promise<{ key: string; fps: string[] } | null> {
  const checkpoint = await runtime.storage!.get_latest_checkpoint(thread_id);
  const raw = checkpoint?.state?.[RECENT_TOPS_STATE_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  const [key, fps] = entries[0]!;
  return { key, fps: Array.isArray(fps) ? fps.map(String) : [] };
}

/** 运行期窗口首个 key 的指纹序列长度（无窗口 = 0）。 */
function runtimeFirstWindowLength(runtime: Runtime): number {
  const tops = runtime.assembly_runtime?.recent_tops;
  if (tops === undefined || tops.size === 0) return 0;
  const fps = tops.values().next().value as string[];
  return fps.length;
}

describe('P4.1 反垄断窗口会话态持久化（#7）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('反垄断开启：每轮组装窗口随 checkpoint `_recent_tops` 落库（线程尺度会话态）', async () => {
    const host = new SharedStorageHost();
    const runtime = await new Runtime().boot(toHost(host), antiMonopolyRecipe());
    await runtime.assemble_round({ state: { input: 'one' }, thread_id: 't-top', round_id: 'r1' });
    await runtime.assemble_round({ state: { input: 'two' }, thread_id: 't-top', round_id: 'r2' });
    // 运行期窗口 2 条；checkpoint state 落库同源（键独立、含 2 条指纹）
    expect(runtimeFirstWindowLength(runtime)).toBe(2);
    const persisted = await firstRecentWindow(runtime, 't-top');
    expect(persisted).not.toBeNull();
    expect(persisted!.fps.length).toBe(2);
    // 指纹稳定（同一终态兜底图）+ 与运行期 map 同一 key
    expect(persisted!.fps[0]).toBe(persisted!.fps[1]);
    const tops = runtime.assembly_runtime!.recent_tops;
    expect(tops.has(persisted!.key)).toBe(true);
    expect(runtime.assembly_runtime!.exploration_budget!.anti_monopoly_enabled).toBe(true);
    await runtime.stop();
  });

  it('重启/跨会话可续：新 Runtime（同存储）hydration 后窗口长度跨运行时连续', async () => {
    const host = new SharedStorageHost();
    const first = await new Runtime().boot(toHost(host), antiMonopolyRecipe());
    await first.assemble_round({ state: { input: 'one' }, thread_id: 't-restart', round_id: 'r1' });
    await first.assemble_round({ state: { input: 'two' }, thread_id: 't-restart', round_id: 'r2' });
    await first.stop();
    // 重启：新 Runtime 进程内存窗口为空；同存储下既有 checkpoint 仍在
    const second = await new Runtime().boot(toHost(host), antiMonopolyRecipe());
    expect(runtimeFirstWindowLength(second)).toBe(0);
    const result = await second.assemble_round({
      state: { input: 'three' },
      thread_id: 't-restart',
      round_id: 'r3',
    });
    expect(result.reason).toBe('reply');
    // 若窗口未经会话态恢复：新运行时第 1 轮窗口长度 = 1；持久化生效 = 3
    expect(runtimeFirstWindowLength(second)).toBe(3);
    const persisted = await firstRecentWindow(second, 't-restart');
    expect(persisted).not.toBeNull();
    expect(persisted!.fps.length).toBe(3);
    await second.stop();
  });

  it('引擎默认（预算关）零漂移：回合 checkpoint state 不带 `_recent_tops` 新键', async () => {
    const runtime = await new Runtime().boot(
      toHost(new SharedStorageHost()),
      antiMonopolyRecipe({ anti_monopoly_enabled: false }),
    );
    await runtime.assemble_round({ state: { input: 'plain' }, thread_id: 't-off', round_id: 'r1' });
    const checkpoint = await runtime.storage!.get_latest_checkpoint('t-off');
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.state[RECENT_TOPS_STATE_KEY]).toBeUndefined();
    // 预算关时运行期即使自持窗口也不落会话态（避免默认路径无谓新状态键）
    expect(runtime.assembly_runtime!.exploration_budget).toBeNull();
    await runtime.stop();
    set_default_assembly_runtime(null);
    expect(get_default_assembly_runtime()).toBeNull();
  });
});
