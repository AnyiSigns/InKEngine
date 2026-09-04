/**
 * 自指层观察原语单测：内省服务快照正确性 + 元工具注册形态
 * （对标 Python test_introspection.py 服务快照段）。
 *
 * 覆盖：工具描述注册形态（权限声明）、图/规则/知识/界面/工具表五路快照
 * （恒定信封、函数直挂节点降级视图、默认严重度补全、深拷贝）、limit 钳制、
 * 未知工具名拒绝、五路快照 JSON 可序列化、OpenAI 工具转换契约。
 *
 * 延后（defer）：引擎/运行时集成用例——introspection 是对运行时对象
 * 反射，TS 侧以 seam/注册表映射表达（图/注册表/实体目录为显式类型，
 * 不反射 JS 对象）；内省元工具接入引擎运行时工具表与真跑图执行的用例
 * 待引擎运行时接线后补（随 tool_index / entities 先例）。Python 端
 * entities 套件的 TestIntrospectionEntities 亦依赖本模块，待实体目录
 * 快照的宿主接线后补测。
 */
import { describe, expect, it } from 'vitest';

import { Graph } from '../../../src/core/graph/graph.js';
import {
  INTROSPECTION_PERMISSION,
  IntrospectionService,
  IntrospectionSources,
  introspection_tool_specs,
} from '../../../src/core/introspection/index.js';
import { LEVEL_USER } from '../../../src/core/knowledge_set/_types.js';
import { ToolSpec, to_openai_tools } from '../../../src/core/llm/tools.js';
import {
  INTROSPECTION_TOOL_NAMES,
  conditional_graph,
  data_graph,
  function_graph,
  harness_registry,
  knowledge_set,
  make_service,
} from './helpers.js';

describe('内省元工具注册形态', () => {
  it('六个工具描述：固定名序 + 只读权限声明 + schema/描述齐备', () => {
    const specs = introspection_tool_specs();
    expect(specs).toHaveLength(6);
    expect(specs.map((spec) => spec.name)).toEqual([...INTROSPECTION_TOOL_NAMES]);
    for (const spec of specs) {
      expect(spec.permissions).toEqual([INTROSPECTION_PERMISSION]);
      expect(spec.parameters).not.toBeNull();
      expect(typeof spec.parameters).toBe('object');
      expect(typeof spec.description).toBe('string');
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });
});

describe('图快照', () => {
  it('类型化图：恒定信封 {graph, digest} 与结构内容', () => {
    const service = make_service({ graph: data_graph() });
    const snapshot = service.snapshot_graph();
    expect(Object.keys(snapshot).sort()).toEqual(['digest', 'graph']);
    const graph = snapshot['graph'] as {
      name: string;
      entry: string;
      nodes: Record<string, unknown>;
      edges: Record<string, Array<Record<string, unknown>>>;
      exits: string[];
    };
    expect(graph.name).toBe('intro');
    expect(graph.entry).toBe('start');
    expect(Object.keys(graph.nodes)).toContain('start');
    expect(graph.edges['start']?.[0]?.['target']).toBe('mid');
    expect(graph.exits).toContain('mid');
    expect(typeof snapshot['digest']).toBe('string');
    expect(String(snapshot['digest']).length).toBeGreaterThan(0);
  });

  it('无图源：空态信封', () => {
    const service = make_service({ graph: null });
    expect(service.snapshot_graph()).toEqual({ graph: null, digest: null });
  });

  it('函数直挂节点：降级视图 + degraded 标记，观察不失败', () => {
    const service = make_service({ graph: function_graph() });
    const snapshot = service.snapshot_graph();
    const graph = snapshot['graph'] as {
      name: string;
      nodes: Record<string, unknown>;
      degraded: boolean;
      degraded_reason: unknown;
    };
    expect(graph.name).toBe('fn');
    expect(graph.nodes['start']).toEqual({ type: 'function' });
    expect(graph.degraded).toBe(true);
    expect(graph.degraded_reason).toBeTruthy();
    expect(String(snapshot['digest']).length).toBeGreaterThan(0);
  });

  it('无名条件边：降级视图呈现边结构与条件类型标记', () => {
    const service = make_service({ graph: conditional_graph() });
    const snapshot = service.snapshot_graph();
    const graph = snapshot['graph'] as {
      degraded: boolean;
      edges: Record<string, Array<Record<string, unknown>>>;
    };
    expect(graph.degraded).toBe(true);
    const edges = graph.edges['start'] ?? [];
    expect(
      edges.some(
        (edge) => edge['target'] === 'yes' && edge['condition'] === 'function',
      ),
    ).toBe(true);
    expect(edges.some((edge) => edge['target'] === 'no')).toBe(true);
  });

  it('降级视图递归呈现子图内部结构（子图节点不混入 nodes）', () => {
    const parent = new Graph({ name: 'parent', entry: 'root' });
    parent.add_node('root', async () => ({}));
    parent.add_exit('root');
    parent.add_subgraph('child', data_graph());
    const service = make_service({ graph: parent });
    const snapshot = service.snapshot_graph();
    const graph = snapshot['graph'] as {
      degraded: boolean;
      nodes: Record<string, unknown>;
      subgraphs: Record<string, { name: string; nodes: Record<string, unknown> }>;
    };
    expect(graph.degraded).toBe(true);
    expect(graph.nodes['root']).toEqual({ type: 'function' });
    expect(Object.keys(graph.nodes)).not.toContain('child');
    const sub = graph.subgraphs['child']!;
    expect(sub.name).toBe('intro');
    expect(Object.keys(sub.nodes)).toContain('start');
  });
});

describe('规则/知识快照', () => {
  it('规则集快照：缺省严重度补全为 error，而非 null', () => {
    const service = make_service({ graph: data_graph() });
    const snapshot = service.snapshot_rules();
    expect(snapshot['count']).toBe(2);
    const rules = snapshot['rules'] as Array<Record<string, unknown>>;
    const by_id = new Map<string, Record<string, unknown>>();
    for (const rule of rules) by_id.set(String(rule['id']), rule);
    expect(by_id.get('rule-1')?.['severity']).toBe('error');
    expect(by_id.get('rule-2')?.['severity']).toBe('warning');
    expect(by_id.get('rule-1')?.['description']).toBe('主角行为须与既定动机一致');
  });

  it('知识集快照：统计 + 近期条目概览，limit 限制条数', () => {
    const service = make_service({ graph: data_graph() });
    const snapshot = service.snapshot_knowledge();
    expect(snapshot['count']).toBe(3);
    expect(snapshot['by_kind']).toEqual({ rule: 2, template: 1 });
    expect(snapshot['by_level']).toEqual({ [LEVEL_USER]: 3 });
    const titles = new Set(
      (snapshot['entries'] as Array<{ title: string }>).map((entry) => entry.title),
    );
    expect(titles).toEqual(new Set(['主角动机一致', '伏笔回收', '章节模板']));
    const limited = service.snapshot_knowledge(1) as { entries: unknown[] };
    expect(limited['entries']).toHaveLength(1);
  });

  it('limit 钳制到 [1, 100]：负值/越界不静默失真', () => {
    const service = make_service({ graph: data_graph() });
    const negative = service.snapshot_knowledge(-3) as { entries: unknown[] };
    expect(negative['entries']).toHaveLength(1);
    const huge = service.snapshot_knowledge(10000) as { entries: unknown[] };
    expect(huge['entries']).toHaveLength(3);
  });
});

describe('界面/工具表快照', () => {
  it('界面快照返回深拷贝：改写结果不得反写引擎源数据', () => {
    const service = make_service({ graph: data_graph() });
    const snapshot = service.snapshot_ui();
    const ui = snapshot['ui_spec'] as Record<string, string>;
    expect(ui['layout']).toBe('panel');
    ui['layout'] = 'mutated';
    const again = service.snapshot_ui()['ui_spec'] as Record<string, string>;
    expect(again['layout']).toBe('panel');
  });

  it('工具表快照含注入面清单与集内 harness 领域', () => {
    const service = make_service({ graph: data_graph(), registry: harness_registry() });
    const snapshot = service.snapshot_tools();
    expect(snapshot['count']).toBe(6);
    const tools = snapshot['tools'] as Array<{ name: string; permissions: string[] }>;
    expect(tools.map((tool) => tool.name)).toContain('inspect_graph');
    expect(snapshot['harnesses']).toEqual(['novel']);
    expect(tools[0]?.permissions).toEqual([INTROSPECTION_PERMISSION]);
  });

  it('注入面与全量注册面分开呈现：注册面含未注入工具', () => {
    const injected = introspection_tool_specs();
    const registered = [
      ...injected,
      new ToolSpec({ name: 'shell_exec', description: '执行命令', parameters: {} }),
    ];
    const service = new IntrospectionService(
      new IntrospectionSources({
        graph: data_graph(),
        harness_registry: harness_registry(),
        tools: injected,
        registered_tools: registered,
        ui_spec: { layout: 'panel' },
      }),
    );
    const snapshot = service.snapshot_tools();
    expect(snapshot['count']).toBe(6);
    const registered_only = snapshot['registered_tools'] as Array<{ name: string }>;
    expect(registered_only).toHaveLength(1);
    expect(registered_only[0]?.name).toBe('shell_exec');
    expect(snapshot['registered_count']).toBe(1);
  });
});

describe('分发与序列化', () => {
  it('未知工具名显式拒绝（fail-closed）', () => {
    const service = make_service({ graph: data_graph() });
    expect(() => service.snapshot('inspect_nothing', {})).toThrow('未知内省工具');
  });

  it('五路快照均为可 JSON 序列化的确定性数据', () => {
    const service = make_service({ graph: function_graph() });
    for (const name of INTROSPECTION_TOOL_NAMES) {
      const snapshot = service.snapshot(name, {});
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    }
  });

  it('知识集缺省为 null 时按空态呈现', () => {
    const service = make_service({ knowledge: null });
    expect(service.snapshot_rules()).toEqual({ rules: [], count: 0 });
    expect(service.snapshot_knowledge()).toEqual({
      entries: [],
      count: 0,
      by_kind: {},
      by_level: {},
    });
  });
});

describe('OpenAI 工具转换契约', () => {
  it('内省工具描述可转换为 OpenAI 兼容 tools schema', () => {
    const converted = to_openai_tools([...introspection_tool_specs()]);
    expect(converted).toHaveLength(6);
    const names = new Set(
      converted.map(
        (tool) => (tool['function'] as { name: string }).name,
      ),
    );
    expect(names).toEqual(new Set(INTROSPECTION_TOOL_NAMES));
  });
});
