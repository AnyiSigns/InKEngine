# core/run_result — 运行结果契约与执行选项（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

单次 run 的**配置面**（`RunOptions`：存储/传输/预算/schema/计划/推演/调配
全部注入式，引擎不持有产品实现）与**结果面**（`RunResult`：最终状态 +
终止原因 + 中断点 + 事件统计）两类纯数据契约；引擎执行语义在
`kernel/executor`，本模块只承载形态，供执行语义、引擎重建装配（runtime）、
测试与宿主共用同一形态。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `run_result.ts` | `RunOptions`/`RunResult` 数据契约、`MultipathAssemblySeam` 多径组装上下文 seam 形态、`AssemblySourcesProvider` 装配源提供者协议（`run_result.py` 移植） |

## 对外契约面

目录导出 8 名：

- 类：`RunOptions`（构造器接受 `RunOptionsInit = Partial<RunOptions>`）、
  `RunResult`（构造器接受 `RunResultInit`，`state`/`reason` 必填）。
- 类型：`MultipathAssemblySeam`、`AssemblySourceContext`、
  `AssemblySourcesResult`、`AssemblySourcesProvider`、`RunOptionsInit`、
  `RunResultInit`。

公共面（逐名核对）：`src/index.ts` `export * from
'./core/run_result/run_result.js'`——上述 8 名全部上公共面；
`kernel/executor/index.ts` 另转出 `RunOptions`/`RunResult` 作内核收敛面，
公共面仅直取本目录。

## 数据形态

- `RunOptions`：33 个实例字段，逐项对齐 Python dataclass，实例可变
  （executor 运行时按 Python 语义就地改选分支 `branch_pick`）。分组：
  - DI 注入面（除 `transports` 外默认 null）：`storage`/`schema`/`budget`/
    `registries`/`evaluator`/`branch_mixer`/`assembly`/`assembly_sources`/
    `assembly_aggregator`/`metrics`/`settle`；`transports: EngineTransport[]`
    默认空表。
  - 成本护栏数字：`max_node_retries`=0、`max_spawns`=16、
    `spawn_concurrency`=4、`spawn_max_depth`=2、
    `simulate_max_branch_steps`=16、`max_cycle`=64、`checkpoint_keep`=256、
    `max_plan_steps`=`DEFAULT_MAX_PLAN_STEPS`（32，真源 `core/plan`）、
    `max_simulations`=`DEFAULT_MAX_SIMULATIONS`（8，真源
    `kernel/simulation`）、`parallel_concurrency`=4、
    `simulate_concurrency`=2。
  - 语义开关：`error_on_exception`=true、`plan_policy`='loose'、
    `plan_workflow`=null、`emit_timeline_events`=false、
    `multipath_enabled`=false、`branch_pick`=null、`domain`=null。
  - 内部/协议字段：`spawn_depth`=0（嵌套深度传播，非用户配置）、
    `system_events`（`ReadonlySet<string>`，默认空集——机制层不预置任何
    领域事件名）、`multipath_assembly`=null。
- `RunResult`：`state: Record<string, unknown>`、`reason: string` 必填；
  `checkpoint_id`=null、`interrupt`=null、`events_emitted`=0、`error`=null
  缺省；`to_dict()` 输出六键，`interrupt` 非 null 时经
  `InterruptState.to_dict()` 序列化；executor 收尾阶段原位补记
  `checkpoint_id`/`interrupt`/`events_emitted`/`error`（镜像 Python 可变
  dataclass 行为）。

## Seam 与 IO 边界

纯数据契约，无 IO 执行声明。注入点即 seam 面：`storage`/`transports`/
`budget` 等由宿主装配注入，null = 关闭该面。显式命名 seam
`MultipathAssemblySeam` 三成员（`evidence_store`/`sink`/
`report_cache_execution`）全 null = 零证据/零审计/零缓存回馈；seam 只定
IO 面，不引组装数据形态。`AssemblySourcesProvider` 消费
`AssemblySourceContext` 最小读面（`state`/`node`/`thread_id`）。

## 装配与消费

- 装配层（`kernel/runtime`、`kernel/path_assembler`）按配方构造/覆盖
  `RunOptions`；`kernel/executor` 全链消费（run/execute/base/instance/
  events/trace/node_context）并在收尾补记 `RunResult`；
  `kernel/multipath`、`core/execution_runtime` 持同形态驱动子流程。
- `assembly_sources` 由节点执行器在节点执行前自动调用一次取源并统一
  调配，节点内 assemble 复用预装配结果（不重复装配/不重复留痕）；
  `settle`/`metrics` 于 run 收尾触发；`checkpoint_keep` 作用于链级
  rebase 窗口（编辑重放期间跳过）。
- hosts/lib `recipe.ts` 经公共面以 `run_options?: Partial<RunOptions>`
  覆盖配方默认（引擎唯一执行域选项入口）。

## 不变式与门禁

- core 纯函数纪律：禁 `node:*` 与第三方 import、禁反向依赖 `adapters/`、
  禁宿主词（架构门禁随 vitest 强制）。
- `transports`/`system_events` 逐实例新建（对齐 Python
  `field(default_factory)`），防跨实例串写。
- 本模块不定义语义枚举/协议词表（字段为类型引用 + 数字护栏），不触
  「第二套语义枚举」约束。

## 测试

镜像测试：`test/core/run_result/run_result.test.ts`。覆盖点：默认构造
31 字段逐项对位（含 32/8 两常量值断言）、`transports`/`system_events`
逐实例隔离、关键字式覆盖（DI 注入 + 数字护栏）、`branch_pick` 原位改选
还原、`RunResult` 必填/缺省、`to_dict` 两态（无中断点/挂起卡含
`InterruptState` 四键）、收尾原位补记后序列化一致。

## 疑点与不一致

1. 模块 docstring 自述「只依赖其他 core 契约模块」，实际 import 跨 core
   与 kernel 两层（`kernel/budget`/`interrupt`/`simulation`/`tuning`/
   `settle`）；与 AGENTS.md「core/、kernel/ 同属机制语义与数据面纯逻辑」
   不冲突，但措辞与实际路径不符（已核 15 条 import 行）。
2. `RunResult.reason` 为裸 `string`，本模块未引用 `core/graph`
   `TerminateReason`（REPLY/STOP/BUDGET_EXCEEDED/ERROR/CANCELLED）；
   对位测试另用 `'completed'`/`'interrupt'` 等值。reason 值域约束未见
   显式说明。
3. 公共面单数 `AssemblySourceProvider`（`kernel/runtime/_types.ts` 定义）
   与本目录复数 `AssemblySourcesProvider` 是两个不同类型；kernel/runtime
   自身文档已将单数列为孤儿面，实际消费方为本目录复数。
4. 默认值测试未断言 `multipath_enabled`/`multipath_assembly` 两字段；
   构造经 `Object.assign(this, init)` 合并，显式传 `undefined` 的键会
   覆盖类字段默认值（「缺省 = 默认值」仅对未提供的键成立），测试未见
   覆盖该行为。
