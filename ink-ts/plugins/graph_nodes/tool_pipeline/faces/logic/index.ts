/**
 * tool_pipeline 图节点插件 —— 工具执行流水线节点（消费 state.pending 清单）。
 * 本 face = 节点注册声明数据（S1-b 声明层形态）；S1-b2 后切换统一工厂。
 */
export default {
  type: 'tool_pipeline',
  executor: 'tool_pipeline',
  contract: {
    input_schema: null,
    output_schema: {
      name: 'tool_pipeline.output',
      fields: [
        { name: 'messages', required: false, kind: 'array', enum: [], min: null, max: null, pattern: null },
      ],
    },
    safety_tier: 0,
    version: 1,
  },
  config_defaults: {},
  kind: 'tool',
  label: '工具流水线',
  description: '消费 state.pending 工具清单；role=terminal 为终态',
  flags: {},
} as const;