/**
 * 契约自指元工具测试共用装置（内存假存储 + 挂卡审批假节点上下文 + 装配）。
 *
 * 引擎 core 零 IO：Storage seam 以注入内存假存储驱动，与 Python
 * create_storage("memory://") 等价；StubCtx 为鸭子类型节点上下文
 * （无注入值挂起抛 InterruptSignal / 有注入值消费返回 / 挂起清单留痕
 * 供断言），与 Python 侧 _StubCtx 同构。
 */

import type { EngineEvent } from '../../../src/core/events/events.js';
import { InterruptSignal } from '../../../src/core/interrupt/interrupt_types.js';
import { HarnessRegistry } from '../../../src/core/harness/index.js';
import { KnowledgeSet } from '../../../src/core/knowledge_set/index.js';
import { ApprovalLevel, SelfApplicationPipeline } from '../../../src/core/self_application/index.js';
import { PatchKind, ProposalValidator } from '../../../src/core/self_proposal/index.js';
import type { PatchKind as PatchKindType } from '../../../src/core/self_proposal/index.js';
import type {
  ChainLink,
  CheckpointRecord,
} from '../../../src/core/storage/storage_records.js';
import type { Storage } from '../../../src/core/storage/storage.js';
import {
  SelfToolContext,
  make_self_executor,
  self_tool_specs,
} from '../../../src/core/self_tools/index.js';
import type { ConvergenceHook, SelfToolNodeContext } from '../../../src/core/self_tools/index.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';

/** 内存假存储：records/事件日志三原语 + checkpoint 惰性通道全量实现。 */
export class MemStorage implements Storage {
  readonly records = new Map<string, Map<string, Record<string, unknown>>>();
  readonly events = new Map<string, { seq: number; event: EngineEvent }[]>();
  readonly snapshot_capable = false;

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    return this.records.get(collection)?.get(key) ?? null;
  }

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(
      key,
      JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
    );
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return [...(this.records.get(collection)?.values() ?? [])];
  }

  async delete_collection(collection: string): Promise<number> {
    const table = this.records.get(collection);
    if (!table) return 0;
    this.records.delete(collection);
    return table.size;
  }

  async append_event(thread_id: string, event: EngineEvent): Promise<number> {
    const list = this.events.get(thread_id) ?? [];
    const seq = list.length + 1;
    list.push({ seq, event });
    this.events.set(thread_id, list);
    return seq;
  }

  async events_after(thread_id: string, seq: number): Promise<EngineEvent[]> {
    return (this.events.get(thread_id) ?? [])
      .filter((item) => item.seq > seq)
      .sort((a, b) => a.seq - b.seq)
      .map((item) => item.event);
  }

  async latest_event_seq(thread_id: string): Promise<number> {
    return this.events.get(thread_id)?.length ?? 0;
  }

  async truncate_events(thread_id: string, after_seq: number): Promise<void> {
    const list = this.events.get(thread_id) ?? [];
    this.events.set(thread_id, list.filter((item) => item.seq <= after_seq));
  }

  async trim_events(thread_id: string, before_seq: number): Promise<number> {
    const list = this.events.get(thread_id) ?? [];
    const keep = list.filter((item) => item.seq >= before_seq);
    this.events.set(thread_id, keep);
    return list.length - keep.length;
  }

  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return null;
  }

  async get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> {
    return null;
  }

  async put_checkpoint(record: CheckpointRecord): Promise<CheckpointRecord> {
    return record;
  }

  async list_checkpoints(thread_id: string): Promise<CheckpointRecord[]> {
    return [];
  }

  async chain_index(thread_id: string): Promise<ChainLink[]> {
    return [];
  }

  async delete_checkpoints(thread_id: string, ids: readonly number[]): Promise<number> {
    return 0;
  }

  async set_checkpoint_parent(
    thread_id: string,
    checkpoint_id: number,
    parent_id: number | null,
  ): Promise<number> {
    return 0;
  }

  async snapshot(dest: string): Promise<void> {
    throw new Error('内存假存储不支持快照');
  }

  async restore(src: string): Promise<void> {
    throw new Error('内存假存储不支持还原');
  }

  async close(): Promise<void> {}
}

/** 挂卡审批的假节点上下文（Python 侧 _StubCtx 同构）。 */
export class StubCtx implements SelfToolNodeContext {
  readonly round_id: string | null;
  readonly thread_id: string | null;
  private readonly injects: Map<string, unknown>;
  readonly suspended: Array<{ key: string; payload: Record<string, unknown> }>;

  constructor(
    options: {
      injections?: Record<string, unknown>;
      round_id?: string | null;
      thread_id?: string | null;
    } = {},
  ) {
    this.injects = new Map(Object.entries(options.injections ?? {}));
    this.round_id = options.round_id ?? 'r-1';
    this.thread_id = options.thread_id ?? null;
    this.suspended = [];
  }

  async interrupt(key: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.injects.has(key)) {
      const value = this.injects.get(key);
      this.injects.delete(key);
      return value;
    }
    this.suspended.push({ key, payload });
    throw new InterruptSignal(key, payload);
  }

  async get_interrupt_payload(): Promise<unknown> {
    return null;
  }
}

/** 工具描述清单按名索引。 */
export function _specs(): Record<string, ToolSpec> {
  const out: Record<string, ToolSpec> = {};
  for (const spec of self_tool_specs()) out[spec.name] = spec;
  return out;
}

/** 装配最小自指工具执行环境（内存存储 + 分级表 + 可选前置闸门）。 */
export function _make_tools(
  storage: Storage,
  options: {
    approval_levels?: Partial<Record<PatchKindType, 'L0' | 'L1' | 'L2'>> | null;
    convergence?: ConvergenceHook | null;
  } = {},
): { pipeline: SelfApplicationPipeline; executor: ReturnType<typeof make_self_executor>; context: SelfToolContext } {
  const validator = new ProposalValidator({
    allowed_components: ['column', 'message_list', 'agent_input'],
    allowed_channels: ['state'],
    allowed_theme_tokens: ['bg', 'fg', 'accent'],
  });
  const pipeline = new SelfApplicationPipeline({
    storage,
    validator,
    approval_levels:
      options.approval_levels
      ?? { [PatchKind.THEME]: ApprovalLevel.L0, [PatchKind.KNOWLEDGE]: ApprovalLevel.L0 },
  });
  const harnessRegistry = new HarnessRegistry();
  const knowledgeSet = new KnowledgeSet('test', { storage });
  const context = new SelfToolContext({
    self_pipeline: pipeline,
    harness_registry: harnessRegistry,
    knowledge_set: knowledgeSet,
    convergence: options.convergence ?? null,
  });
  const executor = make_self_executor(pipeline, () => context);
  return { pipeline, executor, context };
}
