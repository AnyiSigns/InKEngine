/**
 * router_judge 图节点插件 —— LLM 路由判断节点（写 _route_to 走向决议）。
 * 本 face = 节点注册声明数据（S1-b 声明层形态）；S1-b2 后切换统一工厂。
 */
export default {
  type: 'router_judge',
  executor: 'router_judge',
  contract: {
    input_schema: null,
    output_schema: {
      name: 'router_judge.output',
      fields: [
        { name: '_route_to', required: false, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
    safety_tier: 0,
    version: 1,
  },
  config_defaults: {
    routes: [
      { key: 'answer', label: '直接回答', description: '目标已明确，直接产出回复' },
      { key: 'research', label: '先研究再回答', description: '目标信息不足，先检索/观察再回复' },
    ],
    prompt: '根据会话目标判断当前应直接回答还是需要先收集信息',
  },
  kind: 'router',
  label: '路由判断',
  description: 'LLM 从候选目标中选一个走向（模糊/复杂判断，占一个执行步骤）',
  flags: {},
} as const;