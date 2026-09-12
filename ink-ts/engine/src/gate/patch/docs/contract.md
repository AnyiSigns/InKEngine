# kernel/patch — 内容型补丁链原语（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

kernel 机制件层的最底层纯内存原语：Event Sourcing 补丁链（状态 = base + append-only 补丁链，取用 = 组装、压缩 = rebase、编辑重放 = truncate + branch）。被 core 数据面多模块（state/security/storage_records/knowledge_set/harness）与 kernel 多个机制件（simulation/self_application/evolution_writer）依赖；自身不依赖任何机制件、不消费任何副作用端口。`contract.ts` 头注：「链的受守卫落库由宿主经 GuardedStorage 接线在演化资产写盘通道上，本机制自身不直接消费存储 seam」。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `patchChain.ts` | `PatchChain` 类（`apply`/`apply_many`/`truncate` 变更、`assemble(mode,start,end)` 组装、`rebase`/`branch` 派生、`to_dict`/`from_dict` 序列化、私有 `#version` 计数 + `on_change` 钩子）；`buildMessageCompressPatches(messages,cutoff,summary)` 消息压缩链构造；内部辅助 `deepCopy`/`resolve`/`setValue`/`applyOne`/`toStrish` 等 |
| `types.ts` | 数据形态 `Path`/`Patch`/`PatchOp`/`AssembleMode`、协议常量 `PATCH_OP_VALUES`/`ASSEMBLE_MODE_VALUES`；re-export `core/json` 的 `Json`/`JsonRecord` |
| `contract.ts` | 机制契约 `patch_contract: MechanismContract`（见对外契约面） |

## 对外契约面

- 公共面（`src/index.ts:108`）：`export * from './kernel/patch/patchChain.js'` → `PatchChain`、`buildMessageCompressPatches`、`PatchChainSerialized`，及 patchChain re-export 的类型 `Json`/`Patch`/`PatchOp`/`Path`/`AssembleMode`。
- 仅直连 `types.ts` 可达（不经公共面）：`PATCH_OP_VALUES`、`ASSEMBLE_MODE_VALUES`、`JsonRecord`（`patchContract.test.ts` 即直连 import `PATCH_OP_VALUES`）。
- 机制端口契约：`patch_contract = { id: 'patch', contract: { effects: [] }, depends: [] }`——零副作用端口、零机制间依赖；经 `kernel/registry/contracts.ts:67` 收入 `ALL_MECHANISM_CONTRACTS`（34 项全量契约清单）。

## 数据形态

- `Patch = { op: PatchOp; path: Path; value?: Json }`；`PATCH_OP_VALUES = ['append','replace','delete']`，与 `fixtures/patch_protocol.fixture.json` 的 `patch_ops`、`schemas/patch_protocol.schema.json` 的 enum 由测试钉住（单一数据源）。
- `Path = readonly (string | number)[]`：dict 段 string、list 段 number。
- `ASSEMBLE_MODE_VALUES = ['full','base_only','partial']`：组装模式（全量 / 仅 base / 区间 [start,end)）。
- `PatchChainSerialized = { base: Record<string,Json>; patches: {op; path; value}[] }`：链持久化格式（`value` 必填，`Patch.value` 可选——见疑点 5）。
- 链内可变面：`base`（构造时深拷贝）、`patches`（append-only）、私有 `#version`（`apply`/`apply_many`/`truncate` 各 +1；`rebase`/`branch` 产物为新链、version 从 0 起）；`on_change?: () => void` 观察方失效信号。

## Seam 与 IO 边界

纯函数目录，无 IO 声明：`patch_contract.contract.effects = []`，不消费 storage_seam 等任何机制端口；全部运算为纯内存数据结构（`assemble` 从深拷贝 base 出发重放补丁，不改链）。链的持久化在宿主侧经 GuardedStorage 演化资产写盘通道完成（见定位）。无时钟/id 依赖。

## 装配与消费

- 契约装配：`kernel/registry/contracts.ts` 将 `patch_contract` 收入全量机制契约清单（机制三键校验的输入之一）。
- 值面消费（实际 import）：core 侧 `storage/storage_records.ts`、`state/schema.ts`、`state/reducers.ts`、`security/security.ts`、`harness/repository.ts`、`knowledge_set/`（4 文件）；kernel 侧 `simulation/simulation.ts`、`self_application/set_patch_chain.ts`、`self_application/apply_flow.ts`、`evolution_writer/evolution_writer.ts`。依赖方向为 core → kernel/patch（`core/state/docs/contract.md` 已注明该机制依赖仍为零 IO 纯逻辑）。hosts 侧无直接 import。
- 错误语义：append 目标非 list/str → `TypeError`（组装重放期）；`buildMessageCompressPatches` cutoff 越界（须 1..N）→ `RangeError`；`truncate(keep<0)` → `RangeError`；delete 路径缺失静默成功（幂等）；`on_change` 异常吞掉不阻断链演化；`from_dict` 容忍多余字段；路径中段/叶子父级非容器 → `TypeError`。

## 不变式与门禁

- 机制三键：依赖单向 DAG——`depends: []`，无机制间依赖；runtime depends 闭包——patch 为其它机制复用的自足叶子，自身无再入依赖；零自持 IO——effects=[]，纯内存成立。
- gate 规则（core/kernel 禁 `node:*`/第三方/宿主词）：三文件仅相对 import 与类型定义，无宿主词命中。
- 目录形态差异：`engine/AGENTS.md` 所述机制件形态「contract.ts + impl.ts + *.test.ts」在本目录未按 impl.ts/同目录测试落位（实现即 `patchChain.ts`，测试在 `test/kernel/patch/`）——见疑点 7。

## 测试

`test/kernel/patch/` 镜像测试三文件：

- `patchChain.test.ts` — append/replace/delete 基元（自动创建容器、列表越界补 null、delete 缺键幂等、非容器 append 报错）；assemble 三模式与纯函数性；rebase/truncate/branch（共享前缀互不影响）；to_dict/from_dict 往返与深拷贝隔离；version 单调、on_change 每次变更触发且异常不阻断、branch/rebase 产物 version 从 0 起。
- `patchCompress.test.ts` — 消息压缩链：组装结果 = 摘要 + 保留段；delete 从后向前即删除证据；cutoff=1/全长/越界抛错；rebase 压扁后链长收敛且组装不变；序列化往返。
- `patchContract.test.ts` — `PATCH_OP_VALUES` ↔ fixture `patch_ops` ↔ schema enum 三方一致（单一数据源门禁）。

## 疑点与不一致

1. `AssembleMode` 同名类型在 `types.ts:19` 与 `patchChain.ts:17` 各导出一份（均由同一常量 `ASSEMBLE_MODE_VALUES` 派生、结构等价），未见单一出处说明。
2. `apply`/`apply_many` 将外部 patch 对象按引用存入 `this.patches`（不深拷贝）；构造函数与 `to_dict`/`from_dict` 才深拷贝。文件头注「补丁 value 一律深拷贝入产物/分支」覆盖的是组装产物/分支面，未覆盖链内存储：入链后原地修改补丁 `value`（对象时）会改动链内补丁。
3. `toStrish`（append→string 路径）以 falsy 判空：`value` 为 `0`/`false` 时拼接为空串；未见显式说明。
4. `buildMessageCompressPatches` 在 src 与 hosts 内均无消费方（仅 `patchCompress.test.ts` 使用），同时在公共面导出——孤儿导出，目录内未见其装配/调用点。
5. `Patch.value` 可选，而序列化形态 `PatchChainSerialized.patches[].value: Json` 必填；`to_dict` 对 value 为 undefined 的补丁产出 undefined 值字段，两者落差未见显式说明。
6. types.ts ↔ patchChain.ts 相互 import（patchChain 值依赖 `ASSEMBLE_MODE_VALUES`；types 仅类型 re-export `PatchChainSerialized`）——类型侧擦除后运行期无环，但模块图上为相互引用。
7. `engine/AGENTS.md` 描述机制件目录形态为「contract.ts + impl.ts + *.test.ts」，本目录实际为 contract.ts + types.ts + patchChain.ts，无 impl.ts、无同目录测试。
