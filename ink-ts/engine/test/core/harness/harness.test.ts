/**
 * harness 声明式定义单测（Python test_harness.py 移植）：定义数据往返 /
 * 注册表重建（图/工具/schema）/ 集内激活路由 / 注销原语 / 注册期校验 /
 * build_tools 登记副作用。
 *
 * 延后（engine/执行体集成，头部注记）：
 * - test_registry_graph_runs_end_to_end：注册表重建的图直接执行需 Engine
 *   （make_engine + engine._execute）——引擎未迁入 ink-ts，待引擎模块迁入
 *   后按 build_graph 产物联跑补测（详见下方 it.skip 用例）；
 * - test_build_pipeline_runs_declarative_tool：需 PermissionGate +
 *   ProcessSandbox + 宿主 process_executor 执行体注入的完整流水线执行，
 *   属执行体集成用例——待宿主执行流水线 seam 就绪后按 build_pipeline
 *   接线补测（详见下方 it.skip 用例）。
 */
import { describe, expect, it } from 'vitest';

import { DeclarativeToolSpec } from '../../../src/core/declarative_tools/index.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';
import {
  HarnessDefinition,
  HarnessRegistry,
} from '../../../src/core/harness/index.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';

import { _harness, _registry } from './helpers.js';

/** 断言抛错为 GraphDefinitionError 且文案命中（Python pytest.raises 等价）。 */
function expectGraphError(fn: () => unknown, pattern: RegExp): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(GraphDefinitionError);
  expect((caught as Error).message).toMatch(pattern);
}

describe('harness 定义数据往返', () => {
  it('导出/导入形态字段完整', () => {
    const definition = _harness();
    const rebuilt = HarnessDefinition.from_dict(definition.to_dict());
    expect(rebuilt.name).toBe('plotter');
    expect([...rebuilt.keywords]).toEqual(['推演', '大纲']);
    expect(rebuilt.graph).not.toBeNull();
    expect(rebuilt.graph?.['name']).toBe('plotter');
    expect(rebuilt.tools[0]?.['endpoint']).toBe('process_exec');
    expect(rebuilt.default_plan).not.toBeNull();
    expect(rebuilt.meta).toEqual({ source: 'seed' });
  });
});

describe('harness 注册表重建与路由', () => {
  it('注册表重建：图/工具/schema 从定义数据还原（注册即可用）', () => {
    const registry = new HarnessRegistry({ registries: _registry() });
    registry.register(_harness());
    const graph = registry.build_graph('plotter');
    expect(graph).not.toBeNull();
    expect(graph?.entry).toBe('w1');
    const tools = registry.build_tools('plotter');
    expect(tools.map((t) => t.name)).toEqual(['plottertool']);
    expect(tools[0]).toBeInstanceOf(ToolSpec);
    const schema = registry.build_schema('plotter');
    expect(schema).not.toBeNull();
    expect('seen' in schema!.channels).toBe(true);
  });

  it('集内激活：任务描述 → 相关度激活清单（降序 + 阈值过滤）', () => {
    const registry = new HarnessRegistry({ registries: _registry() });
    registry.register(_harness({ keywords: ['推演', '大纲'] }));
    registry.register(_harness({ name: 'editor', keywords: ['润色', '修改'] }));
    const activated = registry.route('帮我推演一下这个大纲走向，然后润色一下');
    expect(activated[0]?.[0]).toBe('plotter'); // 相关度最高者居首
    expect(activated[0]![1]).toBeGreaterThan(activated[1]![1]);
    expect(new Set(activated.map(([name]) => name))).toEqual(
      new Set(['plotter', 'editor']),
    );
    expect(registry.route('完全无关的任务')).toEqual([]);
  });

  it('自定义激活匹配器可注入（换匹配器不改装配）', () => {
    const registry = new HarnessRegistry({
      registries: _registry(),
      matcher: (task, definition) => (task.includes(definition.name) ? 1.0 : 0.0),
    });
    registry.register(_harness());
    expect(registry.route('请 plotter 处理')[0]?.[0]).toBe('plotter');
    expect(registry.route('别的任务')).toEqual([]);
  });

  it('激活阈值可配：低于阈值的弱相关能力包不激活', () => {
    const registry = new HarnessRegistry({ registries: _registry() });
    registry.register(_harness({ keywords: ['推演', '大纲'] }));
    expect(registry.route('推演', { threshold: 0.5 })[0]?.[0]).toBe('plotter');
    // 只命中 1/2 关键词，低于阈值
    expect(registry.route('推演', { threshold: 0.8 })).toEqual([]);
  });
});

describe('harness 注销原语', () => {
  it('注册→注销→再注册可用 + 重复注销幂等', () => {
    const registry = new HarnessRegistry({ registries: _registry() });
    registry.register(_harness());
    expect(registry.get('plotter')).not.toBeNull();

    registry.unregister('plotter');
    expect(registry.get('plotter')).toBeNull();
    expect(registry.names()).not.toContain('plotter');
    expect(registry.route('推演大纲')).toEqual([]);
    expect(() => registry.build_graph('plotter')).toThrow('harness 未注册: plotter');

    // 注销后可再注册（回退 = 注销当前 + 重登记旧版本）
    registry.register(_harness({ description: '回退版本' }));
    expect(registry.get('plotter')?.description).toBe('回退版本');

    // 重复注销幂等：再注销多次不报错、状态保持已退役
    registry.unregister('plotter');
    registry.unregister('plotter');
    registry.unregister('plotter'); // 未注册名静默（幂等）
    expect(registry.get('plotter')).toBeNull();
  });
});

describe('harness 注册期校验', () => {
  it('非法图定义数据在注册期拒绝（悬挂出口回归 P1-5 接线）', () => {
    const registry = new HarnessRegistry({ registries: _registry() });
    const graph = new Graph({ name: 'bad', entry: 'w1' });
    graph.add_node_type('w1', 'write', { tag: 'x' });
    graph.add_exit('w1');
    const data = graph.to_dict();
    data['exits'] = ['w1', 'ghost']; // 悬挂出口
    expectGraphError(
      () =>
        registry.register(
          HarnessDefinition.from_dict({ ..._harness().to_dict(), graph: data }),
        ),
      /节点不存在/,
    );
  });

  it('默认编排模板引用未知节点在注册期拒绝（不落到执行期）', () => {
    const registry = new HarnessRegistry({ registries: _registry() });
    const data = _harness().to_dict();
    data['default_plan'] = { steps: [{ nodes: ['ghost_plan_node'] }] };
    expectGraphError(
      () => registry.register(HarnessDefinition.from_dict(data)),
      /未知节点/,
    );

    // 无图定义却带编排模板 = 模板无处可执行，同样拒绝
    const bare = new HarnessDefinition({
      name: 'bare',
      description: '无图',
      keywords: [],
      graph: null,
      tools: [],
      default_plan: { steps: [{ nodes: ['w1'] }] },
    });
    expectGraphError(() => registry.register(bare), /要求 graph 定义/);
  });
});

describe('build_tools 登记副作用', () => {
  it('声明式定义登记进执行体注册表（分发反查）', () => {
    const registry = new HarnessRegistry({ registries: _registry() });
    registry.register(_harness());
    registry.build_tools('plotter');
    const registered = registry.declarative.definitions;
    expect(registered['plottertool']).toBeInstanceOf(DeclarativeToolSpec);
    expect(registered['plottertool']!.endpoint).toBe('process_exec');
  });
});

describe('延后用例（engine/执行体集成，头部注记）', () => {
  it.skip('注册表重建的图可直接执行（Python test_registry_graph_runs_end_to_end）', () => {
    // 延后：引擎（make_engine + engine._execute）未迁入 ink-ts core。
    // 语义 = build_graph 产物可直接交引擎执行并回流 state["seen"]。
  });

  it.skip('build_pipeline 声明式工具走完整流水线（Python test_build_pipeline_runs_declarative_tool）', () => {
    // 延后：需 PermissionGate + ProcessSandbox + 宿主 process_executor
    // 执行体注入的完整执行体集成；含 fail-closed「无法判定目标」语义。
  });
});
