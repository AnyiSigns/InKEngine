/**
 * llm_main 图节点插件 —— 可区分 LLM 实例（executor = llm_decider 共享内核）。
 * 本 face = 节点注册声明数据（S1-b 声明层形态）；S1-b2 后切换统一工厂。
 */
export default {
  type: 'llm_main',
  executor: 'llm_decider',
  contract: {
    input_schema: {
      name: 'instance.input',
      fields: [
        { name: 'plan', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
        { name: 'review', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
    output_schema: {
      name: 'llm_decider.output',
      fields: [
        { name: 'reply', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
    safety_tier: 0,
    version: 1,
  },
  config_defaults: {
    system_prompt: '你是主回答器：综合已有计划与评审意见，输出对用户问题的最终答复（只输出答复正文，不要多余解释）。',
    read_fields: ['plan', 'review'],
    max_tool_rounds: 8,
  },
  kind: 'llm',
  label: '综合答复',
  description: '读取 plan+review 综合产出最终 reply（读面=plan+review）',
  flags: {},
} as const;