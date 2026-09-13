/**
 * llm_decider 图节点插件 —— graph_node kind（S1-b 节点族插件化）声明真源。
 *
 * 本 face = **节点注册声明数据**（S1-b 声明层形态）：默认导出 = 图节点注册
 * 清单行（type/executor/contract/config_defaults/flags）。宿主装配经
 * plugins/manifest.json graph_nodes[] 派生视图取用（生成器聚合 spec.data.node），
 * 经引擎节点执行体装配槽（register_node_builder，S1-a）建节点。
 *
 * S1-b2（节点实现物理迁移）后本文件默认导出切换为**统一工厂**
 * （(init?: unknown) => 节点工厂，S0 faces.logic 契约），执行体随插件同住，
 * engine 不再自带出厂内核槽。
 */
/** 节点注册声明（executor = 执行内核名；spec.data.node 的镜像数据，结构对齐
 *  引擎侧 NodeContract 数据面；装配时由引擎按契约解析）。 */
export default {
  type: 'llm_decider',
  executor: 'llm_decider',
  contract: {
    input_schema: null,
    output_schema: {
      name: 'llm_decider.output',
      fields: [
        { name: 'reply', required: true, kind: 'string', enum: [], min: null, max: null, pattern: null },
      ],
    },
    safety_tier: 0,
    version: 1,
  },
  config_defaults: { max_tool_rounds: 8 },
  kind: 'llm',
  label: 'LLM 决策',
  description: '单节点内完成模型流式 + 工具回合',
  flags: { terminal: true },
} as const;