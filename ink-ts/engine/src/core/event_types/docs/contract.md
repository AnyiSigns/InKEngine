# core/event_types — 事件类型注册与声明（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

事件类型是数据（AI 可演化），随补丁链版本化/回退；注册表是增强不是收紧——未注册宽松允许 + 折叠兜底，schema 违规仅宽松标记不阻断。声明只含类型（schema/renderer/system/meta），事件本身由使用方在对应时机产出。持久化经 seams（records 读取 + 写入器）表达，写入走宿主注入的通道（evolution_writer seam 就绪前以最小写接口承接，见 `registry.ts` 头注释）。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `eventTypeSpec.ts` | `EventTypeSpec` 数据形态与往返、`EventVerdict` 判定结果、状态/配额/附件/集合前缀常量。 |
| `registryTypes.ts` | `EventTypeRegistryLike` 最小接口（打破 specs ↔ registry 循环）。 |
| `registry.ts` | `EventTypeRegistry`：register/unregister/get/names/specs、classify、system_events、load/save。 |
| `eventTypeSpecs.ts` | 声明族规格函数（附件/审计/组装候选/时间线）+ `register_*` 注册辅助。 |

## 对外契约面

- 目录导出：`EventTypeSpec`/`EventVerdict`；常量 `EVENT_STATUS_REGISTERED`/`EVENT_STATUS_UNKNOWN`/`DEFAULT_MAX_EVENT_TYPES = 200`/`DEFAULT_ATTACHMENT_EVENT_NAME = 'attachment'`/`DEFAULT_ATTACHMENT_RENDERER = 'AttachmentRow'`/`EVENT_TYPES_COLLECTION_PREFIX = 'event_types:'`/`event_types_collection`/`COLLECTION_EVENT_TYPES`；`EventTypeRegistryLike`；`EventTypeRecordsStore`/`EventTypeSpecWriter`/`EventTypeRegistryOptions`/`EventTypeRegistry`；事件名常量与规格/注册函数。
- 公共面：`export * from registry.js` + `export * from eventTypeSpec.js`；`eventTypeSpecs.js` 仅具名导出事件名常量（`EVENT_AUDIT_ASSEMBLY`/`EVENT_ASSEMBLY_CANDIDATE`/`EVENT_AUDIT_JUNCTION`/`EVENT_AUDIT_FINGERPRINT_REPLACE`/`EVENT_AUDIT_POLICY_REVIEW`/`EVENT_AUDIT_PROMOTION`/`EVENT_TURN_STARTED`/`EVENT_ASSEMBLY_STARTED`/`EVENT_ASSEMBLY_DONE`/`EVENT_EXECUTION_STARTED`）与规格函数（`attachment_event_spec`/`audit_event_specs`/`assembly_candidate_event_spec`/`output_gate_event_specs`）；`register_*` 注册函数族不随公共面外泄（装配期内部动作，宿主经 `EventTypeRegistry` + 规格函数显式装配）。`EventTypeRegistryLike` 经 `registry.ts` re-export 间接上公共面。

## 数据形态

- `EventTypeSpec{name, schema: SchemaSpec|null, renderer: string(空 = 折叠), system: boolean, meta}`；`to_dict` 只输出非缺省字段（name/system 恒在）。
- `EventVerdict{status, violations, fold}`：未注册 → `EVENT_STATUS_UNKNOWN` + fold=true；已注册 → `EVENT_STATUS_REGISTERED` + schema 违规列表（宽松标记）+ fold = !renderer。
- 集合前缀：按集集合 `event_types:<set_id>`（set_id 缺省 `'-'`）；load 读取顺序：按集集合 → 历史集合 `event_types`（`COLLECTION_EVENT_TYPES`）。
- 事件名常量：审计族 5（assembly_audit/junction_verdict_audit/fingerprint_replace_audit/policy_edge_review_audit/recommended_prior_promotion）+ 组装候选 assembly_candidate + 时间线 4（turn_started/assembly_started/assembly_done/execution_started）。

## Seam 与 IO 边界

- 持久化 seam：`EventTypeRecordsStore.list_records(collection): Promise<Record[]>`（读）与 `EventTypeSpecWriter.write(collection, name, data): Promise<void>`（写），构造期注入；无存储/写器 = load/save 静默跳过。
- `on_skip` 观察 seam：load 期 duplicate/malformed/quota 跳过回调（缺省静默，不阻断启动）。
- 除 load/save 两个异步 seam 入口外为同步纯逻辑；本目录无 IO 实现。

## 装配与消费

- `kernel/runtime`（_runtime_assemble/_runtime_base/_runtime_engine/_types）装配 `EventTypeRegistry` 并持 `EventTypeSpec` 形态；`adapters/boot` 以 `EventTypeSpec` 建 boot 种子。
- 审计常量消费：`kernel/settle`（review/promotion）、`kernel/multipath`（junction 审计）、`kernel/path_assembler`（assembly_candidate/assembly_audit）、`core/fingerprint_cache`（fingerprint_replace_audit）、`core/edge_evidence`（policy_edge_review_audit）；`hosts/lib/src/bridge/path.ts` 经公共面取 assembly_candidate/assembly_audit。
- `kernel/self_proposal/proposal_validator.ts` 以 `EventTypeSpec` 校验提案声明。
- 错误语义：重复注册/配额超限/未注册注销 → `GraphDefinitionError`；load 脏记录跳过（on_skip 留痕）不阻断启动；classify 不抛错（宽松语义）。

## 不变式与门禁

- 注册是门禁：重复与配额（`max_types`，缺省 200）在 register 期显式拒绝；load 与 register 配额口径一致（超配额不入册）。
- 折叠兜底：未注册事件折叠展示、无 renderer 事件折叠展示——注册表缺失不破坏事件流。
- core 纯函数纪律：零框架/零 `node:*`/零宿主词/JSON 进 JSON 出；禁反向依赖 adapters。
- 架构门禁（`vitest run --root engine` 随跑）：core 目录 import 白名单与宿主词扫描。

## 测试

`test/core/event_types/eventTypes.test.ts` 镜像一件：Spec 往返/极简声明/非法声明拒绝、注册门禁（按注册序/重复拒绝/配额参数化/未注册注销拒绝）、classify（未注册宽松折叠/schema 通过/schema 违规宽松标记/renderer 缺失折叠/system_events 合成）、随集持久化 seam（save→load 往返/脏记录跳过/超配额 on_skip/畸形上报/无存储静默）、审计事件注册（5 类可往返/重复拒绝/负载按 schema 校验）。

## 疑点与不一致

- `EventTypeRegistry.classify` 与 `EventVerdict` 在 src 内无调用方（grep 全 src：两者仅 registry.ts/eventTypeSpec.ts 自身与镜像测试出现）——发射判定能力当前无生产侧接线，发射侧如何取用 verdict 未见显式说明。
- `system_events()` 经目录内装配恒为空集：`system: true` 在全 src 无生产者（grep 核对），声明族四个规格函数产出的 spec 均非 system（`attachment_event_spec` 显式 `system: false`，其余缺省 false）——该分支成立路径仅测试可手工构造。
- `DEFAULT_ATTACHMENT_EVENT_NAME`/`DEFAULT_ATTACHMENT_RENDERER` 在 src 内无引用：`attachment_event_spec` 以同值字面量作参数缺省（`'attachment'`/`'AttachmentRow'`），常量与默认值重复定义、未互相引用。
- 命名与用途词不一致：`output_gate_event_specs`/`register_output_gate_event_types` 产出的四个规格 `meta.purpose` 均为 `'timeline'`；`assembly_candidate_event_spec` 的 purpose 亦为 `'audit'`——函数名、常量名与 purpose 词三套表述并存，对应关系未见显式说明。
- `registry.ts` 头注释「写入走宿主注入的补丁链守卫通道（evolution_writer seam 就绪前以最小写接口承接）」：`EventTypeSpecWriter` 接口无任何补丁链/守卫形态，该过渡表述与接口现状的对接关系未见显式说明。
- load/save 集合不对称：`load` 读取 `[<按集集合>, 'event_types'（历史集合 `COLLECTION_EVENT_TYPES`）]`，`save` 只写按集集合——历史集合条目只读、无迁移写回逻辑，两集合同名条目靠 load 期 `duplicate` 跳过去重。
- 事件名常量（eventTypeSpecs.ts 手写声明族）与 AGENTS「枚举/注册表一律经 contracts generated、禁第二套语义枚举」的口径关系未见显式说明——声明族自述为「AI 可演化数据」，与 schemas/fixtures 真源的对接面未见。
- `EventVerdict.status` 为裸 `string`，与 `EVENT_STATUS_REGISTERED`/`EVENT_STATUS_UNKNOWN` 两常量无类型绑定（构造器接受任意字符串）。
