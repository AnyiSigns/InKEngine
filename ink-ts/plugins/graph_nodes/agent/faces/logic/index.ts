/**
 * agent 图节点插件 —— kind=agent 实体收敛执行体（config 引用 entity_id，展开
 * 内部子回路；注册表登记只装执行体，实体绑定在图形 binding config）。
 * 本 face = 节点注册声明数据（S1-b 声明层形态）；S1-b2 后切换统一工厂。
 */
export default {
  type: 'agent',
  executor: 'agent',
  contract: {
    input_schema: null,
    output_schema: null,
    safety_tier: 0,
    version: 1,
  },
  config_defaults: {},
  kind: 'agent',
  label: '实体协作者',
  description: '按 entity_id 展开实体子回路（persona 引导 + per-scope model），产出并入父状态',
  flags: {},
} as const;