/**
 * 执行引擎嵌套子图单测（B 批：graph_path 记录/输出回流/事件路径/子图中断/
 * 恢复锚点/回流 delta 语义）——test_executor.py 嵌套面移植（纯内存 seam）。
 *
 * TS 图模块差异：add_subgraph 不放占位 fn，执行器在 Engine 构造期把子图名
 * 挂载为 run_subgraph 包装（与 Python add_subgraph 的 nodes[name]=runner
 * 形态一致，编译期边/出口校验同口径）。
 *
 * defer 注记：本批全部经 MemoryStorage seam 验证；真实存储后端（sqlite/
 * postgres）与宿主装配的校验/审计侧不在执行器职责内。
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage, _execute, make_engine } from './helpers.js';
import { Engine, run_subgraph, _NodeContextImpl } from '../../../src/core/executor/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';
import { StateSchema } from '../../../src/core/state/schema.js';
import { register_reducer } from '../../../src/core/state/reducers.js';
import type { EngineEvent } from '../../../src/core/events/events.js';

async function collect(engine: Engine, state: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.run(state, opts as never)) {
    events.push(event);
  }
  return events;
}

describe('Engine 嵌套子图：路径/回流/事件', () => {
  it('graph_path 记录子图路径，子图输出回流父图（不静默丢值）', async () => {
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    const subStart = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ sub_count: 5 });
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', subStart as never);
    sub.add_exit('s1');
    parent.add_subgraph('sub', sub);
    const after = async (ctx: any): Promise<Record<string, unknown>> => ({
      final: (ctx.state.sub_count ?? 0) + 1,
    });
    parent.add_node('after', after as never);
    parent.add_edge('sub', 'after');
    parent.add_exit('after');
    const engine = make_engine(parent);
    const [state, result] = await _execute(engine);
    expect(state['sub_count']).toBe(5);
    expect(state['final']).toBe(6);
    expect(result.reason).toBe(TerminateReason.REPLY);
  });

  it('嵌套子图事件携带 graph_path 路径', async () => {
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    const subEmit = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('node_start', { name: 's1' }, { step_id: 'n:1' });
      return {};
    };
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', subEmit as never);
    sub.add_exit('s1');
    parent.add_subgraph('sub', sub);
    parent.add_exit('sub');
    const storage = new MemoryStorage();
    const engine = make_engine(parent, { storage });
    const events = await collect(engine, {}, { thread_id: 't1' });
    expect(events.length).toBe(1);
    expect(events[0]!.graph_path).toEqual(['sub']);
    expect(events[0]!.node).toBe('s1');
  });

  it('子图内 interrupt：共享 coordinator，挂起/重入可用', async () => {
    const subGate = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.interrupt('sub_gate', { q: 'ok' });
      return {};
    };
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', subGate as never);
    sub.add_exit('s1');
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    parent.add_subgraph('sub', sub);
    parent.add_exit('sub');
    const storage = new MemoryStorage();
    const engine = make_engine(parent, { storage });
    const [, result] = await _execute(engine, null, { thread_id: 't1' });
    expect(result.interrupt).not.toBeNull();
    expect(result.interrupt!.key).toBe('sub_gate');
  });

  it('子图终态 ERROR 上抛父图（不静默回流陈旧部分增量）', async () => {
    const boom = async (_ctx: unknown): Promise<never> => {
      throw new Error('sub boom');
    };
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', boom as never);
    sub.add_exit('s1');
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    parent.add_subgraph('sub', sub);
    parent.add_exit('sub');
    const storage = new MemoryStorage();
    const engine = make_engine(parent, { storage });
    const [, result] = await _execute(engine, null, { thread_id: 't1' });
    expect(result.reason).toBe(TerminateReason.ERROR);
    expect(result.error).toContain('sub');
  });

  it('子图事件计入父 checkpoint 锚点：resume 不重复投递子图事件', async () => {
    const subEmit = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('node_start', { name: 's1' }, { step_id: 'n:1' });
      return { done: true };
    };
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', subEmit as never);
    sub.add_exit('s1');
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    parent.add_subgraph('sub', sub);
    parent.add_exit('sub');
    const storage = new MemoryStorage();
    const engine = make_engine(parent, { storage });
    const events = await collect(engine, {}, { thread_id: 't1' });
    expect(events.length).toBe(1);
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest!.event_seq).toBeGreaterThan(0);
    const replay = await collect(engine, {}, { thread_id: 't1', resume_from: latest!.checkpoint_id });
    expect(replay.length).toBe(0);
  });

  it('additive reducer 声明化：嵌套子图回流按条目差集（不二次追加）', async () => {
    const roll_summary = (base: unknown, overlay: unknown): unknown[] => {
      const items = [...(Array.isArray(base) ? base : [])];
      for (const item of Array.isArray(overlay) ? overlay : []) {
        if (item !== null && typeof item === 'object' && (item as Record<string, unknown>)['text']) {
          items.push({ ...(item as Record<string, unknown>) });
        }
      }
      return items.slice(-3);
    };
    register_reducer('roll_summary', roll_summary as never, { additive: true });
    const schema = new StateSchema({ summary: 'roll_summary' });
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    const subWork = async (_ctx: unknown): Promise<Record<string, unknown>> => ({
      summary: [{ kind: 'k', text: '子图新增' }],
    });
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', subWork as never);
    sub.add_exit('s1');
    parent.add_subgraph('sub', sub);
    parent.add_exit('sub');
    const engine = make_engine(parent, { schema });
    const [state] = await _execute(engine, { summary: [{ kind: 'k', text: '既有' }] });
    expect(state['summary']).toEqual([
      { kind: 'k', text: '既有' },
      { kind: 'k', text: '子图新增' },
    ]);
  });

  it('merge_dicts 通道：多次子图访问逐次累加不互覆', async () => {
    const schema = new StateSchema({ group: null, windows: 'merge_dicts' });
    const parent = new Graph({ name: 'parent', entry: 'first' });
    const subWork = async (ctx: any): Promise<Record<string, unknown>> => ({
      windows: { [ctx.state.group as string]: { digest: `d-${ctx.state.group}` } },
    });
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', subWork as never);
    sub.add_exit('s1');
    parent.add_node('first', (async (_ctx: unknown) => ({ group: 'query' })) as never);
    parent.add_node('second', (async (_ctx: unknown) => ({ group: 'entity' })) as never);
    parent.add_subgraph('sub', sub);
    parent.add_node('done', (async (_ctx: unknown) => ({})) as never);
    parent.add_edge('first', 'sub');
    parent.add_conditional_edge('sub', 'second', (async (ctx: any) => ctx.state.group === 'query') as never);
    parent.add_edge('second', 'sub');
    parent.add_conditional_edge('sub', 'done', (async (ctx: any) => ctx.state.group === 'entity') as never);
    parent.add_exit('done');
    const engine = make_engine(parent, { schema });
    const [state] = await _execute(engine);
    expect(state['windows']).toEqual({
      query: { digest: 'd-query' },
      entity: { digest: 'd-entity' },
    });
  });

  it('缓存子图引擎跨 run 复用：事件计数/seq 锚点每轮复位', async () => {
    const parent = new Graph({ name: 'parent', entry: 'pre' });
    const pre = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('log', { n: 0 });
      return {};
    };
    const s1 = async (_ctx: unknown): Promise<Record<string, unknown>> => ({});
    const s2 = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('log', { n: 1 });
      return {};
    };
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', s1 as never);
    sub.add_node('s2', s2 as never);
    sub.add_edge('s1', 's2');
    sub.add_exit('s2');
    parent.add_node('pre', pre as never);
    parent.add_subgraph('sub', sub);
    parent.add_edge('pre', 'sub');
    parent.add_exit('sub');
    const storage = new MemoryStorage();
    const engine = make_engine(parent, { storage });
    const r1 = await engine.ainvoke({}, { thread_id: 't1' });
    expect(r1.events_emitted).toBe(2);
    const r2 = await engine.ainvoke({}, { thread_id: 't1' });
    expect(r2.reason).toBe(TerminateReason.REPLY);
    expect(r2.events_emitted).toBe(2);
    const { validate_chain } = await import('../../../src/core/storage/storage.js');
    expect(await validate_chain(storage, 't1')).toEqual([]);
    const r3 = await engine.ainvoke({}, { thread_id: 't1' });
    expect(r3.reason).toBe(TerminateReason.REPLY);
    expect(r3.events_emitted).toBe(2);
  });
});

describe('Engine 嵌套子图恢复锚点/图数据形态', () => {
  it('子图 digest 缓存键命中：同内容子图只建一个子引擎', async () => {
    const subCalls = { count: 0 };
    const s1 = async (ctx: any): Promise<Record<string, unknown>> => {
      subCalls.count += 1;
      return { sub: ctx.state.seed ?? 0 };
    };
    // 数据驱动重建：两次调用传入内容相同、实例不同的子图（digest 一致、
    // 实例不同——同一定义函数引用，缓存键应为 digest 而非实例）
    const makeSub = (): Graph => {
      const subTemplate = new Graph({ name: 'data-sub', entry: 's1' });
      subTemplate.add_node('s1', s1 as never);
      subTemplate.add_exit('s1');
      return subTemplate;
    };
    const parent = new Graph({ name: 'parent', entry: 'pre' });
    parent.add_node('pre', (async () => ({})) as never);
    parent.add_exit('pre');
    const storage = new MemoryStorage();
    const engine = make_engine(parent, { storage });
    const ctx = new _NodeContextImpl({
      engine,
      state: { seed: 1 },
      graph_path: [],
      round_id: null,
      trace_id: 't',
      thread_id: 't-digest',
    });
    ctx.node = 'pre';
    const first = await run_subgraph(makeSub(), ctx);
    const second = await run_subgraph(makeSub(), ctx);
    expect(first).toEqual({ seed: 1, sub: 1 });
    expect(second).toEqual({ seed: 1, sub: 1 });
    expect(engine._subgraph_engines.size).toBe(1);
    expect(subCalls.count).toBe(2);
  });

  it('子图 schema 与父图 merge reducer 分类不一致 → 首跑拒绝', async () => {
    const s1 = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ m: { k: 1 } });
    const sub = new Graph({ name: 'sub', entry: 's1' });
    sub.add_node('s1', s1 as never);
    sub.add_exit('s1');
    sub.schema = StateSchema.from_dict({ channels: { m: 'merge_dicts' } });
    const pre = async (_ctx: unknown): Promise<Record<string, unknown>> => ({});
    const parent = new Graph({ name: 'parent', entry: 'pre' });
    parent.add_node('pre', pre as never);
    parent.add_subgraph('sub', sub);
    parent.add_edge('pre', 'sub');
    parent.add_exit('sub');
    parent.schema = StateSchema.from_dict({ channels: {} });
    const engine = make_engine(parent, { schema: parent.schema as never });
    const ctx = new _NodeContextImpl({ engine, state: {}, graph_path: [], round_id: null, trace_id: 't', thread_id: 't' });
    await expect(run_subgraph(sub, ctx)).rejects.toThrow(/merge reducer/);
  });

  it('resume 落在子图中断 checkpoint：graph_path 感知恢复', async () => {
    const calls = { top: 0, tool: 0, gate: 0, finish: 0 };
    const top = async (): Promise<Record<string, unknown>> => {
      calls.top += 1;
      return { top_done: true };
    };
    const toolEntry = async (): Promise<Record<string, unknown>> => {
      calls.tool += 1;
      return {};
    };
    const gate = async (ctx: any): Promise<Record<string, unknown>> => {
      calls.gate += 1;
      const decision = await ctx.interrupt('inner_gate', { q: '?' });
      return { passed: decision === 'yes' };
    };
    const finish = async (): Promise<Record<string, unknown>> => {
      calls.finish += 1;
      return { inner_done: true };
    };
    const domain = new Graph({ name: 'domain', entry: 'gate' });
    domain.add_node('gate', gate as never);
    domain.add_node('finish', finish as never);
    domain.add_edge('gate', 'finish');
    domain.add_exit('finish');
    const tool = new Graph({ name: 'tool', entry: 'tool_entry' });
    tool.add_node('tool_entry', toolEntry as never);
    tool.add_subgraph('domain', domain);
    tool.add_edge('tool_entry', 'domain');
    tool.add_exit('domain');
    const parent = new Graph({ name: 'parent', entry: 'top' });
    parent.add_node('top', top as never);
    parent.add_subgraph('tool', tool);
    parent.add_edge('top', 'tool');
    parent.add_exit('tool');
    const storage = new MemoryStorage();
    const engine = make_engine(parent, { storage });
    const [, result] = await _execute(engine, null, { thread_id: 't1' });
    expect(result.interrupt).not.toBeNull();
    expect(result.interrupt!.key).toBe('inner_gate');
    expect(calls).toEqual({ top: 1, tool: 1, gate: 1, finish: 0 });
    const anchor = await storage.get_latest_checkpoint('t1');
    expect(anchor!.graph_path).toEqual([]);
    engine._coordinator.inject({ inner_gate: 'yes' });
    const [state, result2] = await _execute(engine, null, { thread_id: 't1', resume_from: anchor!.checkpoint_id });
    expect(result2.reason).toBe(TerminateReason.REPLY);
    expect(state['passed']).toBe(true);
    expect(state['inner_done']).toBe(true);
    expect(calls).toEqual({ top: 1, tool: 1, gate: 2, finish: 1 });
  });
});
