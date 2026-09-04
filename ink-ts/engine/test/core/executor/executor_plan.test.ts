/**
 * 执行引擎计划/并行组/重放单测（C 批：ENG2-13 计划工作步 checkpoint 标记、
 * 并行组首信号取消、旧锚点续流重放去重）——test_executor.py 计划/重放面
 * 移植（纯内存 seam）。
 *
 * defer 注记：计划 spawn 步（子任务清单实例展开的完整评估/换选、多径展开）
 * 依赖宿主导入评估器与多径运行期，留待装配接线后补。
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage, _execute, make_engine } from './helpers.js';
import { Engine } from '../../../src/core/executor/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';
import { PLAN_KEY } from '../../../src/core/plan/plan.js';
import type { EngineEvent } from '../../../src/core/events/events.js';

async function collect(engine: Engine, state: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.run(state, opts as never)) {
    events.push(event);
  }
  return events;
}

describe('Engine 计划推进/并行组', () => {
  it('ENG2-13 计划工作步（并行组）完成的 checkpoint 携带 plan_step 标记', async () => {
    const route = async (_ctx: unknown): Promise<Record<string, unknown>> => ({
      [PLAN_KEY]: [{ parallel: ['x', 'y'] }],
    });
    const x = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ xv: 1 });
    const y = async (_ctx: unknown): Promise<Record<string, unknown>> => ({ yv: 2 });
    const g = new Graph({ name: 'plan-mark', entry: 'route' });
    g.add_node('route', route as never);
    g.add_node('x', x as never);
    g.add_node('y', y as never);
    g.add_exit('route');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const [, result] = await _execute(engine, null, { thread_id: 't-planmark' });
    expect(result.reason).toBe(TerminateReason.REPLY);
    const cps = await storage.list_checkpoints('t-planmark');
    const marked = cps.filter((cp) => cp.plan !== null && cp.plan!['plan_step'] === true);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((cp) => cp.node === 'route')).toBe(true);
  });

  it('并行组首信号取消：leader 终止即返回，不等待 slow 成员', async () => {
    const slow = async (_ctx: unknown): Promise<Record<string, unknown>> => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { slow: true };
    };
    const leader = async (ctx: any): Promise<Record<string, unknown>> => {
      ctx.terminate(TerminateReason.REPLY);
      return { lead: true };
    };
    const route = async (_ctx: unknown): Promise<Record<string, unknown>> => ({
      [PLAN_KEY]: [{ parallel: ['slow', 'leader'] }],
    });
    const g = new Graph({ name: 'pg-cancel', entry: 'route' });
    g.add_node('route', route as never);
    g.add_node('slow', slow as never);
    g.add_node('leader', leader as never);
    g.add_exit('route');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    const started = Date.now();
    const [state, result] = await _execute(engine, null, { thread_id: 't-pgcancel' });
    const elapsed = Date.now() - started;
    expect(result.reason).toBe(TerminateReason.REPLY);
    expect(elapsed).toBeLessThan(400);
    expect(state['lead']).toBe(true);
  });

  it('旧锚点续流重放去重：锚点之后增量事件只投递一次', async () => {
    const gated = async (ctx: any): Promise<Record<string, unknown>> => {
      await ctx.emit('tick', { n: 1 }, { step_id: 's:1' });
      await ctx.interrupt('gate', { q: '?' });
      await ctx.emit('tick', { n: 2 }, { step_id: 's:2' });
      return { passed: true };
    };
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', gated as never);
    g.add_exit('a');
    const storage = new MemoryStorage();
    const engine = make_engine(g, { storage });
    // 第一轮：挂起中断（锚点 A）
    await collect(engine, {}, { thread_id: 't1' });
    const anchorA = await storage.get_latest_checkpoint('t1');
    expect(anchorA!.reason).toBe('interrupted');
    // 第二轮：注入重入，推进链尾（产生增量事件）
    await collect(engine, {}, { thread_id: 't1', resume_from: anchorA!.checkpoint_id, inject: { gate: 'yes' } });
    // 第三轮：旧锚点 A 续流（挂起轮无注入 → 再次中断）
    const replay = await collect(engine, {}, { thread_id: 't1', resume_from: anchorA!.checkpoint_id });
    expect(replay.map((e) => e.type)).toEqual(['tick', 'tick', 'tick', 'review_card']);
    const ticks = replay.filter((e) => e.type === 'tick');
    expect(ticks.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 1 }]);
  });
});
