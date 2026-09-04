/**
 * spawn 数据面单测：SpawnSpec/Failure/Result 数据 + to/from_dict、实例归属
 * 标识、入口状态合并归零、清单汇总校验（命令式+数据驱动+图数据解析）。
 *
 * 引擎执行器未移植，本套测试只覆盖纯数据面语义；executor 级（事件统一
 * 父链/独立子链/失败剔除/中断恢复/预算护栏/并发上限/回流增量等）留待
 * Engine.run_spawned 移植后回归。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { StateSchema } from '../../../src/core/state/schema.js';
import type { JsonRecord } from '../../../src/core/json.js';
import {
  SPAWN_KEY,
  SpawnFailure,
  SpawnResult,
  SpawnSpec,
  collect_spawn_specs,
  instance_entry_state,
  instance_thread_id,
} from '../../../src/core/spawn/spawn.js';

const noop = async () => ({});

function make_sub(value: number = 1): Graph {
  const g = new Graph({ name: 'sub', entry: 's1' });
  g.add_node('s1', noop);
  g.add_exit('s1');
  return g;
}

// 可序列化的子图（声明式节点绑定）——供 to_dict 路径使用。
function make_sub_serializable(): Graph {
  const g = new Graph({ name: 'sub', entry: 's1' });
  g.add_node_type('s1', 's1_type', {});
  g.add_exit('s1');
  return g;
}

describe('SPAWN_KEY 保留键', () => {
  it('值为 "__spawn__"（数据驱动形态识别串）', () => {
    expect(SPAWN_KEY).toBe('__spawn__');
  });
});

describe('SpawnSpec 数据形态', () => {
  it('构造后字段只读', () => {
    const spec = new SpawnSpec({ subgraph: make_sub(), state: { seed: 1 }, index: 0 });
    expect(() => {
      (spec as { index: number }).index = 1;
    }).toThrow();
  });

  it('to_dict 序列化子图+state+index', () => {
    const sub = make_sub_serializable();
    const spec = new SpawnSpec({ subgraph: sub, state: { seed: 10 } as JsonRecord, index: 2 });
    const data = spec.to_dict();
    expect(data.index).toBe(2);
    expect(data.state).toEqual({ seed: 10 });
    expect(data.subgraph).toEqual(sub.to_dict());
  });

  it('to_dict 深拷贝 state（修改原 spec 不影响产物）', () => {
    const state: JsonRecord = { seed: 1 };
    const spec = new SpawnSpec({ subgraph: make_sub_serializable(), state, index: 0 });
    const data = spec.to_dict();
    state['seed'] = 999;
    expect(data.state).toEqual({ seed: 1 });
  });
});

describe('SpawnFailure 数据形态', () => {
  it('冻结 index+error', () => {
    const f = new SpawnFailure({ index: 0, error: 'boom' });
    expect(f.index).toBe(0);
    expect(f.error).toBe('boom');
    expect(f.to_dict()).toEqual({ index: 0, error: 'boom' });
  });
});

describe('SpawnResult 数据形态', () => {
  it('默认空 overlay+failures', () => {
    const r = new SpawnResult();
    expect(r.overlay).toEqual({});
    expect(r.failures).toEqual([]);
    expect(r.to_dict()).toEqual({ overlay: {}, failures: [] });
  });

  it('深拷贝 to_dict 防回流共享', () => {
    const r = new SpawnResult({ overlay: { sub_result: 6 } as JsonRecord });
    const first = r.to_dict();
    first.overlay['leak'] = true;
    const second = r.to_dict();
    expect(second.overlay).toEqual({ sub_result: 6 });
  });
});

describe('instance_thread_id 归属标识', () => {
  it('"{父thread}:spawn:{index}" 形式', () => {
    expect(instance_thread_id('t1', 0)).toBe('t1:spawn:0');
    expect(instance_thread_id('parent:42', 7)).toBe('parent:42:spawn:7');
  });
});

describe('instance_entry_state 入口状态', () => {
  it('清单 state 自包含（深拷贝隔离）', () => {
    const state: JsonRecord = { seed: 1, flags: ['a'] };
    const spec = new SpawnSpec({ subgraph: make_sub(), state, index: 0 });
    const entry = instance_entry_state(spec, null);
    state['seed'] = 999;
    expect(entry['seed']).toBe(1);
  });

  it('merge 族通道归零（回流增量口径，防二次加和翻倍）', () => {
    const spec = new SpawnSpec({
      subgraph: make_sub(),
      state: { metrics: { a: 1 }, plain: 'v' } as JsonRecord,
      index: 0,
    });
    const schema = new StateSchema({ metrics: 'merge_metrics', plain: null });
    const entry = instance_entry_state(spec, schema);
    expect(entry['metrics']).toEqual({});
    expect(entry['plain']).toBe('v');
  });

  it('未携带的 merge 通道不归零（隔离由清单完整决定）', () => {
    const spec = new SpawnSpec({
      subgraph: make_sub(),
      state: { seed: 1 },
      index: 0,
    });
    const schema = new StateSchema({ metrics: 'merge_metrics' });
    const entry = instance_entry_state(spec, schema);
    expect(entry['metrics']).toBeUndefined();
  });

  it('sub_schema=null 不归零（保留入口原样）', () => {
    const spec = new SpawnSpec({
      subgraph: make_sub(),
      state: { metrics: { a: 1 } },
      index: 0,
    });
    const entry = instance_entry_state(spec, null);
    expect(entry['metrics']).toEqual({ a: 1 });
  });
});

describe('collect_spawn_specs 清单汇总', () => {
  it('pending 列表原样拷贝（不污染调用方）', () => {
    const a = new SpawnSpec({ subgraph: make_sub(), state: {}, index: 0 });
    const out = collect_spawn_specs(null, [a]);
    expect(out[0]).toBe(a);
  });

  it('空 overlay + 空 pending = 空清单', () => {
    expect(collect_spawn_specs(null, [])).toEqual([]);
    expect(collect_spawn_specs({}, [])).toEqual([]);
  });

  it('数据驱动项：Graph 实例直通', () => {
    const sub = make_sub(2);
    const out = collect_spawn_specs(
      { [SPAWN_KEY]: [{ subgraph: sub, state: { seed: 1 }, index: 5 }] },
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subgraph).toBe(sub);
    expect(out[0]!.state).toEqual({ seed: 1 });
    expect(out[0]!.index).toBe(5);
  });

  it('数据驱动项：overlay 中保留键被消费（不残留在 overlay）', () => {
    const sub = make_sub();
    const overlay: Record<string, unknown> = { [SPAWN_KEY]: [{ subgraph: sub, state: {}, index: 0 }] };
    collect_spawn_specs(overlay, []);
    expect(SPAWN_KEY in overlay).toBe(false);
  });

  it('数据驱动项：index 缺省 = 当前已收集数（保持序号稳定）', () => {
    const sub = make_sub();
    const a = new SpawnSpec({ subgraph: sub, state: {}, index: 0 });
    const out = collect_spawn_specs(
      { [SPAWN_KEY]: [{ subgraph: sub, state: {}, index: null }] },
      [a],
    );
    expect(out.map((s) => s.index)).toEqual([0, 1]);
  });

  it('数据驱动项：state 缺省 = 空 dict', () => {
    const sub = make_sub();
    const out = collect_spawn_specs({ [SPAWN_KEY]: [{ subgraph: sub, index: 0 }] }, []);
    expect(out[0]!.state).toEqual({});
  });

  it('数据驱动项：图定义数据 dict + resolve_graph 重建', () => {
    const sub = make_sub_serializable();
    const sub_data = sub.to_dict();
    const out = collect_spawn_specs(
      { [SPAWN_KEY]: [{ subgraph: sub_data, state: { seed: 1 }, index: 0 }] },
      [],
      { resolve_graph: () => sub },
    );
    expect(out[0]!.subgraph).toBe(sub);
  });

  it('数据驱动项：dict 形态未注入解析器 → 显式拒绝', () => {
    expect(() =>
      collect_spawn_specs(
        { [SPAWN_KEY]: [{ subgraph: { name: 'x' }, state: {}, index: 0 }] },
        [],
      ),
    ).toThrow(GraphDefinitionError);
  });

  it('数据驱动项：subgraph 既非 Graph 也非 dict → 显式拒绝（提示注入解析器）', () => {
    expect(() =>
      collect_spawn_specs(
        { [SPAWN_KEY]: [{ subgraph: 42, state: {}, index: 0 }] },
        [],
      ),
    ).toThrow(/需注入解析器/);
  });

  it('清单非 list-of-dict 形态 → 显式拒绝', () => {
    expect(() =>
      collect_spawn_specs(
        { [SPAWN_KEY]: 'oops' as unknown as never },
        [],
      ),
    ).toThrow(/spawn 清单须为/);
  });

  it('清单元素非 dict → 显式拒绝', () => {
    expect(() =>
      collect_spawn_specs(
        { [SPAWN_KEY]: ['not a dict'] as unknown as never },
        [],
      ),
    ).toThrow(/spawn 清单须为/);
  });

  it('state 字段类型非法（不是 dict）→ 显式拒绝', () => {
    const sub = make_sub();
    expect(() =>
      collect_spawn_specs(
        { [SPAWN_KEY]: [{ subgraph: sub, state: 42 as unknown as Record<string, unknown>, index: 0 }] },
        [],
      ),
    ).toThrow(/状态须为 dict/);
  });

  it('index 非数字 → 显式拒绝', () => {
    const sub = make_sub();
    expect(() =>
      collect_spawn_specs(
        { [SPAWN_KEY]: [{ subgraph: sub, state: {}, index: 'oops' as unknown as number }] },
        [],
      ),
    ).toThrow(/序号非法/);
  });

  it('instance 序号重复 → 显式拒绝', () => {
    const sub = make_sub();
    expect(() =>
      collect_spawn_specs(
        { [SPAWN_KEY]: [
          { subgraph: sub, state: {}, index: 0 },
          { subgraph: sub, state: {}, index: 0 },
        ] },
        [],
      ),
    ).toThrow(/spawn 实例序号重复/);
  });

  it('命令式 pending 与数据驱动项合并：先命令式后数据驱动（序号稳定）', () => {
    const sub = make_sub();
    const a = new SpawnSpec({ subgraph: sub, state: {}, index: 0 });
    const b = new SpawnSpec({ subgraph: sub, state: {}, index: 1 });
    const out = collect_spawn_specs(
      { [SPAWN_KEY]: [{ subgraph: sub, state: {}, index: 2 }] },
      [a, b],
    );
    expect(out.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('state 深拷贝（修改原 overlay 不影响产物）', () => {
    const sub = make_sub();
    const originalItem: Record<string, unknown> = {
      subgraph: sub,
      state: { seed: 1 },
      index: 0,
    };
    const overlay: Record<string, unknown> = {
      [SPAWN_KEY]: [originalItem],
    };
    const out = collect_spawn_specs(overlay, []);
    originalItem['state'] = { seed: 999 };
    expect(out[0]!.state).toEqual({ seed: 1 });
  });
});
