# registry/（kernel/registry）

机制件注册表：机制契约类型 + 装配密封（boot 静态门禁）——
对 `kernel/<mechanism>/contract.ts` 全量契约集做依赖图校验（单向/完整/循环拒绝，
fail-closed）并给出拓扑装配序。纯函数目录，无 IO。端口词表真源见
`engine/src/dock/ports.ts`。

## 文件
- `index.ts` — 公共面收敛者：契约类型 + 密封函数 + 全量契约清单。
- `contract_types.ts` — `MechanismContract`/`MechanismRegistryOptions`/`SealedMechanismRegistry` 契约类型面（机制件装配闭集的声明单元）。
- `registry.ts` — 密封与校验：`validate_mechanism_registry`（违规清单）、`find_cycles`（Tarjan SCC 环检测）、`seal_mechanism_registry`（违规抛错 fail-closed）、`topo_order`（被依赖者先装配）。
- `contracts.ts` — `ALL_MECHANISM_CONTRACTS` 单一真源聚合：31 项契约 re-export（只值面 import，无副作用；不新增机制间依赖边；path_assembler/pool_governance/thread_skeleton 契约已随组装链路退役删除，W7-B）。

## 依赖
- 上游（本目录实际 import）：仅类型 `contract_types`（registry.ts/contracts.ts）；31 个机制件目录的 `contract.ts` 契约常量（approval/audit_log/budget/builder/entity_evolution/evolution/evolution_writer/executor/growth/interrupt/introspection/knowledge_gate/llm/memory_extract/multipath/patch/permissions/recovery/round_steps/runtime/sandbox/self_application/self_proposal/self_tools/settle/simulation/skill_crystal/spawn/tool_pipeline/tool_vetting/tuning）。
- 下游（实际 import 本目录）：`kernel/runtime/_runtime_boot.ts`（`ALL_MECHANISM_CONTRACTS` + `seal_mechanism_registry` boot 首步密封）；全部 31 个机制件 `contract.ts`（type import `MechanismContract`；其中 13 个另取端口常量，经 `engine/src/dock/ports.ts`）；`engine/scripts/verify_mechanisms.ts`（verify:mechanisms 三键，端口词表经 `engine/src/dock/ports.ts`）；`plugins/scripts/verify_unload.ts`（`MECHANISM_PORT_IDS`，唯一跨进引擎内部取端口词表，经 `engine/src/dock/ports.ts`）；测试 `test/kernel/registry/`（registry.test、contracts_registry.test）；公共面 `src/index.ts` 未导出本目录（内部面）。
