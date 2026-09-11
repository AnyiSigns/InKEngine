# state（core/state）

状态通道机制：reducer 族（对齐补丁链心智模型）+ 状态 schema（通道定义表与合并入口）+ 子图/spawn 回流增量。

## 文件
- `reducers.ts` — reducer 函数族与注册表：`add_messages`（累积型）/`merge_dicts`/`merge_metrics`（合并型）/`patch_chain_reducer`（内容型）/`last_value`（覆盖型）、`REDUCER_REGISTRY`、`ADDITIVE_REDUCERS`/`MERGE_REDUCERS` 族集合、`register_reducer`/`is_additive_reducer`/`is_merge_reducer`/`get_reducer`。
- `schema.ts` — `Channel`/`ChannelSpec` 通道定义、`StateSchema`（通道表 + `apply` 合并 + `to_dict`/`from_dict`）、`stateEquals`、子图回流增量 `subgraph_overlay_delta`、spawn 回流 `subgraph_flowback_overlay`。

## 依赖
- 上游（本目录实际 import）：`core/errors.ts`（`GraphDefinitionError`）、`core/json.ts`（`deepCopy`/`deepEqual`/`isRecord`/`stableStringify`/`Json`/`typeName`）、`kernel/patch/patchChain.ts`（`PatchChain`）、`kernel/patch/types.ts`（`Patch`，仅 reducers）；目录内 `schema.ts` → `reducers.ts`。
- 下游（实际 import 本目录）：`src/index.ts`（公共面 `export *` 两文件）、`kernel/executor`（run_subgraph/_engine_spawn/_engine_simulate/_internals/_engine_plan/_engine_instance）、`kernel/spawn`、`kernel/recovery`、`kernel/multipath`、`core/run_result`、`core/harness`、`core/link_validator`（`kernel/path_assembler` 4 文件消费已随组装链路退役删除，W7-B）；hosts 无相对 import，经公共面消费。
