/**
 * 引擎内置基础节点类型的池种子数据（数据形态，非代码图）。
 *
 * 冷启动 = 引擎内置池种子：基础节点类型声明（类型名 + 缺省 config + 契约）
 * 与 chat/general 域边先验（域 base 图模板数据——入口/节点类型引用/边/出口，
 * 供组装在无缓存/技能/证据时稳定产出合法候选数据图）。宿主/集可整体替换
 * 或禁用（enabled=false；AssemblyRecipe.pool_seed 注入），覆写走数据不进代码。
 */

import { NodeContract } from '../contracts/contracts.js';
import {
  ENGINE_DEFAULT_TOOL_ROUNDS,
  ROLE_TERMINAL,
  TYPE_LLM_DECIDER,
  TYPE_TOOL_PIPELINE,
} from './constants.js';
import { llm_decider_contract } from './llm_decider.js';
import { tool_pipeline_contract } from './tool_pipeline.js';

/** 单条引擎基础节点类型种子（类型名 + 缺省 config + 契约数据）。 */
export interface EngineNodeTypeSeed {
  type: string;
  default_config: Record<string, unknown>;
  contract: NodeContract;
}

/** 域边先验种子（base 图模板；数据图按类型名引用引擎内置类型）。 */
export interface EngineDomainSeed {
  domain: string;
  enabled: boolean;
  graph: Record<string, unknown>;
}

/** 引擎内置池种子数据（节点类型 + 域 base 图；可整体禁用）。 */
export interface EnginePoolSeed {
  enabled: boolean;
  node_types: readonly EngineNodeTypeSeed[];
  domains: readonly EngineDomainSeed[];
}

/** chat/general 域 base 图模板（llm_decider → terminal；回合终态 = 出口）。 */
function _chat_base_graph(): Record<string, unknown> {
  return {
    name: 'engine.chat',
    entry: TYPE_LLM_DECIDER,
    nodes: {
      [TYPE_LLM_DECIDER]: { type: TYPE_LLM_DECIDER, config: {} },
      end: { type: TYPE_TOOL_PIPELINE, config: { role: ROLE_TERMINAL } },
    },
    edges: { [TYPE_LLM_DECIDER]: [{ target: 'end' }] },
    exits: ['end'],
    subgraphs: {},
    schema: null,
  };
}

/** 出厂引擎内置池种子（每调用返回新鲜数据，防调用方就地改写污染缺省）。 */
export function default_engine_pool_seed(): EnginePoolSeed {
  return {
    enabled: true,
    node_types: [
      {
        type: TYPE_LLM_DECIDER,
        default_config: { max_tool_rounds: ENGINE_DEFAULT_TOOL_ROUNDS },
        contract: llm_decider_contract(),
      },
      {
        type: TYPE_TOOL_PIPELINE,
        default_config: {},
        contract: tool_pipeline_contract(),
      },
    ],
    domains: [
      { domain: 'general', enabled: true, graph: _chat_base_graph() },
      { domain: 'chat', enabled: true, graph: _chat_base_graph() },
    ],
  };
}
