/**
 * 执行引擎继承链回归断言（P8+S1 摘链退役行为锁）。
 *
 * 目的：锁住「链仍可跑图」的存活行为——单节点图 / 多节点线性图 / 条件边 /
 * 嵌套子图（run_subgraph 内联）/ interrupt 挂起与注入重入 / checkpoint 恢复。
 * 这些路径不依赖被退役的展开段（spawn/simulate/multipath/plan），在
 * Simulate/Multipath/Plan/Spawn/Parallel 五类整体消亡、继承链重接为终态
 * （base→trace→execute→loop 级）后必须依然全绿——本文件即该行为锁。
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage, _execute, make_engine } from './helpers.js';
import { Engine } from '../../../src/graph/executor/index.js';
import { Graph } from '../../../src/model/graph/graph.js';
import { TerminateReason } from '../../../src/model/graph/graph_types.js';
import { InterruptState } from '../../../src/model/storage/interrupt_state.js';
import type { EngineEvent } from '../../../src/dock/ports/events.js';

async function collect(engine: Engine, state: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.run(state, opts as never)) {
    events.push(event);
  }
  return events;
}

describe('P8+S1 继承链存活断言（摘链前后皆须绿）', () => {
  it('单节点图：ainvoke 执行到终止，状态合并回传', async () => {
    const node = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ answer: 42 });
    const g = new Graph({ name: 'single', entry: 'a' });
    g.add_node('a', node as never);
    g.add_exit('a');
    const engine = make_engine(g);
    const result = await engine.ainvoke({ seed: 1 });
    expect(result.reason).toBe(TerminateReason.REPLY);
    expect(result.state).toMatchObject({ seed: 1, answer: 42 });
  });

  it('多节点线性图：节点按边依次执行，全节点增量合并', async () => {
    const a = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ a: 1 });
    const b = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ b: 2 });
    const c = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ c: 3 });
    const g = new Graph({ name: 'linear', entry: 'a' });
    g.add_node('a', a as never);
    g.add_node('b', b as never);
    g.add_node('c', c as never);
    g.add_edge('a', 'b');
    g.add_edge('b', 'c');
    g.add_exit('c');
    const engine = make_engine(g);
    const [state, result] = await _execute(engine);
    expect(state).toMatchObject({ a: 1, b: 2, c: 3 });
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('条件边路由：yes/no 按状态分流', async () => {
    const yes = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ branch: 'yes' });
    const no = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ branch: 'no' });
    const g = new Graph({ name: 'cond', entry: 'start' });
    g.add_node('start', (async () => ({})) as never);
    g.add_node('yes', yes as never);
    g.add_node('no', no as never);
    g.add_conditional_edge(
      'start',
      'yes',
      (async (ctx: any): Promise<boolean> => ctx.state.want_yes === true) as never,
    );
    g.add_conditional_edge(
      'start',
      'no',
      (async (ctx: any): Promise<boolean> => ctx.state.want_yes !== true) as never,
    );
    g.add_exit('yes');
    g.add_exit('no');
    const yesEngine = make_engine(g);
    const [yesState] = await _execute(yesEngine, { want_yes: true });
    expect(yesState['branch']).toBe('yes');
    const noEngine = make_engine(g);
    const [noState] = await _execute(noEngine, { want_yes: false });
    expect(noState['branch']).toBe('no');
  });

  it('嵌套子图（run_subgraph 内联）：子图输出回流父图，路径留痕', async () => {
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', (async () => ({ sub_value: 'v' })) as never);
    sub.add_exit('s1');
    const parent = new Graph({ name: 'parent', entry: 'pre' });
    parent.add_subgraph('sub', sub);
    parent.add_node('pre', (async () => ({ pre: true })) as never);
    parent.add_node('after', (async () => ({ after: true })) as never);
    parent.add_edge('pre', 'sub');
    parent.add_edge('sub', 'after');
    parent.add_exit('after');
    const engine = make_engine(parent);
    const [state, result] = await _execute(engine);
    expect(state).toMatchObject({ pre: true, sub_value: 'v', after: true });
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('interrupt 挂起 + 注入重入：同轮注入决议续跑', async () => {
    const gated = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.interrupt('gate', { q: '?' });
      return { passed: true };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', gated as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const events1 = await collect(engine, {}, { thread_id: 't' });
    expect(events1.some((e) => e.type === 'review_card')).toBe(true);
    const latest = await storage.get_latest_checkpoint('t');
    expect(latest!.reason).toBe('interrupted');
    expect(latest!.interrupt).not.toBeNull();
    const [state, result] = await _execute(engine, {}, {
      thread_id: 't',
      resume_from: latest!.checkpoint_id,
    });
    // 未注入重入 = 再次挂起；注入决议经 ainvoke inject 通道消费
    expect(result.reason).toBe('interrupted');
    expect(state['passed']).toBeUndefined();
    const resumed = await engine.ainvoke(
      {},
      { thread_id: 't', resume_from: latest!.checkpoint_id, inject: { gate: 'yes' } },
    );
    expect(resumed.reason).toBe(TerminateReason.REPLY);
    expect(resumed.state).toMatchObject({ passed: true });
  });

  it('checkpoint 恢复：断线续流从锚点继续，不重跑已完成节点', async () => {
    const counter = { n: 0 };
    const node = async (): Promise<Record<string, unknown>> => {
      counter.n += 1;
      return { done: true };
    };
    const g = new Graph({ name: 'cp', entry: 'a' });
    g.add_node('a', node as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    await _execute(engine, null, { thread_id: 't' });
    const latest = await storage.get_latest_checkpoint('t');
    expect(latest).not.toBeNull();
    expect(counter.n).toBe(1);
    // 恢复续跑：锚点即终态（已完成节点），不重跑节点
    const [state, result] = await _execute(engine, null, { thread_id: 't', resume_from: latest!.checkpoint_id });
    expect(state['done']).toBe(true);
    expect(result.reason).toBe(TerminateReason.REPLY);
    expect(counter.n).toBe(1);
  });

  it('run 流式事件：顺序 = 发射顺序，事件类型完整', async () => {
    const emitter = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('thinking_start', { content: 'x' }, { step_id: 's:1' });
      await ctx.emit('reply_token', { token: 'hi' }, { step_id: 's:2' });
      return { out: 1 };
    };
    const g = new Graph({ name: 'emit', entry: 'a' });
    g.add_node('a', emitter as never);
    g.add_exit('a');
    const engine = make_engine(g);
    const events = await collect(engine, {});
    const types = events.map((e) => e.type);
    expect(types).toContain('thinking_start');
    expect(types).toContain('reply_token');
    expect(types.indexOf('thinking_start')).toBeLessThan(types.indexOf('reply_token'));
  });

  it('执行异常 → error 事件 + reason=error（异常快照落库）', async () => {
    const boom = async (_ctx: unknown): Promise<never> => {
      throw new Error('boom');
    };
    const g = new Graph({ name: 'boom', entry: 'a' });
    g.add_node('a', boom as never);
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const [, result] = await _execute(engine, null, { thread_id: 't' });
    expect(result.reason).toBe(TerminateReason.ERROR);
    const latest = await storage.get_latest_checkpoint('t');
    expect(latest!.reason).toBe(TerminateReason.ERROR);
  });
});
