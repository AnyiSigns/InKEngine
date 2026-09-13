# core/run_result — 运行结果契约与执行选项（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

单次 run 的**配置面**（`RunOptions`：存储/传输/预算/schema/护栏/注册表全部
注入式，引擎不持有产品实现）与**结果面**（`RunResult`：最终状态 +
终止原因 + 中断点 + 事件统计）两类纯数据契约；引擎执行语义在
`graph/executor`，本模块只承载形态，供执行语义、引擎重建装配（runtime）、
测试与宿主共用同一形态。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `run_result.ts` | `RunOptions`/`RunResult` 数据契约（`run_result.py` 移植；`MultipathAssemblySeam`/`AssemblySourcesProvider` 多径装配面已随 P8+S1 展开段退役删除） |

## 对外契约面

目录导出 4 名：

- 类：`RunOptions`（构造器接受 `RunOptionsInit = Partial<RunOptions>`）、
  `RunResult`（构造器接受 `RunResultInit`，`state`/`reason` 必填）。
- 类型：`RunOptionsInit`、`RunResultInit`。

公共面（逐名核对）：`dock/index.ts` `export * from
'../core/run_result/run_result.js'`（`src/index.ts` 只转发 dock）——上述
4 名全部上公共面；`graph/executor/index.ts` 另转出 `RunOptions`/`RunResult`
作内核收敛面，公共面仅直取本目录。

## 数据形态

- `RunOptions`：17 个实例字段，逐项对齐 Python dataclass（推演/多径/计划相关
  字段 `max_spawns`/`spawn_concurrency`/`simulate_max_branch_steps`/
  `max_plan_steps`/`plan_policy`/`plan_workflow`/`evaluator`/`branch_mixer`/
  `max_simulations`/`simulate_concurrency`/`multipath_enabled`/`branch_pick`
  已随 P8+S1 展开段退役删除），实例可变。分组：
  - DI 注入面（除 `transports` 外默认 null）：`storage`/`schema`/`budget`/
    `registries`/`metrics`/`settle`；`transports: EngineTransport[]`
    默认空表。
  - 成本护栏数字：`max_node_retries`=0、`spawn_max_depth`=2、
    `max_cycle`=64、`checkpoint_keep`=256、`parallel_concurrency`=4。
  - 语义开关：`error_on_exception`=true、`emit_timeline_events`=false、
    `domain`=null。
  - 内部/协议字段：`spawn_depth`=0（嵌套深度传播，非用户配置）、
    `system_events`（`ReadonlySet<string>`，默认空集——机制层不预置任何
    领域事件名）。
- `RunResult`：`state: Record<string, unknown>`、`reason: string` 必填；
  `checkpoint_id`=null、`interrupt`=null、`events_emitted`=0、`error`=null
  缺省；`to_dict()` 输出六键，`interrupt` 非 null 时经
  `InterruptState.to_dict()` 序列化；executor 收尾阶段原位补记
  `checkpoint_id`/`interrupt`/`events_emitted`/`error`（镜像 Python 可变
  dataclass 行为）。

## Seam 与 IO 边界

纯数据契约，无 IO 执行声明。注入点即 seam 面：`storage`/`transports`/
`budget` 等由宿主装配注入，null = 关闭该面。多径组装 seam
（`MultipathAssemblySeam` 三成员与 `AssemblySourcesProvider` 协议）已随
P8+S1 展开段退役删除，本模块不再声明额外 seam。

## 装配与消费

- 装配层（`loop/runtime`；`kernel/path_assembler` 已随组装链路退役，W7-B）按配方构造/覆盖
  `RunOptions`；`graph/executor` 全链消费（run/execute/base/instance/
  events/trace/node_context）并在收尾补记 `RunResult`；
  `loop/execution_runtime` 持同形态驱动回合子流程。
- `settle`/`metrics` 于 run 收尾触发；`checkpoint_keep` 作用于链级
  rebase 窗口（编辑重放期间跳过）。
- hosts/lib `recipe.ts` 经公共面以 `run_options?: Partial<RunOptions>`
  覆盖配方默认（引擎唯一执行域选项入口；`multipath_enabled` 开关已随
  P8+S1 退役删除）。

## 不变式与门禁

- core 纯函数纪律：禁 `node:*` 与第三方 import、禁反向依赖 `adapters/`、
  禁宿主词（架构门禁随 vitest 强制）。
- `transports`/`system_events` 逐实例新建（对齐 Python
  `field(default_factory)`），防跨实例串写。
- 本模块不定义语义枚举/协议词表（字段为类型引用 + 数字护栏），不触
  「第二套语义枚举」约束。

## 测试

镜像测试：`test/core/run_result/run_result.test.ts`。覆盖点：默认构造
17 字段逐项对位、`transports`/`system_events` 逐实例隔离、关键字式覆盖
（DI 注入 + 数字护栏）、`RunResult` 必填/缺省、`to_dict` 两态（无中断点/
挂起卡含 `InterruptState` 四键）、收尾原位补记后序列化一致。

## 疑点与不一致

1. 模块 docstring 自述「只依赖其他 core 契约模块」，实际 type import 跨
   dock/core/gate/loop/graph/evolve 多层（`gate/budget`/`loop/interrupt`/
   `evolve/param_tuning`/`loop/turn_settle` 等）；与 AGENTS.md
   「纯逻辑留守项同守纯函数纪律」不冲突，但措辞与实际路径不符。
2. `RunResult.reason` 为裸 `string`，本模块未引用 `core/graph`
   `TerminateReason`（REPLY/STOP/BUDGET_EXCEEDED/ERROR/CANCELLED）；
   对位测试另用 `'completed'`/`'interrupt'` 等值。reason 值域约束未见
   显式说明。
3. 模块 docstring 与「Python 差异」注仍残留 `plan_workflow`/
   `DEFAULT_MAX_SIMULATIONS`/`branch_pick` 等已退役字段的措辞（源码注释
   滞后于 P8+S1 摘链，待后续源码小波清理）。
4. 构造经 `Object.assign(this, init)` 合并，显式传 `undefined` 的键会
   覆盖类字段默认值（「缺省 = 默认值」仅对未提供的键成立），默认值测试
   未覆盖该行为。
