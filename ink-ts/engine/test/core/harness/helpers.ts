/**
 * harness 测试共享 fixture（Python conftest._registry/_harness 移植）。
 * 仅被 .test.ts 引用，不单独收集执行。
 */
import { Graph } from '../../../src/core/graph/graph.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import {
  GraphRegistries,
  NodeTypeRegistry,
} from '../../../src/core/registry/registry.js';

/** 节点注册表：write 类型工厂（登记图定义解析所需；执行语义留引擎）。 */
export function _registry(): GraphRegistries {
  const nodes = new NodeTypeRegistry();
  nodes.register('write', (config) => async (ctx) => {
    const state = (ctx as { state?: Record<string, unknown> }).state ?? {};
    const seen = Array.isArray(state['seen']) ? (state['seen'] as unknown[]) : [];
    return {
      seen: [...seen, (config['tag'] as string | undefined) ?? 'write'],
    };
  });
  return new GraphRegistries(nodes);
}

/** 构造 harness 定义（与 Python conftest _harness 同形；选项式覆盖）。 */
export function _harness(
  options: {
    name?: string;
    keywords?: readonly string[];
    description?: string | null;
  } = {},
): HarnessDefinition {
  const name = options.name ?? 'plotter';
  const keywords = options.keywords ?? ['推演', '大纲'];
  const graph = new Graph({ name, entry: 'w1' });
  graph.add_node_type('w1', 'write', { tag: name });
  graph.add_exit('w1');
  return new HarnessDefinition({
    name,
    description: options.description ?? `${name} 能力包`,
    keywords,
    graph: graph.to_dict(),
    tools: [
      {
        name: `${name}tool`,
        description: '工具',
        parameters: {},
        permissions: ['process:exec:git'],
        endpoint: 'process_exec',
        endpoint_config: {
          allowlist: ['git'],
          path: process.env.PATH ?? '',
        },
      },
    ],
    schema: { channels: { seen: null } },
    default_plan: { steps: [{ nodes: ['w1'] }], index: 0 },
    meta: { source: 'seed' },
  });
}
