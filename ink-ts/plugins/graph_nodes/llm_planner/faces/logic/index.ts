/**
 * llm_planner 图节点插件 —— 可区分 LLM 实例（executor = llm_decider 共享内核）。
 * 本 face = 节点注册声明数据（S1-b 声明层形态）；S1-b2 后切换统一工厂。
 */
export default {
  type: 'llm_planner',
  executor: 'llm_decider',
  contract: {
    input_schema: null,
    output_schema: {
      name: 'llm_decider.output',
      fields: [
        { name: 'plan', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
    safety_tier: 0,
    version: 1,
  },
  config_defaults: {
    system_prompt: '你是任务规划器：分析会话目标，输出一份结构化执行计划（只输出计划正文，不要多余解释）。',
    output_field: 'plan',
    max_tool_rounds: 8,
  },
  kind: 'llm',
  label: '计划制定',
  description: '把会话目标拆解为执行计划并写入 plan（供下游评审/主答复消费）',
  flags: {},
} as const;