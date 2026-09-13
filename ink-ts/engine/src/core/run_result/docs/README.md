# run_result（core/run_result）

单次 run 的配置面与结果面纯数据契约：`RunOptions`（DI 注入字段 + 成本护栏）
与 `RunResult`（最终状态/终止原因/中断点/事件统计）；执行语义在
`graph/executor`，本模块只承载形态。

## 文件
- `run_result.ts` — `RunOptions`/`RunResult` 数据契约（`run_result.py` 移植；
  `MultipathAssemblySeam`/`AssemblySourcesProvider` 多径装配面已随 P8+S1
  展开段退役删除）。

## 依赖
- 上游（本目录实际 import，均 type）：`dock/ports`（storage `Storage`、
  events `EngineTransport`）、`core/state`（`StateSchema`）、`gate/budget`
  （`BudgetManager`）、`loop/interrupt`（`InterruptState`）、`graph/registry`
  （`GraphRegistries`）、`evolve/param_tuning`（`TurnMetrics`）、
  `loop/turn_settle`（`SettleHooks`）。
- 下游（实际 import 本目录）：`graph/executor`（全链 + index 转出
  `RunOptions`/`RunResult`）、`loop/runtime`（引擎重建装配）、
  `loop/execution_runtime`（`engine_turn_runner` 持同形态驱动回合）；公共面经
  `dock/index.ts` `export *` 收口（`src/index.ts` 只转发 dock）；hosts/lib
  经公共面消费 `RunOptions`；测试 `test/core/run_result`、`test/graph/executor`、
  `test/loop/runtime`。
