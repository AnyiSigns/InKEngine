# state（core/state）

状态通道机制：reducer 族（对齐补丁链心智模型）+ 状态 schema（通道定义表与合并入口）+ 子图回流增量。

## 文件
- `reducers.ts` — reducer 函数族与注册表：`add_messages`（累积型）/`merge_dicts`/`merge_metrics`（合并型）/`patch_chain_reducer`（内容型）/`last_value`（覆盖型）、`REDUCER_REGISTRY`、`ADDITIVE_REDUCERS`/`MERGE_REDUCERS` 族集合、`register_reducer`/`is_additive_reducer`/`is_merge_reducer`/`get_reducer`。
- `schema.ts` — `Channel`/`ChannelSpec` 通道定义、`StateSchema`（通道表 + `apply` 合并 + `to_dict`/`from_dict`）、`stateEquals`、子图回流增量 `subgraph_overlay_delta`、回流 overlay `subgraph_flowback_overlay`（spawn/模拟回流的消费侧已随 P8+S1 展开段退役，原语保留供子图/实例链使用）。

## 依赖
- 上游（本目录实际 import）：`model/errors.ts`（`GraphDefinitionError`）、`model/json.ts`（`deepCopy`/`deepEqual`/`isRecord`/`stableStringify`/`Json`/`typeName`）、`gate/patch/patchChain.ts`（`PatchChain`）、`gate/patch/types.ts`（`Patch`，仅 reducers）；目录内 `schema.ts` → `reducers.ts`。
- 下游（实际 import 本目录）：`dock/index.ts`（公共面 `export *` 两文件，经 `src/index.ts` 转发收口）、`graph/executor`（run_subgraph/_internals/_engine_instance；`_engine_spawn`/`_engine_simulate`/`_engine_plan` 消费已随 P8+S1 展开段退役删除）、`loop/recovery`、`gate/link_validator`、`core/run_result`、`core/harness`（`kernel/path_assembler`、`kernel/spawn`、`kernel/multipath` 消费已随组装链路与展开段退役删除，W7-B/P8+S1）；hosts 无相对 import，经公共面消费。
