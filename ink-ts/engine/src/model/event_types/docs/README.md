# event_types（core/event_types）

事件类型注册表与声明族：事件信封是机制（外层字段稳定），事件类型是数据（AI 可演化）——声明式 `EventTypeSpec`、发射判定、配额门禁、随集持久化 seam。

## 文件
- `eventTypeSpec.ts` — 数据形态：`EventTypeSpec`（name/schema/renderer/system/meta，`to_dict`/`from_dict`）、判定结果 `EventVerdict`（status/violations/fold）、常量（状态/配额/附件/集合前缀）。
- `registryTypes.ts` — 最小接口 `EventTypeRegistryLike`（specs 注册辅助依赖，避免与 registry 循环）。
- `registry.ts` — `EventTypeRegistry`：注册/枚举/重复与配额门禁、`classify` 发射判定、`system_events` 合成、`load`/`save` 随集持久化（读写 seam 注入）。
- `eventTypeSpecs.ts` — 声明族：附件/审计（3 类）/时间线（2 类）规格函数与 `register_*` 注册辅助（组装候选/指纹顶替/组装审计等声明族已随组装链路退役删除，W7-B）。

## 依赖
- 上游（本目录实际 import）：`core/errors.ts`（`GraphDefinitionError`）、`core/json.ts`（`isRecord`）、`core/schema/schemaValidator.ts`（`SchemaSpec`/`SchemaValidator`/`SchemaField`/`FIELD_NUMBER`/`FIELD_STRING`）；目录内 specs → spec/registryTypes，registry → spec/registryTypes。
- 下游（实际 import 本目录）：`src/index.ts`（公共面）、`kernel/runtime`（装配注册表）、`kernel/settle`（review/promotion 审计常量）、`kernel/multipath`、`kernel/self_proposal`、`adapters/boot`、`core/edge_evidence`（`kernel/path_assembler`、`core/fingerprint_cache`、`hosts/lib/src/bridge/path.ts` 消费已随组装链路退役删除，W7-B）。
