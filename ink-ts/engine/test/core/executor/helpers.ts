/**
 * 执行引擎测试公共设施：内存 Storage seam + 演示图/引擎构造辅助。
 *
 * MemoryStorage 镜像 Python conftest memory_storage 的口径（自增 checkpoint
 * id / 链一致性写入校验 / 事件序跨接 / 截断/回写原语），供执行器测试做纯
 * 内存恢复/续流/编辑重放语义验证；演示图与 make_engine 对应 conftest 的
 * demo_linear/conditional/loop_graph 与 DemoBudgetPolicy。
 */
import { EngineEvent } from '../../../src/core/events/events.js';
import { ChainLink, CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import type { Storage } from '../../../src/core/storage/storage.js';
import { Engine } from '../../../src/core/executor/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { RunOptions, RunResult } from '../../../src/core/run_result/run_result.js';
import type { EngineTransport } from '../../../src/core/events/events.js';
import { CollectorTransport } from '../../../src/core/events/events.js';
import type { JsonRecord } from '../../../src/core/json.js';
import type { BudgetPolicy } from '../../../src/core/budget/budget_types.js';
import { BudgetExceededError } from '../../../src/core/budget/budget.js';

/** 内存 Storage（自增 id/seq；链一致性写入校验；fork 首写跳过校验）。 */
export class MemoryStorage implements Storage {
  private readonly checkpoints = new Map<number, CheckpointRecord>();
  private readonly events = new Map<string, EngineEvent[]>();
  private readonly records = new Map<string, Record<string, unknown>>();
  private nextCheckpointId = 1;
  private nextEventSeq = 1;

  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return this.checkpoints.get(checkpoint_id) ?? null;
  }

  async get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> {
    let latest: CheckpointRecord | null = null;
    for (const record of this.checkpoints.values()) {
      if (record.thread_id !== thread_id) continue;
      if (latest === null || record.checkpoint_id > latest.checkpoint_id) latest = record;
    }
    return latest;
  }

  async put_checkpoint(
    record: CheckpointRecord,
    opts: { expected_version?: number | null; fork?: boolean } = {},
  ): Promise<CheckpointRecord> {
    const fork = opts.fork ?? false;
    // 链一致性不变量（与后端同口径）：父指针必须存在且同线程、event_seq 不
    // 高于新节点——坏链形态在写入期失败。fork 首写跳过（锚点指向历史链）。
    if (record.parent_id !== null && !fork) {
      const parent = this.checkpoints.get(record.parent_id);
      if (
        parent === undefined ||
        parent.thread_id !== record.thread_id ||
        parent.event_seq > record.event_seq
      ) {
        throw new Error('checkpoint 写入被拒绝（父指针不存在/跨线程/event_seq 回退）');
      }
    }
    const stored = new CheckpointRecord({
      checkpoint_id: this.nextCheckpointId,
      thread_id: record.thread_id,
      node: record.node,
      graph_path: record.graph_path,
      state: record.state,
      parent_id: record.parent_id,
      reason: record.reason,
      created_at: record.created_at,
      version: 1,
      event_seq: record.event_seq,
      error: record.error,
      interrupt: record.interrupt,
      graph_version: record.graph_version,
      plan: record.plan,
    });
    this.nextCheckpointId += 1;
    this.checkpoints.set(stored.checkpoint_id, stored);
    return stored;
  }

  async list_checkpoints(thread_id: string, opts: { limit?: number } = {}): Promise<CheckpointRecord[]> {
    const list: CheckpointRecord[] = [];
    for (const c of this.checkpoints.values()) {
      if (c.thread_id !== thread_id) continue;
      list.push(c);
    }
    list.sort((a, b) => b.checkpoint_id - a.checkpoint_id);
    if (opts.limit !== undefined) return list.slice(0, opts.limit);
    return list;
  }

  async chain_index(thread_id: string): Promise<ChainLink[]> {
    const links: ChainLink[] = [];
    for (const c of this.checkpoints.values()) {
      if (c.thread_id !== thread_id) continue;
      links.push(
        new ChainLink({
          checkpoint_id: c.checkpoint_id,
          parent_id: c.parent_id,
          event_seq: c.event_seq,
          graph_path: c.graph_path,
          reason: c.reason,
        }),
      );
    }
    links.sort((a, b) => b.checkpoint_id - a.checkpoint_id);
    return links;
  }

  async delete_checkpoints(thread_id: string, ids: readonly number[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      const existing = this.checkpoints.get(id);
      if (existing !== undefined && existing.thread_id === thread_id) {
        this.checkpoints.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async set_checkpoint_parent(thread_id: string, checkpoint_id: number, parent_id: number | null): Promise<number> {
    const existing = this.checkpoints.get(checkpoint_id);
    if (existing === undefined || existing.thread_id !== thread_id) return 0;
    const stored = new CheckpointRecord({
      checkpoint_id: existing.checkpoint_id,
      thread_id: existing.thread_id,
      node: existing.node,
      graph_path: existing.graph_path,
      state: existing.state,
      parent_id,
      reason: existing.reason,
      created_at: existing.created_at,
      version: existing.version,
      event_seq: existing.event_seq,
      error: existing.error,
      interrupt: existing.interrupt,
      graph_version: existing.graph_version,
      plan: existing.plan,
    });
    this.checkpoints.set(checkpoint_id, stored);
    return 1;
  }

  async append_event(thread_id: string, event: EngineEvent): Promise<number> {
    const seq = this.nextEventSeq;
    this.nextEventSeq += 1;
    const stored = new EngineEvent({
      type: event.type,
      payload: event.payload,
      step_id: event.step_id,
      parent_step_id: event.parent_step_id,
      round_id: event.round_id,
      node: event.node,
      graph_path: event.graph_path,
      seq,
      trace_id: event.trace_id,
      thread_id: event.thread_id,
      version: event.version,
    });
    const list = this.events.get(thread_id) ?? [];
    list.push(stored);
    this.events.set(thread_id, list);
    return seq;
  }

  async events_after(thread_id: string, seq: number): Promise<EngineEvent[]> {
    return (this.events.get(thread_id) ?? []).filter((e) => (e.seq ?? 0) > seq);
  }

  async truncate_events(thread_id: string, after_seq: number): Promise<void> {
    const list = (this.events.get(thread_id) ?? []).filter((e) => (e.seq ?? 0) <= after_seq);
    this.events.set(thread_id, list);
  }

  async trim_events(thread_id: string, before_seq: number): Promise<number> {
    const list = this.events.get(thread_id) ?? [];
    const kept = list.filter((e) => (e.seq ?? 0) >= before_seq);
    this.events.set(thread_id, kept);
    return list.length - kept.length;
  }

  async latest_event_seq(thread_id: string): Promise<number> {
    const list = this.events.get(thread_id) ?? [];
    let max = 0;
    for (const e of list) {
      if ((e.seq ?? 0) > max) max = e.seq ?? 0;
    }
    return max;
  }

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.records.set(`${collection}:${key}`, { ...data });
  }

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    const data = this.records.get(`${collection}:${key}`);
    return data === undefined ? null : { ...data };
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    const prefix = `${collection}:`;
    const out: Record<string, unknown>[] = [];
    for (const [key, data] of this.records) {
      if (key.startsWith(prefix)) out.push({ ...data });
    }
    return out;
  }

  async delete_collection(collection: string): Promise<number> {
    const prefix = `${collection}:`;
    let removed = 0;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  readonly snapshot_capable = false;
  async snapshot(_dest: string): Promise<void> {}
  async restore(_src: string): Promise<void> {}
  async close(): Promise<void> {}
}

/** 引擎构造辅助（镜像 conftest.make_engine：CollectorTransport 默认传输）。 */
export function make_engine(
  graph: Graph,
  init: {
    storage?: MemoryStorage | null;
    budget?: BudgetPolicy | null;
    schema?: RunOptions['schema'];
    transports?: EngineTransport[] | null;
    extra?: Partial<RunOptions>;
  } = {},
): Engine {
  const transports = init.transports ?? [new CollectorTransport()];
  const options = new RunOptions({
    storage: init.storage ?? null,
    budget: (init.budget ?? null) as unknown as RunOptions['budget'],
    schema: init.schema ?? null,
    transports,
    ...(init.extra ?? {}),
  });
  return new Engine(graph, options);
}

/** 直取内部执行（绕过流式，拿最终状态 + RunResult）。 */
export async function _execute(
  engine: Engine,
  state: Record<string, unknown> | null = null,
  opts: {
    thread_id?: string;
    round_id?: string | null;
    resume_from?: number | null;
    trace_id?: string;
    parent_checkpoint?: number | null;
    continue_chain?: boolean;
  } = {},
): Promise<[Record<string, unknown>, RunResult]> {
  const stateValue = state ?? {};
  return engine._execute({
    state: stateValue,
    thread_id: opts.thread_id ?? 't',
    round_id: opts.round_id ?? null,
    resume_from: opts.resume_from ?? null,
    trace_id: opts.trace_id ?? 'trace',
    queue: null,
    parent_checkpoint: opts.parent_checkpoint ?? null,
    continue_chain: opts.continue_chain ?? false,
  });
}

// ── 演示图（镜像 conftest demo_linear/conditional/loop_graph）────────────

export function demo_linear_graph(): Graph {
  const start = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ count: 1 });
  const mid = async (ctx: any): Promise<Record<string, unknown>> => ({
    count: (ctx.state.count ?? 0) + 1,
  });
  const end = async (ctx: any): Promise<Record<string, unknown>> => ({
    count: (ctx.state.count ?? 0) + 1,
  });
  const g = new Graph({ name: 'linear', entry: 'start' });
  g.add_node('start', start as never);
  g.add_node('mid', mid as never);
  g.add_node('end', end as never);
  g.add_edge('start', 'mid');
  g.add_edge('mid', 'end');
  g.add_exit('end');
  return g;
}

export function demo_conditional_graph(): Graph {
  const yes = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ branch: 'yes' });
  const no = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ branch: 'no' });
  const wantYes = async (ctx: any): Promise<boolean> => ctx.state.want_yes === true;
  const wantNo = async (ctx: any): Promise<boolean> => ctx.state.want_yes !== true;
  const g = new Graph({ name: 'conditional', entry: 'start' });
  g.add_node('start', (async () => ({})) as never);
  g.add_node('yes', yes as never);
  g.add_node('no', no as never);
  g.add_conditional_edge('start', 'yes', wantYes as never);
  g.add_conditional_edge('start', 'no', wantNo as never);
  g.add_exit('yes');
  g.add_exit('no');
  return g;
}

export function demo_loop_graph(): Graph {
  const loop = async (ctx: any): Promise<Record<string, unknown>> => ({
    count: (ctx.state.count ?? 0) + 1,
  });
  const again = async (ctx: any): Promise<boolean> => (ctx.state.count ?? 0) < 3;
  const g = new Graph({ name: 'loop', entry: 'start' });
  g.add_node('start', (async () => ({ count: 0 })) as never);
  g.add_node('loop', loop as never);
  g.add_node('exit', (async () => ({ done: true })) as never);
  g.add_edge('start', 'loop');
  g.add_conditional_edge('loop', 'loop', again as never);
  g.add_conditional_edge(
    'loop',
    'exit',
    (async (ctx: any): Promise<boolean> => !((ctx.state.count ?? 0) < 3)) as never,
  );
  g.add_exit('exit');
  return g;
}

/** 测试预算策略（镜像 DemoBudgetPolicy：节点边界访问计数超限即抛）。 */
export class DemoBudgetPolicy implements BudgetPolicy {
  readonly max_nodes: number;
  visited: string[] = [];

  constructor(max_nodes = 5) {
    this.max_nodes = max_nodes;
  }

  async check(ctx: unknown): Promise<void> {
    const node = (ctx as { node?: string | null }).node ?? '';
    this.visited.push(node);
    if (this.visited.length > this.max_nodes) {
      throw new BudgetExceededError('nodes', this.max_nodes, this.visited.length);
    }
  }
}
