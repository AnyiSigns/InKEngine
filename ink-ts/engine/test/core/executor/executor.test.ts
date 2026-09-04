// gate: 超限(352 行) - 引擎 A 批执行语义用例共享同一 make_engine/内存存储夹具，拆文件降执行链回归可读性
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

describe('Engine 基础执行', () => {
  it('线性执行顺序：节点按边推进、终止 reply、checkpoint 落库', async () => {
    const storage = new MemoryStorage();
    const engine = make_engine(demo_linear_graph(), { storage });
    const [state, result] = await _execute(engine, null, { thread_id: 't1', round_id: 'r1' });
    expect(state['count']).toBe(3);
    expect(result.reason).toBe(TerminateReason.REPLY);
    expect(result.checkpoint_id).not.toBeNull();
    const cps = await storage.list_checkpoints('t1');
    expect(cps.length).toBeGreaterThanOrEqual(1);
  });

  it('条件边 yes 分支', async () => {
    const engine = make_engine(demo_conditional_graph());
    const [state, result] = await _execute(engine, { want_yes: true });
    expect(state['branch']).toBe('yes');
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('条件边 no 分支', async () => {
    const engine = make_engine(demo_conditional_graph());
    const [state] = await _execute(engine, { want_yes: false });
    expect(state['branch']).toBe('no');
  });

  it('循环回路：循环 3 次后出边', async () => {
    const engine = make_engine(demo_loop_graph());
    const [state, result] = await _execute(engine);
    expect(state['count']).toBe(3);
    expect(state['done']).toBe(true);
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('checkpoint 恢复：断线续流从快照继续（不重跑已完成节点）', async () => {
    const storage = new MemoryStorage();
    const engine = make_engine(demo_linear_graph(), { storage });
    await _execute(engine, null, { thread_id: 't1', round_id: 'r1' });
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest).not.toBeNull();
    const [state, result] = await _execute(engine, null, {
      thread_id: 't1',
      round_id: 'r2',
      resume_from: latest!.checkpoint_id,
    });
    expect(state['count']).toBe(3);
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('恢复锚点缺失 → StorageError', async () => {
    const storage = new MemoryStorage();
    const engine = make_engine(demo_linear_graph(), { storage });
    await expect(_execute(engine, null, { thread_id: 't1', resume_from: 99999 })).rejects.toThrow(StorageError);
  });

  it('节点 terminate(reply) → 引擎记录终止原因', async () => {
    const node = async (ctx: any): Promise<Record<string, unknown>> => {
      ctx.terminate(TerminateReason.REPLY);
      return { done: true };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', node as never);
    g.add_exit('a');
    const engine = make_engine(g);
    const [state, result] = await _execute(engine);
    expect(result.reason).toBe(TerminateReason.REPLY);
    expect(state['done']).toBe(true);
  });

  it('节点 terminate(stop)', async () => {
    const node = async (ctx: any): Promise<Record<string, unknown>> => {
      ctx.terminate(TerminateReason.STOP);
      return {};
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', node as never);
    const engine = make_engine(g);
    const [, result] = await _execute(engine);
    expect(result.reason).toBe(TerminateReason.STOP);
  });

  it('非法终止原因 → 显式报错', async () => {
    const node = async (ctx: any): Promise<Record<string, unknown>> => {
      ctx.terminate('bogus');
      return {};
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', node as never);
    const engine = make_engine(g);
    await expect(_execute(engine)).rejects.toThrow('非法终止原因');
  });
});

describe('Engine 异常/重试/预算', () => {
  it('节点异常 → error 事件 + 图终止（ERROR），异常快照保留', async () => {
    const boom = async (_ctx: unknown): Promise<never> => {
      throw new Error('boom');
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', boom as never);
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const events = await collect(engine, {}, { thread_id: 't1' });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest).not.toBeNull();
    expect(latest!.reason).toBe(TerminateReason.ERROR);
  });

  it('节点异常消息脱敏（内部细节只进日志）', async () => {
    const boom = async (_ctx: unknown): Promise<never> => {
      throw new Error('连接器串泄露: postgresql://user:pwd@host/db');
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', boom as never);
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const events = await collect(engine, {}, { thread_id: 't1' });
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect(String((errors[0]!.payload as Record<string, unknown>)['message'])).not.toContain('postgresql');
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest!.error).not.toContain('postgresql');
  });

  it('节点返回非 dict 增量 → error 事件 + 图终止', async () => {
    const bad = async (_ctx: unknown): Promise<string> => 'not-a-dict';
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', bad as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const events = await collect(engine, {}, { thread_id: 't1' });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest!.reason).toBe(TerminateReason.ERROR);
    expect(latest!.error).toContain('非法增量类型');
  });

  it('可配置重试：前 N 次失败，第 N+1 次成功', async () => {
    const attempts = { n: 0 };
    const flaky = async (_ctx: unknown): Promise<Record<string, unknown>> => {
      attempts.n += 1;
      if (attempts.n < 3) throw new Error('transient');
      return { ok: true };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', flaky as never);
    g.add_exit('a');
    const engine = make_engine(g, { extra: { max_node_retries: 3 } });
    const [state, result] = await _execute(engine);
    expect(attempts.n).toBe(3);
    expect(state['ok']).toBe(true);
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('重试耗尽 → reason=error', async () => {
    const attempts = { n: 0 };
    const flaky = async (_ctx: unknown): Promise<never> => {
      attempts.n += 1;
      throw new Error('always');
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', flaky as never);
    const engine = make_engine(g, { extra: { max_node_retries: 2 } });
    const [, result] = await _execute(engine);
    expect(attempts.n).toBe(3);
    expect(result.reason).toBe(TerminateReason.ERROR);
  });

  it('error_on_exception=False：异常节点跳过（无增量），图继续按边走', async () => {
    const boom = async (_ctx: unknown): Promise<never> => {
      throw new Error('boom');
    };
    const after = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ continued: true });
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', boom as never);
    g.add_node('after', after as never);
    g.add_edge('a', 'after');
    g.add_exit('after');
    const engine = make_engine(g, { extra: { error_on_exception: false } });
    const [state, result] = await _execute(engine);
    expect(state['continued']).toBe(true);
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('执行预算钩子：超限终止（budget_exceeded）', async () => {
    const engine = make_engine(demo_loop_graph(), {
      extra: { max_cycle: 0 },
      budget: new DemoBudgetPolicy(3),
    });
    const [, result] = await _execute(engine);
    expect(result.reason).toBe(TerminateReason.BUDGET_EXCEEDED);
  });

  it('ctx.step_count 为真实语义（协议示例即契约）：按步数终止非策略故障', async () => {
    class StepBudgetPolicy implements BudgetPolicy {
      readonly max_steps: number;
      constructor(maxSteps: number) {
        this.max_steps = maxSteps;
      }
      async check(ctx: unknown): Promise<void> {
        const c = ctx as { step_count: number };
        if (c.step_count >= this.max_steps) {
          throw new BudgetExceededError('steps', this.max_steps, c.step_count);
        }
      }
    }
    const engine = make_engine(demo_loop_graph(), {
      extra: { max_cycle: 0 },
      budget: new StepBudgetPolicy(2),
    });
    const [, result] = await _execute(engine);
    expect(result.reason).toBe(TerminateReason.BUDGET_EXCEEDED);
    expect(result.error).toContain('steps');
    expect(result.error).not.toContain('policy_error');
  });

  it('ENG2-5 静态回路护栏：纯静态边回路按 max_cycle 截止（reason=error）', async () => {
    const calls: Record<string, number> = {};
    const a = async (): Promise<Record<string, unknown>> => {
      calls['a'] = (calls['a'] ?? 0) + 1;
      return {};
    };
    const b = async (): Promise<Record<string, unknown>> => {
      calls['b'] = (calls['b'] ?? 0) + 1;
      return {};
    };
    const g = new Graph({ name: 'static-cycle', entry: 'a' });
    g.add_node('a', a as never);
    g.add_node('b', b as never);
    g.add_edge('a', 'b');
    g.add_edge('b', 'a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage, extra: { max_cycle: 8 } });
    const [, result] = await _execute(engine, null, { thread_id: 't-cycle' });
    expect(result.reason).toBe(TerminateReason.ERROR);
    expect(result.error).toContain('回路超限');
    expect((calls['a'] ?? 0) <= 8).toBe(true);
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
