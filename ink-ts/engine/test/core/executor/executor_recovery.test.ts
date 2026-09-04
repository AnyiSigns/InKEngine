/**
 * 执行引擎单测（A 批：执行顺序/条件边/循环/终止信号/恢复/interrupt 注入/
 * 事件顺序/异常处理/预算钩子）——test_executor.py 纯内存面移植。
 *
 * defer 注记（对 Python 对标用例集中需要宿主存储后端/真实 LLM 传输的用例）：
 * - resume/replay 全部经 MemoryStorage seam 验证，不依赖具体后端；
 * - 沉淀/审计钩子、装配调配（assembly_sources/assemble）、VTM 验证器门控的
 *   LLM 验证器用例留待宿主接线后补（本批只覆盖纯机制执行面）。
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryStorage,
  _execute,
  demo_conditional_graph,
  demo_linear_graph,
  demo_loop_graph,
  make_engine,
} from './helpers.js';
import { Engine } from '../../../src/core/executor/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';
import { StateSchema } from '../../../src/core/state/schema.js';
import { StorageError } from '../../../src/core/errors.js';
import { BudgetExceededError } from '../../../src/core/budget/budget.js';
import type { BudgetPolicy } from '../../../src/core/budget/budget_types.js';
import { DemoBudgetPolicy } from './helpers.js';
import type { EngineEvent } from '../../../src/core/events/events.js';

async function collect(engine: Engine, state: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.run(state, opts as never)) {
    events.push(event);
  }
  return events;
}


describe('Engine interrupt 挂起/注入重入', () => {
  it('interrupt 挂起 → checkpoint 持久化中断点 → 注入重入（重入幂等）', async () => {
    const calls: string[] = [];
    const gated = async (ctx: any): Promise<Record<string, unknown>> => {
      calls.push('enter');
      const decision = await ctx.interrupt('gate', { question: '是否写入?' });
      calls.push(`decision=${decision}`);
      return { approved: decision === 'yes' };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', gated as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });

    const [, result] = await _execute(engine, null, { thread_id: 't1', round_id: 'r1' });
    expect(result.interrupt).not.toBeNull();
    expect(result.interrupt!.key).toBe('gate');
    expect(result.interrupt!.node).toBe('a');
    expect(result.reason).toBe('interrupted');
    expect(calls).toEqual(['enter']);
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest).not.toBeNull();

    engine._coordinator.inject({ gate: 'yes' });
    const [state2, result2] = await _execute(engine, null, {
      thread_id: 't1',
      round_id: 'r1',
      resume_from: latest!.checkpoint_id,
    });
    expect(calls).toEqual(['enter', 'enter', 'decision=yes']);
    expect(state2['approved']).toBe(true);
    expect(result2.reason).toBe(TerminateReason.REPLY);
  });

  it('中断负载随挂起持久化且敏感键剥离', async () => {
    const gated = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.interrupt('gate', { question: 'ok', api_key: 'sk-secret' } as never);
      return {};
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', gated as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const [, result] = await _execute(engine, null, { thread_id: 't1' });
    expect(result.interrupt).not.toBeNull();
    expect((result.interrupt!.payload as Record<string, unknown>)['api_key']).toBe('');
    expect((result.interrupt!.payload as Record<string, unknown>)['question']).toBe('ok');
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest).not.toBeNull();
    expect(latest!.reason).toBe('interrupted');
  });

  it('注入值一次性：run 结束后未消费的残留被清理', async () => {
    const gated = async (ctx: any): Promise<Record<string, unknown>> => {
      const decision = await ctx.interrupt('gate', { q: '?' });
      return { decision };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', gated as never);
    g.add_exit('a');
    const engine2 = make_engine(g);
    const noop = async (_ctx: unknown): Promise<Record<string, unknown>> => ({});
    const g2 = new Graph({ name: 'g2', entry: 'n' });
    g2.add_node('n', noop as never);
    g2.add_exit('n');
    const engineNoInterrupt = make_engine(g2);
    await collect(engineNoInterrupt, {}, { thread_id: 't', inject: { gate: 'stale' } });
    expect(engineNoInterrupt._coordinator.pending_inject.has('gate')).toBe(false);
    const [, result] = await _execute(engine2, null, { thread_id: 't2' });
    expect(result.interrupt).not.toBeNull();
    expect(result.interrupt!.key).toBe('gate');
  });
});

describe('Engine checkpoint 锚点/编辑重放', () => {
  it('编辑重放：日志截断 + 新分支', async () => {
    const storage = new MemoryStorage();
    const engine = make_engine(demo_linear_graph(), { storage });
    await _execute(engine, null, { thread_id: 't1', round_id: 'r1' });
    const latest = await storage.get_latest_checkpoint('t1');
    const events = await collect(engine, {}, {
      thread_id: 't1',
      resume_from: latest!.checkpoint_id,
      truncate_log_after: latest!.event_seq,
    });
    expect(events.length).toBe(0);
    const after = await storage.events_after('t1', latest!.event_seq);
    expect(after.length).toBe(0);
  });

  it('checkpoint.event_seq 回填：恢复续跑只重放 seq 之后增量', async () => {
    const eventsSeen: number[] = [];
    const emitter = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('reply_token', { text: 'a' }, { step_id: 'r:1' });
      await ctx.emit('reply_token', { text: 'b' }, { step_id: 'r:2' });
      return { count: 1 };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', emitter as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    for await (const event of engine.run({}, { thread_id: 't1' })) {
      eventsSeen.push(event.seq ?? 0);
    }
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest!.event_seq).toBeGreaterThan(0);
    expect(latest!.event_seq).toBe(Math.max(...eventsSeen));
    const replay: EngineEvent[] = [];
    for await (const event of engine.run({}, { thread_id: 't1', round_id: 'r2', resume_from: latest!.checkpoint_id })) {
      replay.push(event);
    }
    expect(replay.length).toBe(0);
  });

  it('跨实例恢复：新 Engine 从 checkpoint 恢复不重复重放', async () => {
    const emitter = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('reply_token', { text: 'a' }, { step_id: 'r:1' });
      return { count: 1 };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', emitter as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine1 = make_engine(g, { storage });
    for await (const _e of engine1.run({}, { thread_id: 't1' })) {
      /* consume */
    }
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest!.event_seq).toBeGreaterThan(0);
    const engine2 = make_engine(g, { storage });
    const replay: EngineEvent[] = [];
    for await (const event of engine2.run({}, { thread_id: 't1', resume_from: latest!.checkpoint_id })) {
      replay.push(event);
    }
    expect(replay.length).toBe(0);
    const cp2 = await storage.get_latest_checkpoint('t1');
    expect(cp2!.event_seq).toBe(latest!.event_seq);
  });

  it('run state 带 schema：schema 外键裸覆盖照常', async () => {
    const schema = new StateSchema({ messages: 'add_messages' });
    const engine = make_engine(demo_linear_graph(), { schema });
    const [state] = await _execute(engine, { messages: [{ id: 'm0' }] });
    expect(state['count']).toBe(3);
  });
});
