/**
 * 执行引擎恢复/中断单测（B 批：interrupt 挂起/注入重入、挂起负载持久化与
 * 敏感键剥离、注入一次性清理）——test_executor.py 纯内存面移植。
 *
 * 与 executor.test.ts（A 批执行面）分工：checkpoint 锚点/编辑重放用例在
 * executor.test.ts「Engine checkpoint 锚点/编辑重放」节覆盖，本文件只承载
 * 恢复语义核心（中断挂起 → checkpoint 持久化 → 注入重入），避免用例重复执行。
 *
 * defer 注记：沉淀/审计钩子、装配调配（assembly_sources/assemble）、VTM
 * 验证器门控的 LLM 验证器用例留待宿主接线后补（本批只覆盖纯机制执行面）。
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage, _execute, make_engine } from './helpers.js';
import { Engine } from '../../../src/core/executor/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';
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
