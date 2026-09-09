/**
 * 引擎内置基础节点类型的池种子数据（数据形态，非代码图）。
 *
 * 冷启动 = 引擎内置池种子：基础节点类型声明（类型名 + 缺省 config + 契约 +
 * 类型元数据）。池只放结点类型构件（无整图模板数据面；组装恒从池选，无输入
 * 源兜底 = 从池选 flags.terminal=true 的 active 终态候选出单节点图）。宿主/
 * 集可整体替换或禁用（enabled=false；AssemblyRecipe.pool_seed 注入），覆写走
 * 数据不进代码。
 *
 * P4.2a-3 出厂实例多样化（§一.5「组装 = 不确定性」）：池种子 = **可区分实例**
 * ——每个实例条目须有明确契约输出/用途区分，杜绝「同一内核换壳 N 条」。llm
 * 实例按 output_field/read_fields 分化（llm_planner→plan、llm_reviewer 读
 * plan 出 review、llm_main 读 plan+review 出 reply），实例键独立、executor
 * 解耦指向 engine:llm_decider；router 实例按 routes/用途 1 条分化
 * （router_plan_judge 读 plan 做答复/研究路由）。每条的实例契约经
 * derive_instance_contract 随 config_defaults 派生（无分化 config = 原类型
 * 契约零漂移）。出厂边先验（default_engine_seed_edges）与上述实例匹配的
 * feed 关系，装配入口见 runtime 装配（recipe.seed_edges_enabled）。
 */

import { NodeContract } from '../contracts/contracts.js';
import { derive_instance_contract } from './instance_contract.js';
import type { SeedEdgeRaw } from '../edge_evidence/seed.js';
import {
  ENGINE_DEFAULT_TOOL_ROUNDS,
  ENGINE_NODE_TYPE_META,
  STATE_PLAN,
  STATE_REVIEW,
  TYPE_LLM_DECIDER,
  TYPE_LLM_MAIN,
  TYPE_LLM_PLANNER,
  TYPE_LLM_REVIEWER,
  TYPE_ROUTER_JUDGE,
  TYPE_ROUTER_PLAN_JUDGE,
  TYPE_TOOL_PIPELINE,
  type NodeFlags,
} from './constants.js';
import { llm_decider_contract } from './llm_decider.js';
import { router_judge_contract } from './router.js';
import { tool_pipeline_contract } from './tool_pipeline.js';

/** 单条引擎基础节点实例种子（实例键 + 缺省 config + 派生契约 + 元数据）。 */
export interface EngineNodeTypeSeed {
  /** 实例类型键（池内唯一；注册/组装按此名引用）。 */
  type: string;
  /** 实例缺省 config（实例行为分化面：output_field/read_fields/routes 等）。 */
  default_config: Record<string, unknown>;
  /** 注册类型契约（实例契约已随 config_defaults 派生；装配面仍幂等再派生）。 */
  contract: NodeContract;
  kind?: string;
  label?: string;
  description?: string;
  flags?: NodeFlags;
  /** 执行体内核名（缺省 = type 自身；可解耦指向共享内核如 engine:llm_decider）。 */
  executor?: string;
}

/** 引擎内置池种子数据（仅节点类型；可整体禁用）。 */
export interface EnginePoolSeed {
  enabled: boolean;
  node_types: readonly EngineNodeTypeSeed[];
}

/** 种子元数据装配（从内置元数据表取 kind/label/description/flags；表外类型不带）。 */
function _meta_seed(
  type: string,
  default_config: Record<string, unknown>,
  contract: NodeContract,
): EngineNodeTypeSeed {
  const meta = ENGINE_NODE_TYPE_META[type];
  if (meta === undefined) return { type, default_config, contract };
  const seed: EngineNodeTypeSeed = {
    type,
    default_config,
    contract,
    kind: meta.kind,
    label: meta.label,
    description: meta.description,
  };
  if (meta.flags !== undefined) seed.flags = { ...meta.flags };
  return seed;
}

/** llm 共享执行体名（executor 绑定 engine:llm_decider）。 */
const EXECUTOR_LLM_DECIDER = TYPE_LLM_DECIDER;

/** 可区分共享内核实例种子（executor 解耦指向共享内核；实例契约随 config 派生）。 */
function _shared_executor_seed(
  type: string,
  executor: string,
  default_config: Record<string, unknown>,
  base_contract: NodeContract,
): EngineNodeTypeSeed {
  const seed = _meta_seed(type, default_config, derive_instance_contract(base_contract, default_config));
  seed.executor = executor;
  return seed;
}

/** 可区分 llm 实例种子（executor 解耦指向 llm_decider 内核）。 */
function _llm_instance_seed(
  type: string,
  default_config: Record<string, unknown>,
  base_contract: NodeContract,
): EngineNodeTypeSeed {
  return _shared_executor_seed(type, EXECUTOR_LLM_DECIDER, default_config, base_contract);
}

/** 出厂引擎内置池种子（每调用返回新鲜数据，防调用方就地改写污染缺省）。
 *
 * 实例行可区分维度（验收口径：契约输出/需求面或用途两两不同）：
 * - llm_decider：终态单节点兜底（输出 reply，无字段需求；flags.terminal）；
 * - llm_planner：输出 plan（需求面空）；llm_reviewer：读 plan 出 review；
 * - llm_main：读 plan+review 出 reply（非终态 flags——需求非空不可单节点兜底）；
 * - tool_pipeline：kind=tool 流水线终态；
 * - router_judge：kind=router 通用路由（route:answer/research）；
 * - router_plan_judge：kind=router 读 plan 判断答复/研究（routes 与用途分化）。
 */
export function default_engine_pool_seed(): EnginePoolSeed {
  return {
    enabled: true,
    node_types: [
      _meta_seed(
        TYPE_LLM_DECIDER,
        { max_tool_rounds: ENGINE_DEFAULT_TOOL_ROUNDS },
        llm_decider_contract(),
      ),
      _llm_instance_seed(
        TYPE_LLM_PLANNER,
        {
          system_prompt: '你是任务规划器：分析会话目标，输出一份结构化执行计划（只输出计划正文，不要多余解释）。',
          output_field: STATE_PLAN,
          max_tool_rounds: ENGINE_DEFAULT_TOOL_ROUNDS,
        },
        llm_decider_contract(),
      ),
      _llm_instance_seed(
        TYPE_LLM_REVIEWER,
        {
          system_prompt: '你是计划评审器：结合会话目标评审已有计划，输出风险与补充意见（只输出评审正文，不要多余解释）。',
          read_fields: [STATE_PLAN],
          output_field: STATE_REVIEW,
          max_tool_rounds: ENGINE_DEFAULT_TOOL_ROUNDS,
        },
        llm_decider_contract(),
      ),
      _llm_instance_seed(
        TYPE_LLM_MAIN,
        {
          system_prompt: '你是主回答器：综合已有计划与评审意见，输出对用户问题的最终答复（只输出答复正文，不要多余解释）。',
          read_fields: [STATE_PLAN, STATE_REVIEW],
          max_tool_rounds: ENGINE_DEFAULT_TOOL_ROUNDS,
        },
        llm_decider_contract(),
      ),
      _meta_seed(TYPE_TOOL_PIPELINE, {}, tool_pipeline_contract()),
      // router_judge 缺省空 routes：候选清单为图/宿主装配实例化时覆写的数据
      // （config_defaults 里的样例只是声明提示，不预置活跃分支防误路由）
      _meta_seed(
        TYPE_ROUTER_JUDGE,
        {
          routes: [
            { key: 'answer', label: '直接回答', description: '目标已明确，直接产出回复' },
            { key: 'research', label: '先研究再回答', description: '目标信息不足，先检索/观察再回复' },
          ],
          prompt: '根据会话目标判断当前应直接回答还是需要先收集信息',
        },
        router_judge_contract(),
      ),
      _shared_executor_seed(
        TYPE_ROUTER_PLAN_JUDGE,
        TYPE_ROUTER_JUDGE,
        {
          routes: [
            { key: 'direct', label: '直接答复', description: '计划已充分，直接产出答复' },
            { key: 'more', label: '进一步研究', description: '计划仍缺信息，需补充研究' },
          ],
          prompt: '读取计划后判断应直接答复还是需进一步研究',
          read_fields: [STATE_PLAN],
        },
        router_judge_contract(),
      ),
    ],
  };
}

/**
 * 出厂边先验（可喂链 feed 关系；与上面实例契约匹配）。装配入口 =
 * runtime 装配（recipe.seed_edges_enabled 开启后经 import_seed_paths 写入
 * edge_evidence store；缺省关闭 = 出厂先验不入证据面，组装行为零漂移）。
 */
export function default_engine_seed_edges(): SeedEdgeRaw[] {
  return [
    {
      src_type: TYPE_LLM_PLANNER,
      dst_type: TYPE_LLM_REVIEWER,
      src_contract_version: '1',
      dst_contract_version: '1',
      context_domain: 'general',
      success_count: 1,
      fail_count: 0,
    },
    {
      src_type: TYPE_LLM_REVIEWER,
      dst_type: TYPE_LLM_MAIN,
      src_contract_version: '1',
      dst_contract_version: '1',
      context_domain: 'general',
      success_count: 1,
      fail_count: 0,
    },
  ];
}
