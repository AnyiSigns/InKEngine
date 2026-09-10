# core/nodes — 引擎内置基础节点类型区（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

引擎给多宿主用：基础可执行节点类型由引擎 core 内置注册，宿主只给数据——
数据图/池种子按类型名引用即解析执行（类型名是不透明字符串，注册表不解释
含义）。本目录承载执行体内核（llm_decider/tool_pipeline/router_judge/agent）、
P4.2a-3 可区分实例（实例键独立 + executor 解耦 + 实例契约随 config 派生）、
注册面、出厂池种子与边先验、运行时 seam 盒与声明式常量。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `constants.ts` | 类型名/`NODE_KIND_*` 六类/条件边名/状态通道键/护栏常量；`ENGINE_NODE_TYPE_META` 元数据表（9 条）；`clamp_tool_rounds`/`route_condition_name`/`NodeFlags`/`EngineNodeTypeMeta` |
| `field_io.ts` | `output_field`/`read_fields` 归一（`parse_output_field_key`/`config_read_fields`）、保留键写护栏（`is_reserved_output_key`/`LLM_OUTPUT_RESERVED_KEYS`）、落点解析（`llm_output_key`）、只读投影（`build_read_projection`）；纯函数 |
| `instance_contract.ts` | `derive_instance_contract(base, config)`：产出面把 reply 替换为 `output_field`（已含目标键 = 不变）、需求面并入 `read_fields`（`SchemaField` required string）；零分化 = 原契约原样返回（零漂移）；保留键经 `parse_output_field_key` 同一护栏拒绝 |
| `llm_system.ts` | `compose_llm_system(boot, custom)`：双非空 = `boot + '\n\n' + custom`，boot 恒前；无 import 纯函数（口径决议 16） |
| `llm_decider.ts` | 执行体：恢复消息链 → `llm.astream` 流式（`reply_token`/`thinking_start`/`thinking_end` 逐帧）→ 工具调用经 `seams.tool_pipeline` 逐条执行（审批 `terminate` 决议走 `TerminateReason.STOP`）→ `tool` 消息回灌，直至无调用或 `max_tool_rounds`（超限抛错）；无模型/流水线 = `ENGINE_STUB_REPLY` 确定性 stub；`llm_decider_contract`/`make_llm_decider_factory` |
| `tool_pipeline.ts` | 执行体三形态：`role=terminal` 空收口 / `config.tool` 命名工具（参数 = `state.step_args` 同名项或 `config.args`，结果写 `state.results[tool]`）/ 缺省消费 `state.pending` 首项（结果以 tool 消息回灌 `messages`、剩余回写 `pending`）；`tool_pipeline_contract`/`make_tool_pipeline_factory` |
| `router.ts` | 执行体：单次无工具 LLM 判断（候选清单 + 只输出 key 指令），`_match_key` 严格匹配（围栏/引号/反引号剥离 + 逐行兜底，不猜测）写 `STATE_ROUTE_TO`；无候选/无模型 = 空走向、未命中显式写空串清陈旧决议；`router_judge_contract`/`make_router_judge_factory` |
| `agent.ts` | 执行体：`entity_id` 解析（目录 seam 缺失/实体未注册 = 显式失败）→ 作用域 llm 决议（实体 model 非 null 须经 `resolve_scope_llm`，解析失败不静默沿用父模型）→ `_build_agent_scope_graph` 单结点子回路经 `ctx.run_agent_scope` 同步展开、结果回流并入父状态；`agent_scope_contract`（输入输出 schema 均 null）/`make_agent_factory` |
| `pool_seed.ts` | `default_engine_pool_seed`：7 条可区分实例（llm_decider 终态兜底、planner 出 plan、reviewer 读 plan 出 review、main 读 plan+review 出 reply、tool_pipeline、router_judge、router_plan_judge），llm 实例 executor 解耦、契约随 `config_defaults` 经 `derive_instance_contract` 派生；`default_engine_seed_edges`：planner→reviewer→main 两条 `SeedEdgeRaw`（装配入口 `recipe.seed_edges_enabled`，缺省关闭） |
| `register.ts` | 注册面（见「装配与消费」）+ `_ENGINE_EXECUTORS` 四内核构建器表 + `llm.pending_*`/`route:<key>` 条件边判定；`EngineNodeSeams` 转出 |
| `seams.ts` | `EngineNodeSeams` 七成员 seam 声明、`empty_engine_node_seams` 确定性缺省、seams 盒 `_EngineNodeSeamsBox`（模块级 `WeakMap<NodeTypeRegistry, box>`）+ `_seams_box_for`/`_bind_engine_node_seams` |
| `index.ts` | 目录公开面：49 值名 + 3 类型转出（field_io 8、instance_contract 1、constants 28、register 9+1、agent 1、pool_seed 2+2） |

## 对外契约面

公共面逐名核对（`src/index.ts` 从 `./core/nodes/index.js` 收敛，39 值 + 3 类型 = 42 名）：

- 值：`CFG_OUTPUT_FIELD` `CFG_READ_FIELDS` `COND_LLM_FINISHED` `COND_LLM_PENDING` `COND_ROUTE_PREFIX` `ENGINE_DEFAULT_TOOL_ROUNDS` `ENGINE_STUB_REPLY` `ROLE_TERMINAL` `STATE_MESSAGES` `STATE_PENDING` `STATE_PLAN` `STATE_REPLY` `STATE_RESULTS` `STATE_REVIEW` `STATE_ROUND_MODEL` `STATE_ROUND_POSE` `STATE_ROUTE_TO` `STATE_STEP_ARGS` `STATE_TOOL_ROUNDS` `TYPE_LLM_DECIDER` `TYPE_LLM_MAIN` `TYPE_LLM_PLANNER` `TYPE_LLM_REVIEWER` `TYPE_ROUTER_JUDGE` `TYPE_ROUTER_PLAN_JUDGE` `TYPE_TOOL_PIPELINE` `bind_engine_node_seams` `build_read_projection` `config_read_fields` `default_engine_pool_seed` `default_engine_seed_edges` `derive_instance_contract` `has_engine_executor` `is_reserved_output_key` `parse_output_field_key` `register_engine_node_types` `register_route_edge_condition` `register_route_edge_conditions` `route_condition_name`。
- 类型：`EngineNodeSeams` `EngineNodeTypeSeed` `EnginePoolSeed`。

目录 index 转出而公共面未收的 10 名：`LLM_OUTPUT_RESERVED_KEYS` `llm_output_key`（field_io）、`STATE_DISPLAY_MESSAGES` `STATE_DISPLAY_SEQ` `TYPE_AGENT`（constants）、`has_engine_node_type` `register_agent_node_type` `register_engine_edge_conditions` `register_engine_node_type`（register）、`agent_scope_contract`（agent）——kernel/runtime 经目录 index 直取其中 `register_engine_node_type`/`register_engine_edge_conditions`。

## 数据形态

- 类型名：`TYPE_LLM_DECIDER`/`TYPE_TOOL_PIPELINE`/`TYPE_ROUTER_JUDGE` + 实例键 `TYPE_LLM_PLANNER`/`TYPE_LLM_REVIEWER`/`TYPE_LLM_MAIN`/`TYPE_ROUTER_PLAN_JUDGE` + `TYPE_AGENT`。
- kind 六类 `NODE_KIND_LLM/TOOL/ROUTER/ENTRY/END/AGENT`（元数据表实际使用 llm/tool/router/agent 四类）；`NodeFlags`（terminal/loop，仅 true 语义有效）。
- 条件边名：`COND_LLM_PENDING`='llm.pending_nonempty'、`COND_LLM_FINISHED`='llm.pending_empty'、`COND_ROUTE_PREFIX`='route:'（`route_condition_name(key)` 组装）。
- 状态通道键：`STATE_MESSAGES`/`STATE_DISPLAY_MESSAGES`/`STATE_DISPLAY_SEQ`/`STATE_PENDING`/`STATE_REPLY`/`STATE_PLAN`/`STATE_REVIEW`/`STATE_TOOL_ROUNDS`/`STATE_RESULTS`/`STATE_STEP_ARGS`/`STATE_ROUTE_TO`（'_route_to'）/`STATE_ROUND_MODEL`/`STATE_ROUND_POSE`。
- 护栏：`ENGINE_DEFAULT_TOOL_ROUNDS`=8、`clamp_tool_rounds`（域 1..200，非法 = 缺省 8）、`ROLE_TERMINAL`='terminal'、`ENGINE_STUB_REPLY`。
- field_io 协议键：`CFG_OUTPUT_FIELD`='output_field'、`CFG_READ_FIELDS`='read_fields'；保留键 = `_` 前缀 + `LLM_OUTPUT_RESERVED_KEYS` 五结构性键（messages/pending/tool_rounds/display_messages/display_seq）。
- 池种子：`EnginePoolSeed{enabled, node_types}`、`EngineNodeTypeSeed{type, default_config, contract, kind?, label?, description?, flags?, executor?}`；边先验 `SeedEdgeRaw`（契约版本 '1'、`context_domain` 'general'、success_count 1/fail_count 0）。
- 四契约：`llm_decider_contract`（输出 reply required string）、`tool_pipeline_contract`（输出 messages optional array）、`router_judge_contract`（输出 `_route_to` optional string）、`agent_scope_contract`（输入输出均 null）；均 `safety_tier` 0、`version` 1。

## Seam 与 IO 边界

seam 声明与注入点 = `EngineNodeSeams` 七成员：`llm`（`AsyncLLM | null`）、
`tool_pipeline`、`tool_specs`/`all_tool_specs`、`collect_specs`（线程化工具表
读取器，空 = 回落 `tool_specs`）、`boot_system_prompt`（装配注入只读基线，
缺省 ''）、`resolve_entity`/`resolve_scope_llm`（agent 展开）。绑定机制：
注册时 `_seams_box_for` 按 `NodeTypeRegistry` 建/取盒（模块级 `WeakMap`），
工厂闭包持盒、节点执行时现取盒内当前值；引擎重建处 `bind_engine_node_seams`
刷新——装配期注册一次、seams 随重建刷新（registry 生命周期契约：工厂不捕获
装配期快照）。IO 边界：执行体对模型/工具的调用一律经 seams（`llm.astream`/
`pipeline.execute`），core 不持有厂商适配、不 import adapters/boot；boot
提示词文本由装配注入，core 只持 seam 字符串；`empty_engine_node_seams` =
无模型/无流水线确定性缺省。

## 装配与消费

- 注册面（`register.ts`，全部幂等跳过已登记）：`register_engine_node_types`（种子声明登记 + 回环条件边；未知 executor 声明跳过）、`register_engine_node_type`（单类型：type_name 实例键 + executor 内核名缺省同名——声明式登记恢复）、`register_agent_node_type`（agent 入口，缺省契约 `agent_scope_contract`）、`register_engine_edge_conditions`、`register_route_edge_condition(s)`（key 空/含 ':' 抛 `GraphDefinitionError`）、`has_engine_executor`/`has_engine_node_type`（恢复解析前提）。
- 装配点：`kernel/runtime`（`_runtime_assemble` 取出厂池种子、`_runtime_engine` 重建时 `bind_engine_node_seams`、`_runtime_node_registry` 声明式登记恢复 + `derive_instance_contract`、`_runtime_mechanisms` 出厂边先验、`_runtime_rounds` 常量消费）；`core/execution_runtime/engine_turn_runner`（回合引擎：注册 + 绑定 + 池种子 + `_build_agent_scope_graph`）；`kernel/tool_pipeline` 读 `STATE_ROUND_POSE`。
- 实例解耦语义：实例键（`seed.type`）与执行体内核（`seed.executor`）独立；P4.2a-3 四实例分别指向 llm_decider 内核（三 llm）与 `TYPE_ROUTER_JUDGE`（router_plan_judge），分化落在 config（`output_field`/`read_fields`/routes）与实例契约。

## 不变式与门禁

- 执行体只能来自池：内部回路引用的 scope 类型须已注册，agent 不在运行时引入任意代码（`agent.ts` 模块契约）。
- 诚实失败语义（不猜测）：agent 缺 seam/缺实体/model 解析失败显式抛错；router 无候选/无模型空走向、未命中写空串；llm_decider 仅无模型/无流水线落 stub。
- 写护栏：`output_field` 保留键拒绝（实例契约派生与执行面同一 `parse_output_field_key`护栏）；`read_fields` 投影只进提示、不进持久化消息链。
- 契约派生零漂移：无分化 config = 原契约原样返回；派生是运行时视图，不在契约 schema 数据面新增硬字段（契约序列化形态不变）。
- boot 基线恒前：`compose_llm_system` 保证 persona 不绕过 boot 只读基线（llm_decider/router_judge/agent scope 结点同口径）。
- core 纪律：禁 `node:*`/第三方 import、禁宿主词；注册表拒绝重复登记 → 注册面幂等跳过。

## 测试

镜像测试 `test/core/nodes/`（13 文件）：`engine_nodes`（注册面 + 数据图直接执行 llm_decider→terminal）、`llm_decider`（思考事件/每轮推理覆盖/system 合成）、`llm_field_exec`（`output_field` 落点/`read_fields` 投影）、`llm_system`（合成规则）、`router`（执行/system 合成/契约声明）、`router_chain`（多结点路由链 + route 族注册面）、`conditional_edge_branch`（route:<key> 与 llm.pending_* 多目标 conditional）、`field_io`（归一/护栏/投影）、`instance_contract`（零漂移/产出面/需求面/护栏幂等）、`pool_seed_instances`（可区分实例清单/边先验）、`engine_type_metadata`（kind 六类/元数据表/种子携带元数据）、`agent_node`（注册面/最小递归展开/作用域 llm 接线/诚实失败）、`nodes_cold_start`（Runtime boot 池种子注册 + 冷启动组装）。

## 疑点与不一致

1. `ENGINE_NODE_TYPE_META` 9 条与出厂池种子 7 条不同步：`agent` 条目有独立登记入口（`register_agent_node_type`），`vision_perceive` 条目的执行体与注册在 `core/perception`（`VISION_PERCEIVE_TYPE`，独立入口）——二条均不入 `default_engine_pool_seed.node_types`；元数据表与池种子的对应口径未见显式说明。
2. `has_engine_node_type`（register.ts「旧语义兼容」转接，直通 `has_engine_executor`）：全 engine grep 仅定义 + 目录 index 转出两处命中，无 src/测试/宿主消费方。
3. `tool_pipeline.ts` 尾部 `export type { ToolPipeline, ToolSpec }`：目录 index 未转出、全仓无经此路径的 import（孤儿转出）。
4. 公共面未收 `register_engine_node_type`（单类型）、`register_engine_edge_conditions`、`register_agent_node_type`，而 kernel/runtime 经目录 index 消费前二者、第三者 src 内仅测试消费（agent_node.test.ts）——公共面收窄口径未见显式说明。
5. `_build_agent_scope_graph`（`_` 前缀命名却导出）被 `core/execution_runtime/engine_turn_runner.ts` 跨目录 import（行 25/96）；`NODE_KIND_ENTRY`/`NODE_KIND_END` 仅测试断言消费，元数据表/注册面未使用。
