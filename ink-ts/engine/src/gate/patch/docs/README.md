# patch（kernel/patch）

内容型补丁链 Event Sourcing 原语：状态 = base + append-only 补丁链，取用 = `assemble`（纯函数）、压缩 = `rebase`、编辑重放 = `truncate` + `branch`；另含消息压缩链构造器与机制契约声明。

## 文件
- `patchChain.ts` — `PatchChain` 链本体（append/replace/delete 重放、`assemble` 三模式、`rebase`/`branch`/`truncate`、`to_dict`/`from_dict` 序列化、`version` 单调计数 + `on_change` 失效钩子）与 `buildMessageCompressPatches` 消息压缩链构造；目录内数据类型经本文件 re-export 出公共面
- `types.ts` — 域数据形态：`Path`/`Patch`/`PatchOp`/`AssembleMode` 与协议常量 `PATCH_OP_VALUES`/`ASSEMBLE_MODE_VALUES`；re-export `core/json` 的 `Json`/`JsonRecord` 与 patchChain 的 `PatchChainSerialized`
- `contract.ts` — 机制契约声明 `patch_contract`（id=`patch`，effects=[]，depends=[]）

## 依赖
- 上游（本目录实际 import）：
  - `core/json.ts`（`Json`/`JsonRecord` 类型，经 types.ts）
  - `kernel/registry/contract_types.ts`（`MechanismContract` 类型，经 contract.ts）
  - 目录内：patchChain.ts ← types.ts（`Json`/`Patch`/`PatchOp`/`Path`/`ASSEMBLE_MODE_VALUES`）
- 下游（实际 import 本目录）：
  - core：`storage/storage_records.ts`、`state/schema.ts`、`state/reducers.ts`、`security/security.ts`、`harness/repository.ts`（`PatchChain`/`Patch`）、`knowledge_set/`（4 文件，`PatchChain`/`Path`）
  - kernel：`registry/contracts.ts`（`patch_contract` 入 34 项全量契约清单）、`simulation/simulation.ts`、`self_application/set_patch_chain.ts`、`self_application/apply_flow.ts`、`evolution_writer/evolution_writer.ts`
  - hosts 侧无直接 import（经 `@ink-ts/engine` 公共面 `export * from './kernel/patch/patchChain.js'`，`src/index.ts:108`）
