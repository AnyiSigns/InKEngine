/**
 * run_result 纯数据契约对位测试（语义对标 ink_engine/core/run_result.py：
 * Python 侧无独立 test_run_result.py，用例按模块 docstring 契约面自证）：
 *
 * - RunOptions：默认构造逐字段对齐 Python dataclass（含
 *   DEFAULT_MAX_PLAN_STEPS=32 / DEFAULT_MAX_SIMULATIONS=8 常量与
 *   transports/system_events 逐实例隔离）；关键字式覆盖；executor 运行时
 *   原位改选分支（branch_pick）语义。
 * - RunResult：必填/缺省字段、to_dict 序列化（中断点 null 与挂起卡两态、
 *   原位补记后一致）。
 */
import { describe, expect, it } from 'vitest';

import { RunOptions, RunResult } from '../../../src/core/run_result/run_result.js';
import { InterruptState } from '../../../src/core/interrupt/interrupt_types.js';
import { DEFAULT_MAX_PLAN_STEPS } from '../../../src/core/plan/plan.js';
import { DEFAULT_MAX_SIMULATIONS } from '../../../src/core/simulation/simulation.js';
import type { Storage } from '../../../src/core/storage/storage.js';
import type { StateSchema } from '../../../src/core/state/schema.js';
import type { BudgetManager } from '../../../src/core/budget/budget.js';
import type { EngineTransport } from '../../../src/core/events/events.js';
import type { AssemblyConfig } from '../../../src/core/assembly/assembly_config.js';

describe('RunOptions 默认值', () => {
  it('默认构造逐字段对齐 Python dataclass', () => {
    const options = new RunOptions();
    expect(options.storage).toBeNull();
    expect(options.schema).toBeNull();
    expect(options.budget).toBeNull();
    expect(options.transports).toEqual([]);
    expect(options.max_node_retries).toBe(0);
    expect(options.error_on_exception).toBe(true);
    expect(options.max_spawns).toBe(16);
    expect(options.spawn_concurrency).toBe(4);
    expect(options.spawn_max_depth).toBe(2);
    expect(options.simulate_max_branch_steps).toBe(16);
    expect(options.max_cycle).toBe(64);
    expect(options.spawn_depth).toBe(0);
    expect(options.checkpoint_keep).toBe(256);
    expect(options.system_events.size).toBe(0);
    expect(options.plan_policy).toBe('loose');
    expect(options.max_plan_steps).toBe(DEFAULT_MAX_PLAN_STEPS);
    expect(DEFAULT_MAX_PLAN_STEPS).toBe(32);
    expect(options.plan_workflow).toBeNull();
    expect(options.parallel_concurrency).toBe(4);
    expect(options.registries).toBeNull();
    expect(options.evaluator).toBeNull();
    expect(options.branch_mixer).toBeNull();
    expect(options.max_simulations).toBe(DEFAULT_MAX_SIMULATIONS);
    expect(DEFAULT_MAX_SIMULATIONS).toBe(8);
    expect(options.simulate_concurrency).toBe(2);
    expect(options.branch_pick).toBeNull();
    expect(options.assembly).toBeNull();
    expect(options.assembly_sources).toBeNull();
    expect(options.assembly_aggregator).toBeNull();
    expect(options.metrics).toBeNull();
    expect(options.domain).toBeNull();
    expect(options.settle).toBeNull();
    expect(options.emit_timeline_events).toBe(false);
  });

  it('transports/system_events 逐实例新建（对齐 field(default_factory)）', () => {
    const first = new RunOptions();
    const second = new RunOptions();
    expect(first.transports).not.toBe(second.transports);
    expect(first.system_events).not.toBe(second.system_events);
  });
});

describe('RunOptions 覆盖与引擎运行时语义', () => {
  it('关键字式覆盖生效（DI 注入 + 数字护栏字段）', () => {
    const storage = {} as Storage;
    const schema = {} as StateSchema;
    const budget = {} as BudgetManager;
    const transport = {} as EngineTransport;
    const assembly = {} as AssemblyConfig;
    const options = new RunOptions({
      storage,
      schema,
      budget,
      transports: [transport],
      max_node_retries: 3,
      error_on_exception: false,
      max_spawns: 4,
      spawn_concurrency: 2,
      spawn_max_depth: 0,
      simulate_max_branch_steps: 64,
      max_cycle: 0,
      checkpoint_keep: 0,
      system_events: new Set(['message_started']),
      plan_policy: 'strict',
      max_plan_steps: 10,
      parallel_concurrency: 2,
      max_simulations: 4,
      simulate_concurrency: 1,
      branch_pick: 2,
      assembly,
      emit_timeline_events: true,
    });
    expect(options.storage).toBe(storage);
    expect(options.schema).toBe(schema);
    expect(options.budget).toBe(budget);
    expect(options.transports).toEqual([transport]);
    expect(options.max_node_retries).toBe(3);
    expect(options.error_on_exception).toBe(false);
    expect(options.max_spawns).toBe(4);
    expect(options.spawn_concurrency).toBe(2);
    expect(options.spawn_max_depth).toBe(0);
    expect(options.simulate_max_branch_steps).toBe(64);
    expect(options.max_cycle).toBe(0);
    expect(options.checkpoint_keep).toBe(0);
    expect([...options.system_events]).toEqual(['message_started']);
    expect(options.plan_policy).toBe('strict');
    expect(options.max_plan_steps).toBe(10);
    expect(options.parallel_concurrency).toBe(2);
    expect(options.max_simulations).toBe(4);
    expect(options.simulate_concurrency).toBe(1);
    expect(options.branch_pick).toBe(2);
    expect(options.assembly).toBe(assembly);
    expect(options.emit_timeline_events).toBe(true);
  });

  it('branch_pick 可原位改选并还原（executor swap_branch 语义）', () => {
    const options = new RunOptions();
    const original = options.branch_pick;
    options.branch_pick = 3;
    expect(options.branch_pick).toBe(3);
    options.branch_pick = original;
    expect(options.branch_pick).toBeNull();
  });
});

describe('RunResult 数据契约', () => {
  it('state/reason 必填，其余字段缺省（对齐 Python dataclass 默认值）', () => {
    const result = new RunResult({ state: { count: 1 }, reason: 'completed' });
    expect(result.state).toEqual({ count: 1 });
    expect(result.reason).toBe('completed');
    expect(result.checkpoint_id).toBeNull();
    expect(result.interrupt).toBeNull();
    expect(result.events_emitted).toBe(0);
    expect(result.error).toBeNull();
  });

  it('to_dict 序列化（无中断点：interrupt=null，字段齐全）', () => {
    const result = new RunResult({ state: {}, reason: 'error' });
    expect(result.to_dict()).toEqual({
      state: {},
      reason: 'error',
      checkpoint_id: null,
      interrupt: null,
      events_emitted: 0,
      error: null,
    });
  });

  it('to_dict 序列化（挂起卡随 checkpoint 持久化，含中断点与事件统计）', () => {
    const interrupt = new InterruptState('review:audit:n1', { question: '是否通过?' }, 'n1', ['a', 'b']);
    const result = new RunResult({
      state: { a: 1 },
      reason: 'interrupt',
      checkpoint_id: 42,
      interrupt,
      events_emitted: 7,
    });
    const data = result.to_dict();
    expect(data['state']).toEqual({ a: 1 });
    expect(data['reason']).toBe('interrupt');
    expect(data['checkpoint_id']).toBe(42);
    expect(data['interrupt']).toEqual({
      key: 'review:audit:n1',
      payload: { question: '是否通过?' },
      node: 'n1',
      graph_path: ['a', 'b'],
    });
    expect(data['events_emitted']).toBe(7);
    expect(data['error']).toBeNull();
  });

  it('executor 收尾原位补记 checkpoint_id/error 后 to_dict 反映（可变 dataclass）', () => {
    const result = new RunResult({ state: {}, reason: 'completed' });
    result.checkpoint_id = 100;
    result.events_emitted = 3;
    result.error = null;
    expect(result.to_dict()).toEqual({
      state: {},
      reason: 'completed',
      checkpoint_id: 100,
      interrupt: null,
      events_emitted: 3,
      error: null,
    });
  });
});
