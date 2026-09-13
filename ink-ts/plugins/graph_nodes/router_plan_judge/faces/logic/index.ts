/**
 * router_plan_judge 图节点插件 —— 可区分 router 实例（executor = router_judge
 * 共享内核；读 plan 分岔 direct/more）。
 * 本 face = 节点注册声明数据（S1-b 声明层形态）；S1-b2 后切换统一工厂。
 */
export default {
  type: 'router_plan_judge',
  executor: 'router_judge',
  contract: {
    input_schema: {
      name: 'instance.input',
      fields: [
        { name: 'plan', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
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
      { key: 'direct', label: '直接答复', description: '计划已充分，直接产出答复' },
      { key: 'more', label: '进一步研究', description: '计划仍缺信息，需补充研究' },
    ],
    prompt: '读取计划后判断应直接答复还是需进一步研究',
    read_fields: ['plan'],
  },
  kind: 'router',
  label: '计划后路由',
  description: '读取 plan 判断直接答复还是需补充研究（读面=plan；route 走向分岔）',
  flags: {},
} as const;