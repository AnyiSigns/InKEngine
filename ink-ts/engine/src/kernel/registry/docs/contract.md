# kernel/registry — 机制件注册表与密封（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

机制件装配闭集的注册表与密封器：机制件不是插件（插件走 CapabilityComponent），
机制件走独立 `MechanismContract` 契约（每机制一份 `kernel/<mechanism>/contract.ts`，
id = 目录名）。本目录提供契约类型、机制端口词表（effects/depends 命名空间单一
事实源）、依赖图校验与拓扑装配序——boot 组密封与 verify:mechanisms 三键校验
共用同一实现。纯函数目录，无 IO、无 seam 消费。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `index.ts` | 公共面收敛者（类型 + 端口常量 + 密封函数 + 全量契约清单） |
| `contract_types.ts` | `MechanismContract`/`MechanismRegistryOptions`/`SealedMechanismRegistry` 契约类型 |
| `ports.ts` | 机制端口 id 规范常量（`PORT_*` + `MECHANISM_PORT_IDS`） |
| `registry.ts` | `validate_mechanism_registry`/`find_cycles`/`seal_mechanism_registry`/`topo_order` |
| `contracts.ts` | `ALL_MECHANISM_CONTRACTS` 单一真源聚合（31 项，只 re-export 不加边；path_assembler/pool_governance/thread_skeleton 契约已随组装链路退役删除，W7-B） |

注：任务口径中的 registry `contract.ts` 实际不存在——机制契约 `contract.ts` 落在
各机制件目录（31 份），本目录只有契约类型 `contract_types.ts` 与聚合
`contracts.ts`。

## 对外契约面

- 类型：`MechanismContract`（`id` 全局唯一与目录同名；`contract.inputs?/outputs?`
  可选 + `contract.effects` 端口白名单；`depends` 依赖 id 清单形成 DAG；可选
  `inject` 注入工厂）、`MechanismRegistryOptions`（`effectAllowlist`/`externalDeps`
  外部名单）、`SealedMechanismRegistry`（契约表 + 拓扑序）、`RegistryViolation`
  （rule ∈ duplicate-id/unknown-dep/self-dep/cycle）。
- 函数：`validate_mechanism_registry`（纯函数校验，返回违规清单，空 = 通过）、
  `find_cycles`（Tarjan 强连通分量，结点数 >1 的成员为环）、
  `seal_mechanism_registry`（违规即抛错 fail-closed，通过返回契约表 + 拓扑装配
  序；密封后不可变）、`topo_order`（被依赖者先）。
- 端口词表：`PORT_STORAGE_SEAM`='storage_seam'（存储 seam：审计/补丁链/记录等
  受守卫落库端口）、`PORT_LLM_PORT`='llm_port'（模型推理 seam）、
  `PORT_EXEC_ENVELOPE`='exec_envelope'（子进程/沙箱执行端口）、
  `PORT_ROUNDS`='rounds.port'（回合端口：组装回合/恢复/审批重入，插件 depends
  可依赖）、`MECHANISM_PORT_IDS`（以上 4 项清单）。
- 全量契约：`ALL_MECHANISM_CONTRACTS`（31 项，id 与目录同集）。
- 公共面导出情况：本目录导出面**不在** `src/index.ts` 公共面（该文件无任何
  `kernel/registry` re-export 行）——属引擎内部面。消费方 = engine src 内部 +
  `engine/scripts/verify_mechanisms.ts` + `plugins/scripts/verify_unload.ts`
  （取 `ports.ts` 词表，注释自述为唯一跨进引擎内部的例外）+ 镜像测试。

## 数据形态

- 契约形状：`{ id, contract: { inputs?, outputs?, effects: readonly string[] },
  depends: readonly string[], inject? }`；effects 语义 = 0-IO 白名单，只允许
  引用已声明端口；端口 id 与依赖 id 共用同一命名空间，registry 经 external
  名单放行注册表外 id。
- 违规规则四种：`duplicate-id`（契约 id 重复）、`unknown-dep`（依赖未登记且
  不在外部名单）、`self-dep`（自环）、`cycle`（循环依赖；只报真实环成员，
  被环阻塞的下游不误报）；违规非空时短路返回（不进环检测）。
- 密封产物：`{ contracts: ReadonlyMap<string, MechanismContract>, order:
  readonly string[] }`。

## Seam 与 IO 边界

纯函数，无 IO 声明：`registry.ts` 全部为纯函数（Tarjan/拓扑/校验）；`ports.ts`
与 `contract_types.ts` 为常量与类型；`contracts.ts` 只做值面 re-export（无副
作用 import）。本目录不消费任何端口、不持有状态、不触 IO。

## 装配与消费

- 装配：`kernel/runtime/_runtime_boot.ts` `_assemble` 首步调
  `seal_mechanism_registry(ALL_MECHANISM_CONTRACTS)`（boot 静态门禁；依赖单向/
  装配完整/循环拒绝，失败即抛错，半装配或带环的运行时不得进入装配流程）；
  密封纯静态（契约 const + Tarjan/topo），零 IO 零副作用。
- verify：`engine/scripts/verify_mechanisms.ts`（verify:mechanisms 三键）取
  `ALL_MECHANISM_CONTRACTS`/`MECHANISM_PORT_IDS`/`topo_order`/
  `validate_mechanism_registry` + `runtime_contract`——依赖单向（密封）、装配
  完整（runtime depends 闭包 ∪ 自足叶子 = 全量）、0-IO。
- 契约声明侧：31 个机制件 `contract.ts` 经 `contract_types.js` 取
  `MechanismContract` 类型；其中 13 个（audit_log/executor/growth/llm/
  evolution_writer/multipath/recovery/runtime/
  settle/self_application/skill_crystal/sandbox/builder）另取 `ports.js` 端口
  常量入 effects。
- 插件侧：`plugins/scripts/verify_unload.ts` 以 `MECHANISM_PORT_IDS` 为插件
  depends/contract.effects 词表真源（悬空/成环/未登记 = 违规 fail-closed）。
- 错误语义：密封失败抛 `机制注册表密封失败: [rule] message; …`；测试断言含
  `/循环依赖|密封失败/`。

## 不变式与门禁

- 机制三键之「依赖单向 DAG」在本目录实现并被 boot 首步强制：id 唯一、depends
  在册（或外部名单放行）、无自环、无循环、fail-closed。
- 契约单一真源：契约数量/成员变动只改 `contracts.ts` 一处（根 AGENTS「数字先
  核实」纪律的落点）；本文件只 re-export 不新增机制间依赖边；对外仍以
  `registry/index.ts` 为汇出口。
- 全量集不变式（镜像测试强制）：契约 id 全局唯一且数量 = 31；每机制 effects
  只引用 `MECHANISM_PORT_IDS` 内端口；全量依赖图无环（组装时代 executor↔
  path_assembler 历史环随机制退役消失）。
- gate：5 文件均远小于 350 行上限；kernel 层禁 node:*/第三方 import（本目录
  无任何外部依赖）。

## 测试

`test/kernel/registry/` 镜像测试（2 文件）：
- `registry.test.ts` — 样板契约（audit_log）通过校验进装配序；重复 id/未知
  依赖（外部名单放行 `rounds.port`）/自环/循环拒绝（seal 抛错）；拓扑序 =
  被依赖者先。
- `contracts_registry.test.ts` — 全量 31 机制契约：id 全局唯一且与目录同集、
  effects 只引用已登记端口、全量依赖图无环、`runtime_contract.depends` 全部
  有契约（装配闭集完整）。

## 疑点与不一致

以下为通读逐条核实的事实，不推测动机：

- `MechanismRegistryOptions`（`effectAllowlist`/`externalDeps`）全仓零消费（仅定义与转出）：`validate_mechanism_registry`/`seal_mechanism_registry` 直接收 `externalDeps: readonly string[]` 数组参数，不经选项对象；其注释描述的「effects 白名单校验」在 registry.ts 未实现——effects ⊆ `MECHANISM_PORT_IDS` 的校验实际落在 `scripts/verify_mechanisms.ts` 与镜像测试。
- `MechanismContract.inject?` 注释「boot 密封时调用一次，宿主装配期注入端口实现」：`seal_mechanism_registry` 只校验并返回契约表/拓扑序，不调用 inject；31 份 contract.ts 无一定义 inject；全仓无 `.inject(` 调用点（interrupt/executor 测试中的 `inject` 属 InterruptCoordinator，另一机制）——该声明契约无执行路径。
- `MechanismContract.contract.inputs?/outputs?` 可选字段：31 份 contract.ts 无一定义使用（仅 audit_log 注释提及「声明期不固化」）——形状声明面未见消费。
- `find_cycles` 具名导出无外部消费方（仅 `validate_mechanism_registry` 内部使用；镜像测试与 verify 脚本均未 import）。
- `topo_order` 对含环契约集按 Kahn 算法静默省略环成员及其下游（不报错）；自环同样不入环检测（单结点 SCC 不记）——防环完全依赖调用方先走 `validate_mechanism_registry`/`seal_mechanism_registry`，函数本身无环守卫。
- `PORT_ROUNDS` 常量无直接 import 方（仅经 `MECHANISM_PORT_IDS` 间接消费）；`registry.test.ts` 的外部名单示例用字面量 `'rounds.port'` 而未引用该常量。
