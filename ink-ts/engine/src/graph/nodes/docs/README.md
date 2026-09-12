# nodes（core/nodes）

引擎内置基础节点类型区：四个执行体内核（`llm_decider`/`tool_pipeline`/
`router_judge`/`agent`）+ P4.2a-3 可区分实例（`llm_planner`/`llm_reviewer`/
`llm_main`/`router_plan_judge`）+ 注册面/池种子/实例契约派生/seam 绑定/
声明式常量——数据图按类型名引用即解析执行。

## 文件
- `constants.ts` — 类型名/kind 六类/条件边名/状态通道键/护栏常量、内置类型元数据表 `ENGINE_NODE_TYPE_META`、`clamp_tool_rounds`/`route_condition_name`。
- `field_io.ts` — llm 内核 config 字段 I/O 约定：`output_field`/`read_fields` 归一、保留键写护栏、只读文本投影（纯函数）。
- `instance_contract.ts` — `derive_instance_contract`：实例契约随 config 派生（产出面/需求面分化，零漂移）。
- `llm_system.ts` — `compose_llm_system`：boot 基线 + 自定义 system_prompt 合成（纯函数，无 import）。
- `llm_decider.ts` — llm_decider 执行体：单节点模型流式 + 工具回合闭环、契约、工厂。
- `tool_pipeline.ts` — tool_pipeline 执行体：terminal/命名工具/pending 消费三形态、契约、工厂。
- `router.ts` — router_judge 执行体：单次无工具 LLM 判断写 `_route_to`、契约、工厂。
- `agent.ts` — agent 执行体：entity_id 解析 → 作用域 llm 决议 → 子回路构造展开、契约、工厂。
- `pool_seed.ts` — `default_engine_pool_seed`（7 条可区分实例种子）+ `default_engine_seed_edges`（出厂边先验 2 条）。
- `register.ts` — 注册面（`register_engine_node_types` 等，幂等）+ `_ENGINE_EXECUTORS` 四内核构建器表 + 回环/route 条件边判定。
- `seams.ts` — `EngineNodeSeams` 运行时 seam 声明 + seams 盒（`WeakMap` 持盒、`bind_engine_node_seams` 刷新）。
- `index.ts` — 目录公开面（49 值名 + 3 类型转出）。

## 依赖
- 上游（本目录实际 import）：`core/`（contracts、schema、graph、entities、edge_evidence/seed、errors、registry、registry_types）+ `kernel/llm`（messages、base、`_guard_types`、tools）+ `kernel/tool_pipeline`（llm/tool 类型面与消息原语，无 IO 实现 import）。
- 下游（实际 import 本目录）：`src/index.ts`（公共面 42 名）；`kernel/runtime`（`_runtime_boot`/`_runtime_engine`/`_runtime_mechanisms`/`_runtime_node_registry`/`_types`；`_runtime_rounds` 消费已随组装链路退役删除，W7-B）；`kernel/tool_pipeline`（`STATE_ROUND_POSE`）；`core/execution_runtime`（`engine_turn_runner`）；hosts/lib `bridge/rounds.ts` 经公共面取 `STATE_*`；测试 `test/core/nodes/`（13 文件）。
