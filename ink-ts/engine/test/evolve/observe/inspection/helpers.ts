/**
 * 内省服务测试夹具（对标 Python test_introspection.py 的 _knowledge_set /
 * _service 段；图夹具随 inspect_graph 子面退役删除，W7-B）。
 *
 * 知识/注册表为引擎侧已迁移的显式形态（KnowledgeSet/HarnessRegistry），
 * TS 不反射 JS 对象；知识集存储未注入（storage=null，
 * 纯内存链——内省快照只读内存链，落库面不参与）。
 */
import { HarnessDefinition, HarnessRegistry } from '../../../../src/core/harness/index.js';
import {
  IntrospectionService,
  IntrospectionSources,
  introspection_tool_specs,
} from '../../../../src/evolve/observe/inspection/index.js';
import { KnowledgeEntry, KnowledgeSet, KIND_RULE, LEVEL_USER, SOURCE_MODEL, SOURCE_DIALOG } from '../../../../src/core/knowledge_set/index.js';
import { Rule } from '../../../../src/model/rules/index.js';

/** 内省元工具名清单（注册形态断言的固定序）。 */
export const INTROSPECTION_TOOL_NAMES: readonly string[] = [
  'inspect_rules',
  'inspect_knowledge',
  'inspect_ui',
  'inspect_tools',
  'inspect_entities',
];

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

/** 内省服务夹具（知识集默认装配，注册表可覆盖；ui_spec = 面板布局）。 */
export function make_service(options: {
  registry?: HarnessRegistry | null;
  knowledge?: KnowledgeSet | null;
} = {}): IntrospectionService {
  const registry = options.registry ?? null;
  const knowledge = options.knowledge === undefined ? knowledge_set() : options.knowledge;
  const tools = introspection_tool_specs();
  return new IntrospectionService(
    new IntrospectionSources({
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
