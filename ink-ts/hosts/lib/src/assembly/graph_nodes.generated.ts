// gate: test-exempt - 生成物（verify:plugin-manifest --check 逐字比对守一致性；spec 侧同住测试 graph_nodes/*/faces/logic/index.test.ts 覆盖声明镜像）
/**
 * 生成文件勿手改：图节点注册清单派生视图（真源 = plugins/graph_nodes/<id>/spec.json
 * 的 data.node：type/executor/kind/label/description/flags/config_defaults/contract）。
 * 由 plugins/scripts/sync_plugin_manifest.mjs 生成；hosts/lib 出厂装配据此清单经
 * 引擎节点执行体装配槽（register_node_builder，S1-a）建节点（S1-b2 装配通道）。
 * 移出引擎后执行体内核名集合 = 装配槽注册档；verify:plugin-manifest 强制逐字一致。
 */

/** 图节点注册声明（spec.data.node 镜像；executor = 共享执行体内核名）。 */
export interface GraphNodeDecl {
  type: string;
  executor: string;
  kind: string | null;
  label: string | null;
  description: string | null;
  flags: { terminal?: boolean; loop?: boolean } | null;
  config_defaults: Record<string, unknown>;
  contract: { input_schema: unknown; output_schema: unknown; safety_tier: number; version: number } | null;
}

export const GRAPH_NODE_DECLS: readonly GraphNodeDecl[] = [
  {"type":"agent","executor":"agent","kind":"agent","label":"实体协作者","description":"按 entity_id 展开实体子回路（persona 引导 + per-scope model），产出并入父状态","flags":{},"config_defaults":{},"contract":{"input_schema":null,"output_schema":null,"safety_tier":0,"version":1}},
  {"type":"llm_decider","executor":"llm_decider","kind":"llm","label":"LLM 决策","description":"单节点内完成模型流式 + 工具回合","flags":{"terminal":true},"config_defaults":{"max_tool_rounds":8},"contract":{"input_schema":null,"output_schema":{"name":"llm_decider.output","fields":[{"name":"reply","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"safety_tier":0,"version":1}},
  {"type":"llm_main","executor":"llm_decider","kind":"llm","label":"综合答复","description":"读取 plan+review 综合产出最终 reply（读面=plan+review）","flags":{},"config_defaults":{"system_prompt":"你是主回答器：综合已有计划与评审意见，输出对用户问题的最终答复（只输出答复正文，不要多余解释）。","read_fields":["plan","review"],"max_tool_rounds":8},"contract":{"input_schema":{"name":"instance.input","fields":[{"name":"plan","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null},{"name":"review","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"output_schema":{"name":"llm_decider.output","fields":[{"name":"reply","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"safety_tier":0,"version":1}},
  {"type":"llm_planner","executor":"llm_decider","kind":"llm","label":"计划制定","description":"把会话目标拆解为执行计划并写入 plan（供下游评审/主答复消费）","flags":{},"config_defaults":{"system_prompt":"你是任务规划器：分析会话目标，输出一份结构化执行计划（只输出计划正文，不要多余解释）。","output_field":"plan","max_tool_rounds":8},"contract":{"input_schema":null,"output_schema":{"name":"llm_decider.output","fields":[{"name":"plan","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"safety_tier":0,"version":1}},
  {"type":"llm_reviewer","executor":"llm_decider","kind":"llm","label":"计划评审","description":"读取 plan 产出评审意见写入 review（读面=plan）","flags":{},"config_defaults":{"system_prompt":"你是计划评审器：结合会话目标评审已有计划，输出风险与补充意见（只输出评审正文，不要多余解释）。","read_fields":["plan"],"output_field":"review","max_tool_rounds":8},"contract":{"input_schema":{"name":"instance.input","fields":[{"name":"plan","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"output_schema":{"name":"llm_decider.output","fields":[{"name":"review","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"safety_tier":0,"version":1}},
  {"type":"router_judge","executor":"router_judge","kind":"router","label":"路由判断","description":"LLM 从候选目标中选一个走向（模糊/复杂判断，占一个执行步骤）","flags":{},"config_defaults":{"routes":[{"key":"answer","label":"直接回答","description":"目标已明确，直接产出回复"},{"key":"research","label":"先研究再回答","description":"目标信息不足，先检索/观察再回复"}],"prompt":"根据会话目标判断当前应直接回答还是需要先收集信息"},"contract":{"input_schema":null,"output_schema":{"name":"router_judge.output","fields":[{"name":"_route_to","required":false,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"safety_tier":0,"version":1}},
  {"type":"router_plan_judge","executor":"router_judge","kind":"router","label":"计划后路由","description":"读取 plan 判断直接答复还是需补充研究（读面=plan；route 走向分岔）","flags":{},"config_defaults":{"routes":[{"key":"direct","label":"直接答复","description":"计划已充分，直接产出答复"},{"key":"more","label":"进一步研究","description":"计划仍缺信息，需补充研究"}],"prompt":"读取计划后判断应直接答复还是需进一步研究","read_fields":["plan"]},"contract":{"input_schema":{"name":"instance.input","fields":[{"name":"plan","required":true,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"output_schema":{"name":"router_judge.output","fields":[{"name":"_route_to","required":false,"kind":"string","enum":[],"min":null,"max":null,"pattern":null}]},"safety_tier":0,"version":1}},
  {"type":"tool_pipeline","executor":"tool_pipeline","kind":"tool","label":"工具流水线","description":"消费 state.pending 工具清单；role=terminal 为终态","flags":{},"config_defaults":{},"contract":{"input_schema":null,"output_schema":{"name":"tool_pipeline.output","fields":[{"name":"messages","required":false,"kind":"array","enum":[],"min":null,"max":null,"pattern":null}]},"safety_tier":0,"version":1}},
];

/** 清单声明的引擎执行体内核名集合（装配槽注册档；S1-b2 装配层用途）。 */
export function graphNodeKernels(): readonly string[] {
  return [...new Set(GRAPH_NODE_DECLS.map((d) => d.executor))].sort();
}
