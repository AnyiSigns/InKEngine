/**
 * llm_reviewer 图节点插件 —— 可区分 LLM 实例（executor = llm_decider 共享内核）。
 * 本 face = 节点注册声明数据（S1-b 声明层形态）；S1-b2 后切换统一工厂。
 */
export default {
  type: 'llm_reviewer',
  executor: 'llm_decider',
  contract: {
    input_schema: {
      name: 'instance.input',
      fields: [
        { name: 'plan', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
    output_schema: {
      name: 'llm_decider.output',
      fields: [
        { name: 'review', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
    safety_tier: 0,
    version: 1,
  },
  config_defaults: {
    system_prompt: '你是计划评审器：结合会话目标评审已有计划，输出风险与补充意见（只输出评审正文，不要多余解释）。',
    read_fields: ['plan'],
    output_field: 'review',
    max_tool_rounds: 8,
  },
  kind: 'llm',
  label: '计划评审',
  description: '读取 plan 产出评审意见写入 review（读面=plan）',
  flags: {},
} as const;