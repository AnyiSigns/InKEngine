/**
 * 内省服务测试夹具（对标 Python test_introspection.py 的 _data_graph /
 * _function_graph / _conditional_graph / _knowledge_set / _service）。
 *
 * 图/知识/注册表均为引擎侧已迁移的显式形态（Graph/KnowledgeSet/
 * HarnessRegistry），TS 不反射 JS 对象；知识集存储未注入（storage=null，
 * 纯内存链——内省快照只读内存链，落库面不参与）。
 */
import { Graph } from '../../../src/core/graph/graph.js';
import { HarnessDefinition, HarnessRegistry } from '../../../src/core/harness/index.js';
import {
  IntrospectionService,
  IntrospectionSources,
  introspection_tool_specs,
} from '../../../src/core/introspection/index.js';
import { KnowledgeEntry, KnowledgeSet, KIND_RULE, LEVEL_USER, SOURCE_MODEL, SOURCE_DIALOG } from '../../../src/core/knowledge_set/index.js';
import { Rule } from '../../../src/core/rules/index.js';

/** 内省元工具名清单（注册形态断言的固定序）。 */
export const INTROSPECTION_TOOL_NAMES: readonly string[] = [
  'inspect_graph',
  'inspect_rules',
  'inspect_knowledge',
  'inspect_ui',
  'inspect_tools',
  'inspect_entities',
];

/** 类型化图（节点注册类型名，可序列化为图定义数据）。 */
export function data_graph(): Graph {
  const g = new Graph({ name: 'intro', entry: 'start' });
  g.add_node_type('start', 'start', { prompt: '你好' });
  g.add_node_type('mid', 'mid', {});
  g.add_edge('start', 'mid');
  g.add_exit('mid');
  return g;
}

/** 函数直挂节点图（不可序列化，观察时须回退降级视图）。 */
export function function_graph(): Graph {
  const g = new Graph({ name: 'fn', entry: 'start' });
  g.add_node('start', async () => ({}));
  g.add_exit('start');
  return g;
}

/** 无名条件边图（函数直挂判定，边不可序列化——降级视图呈现）。 */
export function conditional_graph(): Graph {
  const g = new Graph({ name: 'cond', entry: 'start' });
  g.add_node('start', async () => ({ go: true }));
  g.add_node('yes', async () => ({ done: true }));
  g.add_node('no', async () => ({ done: true }));
  g.add_conditional_edge('start', 'yes', async () => true);
  g.add_conditional_edge('start', 'no', async () => false);
  g.add_exit('yes');
  g.add_exit('no');
  return g;
}

/** 真实规则形态夹具：经 Rule.to_dict 产出的声明数据（默认级省略 severity
 *  键是引擎序列化语义，快照须补全而非呈现 null）。 */
export function knowledge_set(): KnowledgeSet {
  const ks = new KnowledgeSet('u1', { storage: null });
  const default_rule = new Rule({
    id: 'rule-1',
    predicate: 'motive_consistent',
    config: { motive_path: 'motive' },
    description: '主角行为须与既定动机一致',
  });
  const warning_rule = new Rule({
    id: 'rule-2',
    predicate: 'foreshadow_paired',
    config: { chain_path: 'foreshadows' },
    severity: 'warning',
    description: '伏笔须有回收',
  });
  ks.add(
    new KnowledgeEntry({
      id: 'rule-1',
      level: LEVEL_USER,
      kind: KIND_RULE,
      title: '主角动机一致',
      data: { rule: default_rule.to_dict() },
      source: SOURCE_MODEL,
    }),
  );
  ks.add(
    new KnowledgeEntry({
      id: 'rule-2',
      level: LEVEL_USER,
      kind: KIND_RULE,
      title: '伏笔回收',
      data: { rule: warning_rule.to_dict() },
      source: SOURCE_MODEL,
    }),
  );
  ks.add(
    new KnowledgeEntry({
      id: 'entry-1',
      level: LEVEL_USER,
      kind: 'template',
      title: '章节模板',
      data: { steps: [] },
      source: SOURCE_DIALOG,
    }),
  );
  return ks;
}

/** 内省服务夹具（知识集默认装配，图/注册表可覆盖；ui_spec = 面板布局）。 */
export function make_service(options: {
  graph?: Graph | null;
  registry?: HarnessRegistry | null;
  knowledge?: KnowledgeSet | null;
} = {}): IntrospectionService {
  const graph = options.graph === undefined ? null : options.graph;
  const registry = options.registry ?? null;
  const knowledge = options.knowledge === undefined ? knowledge_set() : options.knowledge;
  const tools = introspection_tool_specs();
  return new IntrospectionService(
    new IntrospectionSources({
      graph,
      knowledge_set: knowledge,
      harness_registry: registry,
      tools,
      ui_spec: { layout: 'panel' },
    }),
  );
}

/** 带一个注册 harness 的注册表（novel 领域）。 */
export function harness_registry(): HarnessRegistry {
  const registry = new HarnessRegistry();
  registry.register(
    new HarnessDefinition({ name: 'novel', description: '小说领域', keywords: ['小说'] }),
  );
  return registry;
}
