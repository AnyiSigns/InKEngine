# graph（model/graph）

图定义 DSL 机制件：图实例结构、声明式节点绑定、边注册与编译校验；可序列化数据形态与指纹计算（core/graph.py 移植）。

## 文件
- `graph.ts` — `Graph` 主类：节点/边/出口/子图注册（`add_node`/`add_node_type`/`add_edge`/`add_conditional_edge`/`add_conditional_edge_by_name`/`add_loop_edge`/`add_exit`/`add_subgraph`）、声明式解析（`resolve_types`/`resolve_conditions`）、序列化与指纹入口（`to_dict`/`from_dict`/`digest`）、编译校验 `compile()`；`CompiledGraph` 编译产物。
- `graph_types.ts` — 类型面：执行/条件 seam（`NodeFn`/`EdgeCondition`/`NodeContextLike`）、`Edge`/`EdgeKind`（standard/conditional/loop）、`NodeBinding`、`TerminateReason` 终止原因枚举、注册表 seam（`NodeTypeRegistryLike`/`EdgeConditionRegistryLike`）、`SchemaSerializable`、纯哈希 `fnv1a64Hex`。
- `graph_serialize.ts` — 序列化与指纹纯辅助：`graphToDict`/`loadGraphFromDict`/`graphDigest`（稳定键序 JSON、FNV-1a 64 hex）。

## 依赖
- 上游（本目录实际 import）：`model/contracts/contracts.ts`（`NodeContract`）、`model/errors.ts`（`EngineError`/`GraphDefinitionError`/`NodeNotFoundError`）、`model/json.ts`（`deepCopy`/`isRecord`/`typeName`）；目录内 `graph.ts` ↔ `graph_serialize.ts` 互引（`loadGraphFromDict` 以 Graph 构造器注入打破循环）。
- 下游（实际 import 本目录）：`src/index.ts`（公共面 `export *`）、`graph/executor`（执行器全域文件）、`kernel/spawn`、`kernel/simulation`、`loop/turn_settle`、`evolve/observe/inspection`、`evolve/legacy/self_proposal`、`kernel/multipath`、`loop/runtime`、`model/workflow`、`model/plan`、`core/harness`、`graph/nodes`（agent/llm_decider 等；`kernel/path_assembler`、`core/fingerprint` 消费已随组装链路退役删除，W7-B）；hosts 无相对 import，经 `@ink-ts/engine` 公共面消费。
