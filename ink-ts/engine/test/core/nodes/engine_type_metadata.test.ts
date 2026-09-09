/**
 * 引擎类型建模（P1）元数据声明测试 + P4.2a router_judge 元数据：
 * - 结点 kind 常量族（六类值）与内置类型元数据表（llm_decider/tool_pipeline/
 *   router_judge/vision_perceive 的 kind/label/description/flags）；
 * - 池种子节点声明携带元数据（kind/label/description/flags 与元数据表一致）。
 */

import { describe, expect, it } from 'vitest';

import {
  ENGINE_NODE_TYPE_META,
  NODE_KIND_AGENT,
  NODE_KIND_END,
  NODE_KIND_ENTRY,
  NODE_KIND_LLM,
  NODE_KIND_ROUTER,
  NODE_KIND_TOOL,
  TYPE_LLM_DECIDER,
  TYPE_ROUTER_JUDGE,
  TYPE_TOOL_PIPELINE,
} from '../../../src/core/nodes/constants.js';
import { default_engine_pool_seed } from '../../../src/core/nodes/pool_seed.js';

describe('结点 kind 常量族（六类）', () => {
  it('六个类别字符串常量导出', () => {
    expect(NODE_KIND_LLM).toBe('llm');
    expect(NODE_KIND_TOOL).toBe('tool');
    expect(NODE_KIND_ROUTER).toBe('router');
    expect(NODE_KIND_ENTRY).toBe('entry');
    expect(NODE_KIND_END).toBe('end');
    expect(NODE_KIND_AGENT).toBe('agent');
  });
});

describe('内置类型元数据表', () => {
  it('llm_decider：kind=llm、flags.terminal=true（可自终止终态候选）', () => {
    const meta = ENGINE_NODE_TYPE_META[TYPE_LLM_DECIDER];
    expect(meta).toBeDefined();
    expect(meta?.kind).toBe(NODE_KIND_LLM);
    expect(meta?.label).toBe('LLM 决策');
    expect(meta?.description).toBe('单节点内完成模型流式 + 工具回合');
    expect(meta?.flags).toEqual({ terminal: true });
  });

  it('tool_pipeline：kind=tool、空 flags（终态由实例 config role=terminal 表达）', () => {
    const meta = ENGINE_NODE_TYPE_META[TYPE_TOOL_PIPELINE];
    expect(meta?.kind).toBe(NODE_KIND_TOOL);
    expect(meta?.label).toBe('工具流水线');
    expect(meta?.description).toBe('消费 state.pending 工具清单；role=terminal 为终态');
    expect(meta?.flags).toEqual({});
  });

  it('router_judge：kind=router、空 flags（router 占执行步选走向，不作终态）', () => {
    const meta = ENGINE_NODE_TYPE_META[TYPE_ROUTER_JUDGE];
    expect(meta).toBeDefined();
    expect(meta?.kind).toBe(NODE_KIND_ROUTER);
    expect(meta?.label).toBe('路由判断');
    expect(meta?.description).toBe('LLM 从候选目标中选一个走向（模糊/复杂判断，占一个执行步骤）');
    expect(meta?.flags).toEqual({});
  });

  it('vision_perceive：kind=tool、label/description 齐备', () => {
    const meta = ENGINE_NODE_TYPE_META['vision_perceive'];
    expect(meta?.kind).toBe(NODE_KIND_TOOL);
    expect(meta?.label).toBe('视觉感知');
    expect(meta?.description).toBe('截图→结构化描述');
    expect(meta?.flags).toBeUndefined();
  });
});

describe('池种子节点声明携带类型元数据', () => {
  it('llm_decider/tool_pipeline/router_judge 种子携带 kind/label/description/flags（与元数据表一致）', () => {
    const seed = default_engine_pool_seed();
    const llm = seed.node_types.find((n) => n.type === TYPE_LLM_DECIDER);
    expect(llm?.kind).toBe(NODE_KIND_LLM);
    expect(llm?.label).toBe('LLM 决策');
    expect(llm?.description).toBe('单节点内完成模型流式 + 工具回合');
    expect(llm?.flags).toEqual({ terminal: true });
    const tool = seed.node_types.find((n) => n.type === TYPE_TOOL_PIPELINE);
    expect(tool?.kind).toBe(NODE_KIND_TOOL);
    expect(tool?.label).toBe('工具流水线');
    expect(tool?.description).toBe('消费 state.pending 工具清单；role=terminal 为终态');
    expect(tool?.flags).toEqual({});
    const router = seed.node_types.find((n) => n.type === TYPE_ROUTER_JUDGE);
    expect(router?.kind).toBe(NODE_KIND_ROUTER);
    expect(router?.label).toBe('路由判断');
    expect(router?.description).toBe('LLM 从候选目标中选一个走向（模糊/复杂判断，占一个执行步骤）');
    expect(router?.flags).toEqual({});
    // 种子 config_defaults 带示例 routes/prompt（候选清单实际由装配实例化覆写）
    expect(Array.isArray(router?.default_config['routes'])).toBe(true);
    expect(router?.default_config['routes']).toHaveLength(2);
  });
});
